import { afterEach, expect, test } from "bun:test";
import type { Assessment, Goal, Revision, TaskDefinition } from "../../core/src/contracts.ts";
import { learningFixture } from "./learning-fixture.ts";
import { practicePolicy } from "../src/practice-policy.ts";
import { projectLearningState, type LearningState } from "../src/learning-state.ts";
import { modePath } from "./mode-path-fixture.ts";
import { randomUUID } from "node:crypto";
import { projectTeachingState } from "../src/teaching.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { compileContext } from "../src/context.ts";

const stores: ReturnType<typeof learningFixture>["store"][] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const work = "Parts gives x*exp(x)-exp(x)+C. Differentiation recovers x*exp(x). Substitution leaves the product; reducing the polynomial explains the method choice.";
function fixture() {
  const f = learningFixture(); stores.push(f.store);
  const goal = f.define("goal", { ...f.goal.body, mode: "learn" }, f.goal) as unknown as Revision<Goal>;
  const claims = (evidence = work): NonNullable<Assessment["claims"]> => ["execution", "explanation", "discrimination"].map(dimension => ({ component_revision_id: f.component.revision_id, dimension: dimension as "execution" | "explanation" | "discrimination", outcome: "success", evidence }));
  const policy = (changes: Partial<Goal> = {}) => practicePolicy({ ...goal.body, ...changes }, f.views(), [f.component], f.store.now());
  return { ...f, goal, policy, claims };
}
function variedSuccesses(f: ReturnType<typeof fixture>) {
  const baseline = f.task("Integrate x exp(x), explain the invariant, and rule out an unsuitable method.");
  f.observe(baseline, work, "success", "independent", { claims: f.claims() });
  const contrast = f.task("A learner proposes substitution for a polynomial-exponential product. Diagnose its limitation and defend a better method.", { format: "explain" });
  f.observe(contrast, work, "success", "independent", { claims: f.claims() });
  const changed = f.task("Choose and justify a method for the logarithmic integral. Explain why a previously useful substitution fails.", {
    variation: { baseline_definition_revision_id: baseline.revision_id, dimensions: ["method", "structure"], invariant: "Preserve the integration-by-parts relationship", rationale: "A different integrand requires a new method-selection explanation" },
  });
  f.observe(changed, work, "success", "application", { claims: f.claims() });
  expect(f.state().transfer_evidence.success).toBe(1);
  return { baseline, contrast, changed };
}

function expectReadiness(f: ReturnType<typeof fixture>, expected: Record<string, unknown>) {
  expect(f.policy()).toMatchObject({ learn_progression: [{ component_revision_id: f.component.revision_id, epistemic_status: "conditional_engineering_gate_not_mastery", ...expected }], time_pressure: "informational_not_advancement" });
}

test("learn progression does not turn an easy single success into readiness", () => {
  const f = fixture();
  f.observe(f.task("Give the result."), "A short correct result.");
  expectReadiness(f, { ready: false, independent_definition_count: 1, unmet_requirements: expect.arrayContaining(["independent_repetition", "conceptual_explanation", "method_discrimination", "changed_application"]) });
});

test("learn progression counts independent definitions, not repeated instances or steps", () => {
  const f = fixture(), task = f.task("Explain and execute this same frozen task.");
  for (let n = 0; n < 3; n++) f.observe(task, work, "success", "independent", { claims: f.claims() });
  expectReadiness(f, { ready: false, independent_definition_count: 1, unmet_requirements: expect.arrayContaining(["independent_repetition", "changed_application"]) });
});

test("learn progression does not count assisted correct work as independent coverage", () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) {
    const task = f.task(`Explain the method in supported question ${n}.`), instance = f.deliver(task);
    f.record("assistance", { assistance_id: `help-${n}`, instance_revision_id: instance.revision_id, component_revision_ids: [f.component.revision_id], stage: "exposed", kind: "hint", content: "Use integration by parts.", answer_bearing: true });
    const attempt = f.attempt(instance, work);
    f.assess(attempt.id, task, work, "success", { claims: f.claims() });
  }
  expectReadiness(f, { ready: false, independent_definition_count: 0, unmet_requirements: expect.arrayContaining(["independent_repetition", "latest_independent_recheck"]) });
});

test("learn progression permits a local next step only after varied independent conceptual and application evidence", () => {
  const f = fixture(); variedSuccesses(f);
  expectReadiness(f, { ready: true, independent_definition_count: 3, unmet_requirements: [] });
  expect(f.state().retention_evidence.success).toBe(0);
});

test("learn progression preserves missing conceptual evidence despite several high marks", () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.observe(f.task(`Compute familiar numerical example ${n}.`), "Correct numerical result.");
  expectReadiness(f, { ready: false, independent_definition_count: 3, unmet_requirements: expect.arrayContaining(["conceptual_explanation", "method_discrimination", "changed_application"]) });
});

test("learn progression requires a fresh original-criterion recheck after a new failure", () => {
  const f = fixture(); variedSuccesses(f);
  f.observe(f.task("Check a boundary case of the same concept."), "I changed only one side.", "failure");
  expectReadiness(f, { ready: false, unmet_requirements: expect.arrayContaining(["latest_independent_recheck", "original_criteria"]) });
});

