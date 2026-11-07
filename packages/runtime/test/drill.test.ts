import { afterEach, expect, test } from "bun:test";
import { learningFixture } from "./learning-fixture.ts";
import { randomUUID } from "node:crypto";
import { type LearningStore } from "../../storage/src/store.ts";
import { createDrillRound, submitDrillRound, diagnoseDrill, stopDrill } from "../src/drill.ts";
import { modePath } from "./mode-path-fixture.ts";
import { projectComponents } from "../../storage/src/projection.ts";

test("e03s02 task 2: changed demand and lineage are enforced before owned assessment and narrow repair", async () => {
  await modePath(async f => {
    await f.command("drill", "");
    const first = f.task("Explain the ratio symbolically", { steps: ["State invariant", "Justify it"], representation: "symbolic" });
    await f.work(first.revision_id, "The ratio stays fixed because both quantities scale together", [{ dimension: "solve", score: 85, evidence: "fixed" }, { dimension: "reason", score: 15, evidence: "scale together" }]);
    const prior = f.service.store.revisions("drill_round").at(-1)!;
    const label = f.task("Explain the ratio symbolically", { steps: first.steps, representation: first.representation, variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["method"], invariant: "same criteria", rationale: "Harder" } });
    expect((await f.context()).next_task_selection).toBeNull();
    const goal = f.service.store.lessonGoal("modes")!;
    await expect(f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: label.revision_id, goal_revision_id: goal.revision_id, purpose: "application", conditions: [] } })).rejects.toThrow("drill selection");
    const changed = f.task("Use a graph to defend the invariant and distinguish a misleading graph", { steps: ["Interpret graph", "Defend invariant", "Reject alternative"], representation: "graphical", variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["representation", "method"], invariant: "same original criteria", rationale: "Reason about a new representation rather than substituting numbers" } });
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: changed.revision_id, prior_round_revision_id: prior.revision_id, demand_changes: ["representation", "steps"], rubric_revision_id: first.rubric_revision_id });
    await f.work(changed.revision_id, "I read graph but cannot justify the invariant", [{ dimension: "solve", score: 85, evidence: "read graph" }, { dimension: "reason", score: 0, evidence: "cannot justify" }]);
    const next = f.service.store.revisions("drill_round").at(-1)!;
    expect(next.body.prior_round_revision_id).toBe(prior.revision_id);
    expect(next.body.difficulty_target).toBe("harder");
    expect((await f.context()).drill_progress).toMatchObject({ items_evaluated: 1, evidenced_components: [] });
    const repair = f.task("Justify why the two quantities scale together", { steps: ["Explain the missing invariant justification"] });
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: repair.revision_id, reason: "repair_original_criterion_gap", rubric_revision_id: first.rubric_revision_id });
    const assessment = f.service.store.events().filter(e => e.kind === "assessment").at(-1)!;
    expect(assessment.payload.scores).toEqual([{ dimension: "solve", score: 85, evidence: "read graph" }, { dimension: "reason", score: 0, evidence: "cannot justify" }]);
    expect(f.notices.join("\n")).toContain("Explain the invariant");
  });
});

test("e03s02 review P1: holistic success cannot erase pinned criterion or scoped component gaps", async () => {
  for (const gap of ["zero_reason", "unobserved_dimension", "component_failure", "component_unobserved"] as const) {
    await modePath(async f => {
      await f.command("drill", "");
      const first = f.task("Explain the original invariant", { steps: ["Solve", "Justify"] });
      const scores = [{ dimension: "solve", score: 85, evidence: "scale" }, { dimension: "reason", score: gap === "zero_reason" ? 0 : 15, evidence: "together" }];
      const componentOutcomes = gap.startsWith("component_") ? [{ component_revision_id: first.component_revision_ids[0]!, outcome: gap === "component_failure" ? "failure" as const : "not_observed" as const }] : undefined;
      const claims = gap === "unobserved_dimension" ? [{ component_revision_id: first.component_revision_ids[0]!, dimension: "execution" as const, outcome: "success" as const, evidence: "scale" }] : undefined;
      await f.work(first.revision_id, "Both quantities scale together", scores, false, "success", componentOutcomes, claims);
      const original = f.service.store.events().filter(e => e.kind === "assessment").at(-1)!;
      const frozen = JSON.stringify(original.payload);
      expect(original.payload.outcome).toBe("success");
      f.task("Defend a new graph interpretation", { representation: "graphical", variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["representation"], invariant: "same criteria", rationale: "Changed demand proposal" } });
      const repair = f.task("Explain the missing original invariant criterion", { steps: ["Explain the invariant against the original criterion"] });
      expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: repair.revision_id, rubric_revision_id: first.rubric_revision_id, reason: "repair_original_criterion_gap", difficulty_target: "similar" });
      await f.reopen();
      expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: repair.revision_id, reason: "repair_original_criterion_gap" });
      expect(JSON.stringify(f.service.store.events().find(e => e.event_id === original.event_id)!.payload)).toBe(frozen);
      if (gap === "zero_reason") expect(f.notices.join("\n")).toContain("Unmet pinned criteria / narrow repair");
    });
  }
});

