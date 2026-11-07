import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import { modePath } from "./mode-path-fixture.ts";
import { importProtectedTask, deliverProtectedAssessment } from "../src/assessment.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import type { Revision, TaskDefinition } from "../../core/src/contracts.ts";

const fixtures: ReturnType<typeof learningFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.store.close(); });
function fixture() { const f = learningFixture(); fixtures.push(f); return f; }
// Proposed explicit-attestation argument; tests fail against the old provenance-manufacturing API.
const importAttested = importProtectedTask as unknown as (store: LearningStore, task: Omit<TaskDefinition, "partition">, sessionId: string, authorizationEventId?: string) => Revision<TaskDefinition>;
function attestedInput(f: ReturnType<typeof fixture>) {
  return { ...f.task("Standard calculus test item").body, prompt: "Final Exam Item: Evaluate definite integral from 0 to 1 of x * e^x dx", stakes: "high", review: { method: "human", reviewer_role: "expert", reviewer_provenance: "External reviewer attestation: exam bank item 3; credentials not independently verified", reason: "Reviewed against the supplied published rubric" } };
}
function authorize(f: ReturnType<typeof fixture>, task: TaskDefinition, actor = "expert", sessionId = "test") {
  return f.store.append("decision", { action: "assessment_import_authorized", goal_revision_id: f.goal.revision_id, task_hash: hash(canonical(task)), reason: "Explicit external reviewer import receipt, not credential or calibration verification", evidence_event_ids: [] }, randomUUID(), actor, sessionId);
}