test("learn progression cannot weaken the original criteria to force a passing gate", () => {
  const f = fixture(); variedSuccesses(f);
  const easier = f.define("rubric", { title: "A weaker replacement", dimensions: [{ name: "target", criterion: "Repeat a provided result", max_score: 2 }], provisional: true, source_span_ids: [] });
  const task = f.task("Repeat a result instead of demonstrating the original objective.", { rubric_revision_id: easier.revision_id } as Partial<TaskDefinition>);
  f.observe(task, work, "success", "independent", { claims: f.claims() });
  expectReadiness(f, { ready: false, unmet_requirements: expect.arrayContaining(["original_criteria"]) });
});

test("learn progression is not shortened by a small budget or an elapsed deadline", () => {
  const f = fixture(); f.observe(f.task("One familiar calculation."), "Correct result.");
  const expected = { ready: false, independent_definition_count: 1, unmet_requirements: expect.arrayContaining(["independent_repetition"]) };
  for (const budget_minutes of [1, 120]) expect(f.policy({ budget_minutes, deadline: "2026-09-30T12:00:00.000Z" })).toMatchObject({ time_pressure: "informational_not_advancement", learn_progression: [{ component_revision_id: f.component.revision_id, ...expected }] });
});

test("learn progression does not use guided practice-purpose checks as independent repetitions", () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.observe(f.task(`Guided practice check ${n}.`), work, "success", "practice", { claims: f.claims() });
  expect(f.state().independent_performance.success).toBe(3); // Preserve the original projection; the workflow has stricter eligibility.
  expectReadiness(f, { ready: false, independent_definition_count: 0, unmet_requirements: expect.arrayContaining(["independent_repetition"]) });
});

test("host learn flow supplies one initial authoring step without modifying the evidence ledger", () => {
  const f = fixture(), before = f.store.throughSeq;
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { controller: "host", policy_version: "learn-flow-1", action: "draft_instruction", step_id: expect.any(String), allowed_define_kinds: ["learn_step"], allowed_record_kinds: [] } });
  expect(f.store.throughSeq).toBe(before);
});

test("host learn flow requires native collection before permitting a frozen-response assessment", () => {
  const f = fixture(), task = f.task("Explain the invariant and apply it without a hint."), instance = f.deliver(task);
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "collect_response", required_tool: "learning_activity", allowed_define_kinds: [], allowed_record_kinds: ["assistance"] } });
  const attempt = f.attempt(instance, work);
  const assessed = projectLearningState(f.store, "test");
  expect(assessed).toMatchObject({ learn_flow: { action: "assess_response", required_tool: "learning_record", allowed_define_kinds: [], allowed_record_kinds: ["assessment", "assistance"] }, current_task: { attempt_id: attempt.id, response_event_id: attempt.response.event_id, rubric_revision_id: f.rubric.revision_id } });
  expect(assessed.learn_flow!.instruction).toContain("exact response substrings alone");
  expect(assessed.learn_flow!.instruction).toContain("missing work in feedback, not in evidence");
  expect(assessed.learn_flow!.instruction).toContain("Do not label missing work as a conceptual error or diagnose a misconception");
});

