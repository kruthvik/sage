import { afterEach, expect, test } from "bun:test";
import { learningFixture } from "./learning-fixture.ts";
import { canonical, type LearningStore } from "../../storage/src/store.ts";
import { projectComponents, projectHypotheses } from "../../storage/src/projection.ts";
import { compileContext } from "../src/context.ts";
import { proposeReviews } from "../src/reviews.ts";
import { nextActionCandidates } from "../src/candidates.ts";
import { evaluateLearning } from "../src/evaluation.ts";
import type { Component, Revision } from "../../core/src/contracts.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(subject?: string, objective?: string) { const f = learningFixture(subject, objective); stores.push(f.store); return f; }

test("sparse data proposes orientation without assuming a beginner or imposing activities", () => {
  const f = fixture();
  expect(f.candidates().map(c => c.type)).toEqual(["orient", "worked_example", "checkpoint"]);
  expect(f.state().independent_performance.success).toBe(0);
  expect(f.state().guidance_state).toBe("needs_orientation");
  expect(f.candidates().some(c => c.type === "retrieval")).toBe(false);
  const blocked = nextActionCandidates({ goal: f.goal.body, views: f.views(), components: [], reviews: [], as_of_time: f.store.now(), task_reliable: false });
  expect(blocked[0]!.reason_codes).toContain("verify_before_interpreting");
});

test("supported success fades to fresh work; offers and accessibility are not answer-bearing help", () => {
  const f = fixture(); const definition = f.task("Integrate x exp(x)"); const instance = f.deliver(definition);
  f.record("assistance", { assistance_id: "offer", instance_revision_id: instance.revision_id, component_revision_ids: [], stage: "offered", kind: "hint", content: "Try choosing u", answer_bearing: true });
  f.record("assistance", { assistance_id: "access", instance_revision_id: instance.revision_id, component_revision_ids: [], stage: "exposed", kind: "accessibility", content: "Larger text", answer_bearing: false });
  f.record("assistance", { assistance_id: "example", instance_revision_id: instance.revision_id, component_revision_ids: [], stage: "exposed", kind: "example", content: "Set u=x", answer_bearing: true });
  const a = f.attempt(instance, "Set u=x"); f.assess(a.id, definition, "Set u=x");
  expect(f.state().supported_performance.success).toBe(1);
  expect(f.state().independent_performance.success).toBe(0);
  expect(f.state().guidance_state).toBe("fade_support");
  expect(f.candidates()[0]!.type).toBe("fade_support");
  // A new instance of the identical prompt is not a fresh independent task.
  f.observe(definition, "Set u=x");
  expect(f.state().independent_performance.success).toBe(0);
  f.observe(f.task("Integrate x squared exp(x)"), "Set u=x squared");
  expect(f.state().independent_performance.success).toBe(1);
  expect(f.state().support_dependency).toBe("not_recently_observed");
});

test("retention requires actual meaningful delay; elapsed time never adds failure", () => {
  const f = fixture(); const first = f.task("Integrate x exp(x)"); f.observe(first);
  f.time("2026-10-01T12:05:00.000Z"); f.observe(f.task("Integrate 2x exp(x)"), "Select parts", "success", "retention");
  expect(f.state().retention_evidence.success).toBe(0);
  const before = f.state().independent_performance;
  const future = projectComponents(f.store, f.store.throughSeq, "2026-12-01T12:00:00.000Z")[0]!;
  expect(future.independent_performance).toEqual(before);
  expect(future.retention_evidence.failure).toBe(0);
  f.time("2026-10-03T12:05:00.000Z"); f.observe(f.task("Integrate 3x exp(x)"), "Select parts", "failure", "retention");
  expect(f.state().retention_evidence.failure).toBe(1);
  expect(f.state().retention_evidence.tested_delays_days[0]).toBe(2);
});