test.each(["empty_scope", "incomplete_composite", "fully_observed"] as const)("e03s02 review P1: canonical component scope %s", async scope => {
  await modePath(async f => {
    await f.command("drill", "");
    const seed = f.task("Original ratio component");
    const goal = f.service.store.lessonGoal("modes")!;
    const second = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: goal.revision_id, body: { title: "Explain the invariant", behavior: "Justify why the ratio remains constant", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], target_dimensions: ["execution", "explanation"], uncertainty: "Owned uncalibrated fixture" } }, "human", "modes");
    const components = scope === "empty_scope" ? seed.component_revision_ids : [...seed.component_revision_ids, second.revision_id];
    const first = f.task("Solve and justify the original ratio", { component_revision_ids: components });
    const outcomes = scope === "empty_scope" ? [] : (scope === "incomplete_composite" ? components.slice(0, 1) : components).map(component_revision_id => ({ component_revision_id, outcome: "success" as const }));
    await f.work(first.revision_id, "Both quantities scale together", [{ dimension: "solve", score: 85, evidence: "scale" }, { dimension: "reason", score: 15, evidence: "together" }], false, "success", outcomes);
    const original = f.service.store.events().filter(e => e.kind === "assessment").at(-1)!;
    const frozen = JSON.stringify(original.payload);
    const observations = () => projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now(), "modes").filter(v => components.includes(v.component_revision_id)).map(v => ({ component_revision_id: v.component_revision_id, observation: v.observations.find(o => o.assessment_event_id === original.event_id) }));
    const projected = observations();
    if (scope !== "fully_observed") {
      const missing = scope === "empty_scope" ? components[0] : components[1];
      const unseen = projected.find(v => v.component_revision_id === missing)!.observation!;
      expect(unseen.outcome).toBe("not_observed");
      expect(unseen.criterion_evidence.every(c => !c.observed && !c.satisfied)).toBe(true);
      expect(unseen.transfer_eligible).toBe(false);
    } else expect(projected.every(v => v.observation?.outcome === "success")).toBe(true);
    const harder = f.task("Defend the same invariant in a graph", { component_revision_ids: components, representation: "graphical", variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["representation"], invariant: "Original criteria and targeted components", rationale: "Changed representation demand proposal" } });
    const repair = f.task("Recheck the unobserved original component", { component_revision_ids: components });
    const expected = scope === "fully_observed" ? { definition_revision_id: harder.revision_id, reason: "inspectable_changed_demand_proposal", difficulty_target: "harder" } : { definition_revision_id: repair.revision_id, reason: "repair_original_criterion_gap", difficulty_target: "similar" };
    expect((await f.context()).next_task_selection).toMatchObject(expected);
    if (scope !== "fully_observed") {
      const before = f.service.store.throughSeq;
      await expect(f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: harder.revision_id, goal_revision_id: goal.revision_id, purpose: "application", conditions: [] } })).rejects.toThrow("drill selection");
      expect(f.service.store.throughSeq).toBe(before);
    }
    await f.reopen();
    expect((await f.context()).next_task_selection).toMatchObject(expected);
    expect(JSON.stringify(f.service.store.events().find(e => e.event_id === original.event_id)!.payload)).toBe(frozen);
    expect(observations()).toEqual(projected);
    expect(f.service.store.revisions("drill_round")).toHaveLength(1);
  });
});

