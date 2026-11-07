import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, Revision, TaskDefinition } from "../../core/src/contracts.ts";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";
import { LearningService } from "../../runtime/src/service.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { canonical } from "../src/store.ts";
import { projectComponents } from "../src/projection.ts";
import { compileContext } from "../../runtime/src/context.ts";

const stores: ReturnType<typeof learningFixture>["store"][] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }
function componentB(f: ReturnType<typeof fixture>) {
  return f.define("component", { title: "Explain the conditions", behavior: "Explain when the method applies", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Unobserved" });
}

test("a holistic rubric outcome does not credit every component of a composite task", () => {
  const f = fixture(), b = componentB(f);
  const task = f.task("Choose a method and explain its conditions", { component_revision_ids: [f.component.revision_id, b.revision_id] });
  f.observe(task, "Integration by parts", "success");
  for (const view of f.views()) {
    expect(view.independent_performance.success).toBe(0);
    expect(view.observations.at(-1)?.outcome).toBe("not_observed");
  }
  // A fresh prompt avoids the prior identical task's possibly exposed answer/feedback.
  const fresh = f.task("Choose a method for a fresh expression and justify its conditions", { component_revision_ids: task.body.component_revision_ids });
  const scoped = f.observe(fresh, "I choose integration by parts", "success", "independent", { component_outcomes: [{ component_revision_id: f.component.revision_id, outcome: "success" }] });
  expect(f.state().independent_performance.success).toBe(1);
  expect(f.views().find(v => v.component_revision_id === b.revision_id)!.independent_performance.success).toBe(0);
  expect(f.store.event(scoped.assessment.event_id).payload.outcome).toBe("success");
});

test("hypotheses cannot borrow a holistic result for an unobserved composite component", () => {
  const f = fixture(), b = componentB(f);
  const task = f.task("A composite response", { component_revision_ids: [f.component.revision_id, b.revision_id] });
  const work = f.observe(task, "Integration by parts", "failure", "independent", { component_outcomes: [{ component_revision_id: f.component.revision_id, outcome: "failure" }] });
  expect(() => f.hypothesis([work.assessment.event_id], [], undefined, { component_revision_ids: [b.revision_id] })).toThrow("observed");
});

test("matching a composite task's objective key cannot establish its unobserved reasoning components", () => {
  const f = fixture(), b = componentB(f);
  const task = f.task("Give the numeric result and explain the method", { component_revision_ids: [f.component.revision_id, b.revision_id], scoring: "numeric", answer: "5" });
  const work = f.observe(task, "5", "success", "independent", { component_outcomes: [{ component_revision_id: f.component.revision_id, outcome: "success" }, { component_revision_id: b.revision_id, outcome: "not_observed" }], claims: [{ component_revision_id: f.component.revision_id, dimension: "execution", outcome: "success", evidence: "5" }] });
  expect((work.assessment.payload.component_outcomes as Array<{ outcome: string }>)[1]!.outcome).toBe("not_observed");
  expect((work.assessment.payload.claims as Array<{ outcome: string }>)[0]!.outcome).toBe("not_observed");
  expect(f.views().find(v => v.component_revision_id === b.revision_id)!.observations.at(-1)?.outcome).toBe("not_observed");
  expect(f.views().every(v => v.independent_performance.success === 0)).toBe(true);
  expect(() => f.assess(work.id, task, "5", "success", { claims: [{ component_revision_id: b.revision_id, dimension: "explanation", outcome: "success", evidence: "5" }] })).toThrow("cannot establish explanation");
});

test("a task-B response cannot be attached to task-A's step, even in the same conversation", () => {
  const f = fixture(); const a = f.attempt(f.deliver(f.task("Task A")));
  const b = f.attempt(f.deliver(f.task("Task B")), "My response to B");
  const seq = f.store.throughSeq;
  expect(() => f.record("step_attempt", { step_attempt_id: "borrowed", attempt_id: a.id, step: "A step", response_event_id: b.response.event_id, prior_step_ids: [] })).toThrow("task");
  expect(f.store.throughSeq).toBe(seq);
});

test("unsubmitted captured task-B text also cannot masquerade as task-A's step", () => {
  const f = fixture(); const aInstance = f.deliver(f.task("Task A")); const a = f.attempt(aInstance);
  const bInstance = f.deliver(f.task("Task B"));
  const response = f.store.learnerResponse("Working on B", "test", randomUUID(), { goal_revision_id: f.goal.revision_id, instance_revision_id: bInstance.revision_id });
  expect(() => f.record("step_attempt", { step_attempt_id: "captured-b", attempt_id: a.id, step: "A step", response_event_id: response.event_id, prior_step_ids: [] })).toThrow("task");
});

test("declared steps require membership while explicitly spontaneous work stays attributable", () => {
  const f = fixture(); const task = f.task("Explain the derivation", { steps: ["Choose u", "Integrate dv"] });
  const instance = f.deliver(task), a = f.attempt(instance, "u is x");
  expect(() => f.record("step_attempt", { step_attempt_id: "invented", attempt_id: a.id, step: "Invented required step", response_event_id: a.response.event_id, prior_step_ids: [] })).toThrow("declared");
  const step = f.record("step_attempt", { step_attempt_id: "valid", attempt_id: a.id, step: "Choose u", response_event_id: a.response.event_id, prior_step_ids: [] });
  expect(step.payload.response).toBe("u is x");
  const response = f.store.learnerResponse("I noticed a useful boundary condition", "test", randomUUID(), { goal_revision_id: f.goal.revision_id, instance_revision_id: instance.revision_id });
  const spontaneous = f.record("step_attempt", { step_attempt_id: "aside", attempt_id: a.id, step: "Boundary observation", spontaneous: true, response_event_id: response.event_id, prior_step_ids: ["valid"] });
  expect(spontaneous.payload.response).toBe("I noticed a useful boundary condition");
});

test("steps reject pre-attempt text, duplicate prerequisites and another attempt's dependencies", () => {
  const f = fixture(), task = f.task("A declared derivation", { steps: ["Choose u"] });
  const instance = f.deliver(task);
  const premature = f.store.learnerResponse("A note before the full attempt", "test", randomUUID(), { goal_revision_id: f.goal.revision_id, instance_revision_id: instance.revision_id });
  const a = f.attempt(instance, "u is x");
  expect(() => f.record("step_attempt", { step_attempt_id: "premature", attempt_id: a.id, step: "Choose u", response_event_id: premature.event_id, prior_step_ids: [] })).toThrow("follow its attempt");
  f.record("step_attempt", { step_attempt_id: "a-step", attempt_id: a.id, step: "Choose u", response_event_id: a.response.event_id, prior_step_ids: [] });
  const b = f.attempt(f.deliver(task), "u is a polynomial");
  f.record("step_attempt", { step_attempt_id: "b-step", attempt_id: b.id, step: "Choose u", response_event_id: b.response.event_id, prior_step_ids: [] });
  const response = f.store.learnerResponse("An independent observation", "test", randomUUID(), { goal_revision_id: f.goal.revision_id, instance_revision_id: instance.revision_id });
  const body = { step_attempt_id: "aside", attempt_id: a.id, step: "Observation", spontaneous: true, response_event_id: response.event_id };
  expect(() => f.record("step_attempt", { ...body, prior_step_ids: ["b-step"] })).toThrow("Invalid dependent step");
  expect(() => f.record("step_attempt", { ...body, prior_step_ids: ["a-step", "a-step"] })).toThrow();
  expect(f.record("step_attempt", { ...body, prior_step_ids: ["a-step"] }).payload.response).toBe("An independent observation");
});

test("an unscoped step assessment does not certify all composite-task components", () => {
  const f = fixture(), b = componentB(f);
  const task = f.task("A composite derivation", { component_revision_ids: [f.component.revision_id, b.revision_id] });
  const instance = f.deliver(task), a = f.attempt(instance, "Choose integration by parts");
  f.record("step_attempt", { step_attempt_id: "s", attempt_id: a.id, step: "Method choice", response_event_id: a.response.event_id, prior_step_ids: [] });
  f.assess(a.id, task, "integration by parts", "success", { step_attempt_id: "s" });
  for (const view of f.views()) expect(view.diagnostic_steps.at(-1)?.outcome).toBe("not_observed");
  expect(f.views().every(v => v.independent_performance.success === 0)).toBe(true);
});

test("legacy learner-approved human review is not expert validation for changed application", () => {
  const f = fixture(); const baseline = f.task("Choose a method for an integral"); f.observe(baseline);
  const task = f.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: f.goal.revision_id, body: { ...baseline.body, prompt: "Apply the relation to a heat-flow case", variation: { baseline_definition_revision_id: baseline.revision_id, dimensions: ["context"], invariant: "Same mathematical relation", rationale: "Changed application" }, review: { method: "human", reason: "Learner approved public criteria" } } }, "learner", "test") as unknown as Revision<TaskDefinition>;
  f.observe(task, "Integration by parts solves the relation", "success", "application");
  expect(f.state().transfer_evidence.success).toBe(0);
  expect(f.state().observations.at(-1)?.transfer_eligible).toBe(false);
  const context = compileContext(f.store, {}, "", "test");
  expect(context.task).toMatchObject({ review_role: "learner" });
  expect(f.store.revision<TaskDefinition>(task.revision_id).body.review.reviewer_role).toBeUndefined();
});

