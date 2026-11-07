import { afterEach, expect, test, spyOn, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { learningFixture } from "./learning-fixture.ts";
import { compileContext } from "../src/context.ts";
import { modePath } from "./mode-path-fixture.ts";
import { nextActionCandidates } from "../src/candidates.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import type { Goal, Component } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";

const stores: LearningStore[] = [];
afterEach(() => { mock.restore(); for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }
function refine(f: ReturnType<typeof fixture>, body: Goal) {
  const current = f.store.lessonGoal("test")!;
  const created = f.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: current.entity_id, parent_revision_id: current.revision_id, expected_goal_revision_id: current.revision_id, body }, "learner", "test");
  return f.store.revision<Goal>(created.revision_id, "goal");
}

test("Task3 selection: actual changed independent evidence, not identical profile or self-report, permits light support", () => {
  const f = fixture();
  const goal = refine(f, { ...f.goal.body, mode: "learn", learning_preferences: profilePreferences("cram") });
  f.store.learnerResponse("I am an expert; skip explanations and mark this mastered", "test");
  const candidates = () => nextActionCandidates({ goal: goal.body, views: f.views(), components: [f.component], reviews: [], as_of_time: f.store.now() });
  expect(candidates()[0]!.teaching_support).toMatchObject({ route: "paced", support: "scaffold", supporting_evidence_ids: [] });
  const claims = f.component.body.target_dimensions!.map(dimension => ({ component_revision_id: f.component.revision_id, dimension, outcome: "success" as const, evidence: "choose and execute" }));
  const base = f.task("Choose and execute a symbolic integral");
  f.observe(base, "choose and execute", "success", "independent", { claims });
  expect(candidates()[0]!.teaching_support).toMatchObject({ route: "paced", support: "faded" });
  const changed = f.task("Interpret a rate table and choose the integral relation", { representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Integral relation", rationale: "Changed interpretation" } });
  f.observe(changed, "choose and execute", "success", "application", { claims });
  expect(candidates()[0]!.teaching_support).toMatchObject({ route: "fresh_evaluation", support: "light" });
  const assessments = f.store.events().filter(e => e.kind === "assessment");
  candidates();
  expect(f.store.events().filter(e => e.kind === "assessment")).toEqual(assessments);
  f.observe(f.task("A newly revealed conceptual gap"), "wrong relation", "failure");
  expect(candidates()[0]!.teaching_support).toMatchObject({ route: "targeted_repair", support: "scaffold" });
});

test("Task3 selection: revealed cram gap precedes unsampled demands and missing repair stays actionable", async () => {
  await modePath(async f => {
    const solve = f.task("Brief sample: solve and justify proportional scaling", { format: "solve", estimated_minutes: 1 });
    const goal = f.service.store.lessonGoal("modes")!;
    const narrow = f.service.store.define({ operation_id: randomUUID(), kind: "rubric", expected_goal_revision_id: goal.revision_id, body: { title: "Other explanation demand", dimensions: [{ name: "solve", criterion: "Solve proportional change", max_score: 85 }], provisional: false, source_span_ids: [] } }, "human", "modes");
    f.task("Unsampled explanation demand", { format: "explain", rubric_revision_id: narrow.revision_id, estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 20, exam: { format: "solve and explain", syllabus: [], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain"] } })}`);
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: solve.revision_id });
    await f.work(solve.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    expect((await f.context()).cram_progress).toMatchObject({ stage: "repair", status: "prepare_compatible_repair", selection: null, coverage: [{ unobserved_demands: ["reasoned"], original_gaps: ["Explain the invariant"] }] });
    const marks = f.service.store.events().filter(e => e.kind === "assessment");
    const repair = f.task("Small explanation and changed proportional practice", { format: "solve", estimated_minutes: 1 });
    expect((await f.context()).cram_progress).toMatchObject({ stage: "repair", status: "ready", selection: { definition_revision_id: repair.revision_id, teaching_support: { route: "targeted_repair", support: "scaffold" } }, coverage: [{ unobserved_demands: ["reasoned"] }] });
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toEqual(marks);
  });
});

test("cram is deadline and task-demand aware without becoming a compulsory flashcard or planner protocol", () => {
  const f = fixture();
  refine(f, { ...f.goal.body, mode: "cram" as Goal["mode"], deadline: "2026-10-01T12:30:00.000Z", budget_minutes: 20, target_format: "oral defense", allowed_aids: ["outline cards"], learning_preferences: profilePreferences("cram") });
  const before = f.store.throughSeq;
  const policy = compileContext(f.store, {}, "", "test").practice_policy;
  expect(policy).toMatchObject({ regime: "cram", profile: "cram", minutes_to_deadline: 30, budget_minutes: 20, feasible_session_minutes: 20, target_format: "oral defense", allowed_aids: ["outline cards"], task_demand: "reasoned_production", learner_can_continue: true, confidence: "engineering_policy_not_calibrated" });
  expect(f.store.throughSeq).toBe(before);
  expect(JSON.stringify(policy)).not.toMatch(/"mandatory_flashcards":true|"optimal_interval_minutes":|"guaranteed_score":/);
});

test("missing and passed deadlines remain explicit unknowns or limits, never invented timing or forced stops", () => {
  const f = fixture(); const { deadline: _deadline, ...body } = f.goal.body;
  refine(f, { ...body, mode: "cram" as Goal["mode"], learning_preferences: profilePreferences("cram") });
  expect(compileContext(f.store, {}, "", "test").practice_policy).toMatchObject({ minutes_to_deadline: null, spacing_window: "unspecified", reason_codes: ["deadline_unknown", "preserve_exam_task_demand", "target_observed_recoverable_gaps"] });
  refine(f, { ...body, mode: "cram" as Goal["mode"], deadline: "2026-10-01T11:55:00.000Z", learning_preferences: profilePreferences("cram") });
  expect(compileContext(f.store, {}, "", "test").practice_policy).toMatchObject({ minutes_to_deadline: 0, feasible_session_minutes: 0, spacing_window: "deadline_passed", learner_can_continue: true });
});

test("accelerate cannot prioritize compression from one familiar success", () => {
  const f = fixture(); const goal = refine(f, { ...f.goal.body, mode: "accelerate", learning_preferences: profilePreferences("balanced") });
  f.observe(f.task("Familiar integration"), "parts", "success");
  const candidates = nextActionCandidates({ goal: goal.body, views: f.views(), components: [f.component], reviews: [], as_of_time: f.store.now() });
  expect(candidates[0]!.type).not.toBe("advance");
  expect(compileContext(f.store, {}, "", "test").practice_policy).toMatchObject({ regime: "accelerate", compression_eligible_component_ids: [], compression_requires: "independent_changed_task_and_target_dimensions" });
});

test("compression is earned by changed independent work and target dimensions, independent of the cram preference", () => {
  const f = fixture(); const goal = refine(f, { ...f.goal.body, mode: "accelerate", learning_preferences: profilePreferences("cram") });
  const claims = [{ component_revision_id: f.component.revision_id, dimension: "discrimination" as const, outcome: "success" as const, evidence: "choose parts" }, { component_revision_id: f.component.revision_id, dimension: "execution" as const, outcome: "success" as const, evidence: "execute correctly" }];
  const base = f.task("Symbolic integration baseline"); f.observe(base, "choose parts; execute correctly", "success", "independent", { claims });
  const changed = f.task("Interpret a table of rates then apply the integral relation", { representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Integral relation", rationale: "Interpret rather than substitute numbers" } });
  f.observe(changed, "choose parts; execute correctly", "success", "application", { claims });
  expect(compileContext(f.store, {}, "", "test").practice_policy).toMatchObject({ regime: "accelerate", profile: "cram", compression_eligible_component_ids: [f.component.revision_id] });
  const candidates = nextActionCandidates({ goal: goal.body, views: f.views(), components: [f.component], reviews: [], as_of_time: f.store.now() });
  expect(candidates[0]!.type).toBe("advance");
  expect(candidates[0]!.reason_codes).toContain("evidenced_compression_not_assumed_ability");
});

test("e03s01 task 2: registered mode control selects distinct priorities and preserves owned work with profile independent", async () => {
  await modePath(async f => {
    await f.command("mode", 'learn {"exam":{"format":"solve","syllabus":["Proportional change"],"topic_weights":[],"grading_criteria":["Solve","Explain the invariant"]}}');
    const initial = f.service.store.lessonGoal("modes")!;
    const task = f.task("A quantity doubles: solve and explain the invariant");
    await f.work(task.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    expect(f.notices.join("\n")).toContain("85/100");
    expect(f.notices.join("\n")).toContain("Unobserved criteria: reason");
    const work = f.service.store.events().filter(e => ["task_delivered", "learner_response", "attempt_submitted", "assessment"].includes(e.kind));
    const priorities: string[] = [];
    for (const mode of ["learn", "exam", "cram"]) {
      await f.command("mode", mode);
      const packet = await f.context();
      const policy = packet.practice_policy as { regime: string; profile: string };
      expect(policy.regime).toBe(mode); expect(policy.profile).toBe("balanced");
      priorities.push((packet.next_action_candidates as Array<{ type: string }>)[0]!.type);
      expect(f.service.store.lessonGoal("modes")!.body.provider_sharing).toBe(initial.body.provider_sharing);
    }
    expect(new Set(priorities).size).toBe(3);
    for (const mode of ["learn", "exam", "cram"]) {
      await f.command("mode", mode);
      const fresh = f.task(`Fresh ${mode}: solve a changed ratio and justify its invariant`, { format: "solve" });
      const selection = (await f.context()).next_task_selection as { definition_revision_id: string; allowed_aids: string[] };
      expect(selection.definition_revision_id).toBe(fresh.revision_id);
      expect(selection.allowed_aids).toEqual([]);
      await f.work(selection.definition_revision_id, `${mode}: 20`, [{ dimension: "solve", score: 85, evidence: `${mode}: 20` }]);
      expect(f.notices.at(-1)).toContain("85/100");
    }
    f.task("Final fresh exam-format recheck", { format: "solve" });
    const selected = (await f.context()).next_task_selection;
    const before = (await f.context()).next_action_candidates;
    const goal = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, learning_preferences: profilePreferences("thorough") } }, "learner", "modes");
    expect((await f.context()).next_action_candidates).toEqual(before);
    expect((await f.context()).next_task_selection).toEqual(selected);
    expect(f.service.store.events().filter(e => work.some(w => w.event_id === e.event_id))).toEqual(work);
  });
});

test("e03s01 task 2: native mode declarations preserve unanswered frozen work and reject invented control fields/windows", async () => {
  await modePath(async f => {
    const task = f.task("Unanswered original ratio problem");
    const goal = f.service.store.lessonGoal("modes")!;
    const state = (await f.context()).learning_state as { state_revision: string };
    const instance = f.service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision }, "modes");
    const before = (await f.context()).learning_state as { current_task: unknown };
    const start = new Date(Date.now() + 60000).toISOString(), end = new Date(Date.now() + 11 * 60000).toISOString();
    await f.command("mode", `cram ${JSON.stringify({ study_windows: [{ start, end }], allowed_aids: ["outline"] })}`);
    expect((await f.context()).learning_state).toMatchObject({ phase: "awaiting_answer", pending_count: 1, current_task: before.current_task });
    expect((await f.context()).next_task_selection).toBeNull();
    expect(f.service.store.revision<{ allowed_aids: string[] }>(task.revision_id, "task_definition").body.allowed_aids).toEqual([]);
    expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    const stable = f.service.store.throughSeq;
    await f.command("mode", 'learn {"provider_sharing":false}');
    await f.command("mode", `learn ${JSON.stringify({ study_windows: [{ start: end, end: start }] })}`);
    expect(f.service.store.throughSeq).toBe(stable);
    expect(f.service.store.lessonGoal("modes")!.body.mode).toBe("cram");
    expect(instance).toBeDefined();
  });
});

test("e03s01 task 2: persisted cram progresses from mixed diagnostic through requested refresh, intervening work, original-gap recheck and fresh mini-set", async () => {
  await modePath(async f => {
    const solve = f.task("Diagnostic: predict an amount after proportional doubling and justify the invariant", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 40, exam: { format: "solve and explain", syllabus: ["Ratios", "Unit reasoning"], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain the invariant"] } })}`);
    const explain = f.task("Diagnostic: explain why unit scaling preserves proportionality", { format: "explain", estimated_minutes: 1 }, true);
    const progress = async () => (await f.context()).cram_progress as { stage: string; status: string; selection: { definition_revision_id: string } | null; coverage: Array<{ original_gaps: string[]; unobserved_demands: string[] }> };
    expect(await progress()).toMatchObject({ stage: "diagnostic", status: "ready" });
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(solve.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const original = f.service.store.events().filter(e => ["assessment", "attempt_submitted", "learner_response"].includes(e.kind));
    // Task3: the available explanation now repairs the revealed gap, not a compulsory second diagnostic.
    expect(await progress()).toMatchObject({ stage: "repair", selection: { definition_revision_id: explain.revision_id }, coverage: [{ unobserved_demands: ["reasoned"] }] });
    await f.work(explain.revision_id, "10 because the invariant ratio survives unit scaling", full("10 because the invariant ratio survives unit scaling"));
    const repair = f.task("Retrieve the proportional invariant and apply it to a new unit relation", { format: "solve", estimated_minutes: 1, refresher: "A proportional relation preserves the ratio when units are changed consistently. Check the relation, not only the final number." }, true);
    expect(await progress()).toMatchObject({ stage: "intervening", selection: { definition_revision_id: repair.revision_id } });
    const goal = f.service.store.lessonGoal("modes")!;
    await f.tool("learning_activity", { action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: goal.revision_id, unit_id: randomUUID(), component_revision_id: repair.component_revision_ids[0], instruction_revision_id: repair.artifact_revision_ids![0], definition_revision_id: repair.revision_id });
    await f.command("refresh", "");
    expect(f.notices.join("\n")).toContain("A proportional relation preserves the ratio");
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(2);
    await f.work(repair.revision_id, "12 because the invariant ratio survives unit scaling", full("12 because the invariant ratio survives unit scaling"));
    expect(await progress()).toMatchObject({ stage: "recheck", selection: null });
    await f.reopen();
    expect(await progress()).toMatchObject({ stage: "recheck", selection: null });
    const recheck = f.task("Interpret an unfamiliar rate table under changed units; infer its missing value and justify proportionality", { format: "solve", representation: "table", estimated_minutes: 1, variation: { baseline_definition_revision_id: solve.revision_id, dimensions: ["representation", "context"], invariant: "Proportional ratio", rationale: "Interpret changed units and a table rather than reuse a numeric answer" } });
    expect(await progress()).toMatchObject({ stage: "recheck", selection: { definition_revision_id: recheck.revision_id } });
    await f.work(recheck.revision_id, "14 because the invariant ratio survives the table's unit transformation", full("14 because the invariant ratio survives the table's unit transformation"));
    const miniSolve = f.task("Mini-set: predict a missing quantity when the unit scale halves and justify the relation", { format: "solve", estimated_minutes: 1 });
    expect(await progress()).toMatchObject({ stage: "mini_set", selection: { definition_revision_id: miniSolve.revision_id } });
    await f.work(miniSolve.revision_id, "16 because consistent scaling preserves the ratio", full("16 because consistent scaling preserves the ratio"));
    const miniExplain = f.task("Mini-set: explain the proportional invariant and contrast a nonproportional counterexample", { format: "explain", estimated_minutes: 1 });
    await f.work(miniExplain.revision_id, "A nonconstant ratio violates the invariant", full("A nonconstant ratio violates the invariant"));
    expect(await progress()).toMatchObject({ stage: "report", status: "coverage_report", coverage: [{ original_gaps: [], unobserved_demands: [] }] });
    expect(f.notices.join("\n")).toContain("85/100");
    expect(f.service.store.events().filter(e => original.some(o => o.event_id === e.event_id))).toEqual(original);
    await f.reopen(); expect(await progress()).toMatchObject({ stage: "report", status: "coverage_report" });
  });
});

test("e03s01 task 2: boundary urgency, windows and budget change feasible owned selection without profile or unknown-data inference", async () => {
  await modePath(async f => {
    let at = Date.now() + 1000;
    spyOn(f.service.store, "now").mockImplementation(() => new Date(at).toISOString());
    const baseline = f.task("Baseline proportional evidence", { format: "solve" });
    await f.work(baseline.revision_id, "The ratio is invariant", [{ dimension: "solve", score: 85, evidence: "The ratio is invariant" }, { dimension: "reason", score: 15, evidence: "The ratio is invariant" }]);
    const short = f.task("Bounded proportional calculation", { format: "solve", estimated_minutes: 1 });
    const long = f.task("Extended proportional comparison with several constraints", { format: "solve", estimated_minutes: 3 });
    await f.command("mode", `cram ${JSON.stringify({ deadline: new Date(at + 3 * 86400000).toISOString(), exam: { format: "solve", syllabus: [], topic_weights: [], grading_criteria: ["Solve", "Explain"] } })}`);
    const far = (await f.context()).next_task_selection as { definition_revision_id: string; cram: { allocated_minutes: number } };
    expect(far).toMatchObject({ definition_revision_id: long.revision_id, cram: { allocated_minutes: 3 } });
    await f.command("mode", `cram ${JSON.stringify({ deadline: new Date(at + 3600000).toISOString() })}`);
    const urgent = (await f.context()).next_task_selection;
    expect(urgent).toMatchObject({ definition_revision_id: short.revision_id, cram: { allocated_minutes: 1 } });
    const goal = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, learning_preferences: profilePreferences("thorough") } }, "learner", "modes");
    expect((await f.context()).next_task_selection).toEqual(urgent);
    expect((await f.context()).cram_progress).toMatchObject({ timing: "windows_unknown", coverage: [{ importance: "unknown", observed_demands: [], unobserved_demands: ["solve"] }] });
    await f.command("mode", 'cram {"budget_minutes":1}');
    await f.work(short.revision_id, "The ratio remains invariant", [{ dimension: "solve", score: 85, evidence: "The ratio remains invariant" }, { dimension: "reason", score: 15, evidence: "The ratio remains invariant" }]);
    expect((await f.context()).cram_progress).toMatchObject({ status: "allocation_budget_exhausted", selection: null, allocation_minutes_remaining: 0 });
    const marks = f.service.store.events().filter(e => ["assessment", "attempt_submitted"].includes(e.kind));
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 20, study_windows: [{ start: new Date(at + 60000).toISOString(), end: new Date(at + 300000).toISOString() }] })}`);
    expect((await f.context()).cram_progress).toMatchObject({ status: "await_declared_window", selection: null });
    await expect(f.work(long.revision_id, "Unobserved work", [])).rejects.toThrow("cram selection");
    await f.command("mode", 'cram {"study_windows":[]}');
    expect((await f.context()).cram_progress).toMatchObject({ status: "no_feasible_declared_window", selection: null });
    await f.command("mode", `cram ${JSON.stringify({ study_windows: [{ start: new Date(at - 1000).toISOString(), end: new Date(at + 30000).toISOString() }] })}`);
    expect((await f.context()).cram_progress).toMatchObject({ status: "no_task_fits_declared_allocation", selection: null });
    await f.command("mode", `cram ${JSON.stringify({ deadline: new Date(at - 1).toISOString() })}`);
    expect((await f.context()).cram_progress).toMatchObject({ status: "deadline_passed", selection: null });
    expect(f.service.store.events().filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual(marks);
    expect(JSON.stringify(await f.context())).not.toMatch(/"predicted_score"|"mastery":|"sleep_sacrifice"/);
  });
});

test("e03s01 task 2: boundary separated-window recheck requires actual intervening work and original criterion evidence, not annotations", async () => {
  await modePath(async f => {
    let at = Date.now() + 1000;
    spyOn(f.service.store, "now").mockImplementation(() => new Date(at).toISOString());
    const second = at + 86400000;
    const solve = f.task("Solve 2 proportional relations and justify their invariant", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ deadline: new Date(second + 86400000).toISOString(), budget_minutes: 40, study_windows: [{ start: new Date(at - 1000).toISOString(), end: new Date(at + 600000).toISOString() }, { start: new Date(second).toISOString(), end: new Date(second + 600000).toISOString() }], exam: { format: "solve and explain", syllabus: ["Proportional invariants"], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain"] } })}`);
    const explain = f.task("Explain a proportional unit transformation", { format: "explain", estimated_minutes: 1 }, true);
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(solve.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    await f.work(explain.revision_id, "The ratio is invariant", full("The ratio is invariant"));
    const repair = f.task("Retrieve and explain the original ratio invariant", { format: "solve", estimated_minutes: 1 }, true);
    // Task3: explanation repaired the gap; the subsequent calculation is actual intervening work.
    expect((await f.context()).cram_progress).toMatchObject({ stage: "intervening", selection: { definition_revision_id: repair.revision_id } });
    await f.work(repair.revision_id, "The ratio survives consistent scaling", full("The ratio survives consistent scaling"));
    const cosmetic = f.task("Solve 3 proportional relations and justify their invariant", { format: "solve", estimated_minutes: 1, variation: { baseline_definition_revision_id: solve.revision_id, dimensions: ["context"], invariant: "Ratio", rationale: "Metadata claim alone; only a familiar number changed" } });
    const fresh = f.task("Interpret a rate table with transformed units and justify the missing-value relation", { format: "solve", representation: "table", estimated_minutes: 1, variation: { baseline_definition_revision_id: solve.revision_id, dimensions: ["representation", "context"], invariant: "Ratio", rationale: "Inspect the table and unit transformation, preserving the original explanation criterion" } });
    const before = f.service.store.events().filter(e => e.kind === "assessment");
    expect((await f.context()).cram_progress).toMatchObject({ stage: "recheck", status: "await_separated_recheck_window", selection: null, coverage: [{ original_gaps: ["Explain the invariant"] }] });
    await expect(f.work(fresh.revision_id, "Premature answer", full("Premature answer"))).rejects.toThrow("cram selection");
    at = second + 1000;
    await f.reopen(); spyOn(f.service.store, "now").mockImplementation(() => new Date(at).toISOString());
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: fresh.revision_id });
    expect((await f.context()).next_task_selection).not.toMatchObject({ definition_revision_id: cosmetic.revision_id });
    const goal = f.service.store.lessonGoal("modes")!;
    const instance = await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: fresh.revision_id, goal_revision_id: goal.revision_id, purpose: "application", conditions: ["No answer-bearing help"] } });
    expect((await f.context()).cram_progress).toMatchObject({ stage: "recheck", selection: null, coverage: [{ original_gaps: ["Explain the invariant"] }] });
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toEqual(before);
    const annotation = f.service.store.events().filter(e => e.payload.action === "cram_task_selected").at(-1)!;
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: goal.revision_id, payload: { ...annotation.payload, cram_selection: { ...(annotation.payload.cram_selection as object), stage: "mini_set" } } })).rejects.toThrow("host delivery control");
    expect(instance.revision_id).toBeDefined();
    await f.work(fresh.revision_id, "The transformed table preserves the original ratio invariant", full("The transformed table preserves the original ratio invariant"));
    expect((await f.context()).cram_progress).toMatchObject({ stage: "mini_set", coverage: [{ original_gaps: [] }] });
    expect(f.service.store.events().filter(e => before.some(o => o.event_id === e.event_id))).toEqual(before);
  });
});