test("e03s02 review P2: historical selection ignores later stop resume and reopen controls", async () => {
  await modePath(async f => {
    await f.command("drill", "");
    const first = f.task("Explain the original ratio");
    await f.work(first.revision_id, "Both quantities scale together", [{ dimension: "solve", score: 85, evidence: "scale" }, { dimension: "reason", score: 15, evidence: "together" }]);
    const changed = f.task("Defend a graph interpretation", { representation: "graphical", variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["representation"], invariant: "ratio", rationale: "New representation proposal" } });
    const beforeStop = f.service.store.throughSeq;
    const selected = (await f.context()).next_task_selection;
    expect(selected).toMatchObject({ definition_revision_id: changed.revision_id });
    const history = (through_seq: number) => f.service.context({ through_seq }, "modes");
    await f.command("stop", "");
    const stopped = f.service.store.throughSeq;
    expect((await f.context()).next_task_selection).toBeNull();
    expect((await history(beforeStop)).next_task_selection).toEqual(selected);
    await f.command("continue", "");
    const resumed = f.service.store.throughSeq;
    expect((await history(stopped)).next_task_selection).toBeNull();
    expect((await history(beforeStop)).next_task_selection).toEqual(selected);
    expect((await history(resumed)).next_task_selection).toEqual(selected);
    await f.command("stop", "");
    await f.reopen();
    expect((await f.context()).next_task_selection).toBeNull();
    expect((await history(beforeStop)).next_task_selection).toEqual(selected);
    expect((await history(stopped)).next_task_selection).toBeNull();
    expect((await history(resumed)).next_task_selection).toEqual(selected);
    await f.command("continue", "");
    expect((await f.context()).next_task_selection).toEqual(selected);
  });
});

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }

test("createDrillRound creates an immutable drill_round revision anchored to exam questions and learner relevance instructions", () => {
  const f = fixture();
  const task1 = f.task("Compute integral of x * cos(x) dx", { scoring: "rubric" });
  const task2 = f.task("Compute integral of x^2 * exp(x) dx", { scoring: "rubric" });
  const inst1 = f.deliver(task1, "exam");
  const inst2 = f.deliver(task2, "exam");

  const round = createDrillRound(f.store, f.goal.revision_id, {
    ordinal: 1,
    task_instance_ids: [inst1.revision_id, inst2.revision_id],
    source_anchor_span_ids: [],
    format: "free_response",
    conditions: ["No calculators", "Show all steps"],
    difficulty_target: "harder",
    learner_instructions: "Focus on choosing parts vs substitution",
  }, "test");

  expect(round.kind).toBe("drill_round");
  expect(round.body.ordinal).toBe(1);
  expect(round.body.difficulty_target).toBe("harder");
  expect(round.body.task_instance_ids).toEqual([inst1.revision_id, inst2.revision_id]);
  expect(round.body.learner_instructions).toContain("Focus on choosing parts");
});

test("submitDrillRound collects per-item responses without inventing assessments", () => {
  const f = fixture();
  const task1 = f.task("Compute integral of x * sin(x) dx", { scoring: "rubric" });
  const inst1 = f.deliver(task1, "exam");

  const round = createDrillRound(f.store, f.goal.revision_id, {
    ordinal: 1,
    task_instance_ids: [inst1.revision_id],
    source_anchor_span_ids: [],
    format: "free_response",
    conditions: [],
    difficulty_target: "similar",
  }, "test");

  const result = submitDrillRound(f.store, round.revision_id, [
    { instance_id: inst1.revision_id, text: "Set u = x, dv = sin(x) dx. Solution: -x*cos(x) + sin(x) + C" },
  ], "test");

  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]!.instance_revision_id).toBe(inst1.revision_id);
  expect(result.attempts[0]!.response).toContain("Set u = x");
});