test("family lineage and surface variants do not manufacture transfer or breadth", () => {
  const f = fixture(); const base = f.task("Integrate x exp(x)"); f.observe(base);
  const family2 = f.define("task_family", { title: "Renamed template", construct: "Parts", variation: "Only coefficients", lineage_revision_ids: [f.family.revision_id] });
  const surface = f.task("Integrate 2x exp(x)", { family_revision_id: family2.revision_id, changes: ["new context"], variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["surface"], invariant: "Same solution structure", rationale: "Only the coefficient changes" } });
  f.observe(surface, "Parts", "success", "application");
  expect(f.state().family_exposure).toHaveLength(1);
  expect(f.state().transfer_evidence.success).toBe(0);
  expect(f.state().applied).toHaveLength(0);
  const changed = f.task("Explain accumulated area from a tabular growth rate", { representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Same integral relation", rationale: "Interpret a rate table before selecting and applying the relation" } });
  f.observe(changed, "The area accumulates the rate", "failure", "application");
  expect(f.state().transfer_evidence.failure).toBe(1);
  expect(f.state().independent_performance.success).toBe(2);
  expect(f.state().guidance_state).not.toBe("independent_across_forms");
});

test("an unobserved baseline and free-text changes do not prove changed application", () => {
  const f = fixture(); const unseen = f.task("Unseen baseline");
  f.observe(f.task("Changed case", { variation: { baseline_definition_revision_id: unseen.revision_id, dimensions: ["structure"], invariant: "Target relation", rationale: "Documented change" } }), "Correct changed case", "success", "application");
  expect(f.state().transfer_evidence.success).toBe(0);
  f.observe(f.task("Cosmetic renamed task", { changes: ["Far transfer!", "Changed context"] }), "Correct", "success", "application");
  expect(f.state().transfer_evidence.success).toBe(0);
});

test("numeric-only prompt variants cannot create new exposure families by omitting lineage", () => {
  const f = fixture();
  const alias = f.define("task_family", { title: "Supposedly new topic", construct: "Same component", variation: "Fresh values", lineage_revision_ids: [] });
  f.observe(f.task("Solve 3x + 5 = 20"), "x=5");
  f.observe(f.task("Solve 4x + 7 = 21", { family_revision_id: alias.revision_id }), "x=3.5");
  expect(f.state().family_exposure).toHaveLength(1);
  expect(f.state().family_exposure[0]!.attempts).toBe(2);
  expect(f.state().transfer_evidence.success).toBe(0);
  const baseline = f.store.revisions("task_definition")[0]!;
  const mislabeled = f.task("Solve 8x + 9 = 25", { family_revision_id: alias.revision_id, variation: { baseline_definition_revision_id: baseline.revision_id, dimensions: ["structure"], invariant: "Same linear equation", rationale: "Incorrectly labeled numeric substitution" } });
  f.observe(mislabeled, "x=2", "success", "application");
  expect(f.state().transfer_evidence.success).toBe(0);
});

test("contradictions weaken competing hypotheses; immutable revisions preserve past knowledge", () => {
  const f = fixture(); const bad = f.observe(f.task("Choose method for log integral"), "Use substitution", "failure", "independent", { error_category: "selection" });
  const h = f.hypothesis([bad.assessment.event_id]); const before = f.store.throughSeq;
  expect(f.state().unresolved_gaps[0]!.derived_status).toBe("active");
  expect(f.candidates()[0]!.type).toBe("discriminate");
  const good = f.observe(f.task("Contrast log integral with derivative substitution"), "Parts, because no matching derivative", "success", "independent", { claims: [{ component_revision_id: f.component.revision_id, dimension: "discrimination", outcome: "success", evidence: "no matching derivative" }] });
  const revised = f.hypothesis([bad.assessment.event_id], [good.assessment.event_id], h);
  expect(f.state().unresolved_gaps[0]!.derived_status).toBe("weakened");
  expect(f.state().unresolved_gaps[0]!.evidence_balance).toBe("mixed");
  expect(projectHypotheses(f.store, before, f.store.now())[0]!.derived_status).toBe("active");
  f.hypothesis([bad.assessment.event_id], [good.assessment.event_id], revised, { status: "resolved" });
  expect(f.state().unresolved_gaps).toHaveLength(0);
  expect(f.state().misconception_hypotheses[0]!.derived_status).toBe("resolved");
  expect(() => f.hypothesis([bad.assessment.event_id], [bad.assessment.event_id])).toThrow("both support and contradict");
});

test("corrected evidence is removed from hypothesis support, not erased from history", () => {
  const f = fixture(); const task = f.task("Choose method"); const wrong = f.observe(task, "Parts", "failure"); f.hypothesis([wrong.assessment.event_id]);
  f.assess(wrong.id, task, "Parts", "success", { correction_of_event_id: wrong.assessment.event_id });
  expect(f.state().unresolved_gaps[0]!.evidence_balance).toBe("unknown");
  expect(f.state().unresolved_gaps[0]!.derived_status).toBe("uncertain");
  expect(f.store.event(wrong.assessment.event_id).payload.outcome).toBe("failure");
});

test("review offers are consent-free proposals, goal-bounded and component-aware", () => {
  const f = fixture(); f.observe(f.task("Integrate x exp(x)"));
  const components = f.store.revisions("component") as unknown as Revision<Component>[];
  const before = f.store.throughSeq;
  const review = proposeReviews(f.goal.body, f.views(), components, f.store.now())[0]!;
  expect(review.interval_days).toBe(2);
  expect(review.task_requirement).toContain("not an automatic flashcard");
  expect(review.requires_consent).toBe(true);
  expect(f.store.throughSeq).toBe(before);
  f.time("2026-10-03T12:00:00.000Z");
  expect(f.candidates().some(c => c.type === "retrieval")).toBe(true);
  expect(f.state().independent_performance.failure).toBe(0);
  expect(proposeReviews({ ...f.goal.body, horizon_days: 0 }, f.views(), components, f.store.now())).toEqual([]);
});

test("an evidenced prerequisite issue produces repair; a bare prerequisite edge does not", () => {
  const f = fixture();
  const prerequisite = f.define("component", { title: "Algebra", behavior: "Rearrange equations", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Unknown" });
  const revised = f.define("component", { ...f.component.body, prerequisite_revision_ids: [prerequisite.revision_id] }, f.component);
  const task = f.task("Rearrange a coefficient", { component_revision_ids: [prerequisite.revision_id] });
  const failure = f.observe(task, "Incorrect algebra", "failure");
  const h = f.define("hypothesis", { component_revision_ids: [revised.revision_id], category: "prerequisite", description: "Algebra may block the current integral", confidence: "low", supporting_evidence_ids: [failure.assessment.event_id], contradicting_evidence_ids: [], status: "active", first_observed_at: f.store.now(), last_observed_at: f.store.now(), prerequisite_component_revision_id: prerequisite.revision_id });
  expect(h.kind).toBe("hypothesis");
  expect(f.candidates()[0]!.type).toBe("prerequisite_repair");
  expect(f.candidates()[0]!.target_component_revision_ids).toContain(prerequisite.revision_id);
  const context = compileContext(f.store, { component_revision_ids: [revised.revision_id] }, "", "test");
  expect((context.next_action_candidates as Array<{ type: string }>)[0]!.type).toBe("prerequisite_repair");
});

test("careless errors receive narrow practice; repeated failures change representation", () => {
  const f = fixture(); f.observe(f.task("Check arithmetic in the final integral"), "Arithmetic slip", "failure", "independent", { error_category: "careless_error" });
  expect(f.candidates()[0]!.type).toBe("independent_practice");
  expect(f.candidates()[0]!.reason_codes).toContain("target_slip_not_whole_concept");
  f.observe(f.task("Fresh integral after feedback"), "Still incorrect", "failure", "independent", { error_category: "procedural" });
  expect(f.candidates()[0]!.type).toBe("representation_change");
  expect(f.candidates().some(c => c.type === "completion_problem")).toBe(true);
});

test("dependent steps quote their own response and later feedback contaminates dependent evidence", () => {
  const f = fixture(); const task = f.task("Select u then perform integration"); const instance = f.deliver(task); const a = f.attempt(instance, "u=x");
  f.record("step_attempt", { step_attempt_id: "s1", attempt_id: a.id, step: "Choose u", response_event_id: a.response.event_id, prior_step_ids: [] });
  f.assess(a.id, task, "u=x", "success", { step_attempt_id: "s1" });
  const response = f.store.learnerResponse("Then integrate dv", "test");
  f.record("step_attempt", { step_attempt_id: "s2", attempt_id: a.id, step: "Integrate dv", response_event_id: response.event_id, prior_step_ids: ["s1"] });
  expect(() => f.assess(a.id, task, "u=x", "success", { step_attempt_id: "s2" })).toThrow("actual span");
  f.assess(a.id, task, "Then integrate dv", "success", { step_attempt_id: "s2" });
  expect(f.state().diagnostic_steps.map(s => s.eligibility)).toEqual(["independent", "uncertain"]);
  expect(f.state().acquisition_evidence.success).toBe(0);
  const foreign = f.store.learnerResponse("Other conversation", "other");
  expect(() => f.record("step_attempt", { step_attempt_id: "s3", attempt_id: a.id, step: "Finish", response_event_id: foreign.event_id, prior_step_ids: [] })).toThrow("same conversation");
});

test("context size stays bounded as history grows and targeted evidence drill-down works", () => {
  const f = fixture(); const base = f.task("Original integration task");
  let last = f.observe(base);
  for (let i = 0; i < 35; i++) last = f.observe(f.task(`Fresh integration task ${i}`));
  const packet = compileContext(f.store, { budget_chars: 10000 }, "I prefer short feedback.", "test");
  expect(JSON.stringify(packet).length).toBeLessThanOrEqual(10000);
  expect((packet.components as unknown[]).length).toBeGreaterThan(0);
  expect((packet.next_action_candidates as unknown[]).length).toBeLessThanOrEqual(5);
  expect(JSON.stringify(packet)).not.toContain("Original integration task");
  const targeted = compileContext(f.store, { evidence_event_ids: [last.assessment.event_id], budget_chars: 16000 }, "", "test");
  expect((targeted.evidence_details as Array<{ event_id: string }>)[0]!.event_id).toBe(last.assessment.event_id);
  for (const size of [2000, 4000, 8000]) expect(JSON.stringify(compileContext(f.store, { budget_chars: size }, "", "test")).length).toBeLessThanOrEqual(size);
});

test("decisions and outcomes replay deterministically without storing private model reasoning", () => {
  const f = fixture(); const outcome = f.observe(f.task("Method selection")); const candidates = f.candidates(); const chosen = candidates[0]!;
  const input = { operation_id: "decision-1", kind: "decision", expected_goal_revision_id: f.goal.revision_id, payload: { action: chosen.type, reason: "Familiar execution does not establish changed selection", policy_version: chosen.policy_version, evidence_event_ids: [outcome.assessment.event_id], candidate_ids: candidates.map(c => c.id), selected_candidate_id: chosen.id, reason_codes: chosen.reason_codes, uncertainty: "high" } };
  const first = f.store.record(input, "test"); const seq = f.store.throughSeq;
  expect(f.store.record(input, "test").event_id).toBe(first.event_id);
  expect(f.store.throughSeq).toBe(seq);
  const state = canonical(f.views()); f.store.db.exec("DELETE FROM projection"); f.store.rebuild(f.store.now());
  expect(canonical(f.views())).toBe(state);
  const report = evaluateLearning(f.store);
  expect(report.decisions[0]!.selected_candidate_id).toBe(chosen.id);
  expect(report.components[0]!.retention.success).toBe(0);
  expect(report.timing_note).toContain("not learning time");
  expect(() => f.store.record({ ...input, operation_id: "private-reasoning", payload: { ...input.payload, chain_of_thought: "hidden" } }, "test")).toThrow("Invalid operation");
});

test("biology scenario distinguishes listing, mechanism explanation, discrimination and application", () => {
  const f = fixture("science", "Explain chemiosmosis and distinguish ATP production mechanisms");
  const list = f.task("List respiration stages"); f.observe(list, "Glycolysis, Krebs cycle, electron transport");
  const mechanism = f.task("Explain the proton gradient", { format: "explain" });
  const weak = f.observe(mechanism, "Electrons directly make all ATP", "failure", "independent", { error_category: "conceptual", claims: [{ component_revision_id: f.component.revision_id, dimension: "explanation", outcome: "failure", evidence: "Electrons directly" }] });
  f.hypothesis([weak.assessment.event_id], [], undefined, { category: "conceptual", description: "May confuse electron transport with ATP synthase's use of a proton gradient" });
  expect(f.candidates().some(c => c.type === "misconception_probe")).toBe(true);
  const compare = f.task("Distinguish substrate-level and oxidative phosphorylation", { format: "discriminate" });
  const good = f.observe(compare, "Substrate-level uses phosphate transfer; oxidative uses the proton gradient", "success", "independent", { claims: [{ component_revision_id: f.component.revision_id, dimension: "discrimination", outcome: "success", evidence: "uses the proton gradient" }] });
  const h = f.store.revisions("hypothesis").at(-1)!; f.hypothesis([weak.assessment.event_id], [good.assessment.event_id], h, { category: "conceptual", status: "resolved" });
  const inhibitor = f.task("Predict ATP production after collapsing the membrane proton gradient", { representation: "changed case", variation: { baseline_definition_revision_id: mechanism.revision_id, dimensions: ["context", "structure"], invariant: "ATP synthase requires the gradient", rationale: "Perturb the mechanism rather than listing stages" } });
  f.observe(inhibitor, "Oxidative ATP falls but substrate-level transfer can continue", "success", "application");
  expect(f.state().transfer_evidence.success).toBe(1);
  expect(f.state().explanation_evidence.failure).toBe(1);
  expect(f.state().retention_evidence.success).toBe(0);
});

test("writing scenario repairs warrants without turning sentences into repetitions or adding flashcards", () => {
  const f = fixture("writing", "Construct a defensible historical warrant"); const initial = f.task("Explain why factory records support a labor-history thesis");
  const weak = f.observe(initial, "Factory output increased, therefore everyone benefited", "partial", "independent", { error_category: "conceptual" });
  f.hypothesis([weak.assessment.event_id], [], undefined, { category: "conceptual", description: "May infer worker welfare directly from aggregate output" });
  const completion = f.task("Complete the missing warrant while acknowledging limits"); const instance = f.deliver(completion);
  f.record("assistance", { assistance_id: "warrant-model", instance_revision_id: instance.revision_id, component_revision_ids: [f.component.revision_id], stage: "exposed", kind: "example", content: "Output does not alone establish distribution of gains", answer_bearing: true });
  const a = f.attempt(instance, "Output does not alone show wages or working conditions"); f.assess(a.id, completion, "Output does not alone show wages or working conditions");
  expect(f.candidates()[0]!.type).toBe("fade_support");
  const fresh = f.task("Use wage records for a different historical argument", { variation: { baseline_definition_revision_id: initial.revision_id, dimensions: ["context"], invariant: "Evidence must warrant the thesis within its limits", rationale: "Different source and thesis require a new link" } });
  f.observe(fresh, "Wage records indicate pay changes but not household purchasing power", "success", "application");
  expect(f.state().supported_performance.success).toBe(1);
  expect(f.state().independent_performance.success).toBe(1);
  expect(f.state().observations).toHaveLength(3);
  expect(f.candidates().some(c => c.type === "retrieval")).toBe(false);
});

test("component-scoped outcomes do not credit an unobserved part of a multi-component task", () => {
  const f = fixture();
  const second = f.define("component", { ...f.component.body, title: "Formula reconstruction", behavior: "Recall the parts formula" });
  const task = f.task("Choose a method without executing it", { component_revision_ids: [f.component.revision_id, second.revision_id] });
  f.observe(task, "I choose parts", "success", "independent", { component_outcomes: [{ component_revision_id: f.component.revision_id, outcome: "success" }], claims: [{ component_revision_id: f.component.revision_id, dimension: "discrimination", outcome: "success", evidence: "choose parts" }] });
  expect(f.state().discrimination_evidence.success).toBe(1);
  const other = f.views().find(v => v.component_revision_id === second.revision_id)!;
  expect(other.independent_performance.success).toBe(0);
  expect(other.independent_performance.not_observed).toBe(1);
  expect(other.guidance_state).toBe("needs_orientation");
});

test("review scheduling rejects wrong-conversation or past consent; completion is not success", () => {
  const f = fixture(); f.observe(f.task("Practice before a review"));
  const foreign = f.store.learnerResponse("Yes, review later", "elsewhere");
  const auth = f.authorizeReview(f.component.revision_id, "2026-10-03T12:00:00.000Z");
  const payload = { component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z", consent: true, consent_response_event_id: foreign.event_id, authorization_event_id: auth.event_id, reason: "Learner-approved two-day check" };
  expect(() => f.record("review_scheduled", payload)).toThrow();
  const consent = f.store.learnerResponse("Yes, review in two days", "test");
  expect(() => f.record("review_scheduled", { ...payload, due_at: "2026-09-30T12:00:00.000Z", consent_response_event_id: consent.event_id })).toThrow();
  const scheduled = f.record("review_scheduled", { ...payload, consent_response_event_id: consent.event_id });
  f.time("2026-10-03T12:00:00.000Z");
  const checked = f.observe(f.task("Fresh review problem"), "Wrong method", "failure", "retention");
  f.record("review_completed", { schedule_event_id: scheduled.event_id, assessment_event_id: checked.assessment.event_id });
  const report = evaluateLearning(f.store);
  expect(report.reviews[0]!.completed).toBe(true);
  expect(report.components[0]!.retention.failure).toBe(1);
  expect(report.components[0]!.retention.success).toBe(0);
});

test("time and sequence scopes exclude hypothetical work and future object revisions", () => {
  const f = fixture(); f.observe(f.task("Real practice")); const cutoff = f.store.throughSeq;
  const before = canonical(f.views());
  f.store.append("assessment", { attempt_id: "hypothetical", outcome: "success" }, "hypothetical", "pi", "test", f.store.now(), undefined, "hypothetical");
  expect(canonical(projectComponents(f.store, cutoff, f.store.now()))).toBe(before);
  expect(projectComponents(f.store, f.store.throughSeq, f.store.now())[0]!.independent_performance.success).toBe(1);
  f.time("2026-10-04T12:00:00.000Z"); f.define("component", { ...f.component.body, title: "Future component" });
  expect(projectComponents(f.store, f.store.throughSeq, "2026-10-01T12:00:00.000Z")).toHaveLength(1);
});

test("late-recorded prior practice changes the actual delay only in current corrected history", () => {
  const f = fixture(); const original = f.task("Initial practice"); const initial = f.observe(original);
  f.time("2026-10-03T12:00:00.000Z"); f.observe(f.task("Delayed fresh check"), "Choose parts", "success", "retention"); const before = f.store.throughSeq;
  expect(f.state().retention_evidence.tested_delays_days).toEqual([2]);
  f.store.record({ operation_id: "late-practice", kind: "assistance", expected_goal_revision_id: f.goal.revision_id, occurred_at: "2026-10-02T12:00:00.000Z", payload: { assistance_id: "late-example", instance_revision_id: initial.instance.revision_id, component_revision_ids: [f.component.revision_id], stage: "exposed", kind: "example", content: "Reviewed a parts example yesterday", answer_bearing: true } }, "test");
  expect(f.state().retention_evidence.tested_delays_days).toEqual([1]);
  expect(projectComponents(f.store, before, f.store.now())[0]!.retention_evidence.tested_delays_days).toEqual([2]);
});