test("e03s01 task 3: owned changed-demand rechecks must test original criteria independently before progression", async () => {
  await modePath(async f => {
    await f.command("mode", "accelerate");
    const base = f.task("Calculate a doubled quantity and explain the invariant");
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(base.revision_id, "10 because the ratio is invariant", full("10 because the ratio is invariant"));
    const candidates = async () => (await f.context()).next_action_candidates as Array<{ type: string }>;
    expect((await candidates()).some(c => c.type === "advance")).toBe(false);
    const familiar = f.task("Calculate another doubled quantity and explain the invariant");
    await f.work(familiar.revision_id, "12 because the ratio is invariant", full("12 because the ratio is invariant"));
    expect((await candidates()).some(c => c.type === "advance")).toBe(false);
    const original = f.service.store.events().filter(e => ["assessment", "attempt_submitted", "learner_response"].includes(e.kind));
    const changed = f.task("Interpret a table under a changed unit scale; predict a missing value and justify the invariant", { representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Ratio invariant", rationale: "Interpret changed units rather than substitute a familiar number" } });
    await f.work(changed.revision_id, "14 because the ratio is invariant", full("14 because the ratio is invariant"), true);
    expect((await candidates()).some(c => c.type === "advance")).toBe(false);
    const unseen = f.task("Read a fresh table; number only", { representation: "table", variation: changed.variation });
    await f.work(unseen.revision_id, "16", [{ dimension: "solve", score: 85, evidence: "16" }]);
    expect((await candidates()).some(c => c.type === "advance")).toBe(false);
    const fresh = f.task("Interpret an unfamiliar rate table with changed units and explain why proportionality survives", { representation: "table", variation: changed.variation });
    await f.work(fresh.revision_id, "18 because the ratio is invariant under the unit transformation", full("18 because the ratio is invariant under the unit transformation"));
    expect((await candidates())[0]!.type).toBe("advance");
    expect(f.notices.join("\n")).toContain("100/100");
    expect(f.service.store.events().filter(e => original.some(o => o.event_id === e.event_id))).toEqual(original);
    const repair = f.task("Test another transformed table and justify proportionality", { representation: "table", variation: changed.variation });
    await f.work(repair.revision_id, "20", [{ dimension: "solve", score: 85, evidence: "20" }]);
    expect((await candidates())[0]!.type).not.toBe("advance");
  });
});

test("e03s01 task 3: a changed rubric cannot replace the original unseen reasoning criterion with an easier demand", async () => {
  await modePath(async f => {
    await f.command("mode", "accelerate");
    const base = f.task("Solve a proportional change and explain its invariant");
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(base.revision_id, "10 because the ratio is invariant", full("10 because the ratio is invariant"));
    const gap = f.task("Solve an unfamiliar proportional change and explain its invariant");
    await f.work(gap.revision_id, "12", [{ dimension: "solve", score: 85, evidence: "12" }]);
    const goal = f.service.store.lessonGoal("modes")!;
    const rubric = f.service.store.define({ operation_id: randomUUID(), kind: "rubric", expected_goal_revision_id: goal.revision_id, body: { title: "Different demand, not original gap", dimensions: [{ name: "solve", criterion: "Solve proportional change", max_score: 85 }, { name: "reason", criterion: "Name the table heading, not explain the invariant", max_score: 15 }], provisional: false, source_span_ids: [] } }, "human", "modes");
    const changed = f.task("Read a table and name its heading", { rubric_revision_id: rubric.revision_id, representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation"], invariant: "Ratio relation", rationale: "Inspectable changed representation, but original reasoning is not tested" } });
    await f.work(changed.revision_id, "14; heading is quantity", full("14; heading is quantity"));
    const packet = await f.context();
    expect((packet.next_action_candidates as Array<{ type: string }>).some(c => c.type === "advance")).toBe(false);
    expect((packet.practice_policy as { compression_eligible_component_ids: string[] }).compression_eligible_component_ids).toEqual([]);
    expect(f.service.store.events().filter(e => e.kind === "assessment").at(-1)!.payload.marking_summary).toMatchObject({ earned: 100, maximum: 100 });
  });
});

test("e03s01 task 3: review repair cannot borrow an A-only baseline to accelerate familiar B work in a composite task", async () => {
  await modePath(async f => {
    await f.command("mode", "accelerate");
    const goal = f.service.store.lessonGoal("modes")!;
    const b = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: goal.revision_id, body: { title: "Component B proportional execution", behavior: "Solve and explain the B relation", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], target_dimensions: ["execution", "explanation"], uncertainty: "Owned software fixture; task quality and semantic marks uncalibrated" } }, "human", "modes");
    const baseA = f.task("Component A: solve and explain an original unit relation");
    const firstB = f.task("Component B: calculate a familiar doubled quantity and explain its ratio", { component_revision_ids: [b.revision_id] });
    const secondB = f.task("Component B: calculate another familiar doubled quantity with the same ratio reasoning", { component_revision_ids: [b.revision_id] });
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(baseA.revision_id, "A has value 10 because consistent units preserve its ratio", full("A has value 10 because consistent units preserve its ratio"));
    await f.work(firstB.revision_id, "B has value 12 because doubling preserves its ratio", full("B has value 12 because doubling preserves its ratio"));
    await f.work(secondB.revision_id, "B has value 14 because the same doubling preserves its ratio", full("B has value 14 because the same doubling preserves its ratio"));
    const original = f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind));
    const composite = f.task("Interpret a transformed-unit table for A, then perform B's familiar doubling and explain each ratio", { component_revision_ids: [...baseA.component_revision_ids, b.revision_id], representation: "table", variation: { baseline_definition_revision_id: baseA.revision_id, dimensions: ["representation", "component_combination"], invariant: "Ratio relations", rationale: "A changes representation; B's demand remains familiar and has no baseline comparison in this variation" } });
    await f.work(composite.revision_id, "A's transformed table gives 16 by its invariant ratio; B gives 18 by its familiar doubling ratio", full("A's transformed table gives 16 by its invariant ratio; B gives 18 by its familiar doubling ratio"), false, undefined, [{ component_revision_id: baseA.component_revision_ids[0]!, outcome: "success" }, { component_revision_id: b.revision_id, outcome: "success" }]);
    const bPacket = await f.tool("learning_context", { component_revision_ids: [b.revision_id], budget_chars: 24000 });
    expect(bPacket.practice_policy).toMatchObject({ compression_eligible_component_ids: [] });
    expect(bPacket.components).toMatchObject([{ component_revision_id: b.revision_id, transfer_evidence: { success: 0 }, independent_performance: { success: 3 } }]);
    const aPacket = await f.tool("learning_context", { component_revision_ids: baseA.component_revision_ids, budget_chars: 24000 });
    expect(aPacket.components).toMatchObject([{ transfer_evidence: { success: 0 } }]);
    expect(f.notices.join("\n")).toContain("100/100");
    const freshA = f.task("Component A alone: infer a quantity from an unfamiliar transformed rate diagram and justify the ratio", { representation: "diagram", variation: { baseline_definition_revision_id: baseA.revision_id, dimensions: ["representation", "context"], invariant: "A ratio", rationale: "Inspectable single-component changed-demand comparison with A's original criteria" } });
    await f.work(freshA.revision_id, "A's diagram gives 20 because its transformed units preserve the ratio", full("A's diagram gives 20 because its transformed units preserve the ratio"));
    expect((await f.tool("learning_context", { component_revision_ids: baseA.component_revision_ids, budget_chars: 24000 })).practice_policy).toMatchObject({ compression_eligible_component_ids: baseA.component_revision_ids });
    const freshB = f.task("Component B alone: infer a missing value from an unfamiliar unit table and justify proportionality", { component_revision_ids: [b.revision_id], representation: "table", variation: { baseline_definition_revision_id: firstB.revision_id, dimensions: ["representation", "context"], invariant: "B ratio", rationale: "A real B-specific baseline comparison, not borrowed A metadata" } });
    await f.work(freshB.revision_id, "B's unfamiliar table gives 22 because consistent units preserve its ratio", full("B's unfamiliar table gives 22 because consistent units preserve its ratio"));
    expect((await f.tool("learning_context", { component_revision_ids: [b.revision_id], budget_chars: 24000 })).practice_policy).toMatchObject({ compression_eligible_component_ids: [b.revision_id] });
    await f.reopen();
    expect((await f.tool("learning_context", { component_revision_ids: [b.revision_id], budget_chars: 24000 })).practice_policy).toMatchObject({ compression_eligible_component_ids: [b.revision_id] });
    expect(f.service.store.events().filter(e => original.some(o => o.event_id === e.event_id))).toEqual(original);
  });
});

