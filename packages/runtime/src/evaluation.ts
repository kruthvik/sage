import type { ComponentView } from "../../storage/src/projection.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { PROJECTOR_VERSION, POLICY_VERSION } from "../../core/src/learning.ts";

/** Descriptive local outcomes. No engagement objective or unsupported causal comparison. */
export function evaluateLearning(store: LearningStore, throughSeq = store.throughSeq, asOfTime = store.now()) {
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.occurred_at <= asOfTime);
  const views = projectComponents(store, throughSeq, asOfTime);
  const completed = new Set(events.filter(e => e.kind === "review_completed").map(e => e.payload.schedule_event_id));
  const decisions = events.filter(e => e.kind === "decision" && e.payload.action !== "revision_defined");
  return {
    through_seq: throughSeq, as_of_time: asOfTime, projector_version: PROJECTOR_VERSION, policy_version: POLICY_VERSION,
    components: views.map(componentOutcomes),
    assistance_exposures: events.filter(e => e.kind === "assistance" && ["exposed", "possibly_exposed"].includes(e.payload.stage as string)).map(e => ({ event_id: e.event_id, kind: e.payload.kind, stage: e.payload.stage, answer_bearing: e.payload.answer_bearing })),
    reviews: events.filter(e => e.kind === "review_scheduled").map(e => ({ schedule_event_id: e.event_id, component_revision_id: e.payload.component_revision_id, due_at: e.payload.due_at, completed: completed.has(e.event_id) })),
    decisions: decisions.map(e => ({ event_id: e.event_id, action: e.payload.action, policy_version: e.payload.policy_version ?? "legacy", evidence_ids: e.payload.evidence_event_ids, selected_candidate_id: e.payload.selected_candidate_id, candidate_ids: e.payload.candidate_ids, reason_codes: e.payload.reason_codes, user_override: e.payload.user_override ?? false })),
    declared_abandonments: decisions.filter(e => e.payload.action === "abandon").map(e => ({ event_id: e.event_id, evidence_event_ids: e.payload.evidence_event_ids })),
    checkpoints: events.filter(e => e.kind === "checkpoint").map(e => ({ event_id: e.event_id, stopped: e.payload.stopped, gaps: e.payload.gaps })),
    learner_reported_work_seconds: events.filter(e => e.kind === "attempt_submitted" && typeof e.payload.learner_reported_work_seconds === "number").reduce((sum, e) => sum + Number(e.payload.learner_reported_work_seconds), 0),
    timing_note: "Elapsed calendar time to first independent success is not learning time. Unreported work duration and abandonment are unknown; stop checkpoints are not inferred abandonment.",
    evaluation_note: "Descriptive observations, not evidence that this policy caused learning. Compare policies only with matched content, time, assistance, and independent delayed/application outcomes.",
  };
}
function componentOutcomes(view: ComponentView) {
  const firstAttempt = view.observations.map(o => o.observed_at).sort()[0];
  const firstIndependent = view.independent.filter(o => o.outcome === "success").map(o => o.observed_at).sort()[0];
  return { component_revision_id: view.component_revision_id, acquisition: view.acquisition_evidence, independent: view.independent_performance, supported: view.supported_performance, uncertain: view.uncertain_performance,
    retention: view.retention_evidence, transfer: view.transfer_evidence, discrimination: view.discrimination_evidence, explanation: view.explanation_evidence, fluency: view.fluency_evidence,
    family_exposure: view.family_exposure, representation_exposure: view.representation_exposure, coverage_debt: view.coverage_debt,
    error_recurrence: view.observations.filter(o => o.outcome === "failure").map(o => ({ assessment_event_id: o.assessment_event_id, category: o.error_category ?? "unknown" })),
    elapsed_calendar_seconds_to_first_independent_success: firstAttempt && firstIndependent ? Math.max(0, (Date.parse(firstIndependent) - Date.parse(firstAttempt)) / 1000) : null,
  };
}
