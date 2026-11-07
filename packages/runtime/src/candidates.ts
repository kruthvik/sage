import type { Component, Goal, Revision } from "../../core/src/contracts.ts";
import { POLICY_VERSION, type LearningActionType, type NextActionCandidate, type ReviewProposal } from "../../core/src/learning.ts";
import type { ComponentView } from "../../storage/src/projection.ts";
import type { AcceptedReview } from "./reviews.ts";
import { canCompressPractice, learnReadiness } from "./practice-policy.ts";

export interface TeachingSupport {
  route: "paced" | "targeted_repair" | "fresh_evaluation";
  support: "scaffold" | "faded" | "light";
  unknown_prerequisite_revision_ids: string[];
  supporting_evidence_ids: string[];
}
/** Derived guidance from host-projected evidence, never persisted competence or caller authority. */
export function teachingSupport(view?: ComponentView, component?: Component, prerequisiteViews: ComponentView[] = []): TeachingSupport {
  const applicable = (v: ComponentView) => v.observations.filter(o => o.component_revision_id === v.component_revision_id && v.evidence_ids.includes(o.assessment_event_id) && o.observed_at <= v.as_of_time).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const observations = view ? applicable(view) : [];
  const recent = observations.at(-1);
  const complete = (o: typeof recent) => !!o && o.outcome === "success" && o.criterion_evidence.length > 0 && o.criterion_evidence.every(c => c.observed && c.satisfied);
  const prerequisites = (component?.prerequisite_revision_ids ?? []).map(id => ({ id, observation: prerequisiteViews.find(v => v.component_revision_id === id) }));
  const unknown = prerequisites.filter(p => { const latest = p.observation && applicable(p.observation).at(-1); return !complete(latest) || latest?.eligibility !== "independent"; }).map(p => p.id);
  const blocked = view?.unresolved_gaps.some(h => h.category === "prerequisite" && ["active", "weakened"].includes(h.derived_status) && h.prerequisite_component_revision_id && prerequisites.some(p => p.id === h.prerequisite_component_revision_id && p.observation && applicable(p.observation).at(-1)?.eligibility === "independent" && applicable(p.observation).at(-1)?.outcome === "failure"));
  const repair = blocked || recent?.outcome === "failure" || recent?.outcome === "partial";
  const light = !repair && !unknown.length && complete(recent) && !!view && canCompressPractice({ ...view, observations }, component);
  return { route: repair ? "targeted_repair" : light ? "fresh_evaluation" : "paced", support: repair || !complete(recent) || unknown.length ? "scaffold" : light ? "light" : "faded", unknown_prerequisite_revision_ids: unknown,
    supporting_evidence_ids: [...new Set([...observations.map(o => o.assessment_event_id), ...prerequisites.flatMap(p => p.observation ? applicable(p.observation).map(o => o.assessment_event_id) : [])])].slice(-5) };
}

