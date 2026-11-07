import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { learningFixture } from "./learning-fixture.ts";
import { projectLearningState } from "../src/learning-state.ts";
import { compileContext } from "../src/context.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import { presentFeedback, overrideFeedback } from "../src/feedback.ts";

const stores: LearningStore[] = [], roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }

test("operational state distinguishes waiting, unclassified captured input, an attempt and its pinned assessment", () => {
  const f = fixture();
  expect(projectLearningState(f.store, "test").phase).toBe("prepare");
  const definition = f.task("Choose a method and explain why"); const instance = f.deliver(definition);
  const deliverySeq = f.store.throughSeq;
  expect(projectLearningState(f.store, "test")).toMatchObject({ schema_version: 1, phase: "awaiting_answer", pending_count: 1, current_task: { instance_revision_id: instance.revision_id, definition_revision_id: definition.revision_id, rubric_revision_id: definition.body.rubric_revision_id } });
  const unrelated = f.store.learnerResponse("Could you clarify the notation?", "test");
  expect(projectLearningState(f.store, "test").phase).toBe("awaiting_answer");
  const response = f.store.learnerResponse("I choose integration by parts.", "test", randomUUID(), { instance_revision_id: instance.revision_id, goal_revision_id: f.goal.revision_id });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "submission_pending", current_task: { response_event_id: response.event_id } });
  const attemptId = randomUUID();
  f.record("attempt_submitted", { attempt_id: attemptId, instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "assessment_pending", current_task: { attempt_id: attemptId, response_event_id: response.event_id } });
  const assessment = f.assess(attemptId, definition, "integration by parts", "partial");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "feedback", pending_count: 0, current_task: { assessment_event_id: assessment.event_id } });
  expect(projectLearningState(f.store, "test", deliverySeq).phase).toBe("awaiting_answer");
  expect(projectLearningState(f.store, "test").current_task?.response_event_id).not.toBe(unrelated.event_id);
  const packet = compileContext(f.store, {}, "", "test");
  expect(packet.learning_state).toMatchObject({ phase: "feedback" });
});

test("a newer prepared item cannot hide an unanswered earlier task; stop keeps it resumable without fabricating an answer", () => {
  const f = fixture(); const first = f.deliver(f.task("First unanswered task"));
  f.deliver(f.task("Later prepared task"));
  expect(projectLearningState(f.store, "test")).toMatchObject({ pending_count: 2, current_task: { instance_revision_id: first.revision_id } });
  expect((compileContext(f.store, {}, "", "test").task as { instance: { revision_id: string } }).instance.revision_id).toBe(first.revision_id);
  f.record("checkpoint", { goal_revision_id: f.goal.revision_id, summary: "Paused", next_action: "Return to the first task", gaps: [], stopped: true });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "stopped", resume_phase: "awaiting_answer", current_task: { instance_revision_id: first.revision_id } });
  f.store.learnerResponse("Resume please", "test");
  expect(projectLearningState(f.store, "test").phase).toBe("awaiting_answer");
  expect(f.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(0);
});

test("feedback repair and learner override use trusted existing receipts rather than successful-outcome inference", () => {
  const f = fixture();
  const goal = f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learning_preferences: profilePreferences("thorough") } }, "learner", "test"); Object.assign(f.goal, goal);
  const definition = f.task("Explain scope"); const work = f.attempt(f.deliver(definition), "integration by parts always applies");
  const assessment = f.assess(work.id, definition, "integration by parts", "partial", { feedback_review: { ready_to_continue: false, issues: [{ quote: "always applies", problem: "The claim is too broad", suggestion: "State the conditions", severity: "blocking" }] } });
  expect(projectLearningState(f.store, "test").phase).toBe("feedback");
  expect(projectLearningState(f.store, "test").pending_count).toBe(1);
  presentFeedback(f.store, assessment.event_id, "test");
  expect(projectLearningState(f.store, "test").phase).toBe("repair");
  overrideFeedback(f.store, "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "checkpoint", pending_count: 0, current_task: { assessment_event_id: assessment.event_id, overridden: true } });
  expect(f.store.event(assessment.event_id).payload.outcome).toBe("partial");
});

test("state retains compatible broader plans and scoped assistance across preference refinements, not objective changes", () => {
  const f = fixture();
  const plan = f.define("plan", { goal_revision_id: f.goal.revision_id, component_revision_ids: [f.component.revision_id], next_activities: ["Check the method choice", "Try a fresh transfer task"], known_gaps: ["Scope is unverified"], uncertain_assumptions: ["No unaided demonstration yet"] });
  const instance = f.deliver(f.task("Current task"));
  const help = f.record("assistance", { assistance_id: randomUUID(), instance_revision_id: instance.revision_id, component_revision_ids: [f.component.revision_id], stage: "exposed", kind: "hint", content: "Consider the product structure", answer_bearing: true });
  expect(projectLearningState(f.store, "test")).toMatchObject({ plan: { revision_id: plan.revision_id }, current_task: { assistance_event_ids: [help.event_id] } });
  const revised = f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learner_notes: "Keep turns short" } }, "learner", "test");
  expect(projectLearningState(f.store, "test").plan?.revision_id).toBe(plan.revision_id);
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: revised.revision_id, expected_goal_revision_id: revised.revision_id, body: { ...f.goal.body, objective: "Different learning objective" } }, "learner", "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "prepare", current_task: null, plan: null });
});

test("reopened SQLite reconstructs the same state without a model, and other sessions/hypothetical input cannot supply work", async () => {
  const f = fixture(); const instance = f.deliver(f.task("Durable task"));
  f.store.append("learner_response", { text: "Invented hypothetical solution", instance_revision_id: instance.revision_id }, randomUUID(), "learner", "test", f.store.now(), undefined, "hypothetical");
  f.store.learnerResponse("Another session's work", "other", randomUUID(), { instance_revision_id: instance.revision_id });
  const before = projectLearningState(f.store, "test");
  expect(before.phase).toBe("awaiting_answer");
  expect(projectLearningState(f.store, "other")).toMatchObject({ phase: "orient", current_task: null, plan: null });
  const root = await mkdtemp(join(tmpdir(), "sage-state-reopen-")); roots.push(root);
  const filename = join(root, "learning.sqlite"); await writeFile(filename, f.store.db.serialize());
  const reopened = new LearningStore(filename, f.store.now); stores.push(reopened);
  expect(projectLearningState(reopened, "test")).toEqual(before);
  const tables = reopened.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  expect(tables).toHaveLength(7);
});
