import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningService } from "../src/service.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { startLearningServer } from "../src/service.ts";
import * as tutorHost from "../src/tutor-host.ts";
import type { Goal, Revision } from "../../core/src/contracts.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { compileContext } from "../src/context.ts";
import { learningFixture } from "./learning-fixture.ts";
import { feedbackState } from "../src/feedback.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }
function secondLesson(f: ReturnType<typeof fixture>) {
  return f.store.define({ operation_id: randomUUID(), kind: "goal", body: { ...f.goal.body, objective: "A separate writing lesson", subject: "writing" } }, "learner", "second") as unknown as Revision<Goal>;
}

test("a new conversation does not inherit the globally latest lesson or its objects", () => {
  const f = fixture();
  f.deliver(f.task("Private lesson A prompt"));
  const packet = compileContext(f.store, {}, "", "empty-session");
  expect(packet.goal).toBeNull();
  expect(packet.task).toBeUndefined();
  expect(packet.components).toEqual([]);
  expect(packet.available_objects).toEqual([]);
  expect(f.store.events().filter(e => e.session_id === "empty-session")).toEqual([]);
});

test("two sessions own independent goals and resuming A does not select B", () => {
  const f = fixture(); const second = secondLesson(f);
  expect((compileContext(f.store, {}, "", "test").goal as Revision).revision_id).toBe(f.goal.revision_id);
  expect((compileContext(f.store, {}, "", "second").goal as Revision).revision_id).toBe(second.revision_id);
  const revised = f.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, budget_minutes: 15 } }, "learner", "test");
  expect((compileContext(f.store, {}, "", "test").goal as Revision).revision_id).toBe(revised.revision_id);
  expect((compileContext(f.store, {}, "", "second").goal as Revision).revision_id).toBe(second.revision_id);
});

test("context rejects another lesson's explicit goal, task and evidence", () => {
  const f = fixture(); const work = f.observe(f.task("Lesson A response")); const second = secondLesson(f);
  expect(() => compileContext(f.store, { goal_revision_id: second.revision_id }, "", "test")).toThrow("lesson");
  expect(() => compileContext(f.store, { instance_revision_id: work.instance.revision_id }, "", "second")).toThrow("lesson");
  expect(() => compileContext(f.store, { evidence_event_ids: [work.assessment.event_id] }, "", "second")).toThrow("lesson");
  expect(() => compileContext(f.store, { component_revision_ids: [f.component.revision_id] }, "", "second")).toThrow("lesson");
  const hypothesis = f.hypothesis([]);
  expect(() => compileContext(f.store, { hypothesis_revision_ids: [hypothesis.revision_id] }, "", "second")).toThrow("lesson");
});

test("one session cannot create a second lesson or revise a different lesson's entity", () => {
  const f = fixture(); const second = secondLesson(f); const seq = f.store.throughSeq;
  expect(() => f.store.define({ operation_id: randomUUID(), kind: "goal", expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Unrelated lesson" } }, "learner", "test")).toThrow("new session");
  expect(() => f.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: second.revision_id, body: f.goal.body }, "learner", "second")).toThrow("lesson");
  expect(f.store.throughSeq).toBe(seq);
});

test("a same-lesson preference refinement does not silently clear pending response review", () => {
  const f = fixture();
  const reviewed = f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learning_preferences: profilePreferences() } }, "learner", "test");
  Object.assign(f.goal, reviewed);
  f.attempt(f.deliver(f.task("Explain your choice")));
  expect(feedbackState(f.store, "test").phase).toBe("awaiting_review");
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learner_notes: "Shorter feedback" } }, "learner", "test");
  expect(feedbackState(f.store, "test").phase).toBe("awaiting_review");
});

test("another lesson cannot revise a task definition's parent", () => {
  const f = fixture(); const task = f.task("A frozen task definition"); const second = secondLesson(f);
  expect(() => f.store.define({ operation_id: randomUUID(), kind: "task_definition", parent_revision_id: task.revision_id, expected_goal_revision_id: second.revision_id, body: { ...task.body, status: "retired" } }, "human", "second")).toThrow("lesson");
});

test("legacy mixed sessions require explicit host binding without rewriting their goals", () => {
  const f = fixture(); const revisionId = randomUUID(), entityId = randomUUID();
  // Recreate a pre-isolation database row through the trusted import seam.
  const created = f.store.append("decision", { action: "revision_defined", kind: "goal", revision_id: revisionId, reason: "Historical mixed-session fixture", evidence_event_ids: [] }, randomUUID(), "learner", "test");
  f.store.insertRevision(revisionId, entityId, "goal", null, { ...f.goal.body, objective: "Historical second lesson" }, created.seq, randomUUID(), {});
  const original = f.store.revisions("goal");
  expect(() => compileContext(f.store, {}, "", "test")).toThrow("multiple lessons");
  f.store.bindLesson("test", f.goal.entity_id);
  expect((compileContext(f.store, {}, "", "test").goal as Revision).revision_id).toBe(f.goal.revision_id);
  f.store.bindLesson("test", entityId);
  expect((compileContext(f.store, {}, "", "test").goal as Revision).revision_id).toBe(revisionId);
  f.store.bindLesson("test", f.goal.entity_id);
  expect((compileContext(f.store, {}, "", "test").goal as Revision).revision_id).toBe(f.goal.revision_id);
  expect(f.store.revisions("goal")).toEqual(original);
  expect(() => f.store.bindLesson("empty", f.goal.entity_id)).toThrow("conversation");
  expect(() => f.store.record({ operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: f.goal.revision_id, payload: { action: "lesson_bound", reason: "Model assertion", evidence_event_ids: [] } }, "test")).toThrow("trusted");
});

