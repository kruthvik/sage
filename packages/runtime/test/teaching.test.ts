import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import { projectLearningState } from "../src/learning-state.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presentFeedback, overrideFeedback } from "../src/feedback.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import { compileContext } from "../src/context.ts";
import { assertCurrentLearningTask } from "../src/learning-controller.ts";

const stores: LearningStore[] = [], roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
  const f = learningFixture(); stores.push(f.store);
  Object.assign(f.goal, f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learning_preferences: profilePreferences("thorough") } }, "learner", "test"));
  const instruction = f.define("artifact", { capability: "worked_example", author: "tutor", provenance: "Host-prepared instruction", media_type: "text/plain", content: "Choose parts when a product has a simplifying factor.", evidence_kind: "artifact_only", interpretation_uncertainty: "Delivery is not understanding", assistance_event_ids: [], goal_revision_id: f.goal.revision_id });
  const definition = f.task("Choose a method for a fresh product and explain why", { artifact_revision_ids: [instruction.revision_id] });
  const teaching = { schema_version: 1, unit_id: randomUUID(), stage: "prepared", goal_revision_id: f.goal.revision_id, component_revision_id: f.component.revision_id, instruction_revision_id: instruction.revision_id, definition_revision_id: definition.revision_id };
  const receipt = (annotation: Record<string, unknown>, session = "test", actor = "host", action = "teaching_stage") => f.store.append("decision", { action, reason: "Owned teaching protocol", evidence_event_ids: [], teaching: annotation }, randomUUID(), actor, session);
  const prepared = receipt(teaching);
  return { ...f, instruction, definition, teaching, prepared, receipt };
}

test("projectLearningState resumes a host-prepared teaching unit before any learner work", () => {
  const f = fixture();
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "instruction_pending", teaching: { stage: "instruction_pending", prepared_event_id: f.prepared.event_id } });
  expect(f.store.events().filter(e => ["attempt_submitted", "assessment", "review_scheduled"].includes(e.kind))).toHaveLength(0);
});

function link(f: ReturnType<typeof fixture>) {
  f.receipt({ ...f.teaching, stage: "presented", prepared_event_id: f.prepared.event_id });
  expect(projectLearningState(f.store, "test").phase).toBe("question_pending");
  const instance = f.deliver(f.definition);
  const annotation = { ...f.teaching, stage: "linked", prepared_event_id: f.prepared.event_id, instance_revision_id: instance.revision_id };
  f.receipt(annotation);
  return { instance, annotation };
}

for (const terminal of ["unit_complete", "checkpoint"] as const) test(`runtime continuity: ${terminal} teaching cannot hide later task feedback`, async () => {
  const f = fixture(); const { instance: guided } = link(f);
  const initial = f.attempt(guided);
  const initialAssessment = f.assess(initial.id, f.definition, "integration by parts", "success", { feedback_review: { ready_to_continue: true, issues: [] } });
  if (terminal === "unit_complete") presentFeedback(f.store, initialAssessment.event_id, "test");
  else overrideFeedback(f.store, "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: terminal, current_task: { instance_revision_id: guided.revision_id } });
  const terminalSeq = f.store.throughSeq, originalAssessment = JSON.stringify(initialAssessment.payload);
  const definition = f.task("Choose a method for the next task without teaching artifacts");
  const next = f.deliver(definition);
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "awaiting_answer", current_task: { instance_revision_id: next.revision_id } });
  const work = f.attempt(next);
  const assessment = f.assess(work.id, definition, "integration by parts", "success", { feedback_review: { ready_to_continue: true, issues: [] } });
  presentFeedback(f.store, assessment.event_id, "test");
  const state = projectLearningState(f.store, "test");
  expect(state).toMatchObject({ phase: "feedback", pending_count: 0, current_task: { instance_revision_id: next.revision_id, assessment_event_id: assessment.event_id }, teaching: { stage: terminal } });
  expect(() => assertCurrentLearningTask(f.store, "test", next.revision_id)).not.toThrow();
  expect(() => assertCurrentLearningTask(f.store, "test", guided.revision_id)).toThrow("no longer current");
  expect((compileContext(f.store, {}, "", "test").task as { instance: { revision_id: string } }).instance.revision_id).toBe(next.revision_id);
  expect(projectLearningState(f.store, "test", terminalSeq)).toMatchObject({ phase: terminal, current_task: { instance_revision_id: guided.revision_id } });
  expect(JSON.stringify(f.store.event(initialAssessment.event_id).payload)).toBe(originalAssessment);
  const root = await mkdtemp(join(tmpdir(), "sage-teaching-continuity-")); roots.push(root);
  const filename = join(root, "learning.sqlite"); await writeFile(filename, f.store.db.serialize());
  const reopened = new LearningStore(filename, f.store.now); stores.push(reopened);
  expect(projectLearningState(reopened, "test")).toEqual(state);
});