test("e03s01 task 2: boundary registered stop skip and continue control workflow but leave frozen work and coverage unobserved", async () => {
  await modePath(async f => {
    const solve = f.task("Unanswered diagnostic calculation", { format: "solve", estimated_minutes: 1 });
    const explain = f.task("Unanswered diagnostic explanation", { format: "explain", estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ exam: { format: "solve and explain", syllabus: [], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "normal" }], grading_criteria: ["Solve", "Explain"] } })}`);
    const deliver = async (id: string) => { const g = f.service.store.lessonGoal("modes")!; return f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: g.revision_id, body: { definition_revision_id: id, goal_revision_id: g.revision_id, purpose: "independent", conditions: ["Frozen no-aids diagnostic"] } }); };
    const first = await deliver(solve.revision_id);
    const frozen = f.service.store.revision(first.revision_id as string, "task_instance");
    await expect(deliver(explain.revision_id)).rejects.toThrow("pending");
    await f.command("stop", "");
    expect((await f.context()).learning_state).toMatchObject({ phase: "stopped", pending_count: 1 });
    expect((await f.context()).next_task_selection).toBeNull();
    await f.command("refresh", "");
    expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual([]);
    await f.command("mode", 'cram {"allowed_aids":["outline"]}');
    expect(f.service.store.revision(first.revision_id as string, "task_instance")).toEqual(frozen);
    expect(f.service.store.revision<{ allowed_aids: string[] }>(solve.revision_id, "task_definition").body.allowed_aids).toEqual([]);
    await f.command("continue", "");
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: explain.revision_id });
    await deliver(explain.revision_id); await f.command("skip", "");
    const miniSolve = f.task("Fresh mini-set application with a different constraint", { format: "solve", estimated_minutes: 1 });
    await deliver(miniSolve.revision_id); await f.command("continue", "");
    const miniExplain = f.task("Fresh mini-set contrast with a counterexample", { format: "explain", estimated_minutes: 1 });
    await deliver(miniExplain.revision_id); await f.command("skip", "");
    expect((await f.context()).cram_progress).toMatchObject({ stage: "report", coverage: [{ observed_demands: [], unobserved_demands: ["solve", "reasoned"] }] });
    expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    expect((await f.context()).next_action_candidates).not.toContainEqual(expect.objectContaining({ type: "advance" }));
    await f.reopen(); expect((await f.context()).cram_progress).toMatchObject({ coverage: [{ observed_demands: [] }] });
  });
});

test("e03s01 task 2: boundary prerequisite repair outranks unrelated owned or foreign components", async () => {
  await modePath(async f => {
    const define = (kind: string, body: unknown) => f.service.store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, body }, "human", "modes");
    const p = define("component", { title: "Unit conversion prerequisite", behavior: "Maintain consistent units", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], target_dimensions: ["execution", "explanation"], uncertainty: "Software fixture" });
    const c = define("component", { title: "Ratio application", behavior: "Apply ratios with consistent units", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [p.revision_id], target_dimensions: ["execution", "explanation"], uncertainty: "Software fixture" });
    const unrelated = define("component", { title: "Unrelated topic", behavior: "Unrelated behavior", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Outside declared exam blueprint" });
    const pre = f.task("Convert inconsistent units before forming the ratio", { format: "solve", component_revision_ids: [p.revision_id], estimated_minutes: 1 });
    const badPre = await f.work(pre.revision_id, "Wrong unit relation", [{ dimension: "solve", score: 0, evidence: "Wrong unit relation" }, { dimension: "reason", score: 0, evidence: "Wrong unit relation" }], false, "failure");
    const target = f.task("Apply a proportional ratio and explain the unit invariant", { format: "solve", component_revision_ids: [c.revision_id], estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ exam: { format: "solve", syllabus: ["Unit-aware ratios"], topic_weights: [{ component_revision_id: c.revision_id, importance: "high" }], grading_criteria: ["Solve", "Explain"] } })}`);
    const badTarget = await f.work(target.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    define("hypothesis", { component_revision_ids: [c.revision_id], prerequisite_component_revision_id: p.revision_id, category: "prerequisite", description: "Observed unit failure may block ratio reasoning", confidence: "medium", supporting_evidence_ids: [badPre.event_id, badTarget.event_id], contradicting_evidence_ids: [], status: "active", first_observed_at: f.service.store.now(), last_observed_at: f.service.store.now() });
    const repair = f.task("Repair consistent-unit conversion before the ratio recheck", { format: "solve", component_revision_ids: [p.revision_id], estimated_minutes: 1 }, true);
    const irrelevant = f.task("An unrelated practice calculation", { format: "solve", component_revision_ids: [unrelated.revision_id], estimated_minutes: 0.5 });
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: repair.revision_id });
    await expect(f.work(irrelevant.revision_id, "Unrelated work", [])).rejects.toThrow("cram selection");
    await f.work(repair.revision_id, "Consistent units preserve the ratio", [{ dimension: "solve", score: 85, evidence: "Consistent units preserve the ratio" }, { dimension: "reason", score: 15, evidence: "Consistent units preserve the ratio" }]);
    expect((await f.context()).cram_progress).toMatchObject({ stage: "intervening", selection: null, status: "prepare_fresh_reviewed_task_for_stage" });
    expect((await f.context()).next_task_selection).toBeNull();
    const foreignGoal = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: { ...f.service.store.lessonGoal("modes")!.body, mode: "learn", objective: "Foreign lesson", source_ids: [] } }, "learner", "foreign");
    const foreignComponent = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: foreignGoal.revision_id, body: { ...(p.body as unknown as Component), title: "Foreign units" } }, "human", "foreign");
    await expect(f.service.context({ component_revision_ids: [foreignComponent.revision_id] }, "modes")).rejects.toThrow("outside this lesson");
    await expect(f.service.context({}, "foreign")).rejects.toThrow("inactive");
    const current = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: current.entity_id, parent_revision_id: current.revision_id, expected_goal_revision_id: current.revision_id, body: { ...current.body, objective: "A different declared lesson", exam: { ...current.body.exam!, topic_weights: [] } } }, "learner", "modes");
    expect((await f.context()).next_task_selection).toBeNull();
    expect((await f.context()).cram_progress).toMatchObject({ coverage: [], status: "blueprint_or_reviewed_tasks_unknown" });
  });
});