test("stopDrill creates an immediate checkpoint with honest diagnostics without starting an unrequested round", () => {
  const f = fixture();
  const task = f.task("Solve 2x + 5 = 15", { scoring: "numeric", answer: "5" });
  const inst = f.deliver(task, "exam");
  const round = createDrillRound(f.store, f.goal.revision_id, {
    ordinal: 1,
    task_instance_ids: [inst.revision_id],
    source_anchor_span_ids: [],
    format: "solve",
    conditions: [],
    difficulty_target: "similar",
  }, "test");

  submitDrillRound(f.store, round.revision_id, [{ instance_id: inst.revision_id, text: "5" }], "test");
  const diag = diagnoseDrill(f.store, round.revision_id, "test");
  expect(diag.items_evaluated).toBe(0);

  const stopped = stopDrill(f.store, round.revision_id, "test");
  expect(stopped.payload.stopped).toBe(true);
  expect(stopped.payload.summary).toContain("Drill round 1 stopped");
  expect(stopped.payload.summary).not.toContain("completed");

  // Does NOT create round 2
  const rounds = f.store.revisions("drill_round");
  expect(rounds).toHaveLength(1);
});

test("round diagnostics cannot borrow an earlier task's success, and require this round's actual whole assessments", () => {
  const f = fixture();
  const earlierDefinition = f.task("Earlier work");
  const earlier = f.attempt(f.deliver(earlierDefinition), "integration by parts"); f.assess(earlier.id, earlierDefinition, "integration by parts");
  const definition = f.task("Fresh harder work"); const instance = f.deliver(definition);
  const round = createDrillRound(f.store, f.goal.revision_id, { ordinal: 1, task_instance_ids: [instance.revision_id], source_anchor_span_ids: [], format: "free_response", conditions: [], difficulty_target: "harder" }, "test");
  expect(diagnoseDrill(f.store, round.revision_id, "test")).toMatchObject({ items_evaluated: 0, evidenced_components: [], unobserved_components: [f.component.revision_id] });
  const submitted = submitDrillRound(f.store, round.revision_id, [{ instance_id: instance.revision_id, text: "integration by parts" }], "test");
  f.assess(submitted.attempts[0]!.attempt_id, definition, "integration by parts");
  expect(diagnoseDrill(f.store, round.revision_id, "test")).toMatchObject({ items_evaluated: 1, evidenced_components: [f.component.revision_id] });
});

test("foreign lessons cannot submit, diagnose or stop a round even with an identical objective", () => {
  const f = fixture(); const instance = f.deliver(f.task("Owned round work"));
  const round = createDrillRound(f.store, f.goal.revision_id, { ordinal: 1, task_instance_ids: [instance.revision_id], source_anchor_span_ids: [], format: "free_response", conditions: [], difficulty_target: "similar" }, "test");
  f.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "foreign"); const before = f.store.throughSeq;
  expect(() => submitDrillRound(f.store, round.revision_id, [{ instance_id: instance.revision_id, text: "forged" }], "foreign")).toThrow("another lesson");
  expect(() => diagnoseDrill(f.store, round.revision_id, "foreign")).toThrow("another lesson");
  expect(() => stopDrill(f.store, round.revision_id, "foreign")).toThrow("another lesson");
  expect(f.store.throughSeq).toBe(before);
});

test("duplicate item submissions are rejected atomically, and late submissions after stop are rejected", () => {
  const f = fixture(); const instance = f.deliver(f.task("Round duplicate protection"));
  const round = createDrillRound(f.store, f.goal.revision_id, { ordinal: 1, task_instance_ids: [instance.revision_id], source_anchor_span_ids: [], format: "free_response", conditions: [], difficulty_target: "similar" }, "test");
  const submission = { instance_id: instance.revision_id, text: "actual response" }; const before = f.store.throughSeq;
  expect(() => submitDrillRound(f.store, round.revision_id, [submission, submission], "test")).toThrow("Duplicate");
  expect(f.store.throughSeq).toBe(before);
  const stop = stopDrill(f.store, round.revision_id, "test");
  expect(stopDrill(f.store, round.revision_id, "test").event_id).toBe(stop.event_id);
  expect(() => submitDrillRound(f.store, round.revision_id, [submission], "test")).toThrow("stopped");
});