test("host learn flow separates displayed feedback and a single task pass from readiness to move on", () => {
  const f = fixture(), result = f.observe(f.task("A single familiar question."), work);
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "present_feedback", can_move_on: false } });
  f.store.append("decision", { action: "response_feedback_presented", reason: "Owned native feedback fixture", evidence_event_ids: [result.assessment.event_id] }, "feedback-fixture", "host", "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "wait_for_continue", can_move_on: false, allowed_define_kinds: [], readiness: { ready: false, independent_definition_count: 1 } } });
  const request = { action: "learn_practice_requested", goal_revision_id: f.goal.revision_id, component_revision_id: f.component.revision_id, reason: "Explicit native Continue for more practice, not mastery", evidence_event_ids: [result.assessment.event_id] };
  f.store.append("decision", request, "forged-model-continue", "pi", "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "wait_for_continue", can_move_on: false } });
  f.store.append("decision", request, "native-practice-continue", "learner", "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "draft_conceptual", can_move_on: false, readiness: { ready: false, independent_definition_count: 1 } } });
});

test("host learn flow offers advancement only after evidence and native feedback, without claiming mastery", () => {
  const f = fixture(); variedSuccesses(f);
  const assessment = f.store.events().filter(event => event.kind === "assessment").at(-1)!;
  f.store.append("decision", { action: "response_feedback_presented", reason: "Owned native feedback fixture", evidence_event_ids: [assessment.event_id] }, "feedback-ready-fixture", "host", "test");
  expect(projectLearningState(f.store, "test")).toMatchObject({ learn_flow: { action: "ready_to_advance", can_move_on: true, allowed_define_kinds: [], readiness: { ready: true, epistemic_status: "conditional_engineering_gate_not_mastery" } } });
});

test("host learn flow cannot authorize teaching, grading or advancement while stopped", () => {
  const f = fixture();
  f.record("checkpoint", { goal_revision_id: f.goal.revision_id, summary: "Pause", next_action: "Wait for learner", gaps: [], stopped: true });
  expect(projectLearningState(f.store, "test")).toMatchObject({ phase: "stopped", learn_flow: { action: "stopped", can_move_on: false, allowed_define_kinds: [], allowed_record_kinds: [] } });
});

function initialStep(state: LearningState) {
  return {
    operation_id: "owned-first-host-step", kind: "learn_step", expected_goal_revision_id: state.goal_revision_id,
    expected_state_revision: state.state_revision, step_id: state.learn_flow!.step_id,
    body: {
      component: { title: "Exact proportionality and misleading near-matches", behavior: "Solve a symbolic ratio, justify invariance and discriminate proportionality from a near-match" },
      title: "Test a machine's proportionality claim",
      instruction: "Test ratio invariance, not visual resemblance. For the separate rule y=2x+3, compare the ratios at two positive inputs; a constant intercept changes the relationship. Track domain restrictions before transforming a formula.",
      prompt: "A machine is claimed to be directly proportional because doubling input nearly doubles output. Its rule is y=kx/(x+c), k,c>0. Derive the exact factor when x doubles, decide whether the claim is ever exact for positive finite x, and explain how an additional observation distinguishes it from y=mx. Identify assumptions and a misleading near-match.",
      criteria: [{ name: "solve", criterion: "Derive and check the symbolic ratio", max_score: 1 }, { name: "explain", criterion: "Justify exact rather than approximate invariance", max_score: 1 }, { name: "discriminate", criterion: "Defend a discriminating observation and explain a near-miss", max_score: 1 }],
      source_span_ids: [] as string[], challenge_rationale: "Symbolic reasoning, a boundary claim and method discrimination rather than a familiar numerical substitution",
      uncertainty: "Synthetic multi-demand practice proposal; difficulty and semantic correctness unvalidated",
    },
  };
}

test("host learning authoring compiles one scoped draft and awaits native review without fabricating work", async () => {
  await modePath(async f => {
    const state = (await f.context()).learning_state as LearningState, request = initialStep(state);
    const result = await f.tool("learning_define", request);
    expect(structuredClone(result)).toMatchObject({ kind: "learn_step", review_required: true, component_revision_id: expect.any(String), definition_revision_id: expect.any(String) });
    const definition = f.service.store.revision<TaskDefinition>(result.definition_revision_id as string, "task_definition");
    expect(definition.body.status).toBe("candidate"); expect(definition.body.review.method).toBe("unreviewed");
    const seq = f.service.store.throughSeq;
    expect(await f.tool("learning_define", request)).toEqual(result);
    expect(f.service.store.throughSeq).toBe(seq);
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ learn_flow: { action: "review_draft", allowed_define_kinds: [], can_move_on: false } });
    expect(f.service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment", "task_delivered"].includes(event.kind))).toEqual([]);
  });
});

test("host learning authoring rejects stale step and unselected sources atomically", async () => {
  await modePath(async f => {
    const state = (await f.context()).learning_state as LearningState, request = initialStep(state), seq = f.service.store.throughSeq;
    await expect(f.tool("learning_define", { ...request, step_id: "not-this-step" })).rejects.toThrow("Stale learning step");
    expect(f.service.store.throughSeq).toBe(seq);
    await expect(f.tool("learning_define", { ...request, body: { ...request.body, source_span_ids: ["unselected-source:0"] } })).rejects.toThrow("selected goal sources");
    expect(f.service.store.throughSeq).toBe(seq);
  });
});

async function nativeControl(f: Parameters<Parameters<typeof modePath>[0]>[0], action: string, extra: Record<string, unknown> = {}) {
  const state = projectLearningState(f.service.store, "modes");
  return f.service.learnControl({ operation_id: randomUUID(), action, confirmed: true, expected_goal_revision_id: state.goal_revision_id, expected_state_revision: state.state_revision, ...extra }, "modes");
}

test("native Continue requests more practice without pretending gaps or marks disappeared", async () => {
  await modePath(async f => {
    const text = "The ratio remains constant, so multiplying both quantities by the same factor preserves their relationship.";
    const task = f.task("Explain and apply an invariant, then compare a near-miss.");
    await f.work(task.revision_id, text, [{ dimension: "solve", score: 2, evidence: text }, { dimension: "reason", score: 1, evidence: text }]);
    const marks = f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind));
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ learn_flow: { action: "wait_for_continue", can_move_on: false } });
    await nativeControl(f, "practice");
    expect(projectLearningState(f.service.store, "modes").learn_flow!.action).toMatch(/^draft_/);
    expect(f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toEqual(marks);
    expect(f.service.store.events().filter(event => event.payload.action === "learn_practice_requested").at(-1)?.actor).toBe("learner");
  });
});