test("teaching progression and disk reopen require real work and canonical feedback, not completion receipts", async () => {
  const f = fixture(); const { instance, annotation } = link(f);
  f.receipt({ ...annotation, stage: "completed" });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "awaiting_answer", teaching: { criterion_evidence: "unknown" } });
  const root = await mkdtemp(join(tmpdir(), "sage-teaching-")); roots.push(root);
  const filename = join(root, "learning.sqlite"); await writeFile(filename, f.store.db.serialize());
  const reopened = new LearningStore(filename, f.store.now); stores.push(reopened);
  expect(projectLearningState(reopened, "test")).toEqual(projectLearningState(f.store, "test"));
  const reopenedResponse = reopened.learnerResponse("I choose integration by parts.", "test", randomUUID(), { instance_revision_id: instance.revision_id, goal_revision_id: f.goal.revision_id });
  expect(projectLearningState(reopened, "test").phase).toBe("submission_pending");
  reopened.record({ operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: randomUUID(), instance_revision_id: instance.revision_id, response_event_id: reopenedResponse.event_id, declared_aids: [] } }, "test");
  expect(projectLearningState(reopened, "test").phase).toBe("assessment_pending");
  expect(reopened.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(7);
  const work = f.attempt(instance);
  expect(projectLearningState(f.store, "test").phase).toBe("assessment_pending");
  const assessment = f.assess(work.id, f.definition, "integration by parts", "success", { feedback_review: { ready_to_continue: true, issues: [] } });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "feedback", pending_count: 1 });
  presentFeedback(f.store, assessment.event_id, "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "unit_complete", teaching: { criterion_evidence: "observed" } });
  expect(f.views()[0]?.current_claim).toBe("unverified");
  expect(f.store.events().filter(e => e.kind === "review_scheduled")).toHaveLength(0);
  const next = f.receipt({ ...f.teaching, unit_id: randomUUID() });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "instruction_pending", teaching: { prepared_event_id: next.event_id } });
});

test("model recording, alternate actions, learner actors and hypothetical receipts cannot control teaching", () => {
  const f = fixture(); const annotation = { ...f.teaching, stage: "presented", prepared_event_id: f.prepared.event_id };
  for (const action of ["teaching_stage", "copied_instruction"]) {
    expect(() => f.record("decision", { action, reason: "Model proposed instruction", evidence_event_ids: [], teaching: annotation })).toThrow("trusted host");
    expect(() => f.receipt(annotation, "test", "pi", action)).toThrow("trusted host");
  }
  expect(() => f.receipt(annotation, "test", "learner")).toThrow("trusted host");
  expect(() => f.store.append("decision", { action: "teaching_stage", teaching: annotation }, randomUUID(), "host", "test", f.store.now(), undefined, "hypothetical")).toThrow("trusted host");
  expect(projectLearningState(f.store, "test").phase).toBe("instruction_pending");
});

test("wrong kinds, components, foreign revisions, stale goals and superseded questions are rejected", () => {
  const f = fixture();
  const prepare = (patch: Record<string, unknown>) => f.receipt({ ...f.teaching, unit_id: randomUUID(), ...patch });
  expect(() => prepare({ instruction_revision_id: f.component.revision_id })).toThrow();
  const otherComponent = f.define("component", { ...f.component.body, subject: "science" });
  expect(() => prepare({ component_revision_id: otherComponent.revision_id })).toThrow();
  const unrelated = f.define("artifact", { ...f.instruction.body, content: "Unrelated instruction from the same goal" });
  expect(() => prepare({ instruction_revision_id: unrelated.revision_id })).toThrow("goal and component");
  const foreignGoal = f.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "other");
  const foreign = f.store.define({ operation_id: randomUUID(), kind: "artifact", expected_goal_revision_id: foreignGoal.revision_id, body: { ...f.instruction.body, goal_revision_id: foreignGoal.revision_id } }, "human", "other");
  expect(() => prepare({ instruction_revision_id: foreign.revision_id })).toThrow("owned");
  expect(() => f.receipt({ ...f.teaching, stage: "presented", prepared_event_id: f.prepared.event_id }, "other")).toThrow("owned");
  f.define("task_definition", { ...f.definition.body, prompt: "A revised fresh question" }, f.definition);
  expect(() => prepare({})).toThrow("superseded");
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "A different objective" } }, "learner", "test");
  expect(() => prepare({})).toThrow("stale goal");
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "prepare", current_task: null });
  expect(projectLearningState(f.store, "test").teaching).toBeUndefined();
});