test("e03s01 task 2: boundary refresher requires current native authority, frozen exam aids and authorized sources, never work", async () => {
  await modePath(async f => {
    const filename = join(f.service.paths.data, "boundary-owned-source.md");
    await writeFile(filename, "Owned source: proportional relationships require consistent units.");
    const source = await f.service.sources.importFile(filename); await f.command("source", `accept ${source.revision_id}`); await f.command("source", `attach ${source.revision_id}`);
    const span = f.service.store.db.query<{ span_id: string }, [string]>("SELECT span_id FROM source_span WHERE source_revision_id=? LIMIT 1").get(source.revision_id)!;
    const task = f.task("Exam calculation with frozen aid conditions", { format: "solve", source_span_ids: [span.span_id], refresher: "PRIVATE_REFRESHER: preserve consistent units before comparing ratios." });
    await f.command("mode", 'exam {"exam":{"format":"solve","syllabus":[],"topic_weights":[],"grading_criteria":["Solve","Explain"]}}');
    const goal = f.service.store.lessonGoal("modes")!;
    const stale = ((await f.context()).learning_state as { state_revision: string }).state_revision;
    const instance = await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: ["No aids"] } });
    await expect(f.service.requestRefresher(stale, instance.revision_id as string, "modes")).rejects.toThrow("stale");
    expect(JSON.stringify(await f.context())).not.toContain("PRIVATE_REFRESHER");
    await f.command("refresh", "");
    expect(f.notices.join("\n")).not.toContain("PRIVATE_REFRESHER");
    await f.command("mode", 'learn {"allowed_aids":["tutor refresher"]}'); await f.command("refresh", "");
    expect(f.notices.join("\n")).not.toContain("PRIVATE_REFRESHER");
    expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual([]);
    await f.command("skip", "");
    const permitted = f.task("Fresh explicitly supported exam practice", { format: "solve", allowed_aids: ["tutor refresher"], source_span_ids: [span.span_id], refresher: "PERMITTED_REFRESHER: consistently transform units before forming a ratio." });
    await f.command("mode", 'exam {"allowed_aids":["tutor refresher"]}');
    const current = f.service.store.lessonGoal("modes")!;
    const second = await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: current.revision_id, body: { definition_revision_id: permitted.revision_id, goal_revision_id: current.revision_id, purpose: "independent", conditions: ["Declared refresher allowed; assisted performance is not independence"] } });
    const state = ((await f.context()).learning_state as { state_revision: string }).state_revision;
    await expect(f.service.requestRefresher(state, instance.revision_id as string, "modes")).rejects.toThrow("stale");
    await expect(f.service.requestRefresher(state, second.revision_id as string, "foreign")).rejects.toThrow("inactive");
    await expect(f.tool("requestRefresher", {})).rejects.toThrow();
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: current.revision_id, payload: { action: "cram_task_selected", reason: "Caller assertion", evidence_event_ids: [] } })).rejects.toThrow("host delivery control");
    await f.command("mode", 'exam {"allowed_aids":[]}');
    await expect(f.service.requestRefresher(state, second.revision_id as string, "modes")).rejects.toThrow("stale");
    await f.command("refresh", "");
    expect(f.notices.join("\n")).not.toContain("PERMITTED_REFRESHER");
    await f.command("mode", 'exam {"allowed_aids":["tutor refresher"]}');
    const before = f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind));
    await f.command("refresh", "");
    expect(f.notices.join("\n")).toContain("PERMITTED_REFRESHER");
    expect(f.service.store.events().filter(e => e.kind === "assistance").map(e => ({ actor: e.actor, stage: e.payload.stage }))).toEqual([{ actor: "learner", stage: "requested" }, { actor: "host", stage: "exposed" }]);
    expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual(before);
    await f.work(permitted.revision_id, "Consistent units preserve the ratio", [{ dimension: "solve", score: 85, evidence: "Consistent units preserve the ratio" }, { dimension: "reason", score: 15, evidence: "Consistent units preserve the ratio" }]);
    expect((await f.context()).components).toContainEqual(expect.objectContaining({ independent_performance: expect.objectContaining({ success: 0 }), supported_performance: expect.objectContaining({ success: 1 }) }));
    expect((await f.context()).next_action_candidates).not.toContainEqual(expect.objectContaining({ type: "advance" }));
    const revocable = f.task("Another explicitly permitted exam task awaiting work", { format: "solve", allowed_aids: ["tutor refresher"], source_span_ids: [span.span_id], refresher: "REVOCABLE_REFRESHER: check the unit relation before calculating." });
    const pendingGoal = f.service.store.lessonGoal("modes")!;
    await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: pendingGoal.revision_id, body: { definition_revision_id: revocable.revision_id, goal_revision_id: pendingGoal.revision_id, purpose: "independent", conditions: ["Current consent and declared aids required"] } });
    const count = f.service.store.events().filter(e => e.kind === "assistance").length;
    const g = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: g.entity_id, parent_revision_id: g.revision_id, expected_goal_revision_id: g.revision_id, body: { ...g.body, provider_sharing: false } }, "learner", "modes");
    await f.command("refresh", ""); expect(f.service.store.events().filter(e => e.kind === "assistance")).toHaveLength(count);
    const denied = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: denied.entity_id, parent_revision_id: denied.revision_id, expected_goal_revision_id: denied.revision_id, body: { ...denied.body, provider_sharing: true, source_ids: [] } }, "learner", "modes");
    await f.command("refresh", ""); expect(f.service.store.events().filter(e => e.kind === "assistance")).toHaveLength(count);
    const omitted = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: omitted.entity_id, parent_revision_id: omitted.revision_id, expected_goal_revision_id: omitted.revision_id, body: { ...omitted.body, source_ids: [source.revision_id] } }, "learner", "modes");
    f.service.sources.remove(source.revision_id);
    await f.command("refresh", ""); expect(f.service.store.events().filter(e => e.kind === "assistance")).toHaveLength(count);
    expect(f.notices.join("\n")).not.toContain("REVOCABLE_REFRESHER");
  });
});