test("native advancement needs readiness or a separately confirmed move-on-with-gaps override", async () => {
  await modePath(async f => {
    const text = "Scaling both quantities preserves the ratio.";
    await f.work(f.task("Apply the invariant once.").revision_id, text, [{ dimension: "solve", score: 2, evidence: text }, { dimension: "reason", score: 1, evidence: text }]);
    const before = f.service.store.throughSeq;
    await expect(nativeControl(f, "advance")).rejects.toThrow("More evidence");
    expect(f.service.store.throughSeq).toBe(before);
    const marks = f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind));
    const result = await nativeControl(f, "move_on_with_gaps");
    expect(result.action).toBe("advanced");
    expect(f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toEqual(marks);
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ learn_flow: { action: "draft_instruction", can_move_on: false, component_revision_id: null } });
    const control = f.service.store.events().filter(event => event.payload.action === "learn_progression_advanced").at(-1)!;
    expect(control.actor).toBe("learner"); expect(control.payload.user_override).toBe(true);
    expect((control.payload.remaining_gaps as string[]).length).toBeGreaterThan(0);
  });
});

test("native existing-task selection freezes one reviewed question and rejects stale control without fabricating answers", async () => {
  await modePath(async f => {
    const task = f.task("Justify a method and diagnose an incorrect worked solution.");
    const state = projectLearningState(f.service.store, "modes"), method = f.service.learnControl.bind(f.service);
    const request = { operation_id: randomUUID(), action: "direct_practice", confirmed: true, expected_goal_revision_id: state.goal_revision_id, expected_state_revision: state.state_revision, definition_revision_id: task.revision_id };
    const seq = f.service.store.throughSeq;
    expect(() => method({ ...request, expected_state_revision: "stale" }, "modes")).toThrow("Stale learning control");
    expect(f.service.store.throughSeq).toBe(seq);
    const first = method(request, "modes");
    expect(first.action).toBe("question_started"); expect(typeof first.instance_revision_id).toBe("string");
    const after = f.service.store.throughSeq;
    expect(method(request, "modes")).toEqual(first);
    expect(f.service.store.throughSeq).toBe(after);
    expect(f.service.store.events().filter(event => event.kind === "task_delivered")).toHaveLength(1);
    expect(f.service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment"].includes(event.kind))).toEqual([]);
  });
});

test("explicit gap override cancels a pending draft without deleting it or reviving its old review", async () => {
  await modePath(async f => {
    const state = projectLearningState(f.service.store, "modes");
    const prepared = await f.tool("learning_define", initialStep(state));
    await nativeControl(f, "move_on_with_gaps");
    expect(f.service.store.revision<TaskDefinition>(prepared.definition_revision_id as string, "task_definition").body.status).toBe("candidate");
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ learn_flow: { action: "draft_instruction", component_revision_id: null } });
    expect(f.service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment", "task_delivered"].includes(event.kind))).toEqual([]);
  });
});

test("explicit instruction skip retires only workflow and invalidates its pending question lease", async () => {
  await modePath(async f => {
    const prepared = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    f.service.approveTask(prepared.definition_revision_id as string, "Native fixture approves only low-stakes content", "modes");
    const state = projectLearningState(f.service.store, "modes"), draft = state.learn_flow!.draft!;
    const offer = await f.service.offerTeaching({ action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: state.goal_revision_id!, unit_id: draft.unit_id, component_revision_id: draft.component_revision_id, instruction_revision_id: draft.instruction_revision_id!, definition_revision_id: draft.definition_revision_id }, "modes");
    await nativeControl(f, "move_on_with_gaps");
    expect(projectTeachingState(f.service.store, "modes", state.goal_revision_id!, f.service.store.throughSeq, f.service.store.now(), [])).toMatchObject({ stage: "checkpoint", criterion_evidence: "unknown" });
    await expect(offer.continue()).rejects.toThrow("stale");
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ phase: "prepare", pending_count: 0, learn_flow: { action: "draft_instruction", can_move_on: false } });
    expect(f.service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment", "task_delivered"].includes(event.kind))).toEqual([]);
  });
});