export interface CandidateInput { goal: Goal; views: ComponentView[]; prerequisite_views?: ComponentView[]; components: Revision<Component>[]; reviews: ReviewProposal[]; accepted_reviews?: AcceptedReview[]; as_of_time: string; stopped?: boolean; task_reliable?: boolean }
/** A short menu, not an autonomous controller. Priorities are ordinal engineering defaults. */
export function nextActionCandidates(input: CandidateInput): Array<NextActionCandidate & { teaching_support: TeachingSupport }> {
  const { goal, views } = input;
  const all = new Map([...(input.prerequisite_views ?? []), ...views].map(v => [v.component_revision_id, v]));
  const metadata = new Map(input.components.map(c => [c.revision_id, c.body]));
  const proposals: Array<{ priority: number; candidate: NextActionCandidate & { teaching_support: TeachingSupport } }> = [];
  const near = goal.mode !== "learn" && goal.deadline ? Date.parse(goal.deadline) - Date.parse(input.as_of_time) <= 7 * 86400000 : false;
  const dueAccepted = new Set((input.accepted_reviews ?? []).filter(r => r.status === "pending" && r.due).map(r => r.component_revision_id));
  const isReviewDue = (compRevisionId: string) => dueAccepted.has(compRevisionId) || input.reviews.some(r => r.component_revision_id === compRevisionId && r.due);
  function add(type: LearningActionType, view: ComponentView | undefined, reasons: string[], priority: number, targets = view ? [view.component_revision_id] : []) {
    const hypotheses = view?.unresolved_gaps.filter(h => h.derived_status === "active" || h.derived_status === "weakened") ?? [];
    const evidence = [...new Set([...(view?.evidence_ids.slice(-3) ?? []), ...hypotheses.flatMap(h => [...h.supporting_evidence_ids, ...h.contradicting_evidence_ids])])].slice(-5);
    const component = view && metadata.get(view.component_revision_id);
    if (component?.importance === "high" || goal.exam?.topic_weights.some(w => targets.includes(w.component_revision_id) && w.importance === "high")) priority += 1;
    proposals.push({ priority, candidate: { id: `${POLICY_VERSION}:${type}:${targets.join(",") || "goal"}`, type, target_component_revision_ids: targets, reason_codes: reasons, supporting_evidence_ids: evidence, hypothesis_revision_ids: hypotheses.slice(0, 2).map(h => h.revision_id),
      teaching_support: teachingSupport(view, component, [...all.values()]),
      features: { goal_relevance: "active", deadline_relevance: goal.mode === "learn" ? "unspecified" : near ? "near" : goal.deadline ? "later" : "unspecified", prerequisite_blockage: type === "prerequisite_repair", evidence_uncertainty: view?.uncertainty ?? "high", support_dependency: view?.support_dependency ?? "unknown", retention_need: isReviewDue(view?.component_revision_id ?? ""), transfer_need: !!view?.independent_performance.success && !view?.transfer_evidence.success, discrimination_need: !!view?.discrimination_evidence.failure || hypotheses.some(h => h.category === "selection"), family_overexposure: !!view?.family_exposure.some(f => f.recent_attempts >= 3) && (view?.family_exposure.filter(f => f.recent_attempts).length ?? 0) < 2, coverage_debt: view?.coverage_debt ?? [], learner_cost: ["checkpoint", "orient", "contrast", "discriminate", "misconception_probe", "advance"].includes(type) ? "small" : "moderate" },
      constraints: [...goal.constraints.slice(0, 3).map(c => c.slice(0, 160)), `allowed_aids: ${goal.allowed_aids.join(", ").slice(0, 300) || "none specified"}`, ...(goal.mode === "learn" ? ["Time is informational; the learner may pause, but do not compress evidence or advance to meet a budget"] : goal.budget_minutes ? [`Scope to ${goal.budget_minutes} available minutes; learner may stop earlier`] : [])], policy_version: POLICY_VERSION } });
  }
  if (input.stopped) { add("checkpoint", undefined, ["learner_stop_intent"], 100); return proposals.map(p => p.candidate); }
  if (input.task_reliable === false) { add("checkpoint", undefined, ["task_source_or_rubric_unreliable", "verify_before_interpreting"], 100); return proposals.map(p => p.candidate); }
  for (const view of views) {
    const component = metadata.get(view.component_revision_id);
    const recent = [...view.observations].filter(o => o.outcome !== "not_observed").sort((a, b) => a.observed_at.localeCompare(b.observed_at)).at(-1);
    const hypotheses = view.unresolved_gaps.filter(h => h.derived_status === "active" || h.derived_status === "weakened");
    const blocking = hypotheses.find(h => h.category === "prerequisite" && h.prerequisite_component_revision_id && (component?.prerequisite_revision_ids ?? []).includes(h.prerequisite_component_revision_id) && all.get(h.prerequisite_component_revision_id)?.independent_performance.failure);
    if (blocking) add("prerequisite_repair", view, ["evidenced_blocking_prerequisite", "prerequisite_link_is_hypothesis"], 95, [blocking.prerequisite_component_revision_id!, view.component_revision_id]);
    if (hypotheses.length) add(hypotheses.some(h => h.category === "selection") ? "discriminate" : "misconception_probe", view, ["competing_error_explanations", "probe_can_discriminate_hypotheses"], 88);
    if (goal.mode === "exam" && goal.exam) add("assessment", view, ["declared_exam_format_and_aids", "fresh_exam_format_mini_set", "coverage_not_predicted_score"], 92);
    if (goal.mode === "cram") {
      if (!recent) add("assessment", view, ["small_representative_diagnostic", "declared_blueprint_not_profile"], 87);
      else if (recent.outcome === "partial" || recent.outcome === "failure") add("retrieval", view, ["important_recoverable_gap", "concise_refresher_then_retrieval_and_corrective_feedback", "intervening_material_before_feasible_recheck"], 89);
      else add("assessment", view, ["fresh_exam_format_mini_set", "report_unknown_coverage_and_remaining_gaps"], 82);
    }
    if (!recent) { add("orient", view, ["sparse_evidence", "skip_diagnostic_does_not_mean_beginner"], 65); add("worked_example", view, ["use_only_if_meaningful_attempt_not_possible"], 55); continue; }
    if (recent.eligibility !== "independent" && recent.outcome === "success") add("fade_support", view, ["supported_success_not_independent", "fresh_task_with_less_answer_bearing_help"], 90);
    if (recent.outcome === "failure" || recent.outcome === "partial") {
      const failures = view.observations.slice(-3).filter(o => o.outcome === "failure").length;
      if (failures >= 2) add("representation_change", view, ["repeated_remediation_stall", "reassess_hypothesis_or_replan"], 91);
      const error = recent.error_category;
      const type: LearningActionType = error === "selection" ? "contrast" : error === "representation" ? "representation_change" : error === "careless_error" ? "independent_practice" : error === "procedural" ? "completion_problem" : error === "conceptual" ? "contrast" : "scaffold";
      add(type, view, [error ? `error_${error}` : "error_cause_uncertain", error === "careless_error" ? "target_slip_not_whole_concept" : "targeted_correction_then_fresh_attempt"], 85);
    }
    const accelerated = goal.mode === "accelerate";
    const compression = accelerated && canCompressPractice(view, component);
    if (recent.eligibility === "independent" && recent.outcome === "success") {
      if (view.family_exposure.length <= 1) add("contrast", view, ["familiar_family_success", "change_meaningful_dimension_not_only_numbers"], 72);
      if (!view.transfer_evidence.success) add("transfer_check", view, ["independence_observed", "changed_application_unknown"], accelerated ? 86 : 68);
      if ((component?.target_dimensions ?? []).includes("discrimination") && !view.discrimination_evidence.success) add("discriminate", view, ["selection_goal_not_yet_evidenced"], 78);
      if ((!accelerated || compression) && (goal.mode !== "learn" || learnReadiness(view, metadata.get(view.component_revision_id)).ready)) add("advance", view, ["independent_success_for_current_goal", compression ? "evidenced_compression_not_assumed_ability" : accelerated ? "compression_requires_changed_independent_evidence" : "conditional_on_learner_goal_not_permanent_mastery"], compression ? 88 : accelerated ? 52 : near ? 73 : 52);
    }
    if (isReviewDue(view.component_revision_id)) add("retrieval", view, ["goal_relevant_delayed_check_due", "elapsed_time_is_uncertainty_not_failure"], near ? 76 : 80);
  }
  add("checkpoint", undefined, ["learner_control", "report_coverage_and_durability_uncertainty"], 1);
  const sorted = proposals.sort((a, b) => b.priority - a.priority || a.candidate.id.localeCompare(b.candidate.id));
  const checkpoint = sorted.find(p => p.candidate.type === "checkpoint")!;
  return [...sorted.filter(p => p !== checkpoint).slice(0, 4), checkpoint].map(p => p.candidate);
}