test("e03s01 task 2: boundary frozen cram diagnostic aids cannot be bypassed by switching to learn", async () => {
  await modePath(async f => {
    const task = f.task("A no-aids diagnostic waiting for real work", { format: "solve", estimated_minutes: 1, refresher: "DIAGNOSTIC_SECRET: topic refresh must not silently assist measurement." });
    await f.command("mode", `cram ${JSON.stringify({ exam: { format: "solve", syllabus: [], topic_weights: [{ component_revision_id: task.component_revision_ids[0], importance: "normal" }], grading_criteria: ["Solve", "Explain"] } })}`);
    const goal = f.service.store.lessonGoal("modes")!;
    await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: ["No answer-bearing assistance"] } });
    await f.command("refresh", ""); await f.command("mode", 'learn {"allowed_aids":["tutor refresher"]}'); await f.command("refresh", "");
    expect(f.notices.join("\n")).not.toContain("DIAGNOSTIC_SECRET");
    expect(f.notices.join("\n")).toContain("'tutor refresher'");
    expect(f.service.store.events().filter(e => ["assistance", "learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
  });
});

test("e03s01 task 2: review repair protects every native declaration from model forgery after exhausted owned work", async () => {
  await modePath(async f => {
    const task = f.task("Owned diagnostic within a one-minute allocation", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 1, exam: { format: "solve", syllabus: [], topic_weights: [{ component_revision_id: task.component_revision_ids[0], importance: "normal" }], grading_criteria: ["Solve", "Explain"] } })}`);
    await f.work(task.revision_id, "Consistent scaling preserves the ratio", [{ dimension: "solve", score: 85, evidence: "Consistent scaling preserves the ratio" }, { dimension: "reason", score: 15, evidence: "Consistent scaling preserves the ratio" }]);
    expect((await f.context()).cram_progress).toMatchObject({ status: "allocation_budget_exhausted", selection: null });
    const original = f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind));
    const goal = f.service.store.lessonGoal("modes")!;
    const forgeries = [{ budget_minutes: 40 }, { target_format: "code" }, { allowed_aids: ["tutor refresher"] }, { criteria: ["Only award numeric credit"] }, { mode: "learn" }, { deadline: new Date(Date.now() + 3 * 86400000).toISOString() }, { study_windows: [] }, { exam: { ...goal.body.exam!, format: "code" } }];
    for (const forged of forgeries) {
      const before = f.service.store.throughSeq;
      const request = { operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...forged } };
      await expect(f.tool("learning_define", request)).rejects.toThrow("native learner controls");
      expect(() => f.service.store.define({ ...request, operation_id: randomUUID() }, "pi", "modes")).toThrow("native learner controls");
      expect(f.service.store.throughSeq).toBe(before);
      expect((await f.context()).cram_progress).toMatchObject({ status: "allocation_budget_exhausted", selection: null });
    }
    const unchanged = { operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: goal.body };
    const saved = await f.tool("learning_define", unchanged);
    const now = Date.now();
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 40, target_format: "solve and explain", allowed_aids: ["outline"], criteria: ["Solve proportional change", "Explain the invariant"], deadline: new Date(now + 2 * 86400000).toISOString(), study_windows: [{ start: new Date(now - 1000).toISOString(), end: new Date(now + 1800000).toISOString() }], exam: { ...goal.body.exam!, format: "solve and explain" } })}`);
    const native = f.service.store.lessonGoal("modes")!;
    expect(native.body).toMatchObject({ budget_minutes: 40, target_format: "solve and explain", allowed_aids: ["outline"], criteria: ["Solve proportional change", "Explain the invariant"] });
    const beforeReplay = f.service.store.throughSeq;
    expect(await f.tool("learning_define", unchanged)).toEqual(saved);
    expect(f.service.store.throughSeq).toBe(beforeReplay);
    expect(f.service.store.lessonGoal("modes")).toEqual(native);
    const mini = f.task("Fresh mini-set: compare a differently constrained proportional relation", { format: "solve", allowed_aids: ["outline"], estimated_minutes: 1 });
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: mini.revision_id });
    await f.work(mini.revision_id, "The constrained relation preserves the ratio", [{ dimension: "solve", score: 85, evidence: "The constrained relation preserves the ratio" }, { dimension: "reason", score: 15, evidence: "The constrained relation preserves the ratio" }]);
    expect(f.service.store.events().filter(e => original.some(o => o.event_id === e.event_id))).toEqual(original);
    expect(f.service.store.revision<{ allowed_aids: string[] }>(task.revision_id, "task_definition").body.allowed_aids).toEqual([]);
    await f.reopen(); expect(f.service.store.lessonGoal("modes")!.body.budget_minutes).toBe(40);
  });
});