test("host learn course uses native editors, frozen criteria and conditional application evidence without expert provenance", async () => {
  await modePath(async f => {
    let index = 0;
    const text = () => `Synthetic owned work ${index}: y(2x)/y(x)=2(x+c)/(2x+c); the additive term prevents exact proportionality. Compare y/x at two distinct positive inputs and check domain assumptions.`;
    f.nativeUi({ editor: async () => text() });
    const grade = async () => {
      const state = projectLearningState(f.service.store, "modes"), task = state.current_task!;
      const attempt = f.service.store.events().filter(event => event.kind === "attempt_submitted" && event.payload.instance_revision_id === task.instance_revision_id).at(-1)!;
      const rubric = f.service.store.revision<{ dimensions: Array<{ name: string; max_score: number }> }>(task.rubric_revision_id, "rubric");
      await f.tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: state.goal_revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: task.rubric_revision_id, outcome: "success", scores: rubric.body.dimensions.map(dimension => ({ dimension: dimension.name, score: dimension.max_score, evidence: text() })), claims: ["execution", "explanation", "discrimination"].map(dimension => ({ component_revision_id: state.learn_flow!.component_revision_id, dimension, outcome: "success", evidence: text() })), feedback: "Synthetic rubric proposal for workflow verification only.", uncertainty: "No semantic grading or teaching efficacy claim", feedback_review: { ready_to_continue: true, issues: [] } } });
    };
    const initial = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    f.service.approveTask(initial.definition_revision_id as string, "Native learner fixture review; not expert validation", "modes");
    await f.command("continue", ""); await grade();
    const original = projectLearningState(f.service.store, "modes").current_task!.rubric_revision_id;
    for (index = 1; index <= 3; index++) {
      await f.command("continue", "practice");
      const state = projectLearningState(f.service.store, "modes");
      const body = { title: `Changed demand ${index}`, prompt: ["Diagnose a deceptive proportionality argument and construct a counterexample.", "An unfamiliar sensor saturates: distinguish invariance from a local approximation under changed constraints.", "Select and justify a method for a reciprocal response with restricted domain."][index - 1]!, reasoning_prompt: "Justify each transformation and its assumptions.", contrast_prompt: "Explain why a plausible competing method fails.", application_prompt: "Apply the invariant in a structurally changed, unfamiliar measurement setting.", source_span_ids: [], challenge_rationale: "Changed structural demand and reasoning, not numerical substitution", uncertainty: "Uncalibrated synthetic challenge and subjective grade proposal" };
      const compiled = await f.tool("learning_define", { operation_id: randomUUID(), kind: "learn_step", expected_goal_revision_id: state.goal_revision_id, expected_state_revision: state.state_revision, step_id: state.learn_flow!.step_id, body });
      expect(compiled.rubric_revision_id).toBe(original);
      f.service.approveTask(compiled.definition_revision_id as string, "Explicit native learner review only", "modes");
      await f.command("continue", ""); await grade();
    }
    const final = projectLearningState(f.service.store, "modes");
    expect(final.learn_flow).toMatchObject({ action: "ready_to_advance", can_move_on: true, readiness: { independent_definition_count: 3, epistemic_status: "conditional_engineering_gate_not_mastery" } });
    expect(f.service.store.revisions("task_definition").filter(task => task.body.status === "practice_ready").every(task => (task.body.review as { method: string }).method !== "expert")).toBe(true);
    expect(projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now(), "modes").flatMap(view => view.observations).some(observation => observation.transfer_eligible)).toBe(false);
    expect(f.service.store.events().filter(event => event.kind === "attempt_submitted")).toHaveLength(4);
    const marks = f.service.store.events().filter(event => event.kind === "assessment");
    await f.command("continue", "advance");
    expect(f.service.store.events().filter(event => event.payload.action === "learn_progression_advanced").at(-1)?.payload.user_override).toBe(false);
    expect(f.service.store.events().filter(event => event.kind === "assessment")).toEqual(marks);
  });
});

test("native question cancellation and blank response never create learner evidence or loop editors", async () => {
  await modePath(async f => {
    const prepared = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    f.service.approveTask(prepared.definition_revision_id as string, "Native fixture review", "modes");
    let editors = 0;
    f.nativeUi({ select: async () => "Not now", editor: async () => { editors++; return ""; } });
    await f.command("continue", "");
    expect(f.service.store.revisions("task_instance")).toHaveLength(0);
    f.nativeUi({ select: async () => "Continue" });
    await f.command("continue", "");
    expect(editors).toBe(1);
    expect(f.service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment"].includes(event.kind))).toHaveLength(0);
    expect(projectLearningState(f.service.store, "modes").learn_flow?.action).toBe("collect_response");
  });
});

test("native open response is not disabled by the optional scrap-work preference", async () => {
  await modePath(async f => {
    const goal = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, learning_preferences: { ...goal.body.learning_preferences!, features: { ...goal.body.learning_preferences!.features, scrap_work: false } } } }, "learner", "modes");
    const task = f.task("Explain the invariant with actual text.");
    const state = projectLearningState(f.service.store, "modes");
    const started = f.service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: state.goal_revision_id!, expected_state_revision: state.state_revision }, "modes");
    await expect(f.service.operation("learning_activity", { action: "open_response", operation_id: randomUUID(), expected_goal_revision_id: state.goal_revision_id, instance_revision_id: started.instance_revision_id }, "modes")).resolves.toBeDefined();
  });
});

