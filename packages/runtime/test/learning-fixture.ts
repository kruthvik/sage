import { randomUUID } from "node:crypto";
import type { Assessment, Component, Goal, Hypothesis, Revision, TaskDefinition } from "../../core/src/contracts.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { nextActionCandidates } from "../src/candidates.ts";
import { proposeReviews } from "../src/reviews.ts";

export function learningFixture(subject = "math", objective = "Choose and execute integration by parts") {
  let at = "2026-10-01T12:00:00.000Z";
  const store = new LearningStore(":memory:", () => at);
  const goal = store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "exam", objective, subject, horizon_days: 30, deadline: "2026-10-05T12:00:00.000Z", budget_minutes: 20, target_format: "open response", criteria: [objective], allowed_aids: [], constraints: ["Keep the next step short"], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "test") as unknown as Revision<Goal>;
  const define = (kind: string, body: unknown, parent?: Revision) => store.define({ operation_id: randomUUID(), kind, body, expected_goal_revision_id: goal.revision_id, ...(parent ? { parent_revision_id: parent.revision_id } : {}) }, "human", "test");
  const component = define("component", { title: objective, behavior: objective, subject, concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Sparse observed evidence", target_dimensions: ["discrimination", "execution"], knowledge_kind: "procedural" }) as unknown as Revision<Component>;
  const rubric = define("rubric", { title: "Public task criterion", dimensions: [{ name: "target", criterion: objective, max_score: 2 }], provisional: false, source_span_ids: [] });
  const family = define("task_family", { title: "Polynomial times exponential", construct: objective, variation: "Numerical coefficients only", lineage_revision_ids: [], component_revision_ids: [component.revision_id], solution_structure: "Choose parts, select u, then execute", method_selection: "Distinguish substitution and parts", representations: ["symbolic"], structural_signature: "integration:polynomial-exponential:v1" });
  const task = (prompt: string, extra: Partial<TaskDefinition> = {}) => define("task_definition", {
    title: prompt, prompt, family_revision_id: family.revision_id, component_revision_ids: [component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: [], format: "free_response", allowed_aids: [], steps: [], scoring: "rubric", status: "practice_ready", review: { method: "curated", reason: "Offline policy fixture, not a calibrated assessment" }, stakes: "low", partition: "practice", changes: [], uncertainty: "Model rubric proposals are conditional", representation: "symbolic", ...extra,
  }) as unknown as Revision<TaskDefinition>;
  const record = (kind: string, payload: unknown, operation_id = randomUUID()) => store.record({ operation_id, kind, payload, expected_goal_revision_id: goal.revision_id }, "test");
  const deliver = (definition: Revision<TaskDefinition>, purpose = "independent") => define("task_instance", { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose, conditions: ["No answer-bearing assistance"] });
  const attempt = (instance: Revision, responseText = "I choose integration by parts.") => {
    const response = store.learnerResponse(responseText, "test"); const id = randomUUID();
    const receipt = record("attempt_submitted", { attempt_id: id, instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] });
    return { id, response, receipt };
  };
  const assess = (attemptId: string, definition: Revision<TaskDefinition>, response: string, outcome = "success", extra: Partial<Assessment> = {}) => record("assessment", { attempt_id: attemptId, rubric_revision_id: definition.body.rubric_revision_id, outcome, scores: [{ dimension: "target", score: outcome === "success" ? 2 : 0, evidence: response }], feedback: "Compare the method with the public criterion.", uncertainty: "Scoped rubric proposal", ...extra });
  const observe = (definition: Revision<TaskDefinition>, responseText = "I choose integration by parts.", outcome = "success", purpose = "independent", extra: Partial<Assessment> = {}) => {
    const instance = deliver(definition, purpose); const submission = attempt(instance, responseText); const assessment = assess(submission.id, definition, responseText, outcome, extra);
    return { instance, ...submission, assessment };
  };
  const views = () => projectComponents(store, store.throughSeq, at);
  const state = () => views().find(v => v.component_revision_id === component.revision_id)!;
  const candidates = () => {
    const all = views(); const components = store.revisions("component") as unknown as Revision<Component>[];
    return nextActionCandidates({ goal: goal.body, views: all, components, as_of_time: at, reviews: proposeReviews(goal.body, all, components, at) });
  };
  const hypothesis = (support: string[], contradict: string[] = [], parent?: Revision, extra: Partial<Hypothesis> = {}) => define("hypothesis", { component_revision_ids: [component.revision_id], category: "selection", description: "May confuse substitution with parts; competing procedural explanation remains possible", confidence: "medium", supporting_evidence_ids: support, contradicting_evidence_ids: contradict, status: "active", first_observed_at: "2026-10-01T12:00:00.000Z", last_observed_at: at, ...extra }, parent);
  return { store, goal, define, component, rubric, family, task, record, deliver, attempt, assess, observe, state, views, candidates, hypothesis, time: (time: string) => { at = time; } };
}