for (const componentNotObserved of [false, true]) test("e03s01 task 2: review repair retains " + (componentNotObserved ? "component-unobserved recheck criteria" : "swapped recheck gaps"), async () => {
  await modePath(async f => {
    const solve = f.task("Diagnostic: solve a unit-aware proportional relation and explain its invariant", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", `cram ${JSON.stringify({ budget_minutes: 40, exam: { format: "solve and explain", syllabus: ["Proportional relations"], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain"] } })}`);
    const explain = f.task("Diagnostic: explain consistent unit scaling", { format: "explain", estimated_minutes: 1 }, true);
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    await f.work(solve.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const original = f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind));
    await f.work(explain.revision_id, "The ratio remains invariant", full("The ratio remains invariant"));
    const repair = f.task("Repair the missing proportional explanation", { format: "solve", estimated_minutes: 1 }, true);
    // Task3: repair starts after brief sampling; this calculation supplies the required intervening observation.
    expect((await f.context()).cram_progress).toMatchObject({ stage: "intervening", selection: { definition_revision_id: repair.revision_id } });
    await f.work(repair.revision_id, "Consistent units preserve the ratio", full("Consistent units preserve the ratio"));
    const current = f.service.store.lessonGoal("modes")!;
    const other = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: current.revision_id, body: { title: "Other targeted relation", behavior: "Explain another relation", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Software fixture, not calibrated" } }, "human", "modes");
    const recheck = f.task("Interpret a transformed unit table and justify its missing proportional value", { format: "solve", representation: "table", estimated_minutes: 1, component_revision_ids: componentNotObserved ? [...solve.component_revision_ids, other.revision_id] : solve.component_revision_ids, variation: { baseline_definition_revision_id: solve.revision_id, dimensions: ["representation", "context"], invariant: "Ratio relation", rationale: "Changed table/units must still test the original execution and explanation criteria" } });
    const text = componentNotObserved ? "The other relation has consistent units and a constant ratio" : "Reasoning identifies an invariant ratio but does not calculate the missing value";
    const assessment = await f.work(recheck.revision_id, text, componentNotObserved ? full(text) : [{ dimension: "reason", score: 15, evidence: text }], false, undefined, componentNotObserved ? [{ component_revision_id: solve.component_revision_ids[0]!, outcome: "not_observed" }, { component_revision_id: other.revision_id, outcome: "success" }] : undefined);
    expect(assessment.payload).toMatchObject({ marking_summary: { earned: componentNotObserved ? 100 : 15, maximum: 100 } });
    expect(f.notices.join("\n")).toContain(componentNotObserved ? "100/100" : "15/100");
    if (!componentNotObserved) expect(f.notices.join("\n")).toContain("Unobserved criteria: solve");
    const omitted = f.service.store.define({ operation_id: randomUUID(), kind: "rubric", expected_goal_revision_id: current.revision_id, body: { title: "Explanation-only is not execution repair", dimensions: [{ name: "reason", criterion: "Explain the invariant", max_score: 15 }], provisional: false, source_span_ids: [] } }, "human", "modes");
    const decoy = f.task("Explanation-only refresh without execution demand", { format: "solve", rubric_revision_id: omitted.revision_id, estimated_minutes: 0.5 });
    const narrow = f.task("Repair the missing execution while preserving the original explanation criterion", { format: "solve", estimated_minutes: 1 }, true);
    const progress = (await f.context()).cram_progress as { stage: string; coverage: Array<{ original_gaps: string[] }>; selection: { definition_revision_id: string } | null };
    expect(progress.stage).toBe("repair");
    expect(progress.coverage[0]!.original_gaps).toContain("Solve proportional change");
    expect(progress.coverage[0]!.original_gaps).toContain("Explain the invariant");
    expect(progress.selection).toMatchObject({ definition_revision_id: narrow.revision_id });
    await expect(f.work(decoy.revision_id, "Explanation cannot establish missing execution", [{ dimension: "reason", score: 15, evidence: "Explanation cannot establish missing execution" }])).rejects.toThrow("cram selection");
    await f.reopen();
    expect((await f.context()).cram_progress).toMatchObject({ stage: "repair", selection: { definition_revision_id: narrow.revision_id } });
    expect(f.service.store.events().filter(e => original.some(o => o.event_id === e.event_id))).toEqual(original);
    expect(f.service.store.event(assessment.event_id as string, "assessment").payload).toEqual(assessment.payload as Record<string, unknown>);
  });
});

test("the core tutor policy is compact, current and delegates optional detail to reachable skills", async () => {
  const policy = await readFile(new URL("../../../resources/prompts/tutor-policy.md", import.meta.url), "utf8");
  expect(policy.length).toBeLessThan(9000);
  for (const name of ["learning_context", "learning_define", "learning_record", "learning_source", "learning_activity", "learning_skill", "render_ui"]) expect(policy).toContain(name);
  expect(policy).not.toContain("No /accelerate or /drill modes are installed");
  expect(policy).not.toContain("learn artifact export");
  expect(policy).toContain("marking_summary");
  expect(policy).toContain("/skip");
});