test("wrong native work keeps its marks and reaches a new pinned repair unit without weakened criteria", async () => {
  await modePath(async f => {
    f.nativeUi({ editor: async () => "10" });
    const prepared = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    f.service.approveTask(prepared.definition_revision_id as string, "Explicit learner fixture review", "modes");
    await f.command("continue", "");
    const state = projectLearningState(f.service.store, "modes"), task = state.current_task!;
    const attempt = f.service.store.events().filter(event => event.kind === "attempt_submitted").at(-1)!;
    const rubric = f.service.store.revision<{ dimensions: Array<{ name: string }> }>(task.rubric_revision_id, "rubric");
    await f.tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: state.goal_revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: task.rubric_revision_id, outcome: "failure", scores: rubric.body.dimensions.map(dimension => ({ dimension: dimension.name, score: 0, evidence: "10" })), feedback: "A number alone does not derive the ratio or justify the claim.", uncertainty: "Synthetic subjective grade, not efficacy evidence", feedback_review: { ready_to_continue: false, issues: [{ quote: "10", problem: "Symbolic ratio and explanation missing", suggestion: "Explain the invariant and compare a near-match", severity: "blocking" }] } } });
    const marks = f.service.store.events().filter(event => event.kind === "assessment");
    await f.command("continue", "practice");
    const current = projectLearningState(f.service.store, "modes");
    expect(current.learn_flow?.action).toBe("draft_repair");
    const request = { operation_id: randomUUID(), kind: "learn_step", expected_goal_revision_id: current.goal_revision_id, expected_state_revision: current.state_revision, step_id: current.learn_flow!.step_id, body: { title: "Repair the invariant", instruction: "Compare multiplicative ratios before choosing a transformation. Check whether the intercept or denominator changes with input.", prompt: "Derive the exact change in a reciprocal sensor response and explain a misleading linear comparison.", source_span_ids: [], challenge_rationale: "Repair the missing mechanism and method discrimination", uncertainty: "Uncalibrated synthetic repair" } };
    await expect(f.tool("learning_define", { ...request, body: { ...request.body, criteria: [{ name: "solve", criterion: "Any answer", max_score: 1 }] } })).rejects.toThrow("original frozen criteria");
    const repair = await f.tool("learning_define", request);
    expect(repair.rubric_revision_id).toBe(task.rubric_revision_id);
    f.service.approveTask(repair.definition_revision_id as string, "Native learner repair review", "modes");
    await f.command("continue", "");
    expect(f.service.store.revisions("task_instance")).toHaveLength(2);
    expect(f.service.store.events().filter(event => event.kind === "attempt_submitted")).toHaveLength(2);
    expect(f.service.store.events().filter(event => event.kind === "assessment")).toEqual(marks);
  });
});

test("native progression pins the next agreed plan component instead of letting the model replace it", async () => {
  await modePath(async f => {
    const task = f.task("Explain this invariant before advancing.");
    await f.work(task.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const goal = f.service.store.lessonGoal("modes")!;
    const next = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: goal.revision_id, body: { title: "Next agreed concept", behavior: "Explain the next agreed relation", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Owned agreed-plan fixture" } }, "learner", "modes");
    f.service.store.define({ operation_id: randomUUID(), kind: "plan", expected_goal_revision_id: goal.revision_id, body: { goal_revision_id: goal.revision_id, component_revision_ids: [task.component_revision_ids[0], next.revision_id], next_activities: [], known_gaps: [], uncertain_assumptions: [] } }, "learner", "modes");
    await f.command("continue", "gaps");
    const state = projectLearningState(f.service.store, "modes");
    expect(state.learn_flow).toMatchObject({ action: "draft_instruction", component_revision_id: next.revision_id });
    const request = initialStep(state);
    const before = f.service.store.throughSeq;
    await expect(f.tool("learning_define", request)).rejects.toThrow("agreed current component");
    expect(f.service.store.throughSeq).toBe(before);
    const compiled = await f.tool("learning_define", { ...request, body: { ...request.body, component: { revision_id: next.revision_id } } });
    expect(compiled.component_revision_id).toBe(next.revision_id);
  });
});

test("native bank release cannot silently add aids outside the current goal", async () => {
  await modePath(async f => {
    const task = f.task("A bank question with an undeclared aid", { allowed_aids: ["private worked solutions"] });
    const state = projectLearningState(f.service.store, "modes"), before = f.service.store.throughSeq;
    expect(() => f.service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: state.goal_revision_id!, expected_state_revision: state.state_revision }, "modes")).toThrow("aids");
    expect(f.service.store.throughSeq).toBe(before);
  });
});

test("one success and a near deadline cannot recommend learn advancement", async () => {
  await modePath(async f => {
    const task = f.task("Explain and solve one proportionality problem.");
    await f.work(task.revision_id, "10 with ratio invariance", [{ dimension: "solve", score: 85, evidence: "10 with ratio invariance" }, { dimension: "reason", score: 15, evidence: "10 with ratio invariance" }]);
    const packet = await f.context();
    expect((packet.next_action_candidates as Array<{ type: string }>).some(candidate => candidate.type === "advance")).toBe(false);
    expect(projectLearningState(f.service.store, "modes").learn_flow?.can_move_on).toBe(false);
  });
});

test("active host step survives a tight context budget instead of becoming model orchestration", async () => {
  await modePath(async f => {
    await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    const packet = compileContext(f.service.store, { budget_chars: 4000 }, "", "modes");
    expect(packet.host_learn_step).toMatchObject({ controller: "host", action: "review_draft", allowed_define_kinds: [] });
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(4000);
  });
});

test("native gap confirmation cancellation, changed permission and stop cannot advance or rewrite marks", async () => {
  for (const change of ["cancel", "permission", "stop"] as const) await modePath(async f => {
    const task = f.task("Explain rather than only guessing a number.");
    await f.work(task.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const marks = f.service.store.events().filter(event => event.kind === "assessment");
    f.nativeUi({ confirm: async () => {
      if (change === "cancel") return false;
      if (change === "stop") await f.command("stop", "");
      else { const goal = f.service.store.lessonGoal("modes")!; f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, provider_sharing: false } }, "learner", "modes"); }
      return true;
    } });
    await f.command("continue", "gaps");
    expect(f.service.store.events().some(event => event.payload.action === "learn_progression_advanced")).toBe(false);
    expect(f.service.store.events().filter(event => event.kind === "assessment")).toEqual(marks);
  });
});