test("definition and event idempotency receipts cannot be replayed through another session", () => {
  const f = fixture();
  const request = { operation_id: randomUUID(), kind: "concept", expected_goal_revision_id: f.goal.revision_id, body: { title: "A", description: "A concept" } };
  const revision = f.store.define(request, "pi", "test");
  expect(f.store.define(request, "pi", "test").revision_id).toBe(revision.revision_id);
  expect(() => f.store.define(request, "pi", "second")).toThrow("conversation");
  const eventRequest = { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: f.goal.revision_id, payload: { action: "orient", reason: "Relevant lesson", evidence_event_ids: [] } };
  f.store.record(eventRequest, "test");
  expect(() => f.store.record(eventRequest, "second")).toThrow("conversation");
});

test("switching the active native lesson invalidates UI capabilities and rejects stale operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-lesson-lifetime-"));
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths);
  try {
    const activate = Reflect.get(service, "activateSession");
    expect(typeof activate).toBe("function");
    activate.call(service, "a");
    service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Lesson A", subject: "writing", horizon_days: 7, target_format: "argument", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "a");
    const ui = await service.renderUi('page "A"\ninput answer', "a", "http://127.0.0.1:3000", () => {}, async () => ({ use: "supplementary" }));
    const request = new Request(`http://127.0.0.1:3000/api/ui/${ui.id}`);
    expect((await service.ui.handle(request))?.status).toBe(200);
    activate.call(service, "b");
    expect((await service.ui.handle(request))?.status).toBe(404);
    await expect(service.operation("learning_context", {}, "a")).rejects.toThrow("inactive");
    expect((await service.context({}, "b")).goal).toBeNull();
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

test("the actual trusted tutor bridge creates two lessons and rejects an inactive goal callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-lesson-bridge-"));
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths), server = startLearningServer(service);
  try {
    const factory = Reflect.get(tutorHost, "createTutorBridge");
    expect(typeof factory).toBe("function");
    const bridge = factory(paths, service, server);
    const body: Goal = { mode: "learn", objective: "Lesson A", subject: "writing", horizon_days: 7, target_format: "argument", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
    expect(bridge.activate).toBeDefined();
    await bridge.activate!("a"); await bridge.goal(body, "a");
    installFixtures(service.store, service.store.lessonGoal("a")!);
    const originalTasks = service.store.revisions("task_definition");
    const base = originalTasks[0]!;
    const candidate = service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: service.store.lessonGoal("a")!.revision_id, body: { ...base.body, prompt: "Private lesson A approval candidate", status: "candidate", review: { method: "unreviewed", reason: "Awaiting learner review" } } }, "pi", "a");
    await bridge.activate!("b"); await bridge.goal({ ...body, objective: "Lesson B", allowed_aids: ["notes"] }, "b");
    for (const task of originalTasks) {
      const latest = service.store.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1)!;
      expect(latest.revision_id).toBe(task.revision_id);
    }
    const b = await bridge.operation("learning_context", {}, "b") as { goal: Revision<Goal> };
    expect(b.goal.body.objective).toBe("Lesson B");
    const beforeReview = service.store.throughSeq;
    await expect(bridge.approve(candidate.revision_id, false, "b")).rejects.toThrow("lesson");
    expect(service.store.throughSeq).toBe(beforeReview);
    await expect(bridge.goal(body, "a")).rejects.toThrow("inactive");
    await bridge.activate!("a");
    const a = await bridge.operation("learning_context", {}, "a") as { goal: Revision<Goal> };
    expect(a.goal.body.objective).toBe("Lesson A");
    const preview = await bridge.approve(candidate.revision_id, false, "a");
    expect(preview).toMatchObject({ review_scope: "learner_acceptance_only", expert_validation: false });
    expect((preview as { instruction: string }).instruction).toContain("not expert validation");
  } finally { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); }
});

test("assessment of A cannot be recorded under B's valid goal revision", () => {
  const f = fixture(); const definition = f.task("Explain lesson A"); const instance = f.deliver(definition); const work = f.attempt(instance); const second = secondLesson(f);
  expect(() => f.store.record({ operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: second.revision_id, payload: { attempt_id: work.id, rubric_revision_id: definition.body.rubric_revision_id, outcome: "success", scores: [{ dimension: "target", score: 2, evidence: "integration by parts" }], feedback: "A review", uncertainty: "Proposal" } }, "second")).toThrow("lesson");
});