test("sequence and time exclude future receipts; replay and pre-instruction delivery cannot supply progress", () => {
  const f = fixture(); const seq = f.store.throughSeq;
  expect(projectLearningState(f.store, "test", f.prepared.seq - 1).phase).toBe("prepare");
  expect(() => f.receipt(f.teaching)).toThrow("replay");
  const annotation = { ...f.teaching, stage: "presented", prepared_event_id: f.prepared.event_id };
  f.store.append("decision", { action: "teaching_stage", teaching: annotation }, randomUUID(), "host", "test", "2026-10-01T12:00:01.000Z");
  const presentationSeq = f.store.throughSeq;
  expect(() => f.receipt(annotation)).toThrow("already recorded");
  expect(f.store.throughSeq).toBe(presentationSeq);
  expect(projectLearningState(f.store, "test").phase).toBe("instruction_pending");
  expect(projectLearningState(f.store, "test", seq, "2026-10-01T12:00:02.000Z").phase).toBe("instruction_pending");
  expect(projectLearningState(f.store, "test", f.store.throughSeq, "2026-10-01T12:00:02.000Z").phase).toBe("question_pending");
  f.time("2026-10-01T12:00:02.000Z");
  expect(() => f.receipt(annotation)).toThrow("already recorded");
  const early = fixture(); const instance = early.deliver(early.definition);
  expect(() => early.receipt({ ...early.teaching, stage: "linked", prepared_event_id: early.prepared.event_id, instance_revision_id: instance.revision_id })).toThrow("presentation");
  early.receipt({ ...early.teaching, stage: "presented", prepared_event_id: early.prepared.event_id });
  expect(() => early.receipt({ ...early.teaching, stage: "linked", prepared_event_id: early.prepared.event_id, instance_revision_id: instance.revision_id })).toThrow("after instruction");
});

test("teaching preparation replay uses sequence identity even when its timestamp is hidden", () => {
  const f = fixture(); const annotation = { ...f.teaching, unit_id: randomUUID() };
  const payload = { action: "teaching_stage", teaching: annotation }; const operationId = randomUUID();
  const prepared = f.store.append("decision", payload, operationId, "host", "test", "2026-10-01T12:00:01.000Z");
  expect(() => f.receipt(annotation)).toThrow("replay");
  expect(f.store.throughSeq).toBe(prepared.seq);
  expect(f.store.validateTeachingAnnotation(annotation, "test", f.goal.revision_id, prepared.seq - 1, "2026-10-01T12:00:02.000Z")).toMatchObject({ stage: "prepared" });
  expect(f.store.append("decision", payload, operationId, "host", "test").event_id).toBe(prepared.event_id);
  expect(projectLearningState(f.store, "test").teaching?.prepared_event_id).toBe(f.prepared.event_id);
});

test("pending legacy work takes precedence and stop/override never change teaching marks", () => {
  const f = fixture(); const legacy = f.deliver(f.task("Earlier pending question"));
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "awaiting_answer", current_task: { instance_revision_id: legacy.revision_id } });
  f.record("checkpoint", { goal_revision_id: f.goal.revision_id, summary: "Paused", next_action: "Resume saved work", gaps: [], stopped: true });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "stopped", resume_phase: "awaiting_answer" });
  const g = fixture(); const { instance } = link(g); const work = g.attempt(instance, "I choose substitution");
  const assessment = g.assess(work.id, g.definition, "I choose substitution", "failure", { feedback_review: { ready_to_continue: true, issues: [] } });
  overrideFeedback(g.store, "test");
  expect(projectLearningState(g.store, "test")).toMatchObject({ phase: "checkpoint", teaching: { criterion_evidence: "unknown" } });
  expect(g.store.event(assessment.event_id).payload.outcome).toBe("failure");
});

test("missing criterion scores and non-target component outcomes remain unknown repair", () => {
  for (const scoped of [false, true]) {
    const f = fixture(); const { instance } = link(f); const work = f.attempt(instance);
    expect(() => f.assess(work.id, f.definition, "integration by parts", "success", { scores: [] })).toThrow("every rubric dimension");
    const assessment = f.assess(work.id, f.definition, "integration by parts", scoped ? "success" : "partial", { ...(scoped ? { component_outcomes: [] } : { scores: [] }), feedback_review: { ready_to_continue: true, issues: [] } });
    presentFeedback(f.store, assessment.event_id, "test");
    expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "repair", teaching: { criterion_evidence: "unknown" } });
  }
});

test("copied historical JSON and nonexistent source relationships do not establish instruction", () => {
  const f = fixture();
  // Exercise untrusted historical metadata in the actual ledger, not a competing database.
  const copied = { ...f.teaching, stage: "presented", prepared_event_id: "foreign-receipt" };
  expect(() => f.store.db.query("UPDATE event SET payload=? WHERE event_id=?").run(JSON.stringify({ action: "teaching_stage", teaching: copied }), f.prepared.event_id)).toThrow("Immutable record");
  expect(() => f.receipt(copied)).toThrow("owned preparation");
  expect(projectLearningState(f.store, "test").phase).toBe("instruction_pending");
  const g = fixture();
  expect(() => g.task("Source-linked question", { source_span_ids: ["missing-source-span"] })).toThrow("source span");
  expect(() => g.store.db.query("UPDATE object_revision SET body=? WHERE revision_id=?").run(JSON.stringify({ ...g.definition.body, source_span_ids: ["missing-source-span"] }), g.definition.revision_id)).toThrow("Immutable record");
  expect(projectLearningState(g.store, "test").phase).toBe("instruction_pending");
});