test("declining diagnostic approval teaches the same topic without a question, mark or advancement", async () => {
  await modePath(async f => {
    const prepared = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    const goal = f.service.store.lessonGoal("modes")!;
    f.nativeUi({ select: async () => "Teach without a diagnostic", confirm: async () => { throw new Error("Declining an optional diagnostic needs no confirmation"); }, editor: async () => { throw new Error("No diagnostic editor should open"); } });
    await f.command("approve", "");
    expect(projectLearningState(f.service.store, "modes").learn_flow).toMatchObject({ action: "teach_explanation", component_revision_id: prepared.component_revision_id, diagnostic_preference: "skip", can_move_on: false });
    expect(f.service.store.lessonGoal("modes")!.revision_id).toBe(goal.revision_id);
    expect(f.service.store.revisions("task_instance")).toHaveLength(0);
    expect(f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toHaveLength(0);
    expect(f.service.store.events().some(event => event.payload.action === "learn_progression_advanced")).toBe(false);
    await f.reopen();
    expect(projectLearningState(f.service.store, "modes").learn_flow).toMatchObject({ action: "teach_explanation", diagnostic_preference: "skip" });
    await f.command("continue", "practice");
    const next = projectLearningState(f.service.store, "modes");
    expect(next.learn_flow).toMatchObject({ action: "draft_instruction", component_revision_id: prepared.component_revision_id, diagnostic_preference: "skip" });
    const request = initialStep(next);
    const compiled = await f.tool("learning_define", { ...request, operation_id: randomUUID(), body: { ...request.body, component: { revision_id: prepared.component_revision_id }, prompt: "Compare an affine increase with a saturating sensor response: justify which observation distinguishes exact proportionality from an approximate local match." } });
    expect(compiled.component_revision_id).toBe(prepared.component_revision_id);
    f.service.approveTask(compiled.definition_revision_id as string, "Learner chose later guided practice, not a diagnostic", "modes");
    const text = "Synthetic actual response: compare multiplicative ratios and check whether they remain invariant under a changed input.";
    f.nativeUi({ select: async () => "Continue", editor: async () => text });
    await f.command("continue", "");
    const attempt = f.service.store.events().filter(event => event.kind === "attempt_submitted").at(-1)!;
    const rubric = f.service.store.revision<{ dimensions: Array<{ name: string; max_score: number }> }>(compiled.rubric_revision_id as string, "rubric");
    await f.tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: compiled.rubric_revision_id, outcome: "success", scores: rubric.body.dimensions.map(dimension => ({ dimension: dimension.name, score: dimension.max_score, evidence: text })), feedback: "Synthetic workflow grade only.", uncertainty: "Subjective fixture, not semantic verification", feedback_review: { ready_to_continue: true, issues: [] } } });
    expect(projectLearningState(f.service.store, "modes").learn_flow?.readiness?.unmet_requirements).not.toContain("original_criteria");
  });
});

test("continue teach bypasses diagnostic consent without approving a draft or awarding evidence", async () => {
  for (const bound of [true, false]) await modePath(async f => {
    if (bound) await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    f.nativeUi({ select: async () => { throw new Error("Explicit teach choice needs no quiz selector"); }, confirm: async () => { throw new Error("No diagnostic consent needed"); } });
    await f.command("continue", "teach");
    expect(projectLearningState(f.service.store, "modes").learn_flow).toMatchObject({ action: "teach_explanation", diagnostic_preference: "skip", protocol_active: true });
    expect(f.service.store.revisions("task_definition").some(task => task.body.status === "practice_ready")).toBe(false);
    expect(f.service.store.revisions("task_instance")).toHaveLength(0);
  });
});

test("stopped learn mode rejects fresh model help records without losing the pending question", async () => {
  await modePath(async f => {
    const task = f.task("Keep this question pinned when stopped.");
    const state = projectLearningState(f.service.store, "modes");
    const started = f.service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: state.goal_revision_id!, expected_state_revision: state.state_revision }, "modes");
    await f.command("stop", "");
    const before = f.service.store.throughSeq;
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "assistance", expected_goal_revision_id: state.goal_revision_id, payload: { assistance_id: randomUUID(), instance_revision_id: started.instance_revision_id, kind: "hint", component_revision_ids: task.component_revision_ids, answer_bearing: true, content: "Unrequested post-stop hint", stage: "requested" } })).rejects.toThrow("stopped");
    expect(f.service.store.throughSeq).toBe(before);
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ phase: "stopped", current_task: { instance_revision_id: started.instance_revision_id } });
  });
});

test("model record metadata cannot replace the native workflow while a host draft awaits review", async () => {
  await modePath(async f => {
    await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    const before = f.service.store.throughSeq;
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, payload: { action: "advance_after_one_question", reason: "Model sequencing must not replace the host job", evidence_event_ids: [] } })).rejects.toThrow("Host learn flow");
    expect(f.service.store.throughSeq).toBe(before);
  });
});