test("arbitrary protected input cannot manufacture expert/high-stakes provenance", () => {
  const f = fixture(); const base = f.task("Unattested import"); const before = f.store.throughSeq;
  expect(() => importProtectedTask(f.store, base.body, "test")).toThrow("attestation");
  expect(f.store.throughSeq).toBe(before);
});

test("a scoped explicit reviewer receipt preserves original review/provenance and enables controlled assessment delivery", () => {
  const f = fixture(); const input = attestedInput(f); const receipt = authorize(f, input);
  const protectedTask = importAttested(f.store, input, "test", receipt.event_id);
  expect(protectedTask.body.partition).toBe("protected"); expect(protectedTask.body.stakes).toBe(input.stakes);
  expect(protectedTask.body.review).toEqual(input.review);
  expect(() => f.store.define({ operation_id: "tutor-attempt-delivery", kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: protectedTask.revision_id, goal_revision_id: f.goal.revision_id, purpose: "practice", conditions: [] } }, "pi", "test")).toThrow("explicit assessment control");
  expect(deliverProtectedAssessment(f.store, protectedTask.revision_id, "test").body.purpose).toBe("exam");
});

test("foreign, changed-content and hypothetical attestations cannot authorize a protected import", () => {
  const f = fixture(); const input = attestedInput(f);
  const foreign = authorize(f, input, "expert", "foreign");
  const valid = authorize(f, input);
  const hypothetical = f.store.append("decision", { action: "assessment_import_authorized", goal_revision_id: f.goal.revision_id, task_hash: hash(canonical(input)), reason: "Hypothetical reviewer", evidence_event_ids: [] }, randomUUID(), "expert", "test", f.store.now(), undefined, "hypothetical");
  const before = f.store.throughSeq;
  expect(() => importAttested(f.store, input, "test", foreign.event_id)).toThrow("attestation");
  expect(() => importAttested(f.store, { ...input, prompt: "Changed unauthorized item" }, "test", valid.event_id)).toThrow("attestation");
  expect(() => importAttested(f.store, input, "test", hypothetical.event_id)).toThrow("attestation");
  expect(f.store.throughSeq).toBe(before);
});