test("expert review requires trusted actor provenance, not a model-written role", () => {
  const f = fixture(), base = f.task("A bounded practice item");
  const body = { ...base.body, prompt: "An externally reviewed item", stakes: "high", review: { method: "human", reviewer_role: "expert", reviewer_provenance: "Synthetic expert-review fixture; not real credential verification", reason: "External reviewer attestation" } };
  const input = { operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: f.goal.revision_id, body };
  expect(() => f.store.define({ ...input, body: { ...body, status: "candidate" } }, "pi", "test")).toThrow("expert actor");
  expect(() => f.store.define(input, "learner", "test")).toThrow("expert actor");
  const reviewed = f.store.define(input, "expert", "test");
  expect(reviewed.body.review).toMatchObject({ method: "human", reviewer_role: "expert" });
});

test("component corrections replace only observed claims and preserve fixed-cutoff evidence", () => {
  const f = fixture(), b = componentB(f);
  const task = f.task("Choose a method and explain when it applies", { component_revision_ids: [f.component.revision_id, b.revision_id] });
  const work = f.observe(task, "Parts; it applies to a product", "failure", "independent", { component_outcomes: [{ component_revision_id: f.component.revision_id, outcome: "failure" }], claims: [{ component_revision_id: f.component.revision_id, dimension: "execution", outcome: "failure", evidence: "Parts" }] });
  const cutoff = f.store.throughSeq, original = canonical(f.store.event(work.assessment.event_id));
  const historical = canonical(projectComponents(f.store, cutoff, "2026-10-01T12:00:00.000Z"));
  expect(() => f.assess(work.id, task, "Parts", "success", { correction_of_event_id: work.assessment.event_id, claims: [{ component_revision_id: b.revision_id, dimension: "explanation", outcome: "success", evidence: "An invented rationale" }] })).toThrow("actual response quote");
  f.assess(work.id, task, "Parts", "success", { correction_of_event_id: work.assessment.event_id, component_outcomes: [{ component_revision_id: b.revision_id, outcome: "success" }], claims: [{ component_revision_id: b.revision_id, dimension: "explanation", outcome: "success", evidence: "applies to a product" }] });
  expect(f.state().independent_performance.success).toBe(0);
  expect(f.state().execution_evidence.failure).toBe(0);
  const correctedB = f.views().find(v => v.component_revision_id === b.revision_id)!;
  expect(correctedB.independent_performance.success).toBe(1);
  expect(correctedB.explanation_evidence.success).toBe(1);
  expect(canonical(projectComponents(f.store, cutoff, "2026-10-01T12:00:00.000Z"))).toBe(historical);
  expect(canonical(f.store.event(work.assessment.event_id))).toBe(original);
});