test("Continue on a saved unbound learn task collects work instead of silently skipping it", async () => {
  await modePath(async f => {
    const goal = f.service.store.lessonGoal("modes")!;
    const task = f.task("Explain why the two ratios describe the same relation.");
    const instance = f.service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "practice", conditions: ["Saved legacy learn task"] } }, "host", "modes");
    f.service.store.rebuild();
    expect(projectLearningState(f.service.store, "modes").learn_flow!.protocol_active).toBe(false);
    let editors = 0;
    f.nativeUi({ editor: async () => { editors++; return undefined; } });
    await f.command("continue", "");
    expect(editors).toBe(1);
    expect(projectLearningState(f.service.store, "modes")).toMatchObject({ pending_count: 1, current_task: { instance_revision_id: instance.revision_id } });
    expect(f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toHaveLength(0);
  });
});

test("initial host authoring requests reusable public criteria without task answers", async () => {
  await modePath(async f => {
    const instruction = projectLearningState(f.service.store, "modes").learn_flow!.instruction;
    expect(instruction).toContain("reusable component-level public criteria");
    expect(instruction).toContain("never put task answers or worked solutions in the rubric");
  });
});

test("default Continue after explanation offers optional practice instead of repeating the teaching step", async () => {
  await modePath(async f => {
    await f.command("continue", "teach");
    f.nativeUi({ select: async (_title: string, choices: string[]) => choices.includes("Try guided practice") ? "Try guided practice" : undefined, editor: async () => { throw new Error("Choosing practice only authors a reviewed draft; it does not fabricate a response"); } });
    await f.command("continue", "");
    expect(projectLearningState(f.service.store, "modes").learn_flow).toMatchObject({ action: "draft_instruction", diagnostic_preference: "skip" });
    expect(f.service.store.revisions("task_instance")).toHaveLength(0);
    expect(f.service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toHaveLength(0);
  });
});

test("native Continue requests practice without turning it into advancement", async () => {
  await modePath(async f => {
    const task = f.task("Explain the ratio invariant and diagnose a misleading near-match.");
    await f.work(task.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const before = f.service.store.events().filter(event => event.kind === "assessment");
    await f.command("continue", "practice");
    expect(f.service.store.events().some(event => event.actor === "learner" && event.payload.action === "learn_practice_requested")).toBe(true);
    expect(f.service.store.events().some(event => event.payload.action === "learn_progression_advanced")).toBe(false);
    expect(f.service.store.events().filter(event => event.kind === "assessment")).toEqual(before);
  });
});

test("native advance cannot silently override missing evidence, while a separate gaps choice preserves it", async () => {
  await modePath(async f => {
    const task = f.task("Justify proportionality rather than only calculating.");
    await f.work(task.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const marks = f.service.store.events().filter(event => event.kind === "assessment");
    await f.command("continue", "advance");
    expect(f.service.store.events().some(event => event.payload.action === "learn_progression_advanced")).toBe(false);
    await f.command("continue", "gaps");
    expect(f.service.store.events().filter(event => event.actor === "learner" && event.payload.action === "learn_progression_advanced").at(-1)?.payload).toMatchObject({ user_override: true, remaining_gaps: expect.any(Array) });
    expect(f.service.store.events().filter(event => event.kind === "assessment")).toEqual(marks);
  });
});

test("native teaching cannot substitute a different question for the current host binding", async () => {
  await modePath(async f => {
    const other = f.task("An unrelated library question is not the current host job.");
    const prepared = await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    const before = f.service.store.throughSeq;
    await expect(f.service.offerTeaching({ action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, unit_id: "unbound-question", component_revision_id: other.component_revision_ids[0]!, definition_revision_id: other.revision_id, instruction_revision_id: prepared.instruction_revision_id as string }, "modes")).rejects.toThrow("Host learn flow");
    expect(f.service.store.throughSeq).toBe(before);
  });
});

test("model low-level definitions cannot bypass the host authoring or native question-release contract", async () => {
  await modePath(async f => {
    const task = f.task("A reviewed bank question still needs native release.");
    await f.tool("learning_define", initialStep(projectLearningState(f.service.store, "modes")));
    const state = projectLearningState(f.service.store, "modes");
    const component = f.service.store.revisions("component")[0]!;
    const draft = initialStep(state).body;
    const requests = [
      { kind: "component", body: component.body },
      { kind: "goal", body: { ...f.service.store.revision<Goal>(state.goal_revision_id!, "goal").body, mode: "exam" } },
      { kind: "task_instance", body: { definition_revision_id: task.revision_id, goal_revision_id: state.goal_revision_id, purpose: "independent", conditions: [] } },
      { kind: "lesson_preparation", body: { component: draft.component, title: draft.title, instruction: draft.instruction, prompt: draft.prompt, criteria: draft.criteria, construct: draft.title, variation: draft.challenge_rationale, allowed_aids: [], source_span_ids: [], uncertainty: draft.uncertainty } },
    ];
    const before = f.service.store.throughSeq;
    for (const request of requests) {
      await expect(f.tool("learning_define", { operation_id: randomUUID(), expected_goal_revision_id: state.goal_revision_id, expected_state_revision: state.state_revision, ...request })).rejects.toThrow("Host learn flow");
      expect(f.service.store.throughSeq).toBe(before);
    }
  });
});