test("projection replay leaves original evidence unchanged", () => {
  const f = fixture(); f.observe(f.task("One observed target"));
  const events = canonical(f.store.events()), revisions = canonical(f.store.revisions());
  const first = canonical(f.views()); f.store.rebuild();
  expect(canonical(f.views())).toBe(first);
  expect(canonical(f.store.events())).toBe(events);
  expect(canonical(f.store.revisions())).toBe(revisions);
});

test("trusted learner approval records its role and cannot approve high-stakes expert validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-review-role-")); const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths);
  try {
    const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Construct an argument", subject: "writing", horizon_days: 7, target_format: "argument", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "test") as unknown as Revision<Goal>;
    const base = installFixtures(service.store, goal)[0]!;
    const candidate = service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...base.body, prompt: "Argue whether a new library policy should continue", status: "candidate", review: { method: "unreviewed", reason: "Generated practice" } } }, "pi", "test");
    const approved = service.approveTask(candidate.revision_id, "Learner reviewed public criteria", "test") as unknown as Revision<TaskDefinition>;
    expect(approved.body.review).toMatchObject({ method: "human", reviewer_role: "learner" });
    const high = service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...base.body, prompt: "A high-stakes external assessment", stakes: "high", status: "candidate", review: { method: "unreviewed", reason: "External validation absent" } } }, "pi", "test");
    expect(() => service.approveTask(high.revision_id, "Learner acceptance", "test")).toThrow("expert");
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
