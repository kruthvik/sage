import type { Component, Goal, Revision, Rubric, TaskDefinition } from "../../core/src/contracts.ts";
import { validTime } from "../../core/src/contracts.ts";
import type { ComponentView } from "../../storage/src/projection.ts";

/** Conservative engineering eligibility, not an ability estimate or optimal learning schedule. */
export function canCompressPractice(view: ComponentView, component?: Component): boolean {
  const observed = view.observations.filter(o => o.outcome !== "not_observed");
  const recent = observed.at(-1);
  const independentSuccesses = observed.filter(o => o.eligibility === "independent" && o.outcome === "success");
  const required = component?.target_dimensions;
  const originalCriteria = new Set(observed.flatMap(o => o.criterion_evidence.map(c => `${c.name}\n${c.criterion}`)));
  const satisfied = new Set(recent?.criterion_evidence.filter(c => c.satisfied).map(c => `${c.name}\n${c.criterion}`));
  return !!recent && recent.eligibility === "independent" && recent.outcome === "success"
    && new Set(independentSuccesses.map(o => o.definition_revision_id)).size >= 2
    && recent.transfer_eligible && !!required?.length
    && required.every(d => recent.claims.some(c => c.dimension === d && c.outcome === "success"))
    && [...originalCriteria].every(c => satisfied.has(c))
    && !view.unresolved_gaps.some(h => h.derived_status === "active" || h.derived_status === "weakened");
}

export interface LearnReadiness {
  component_revision_id: string;
  ready: boolean;
  independent_definition_count: number;
  unmet_requirements: string[];
  evidence_event_ids: string[];
  epistemic_status: "conditional_engineering_gate_not_mastery";
}

/** Three distinct checks are a conservative workflow default, not a universal mastery threshold. */
export function learnReadiness(view: ComponentView, component?: Component, criteria: ReadonlyArray<{ name: string; criterion: string }> = view.observations[0]?.criterion_evidence ?? [], conditionalApplications: ReadonlySet<string> = new Set(), originalDefinitions?: ReadonlySet<string>): LearnReadiness {
  const original = new Set(criteria.map(c => `${c.name}\n${c.criterion}`));
  const coversOriginal = (observation: ComponentView["observations"][number] | undefined) => {
    const satisfied = new Set(observation?.criterion_evidence.filter(c => c.observed && c.satisfied).map(c => `${c.name}\n${c.criterion}`));
    return !!observation && (!originalDefinitions || originalDefinitions.has(observation.definition_revision_id)) && original.size > 0 && [...original].every(key => satisfied.has(key));
  };
  const independent = view.observations.filter(o => o.eligibility === "independent" && o.purpose !== "practice" && o.outcome === "success" && coversOriginal(o));
  const definitions = new Set(independent.map(o => o.definition_revision_id));
  const latest = view.observations.at(-1);
  const dimensions = new Set(independent.flatMap(o => o.claims.filter(c => c.outcome === "success" && c.component_revision_id === view.component_revision_id).map(c => c.dimension)));
  const unmet: string[] = [];
  if (definitions.size < 3) unmet.push("independent_repetition");
  if (!dimensions.has("explanation")) unmet.push("conceptual_explanation");
  if (!dimensions.has("discrimination")) unmet.push("method_discrimination");
  if ((component?.target_dimensions ?? []).some(d => !dimensions.has(d))) unmet.push("target_dimensions");
  if (!independent.some(o => o.transfer_eligible || conditionalApplications.has(o.definition_revision_id))) unmet.push("changed_application");
  if (!latest || latest.eligibility !== "independent" || latest.purpose === "practice" || latest.outcome !== "success") unmet.push("latest_independent_recheck");
  if (!coversOriginal(latest)) unmet.push("original_criteria");
  if (view.unresolved_gaps.some(h => ["active", "weakened"].includes(h.derived_status) && !["careless_error", "unknown"].includes(h.category))) unmet.push("blocking_gap");
  return {
    component_revision_id: view.component_revision_id, ready: unmet.length === 0,
    independent_definition_count: definitions.size, unmet_requirements: unmet,
    evidence_event_ids: [...new Set([...independent.map(o => o.assessment_event_id), ...(latest ? [latest.assessment_event_id] : [])])].slice(-8),
    epistemic_status: "conditional_engineering_gate_not_mastery",
  };
}

export function examFormats(goal: Goal): TaskDefinition["format"][] {
  const declared = goal.exam?.format ?? goal.target_format;
  const formats: TaskDefinition["format"][] = [];
  if (/mcq|choice|select/i.test(declared)) formats.push("mcq", "discriminate");
  if (/solve|calculat|problem/i.test(declared)) formats.push("solve");
  if (/explain|essay|argu|oral|writing|open response|free.response/i.test(declared)) formats.push("free_response", "explain");
  if (/code|debug|program/i.test(declared)) formats.push("code");
  if (/draw|diagram/i.test(declared)) formats.push("draw");
  if (/perform|practic|laboratory/i.test(declared)) formats.push("perform");
  return formats;
}

/** Selects only reviewed, fresh owned work; it does not generate or certify task quality. */
export function selectPracticeTask(goal: Goal, views: ComponentView[], tasks: Revision<TaskDefinition>[], rubrics: Revision<Rubric>[], delivered: Set<string>) {
  const formats = examFormats(goal), exam = goal.mode === "exam" || goal.mode === "cram";
  const rubricMap = new Map(rubrics.map(r => [r.revision_id, r.body]));
  const gaps = new Map(views.map(v => [v.component_revision_id, v.observations.at(-1)?.criterion_evidence.filter(c => !c.satisfied) ?? []]));
  const choices = tasks.filter(t => !delivered.has(t.revision_id) && t.body.status === "practice_ready" && t.body.partition === "practice" && t.body.review.method !== "unreviewed"
    && t.body.component_revision_ids.some(id => views.some(v => v.component_revision_id === id))
    && (!exam || (!formats.length || formats.includes(t.body.format)) && t.body.allowed_aids.every(a => goal.allowed_aids.includes(a))))
    .map(t => {
      const criteria = rubricMap.get(t.body.rubric_revision_id)?.dimensions ?? [];
      const repairs = t.body.component_revision_ids.flatMap(id => gaps.get(id) ?? []).filter(g => criteria.some(c => c.name === g.name && c.criterion === g.criterion)).length;
      const importance = Math.max(...t.body.component_revision_ids.map(id => goal.exam?.topic_weights.find(w => w.component_revision_id === id)?.importance === "high" ? 2 : 0));
      const changed = !!t.body.variation && t.body.variation.dimensions.some(d => d !== "surface");
      const priority = goal.mode === "learn" ? repairs * 3 + (t.body.format === "explain" ? 1 : 0)
        : goal.mode === "cram" ? importance * 4 + repairs * 2 + (changed ? 1 : 0)
          : goal.mode === "accelerate" ? (changed ? 10 : 0) + repairs : 0;
      return { task: t, priority };
    }).sort((a, b) => b.priority - a.priority || b.task.created_seq - a.task.created_seq);
  const selected = choices[0]?.task;
  return selected ? { definition_revision_id: selected.revision_id, rubric_revision_id: selected.body.rubric_revision_id, component_revision_ids: selected.body.component_revision_ids, format: selected.body.format, allowed_aids: selected.body.allowed_aids,
    purpose: selected.body.variation ? "application" : "independent", reason: goal.mode === "learn" ? "repair_original_criterion_gap" : goal.mode === "exam" ? "declared_exam_format_and_aids" : goal.mode === "cram" ? "representative_diagnostic_then_important_recoverable_gaps_and_fresh_mini_set" : "independent_changed_demand_recheck", confidence: "engineering_default_not_calibrated" } : null;
}

export function practicePolicy(goal: Goal, views: ComponentView[], components: Revision<Component>[], asOfTime: string) {
  const now = Date.parse(validTime(asOfTime));
  const deadline = goal.deadline ? Date.parse(validTime(goal.deadline)) : null;
  const remaining = deadline === null ? null : Math.max(0, (deadline - now) / 60000);
  const profile = goal.learning_preferences?.profile ?? "balanced";
  const regime = goal.mode;
  const availableWindows = goal.study_windows?.map(w => ({ start: validTime(w.start), end: validTime(w.end) })) ?? null;
  const feasibleWindows = availableWindows?.map(w => ({ start: Math.max(now, Date.parse(w.start)), end: Math.min(deadline ?? Infinity, Date.parse(w.end)) })).filter(w => w.end > w.start) ?? null;
  const windowMinutes = feasibleWindows?.reduce((sum, w) => sum + (w.end - w.start) / 60000, 0) ?? null;
  const metadata = new Map(components.map(c => [c.revision_id, c.body]));
  const importance = (id: string) => goal.exam?.topic_weights.find(w => w.component_revision_id === id)?.importance ?? metadata.get(id)?.importance ?? "unknown";
  const demand = /essay|oral|defen|argu|explain|open response|writing/i.test(goal.target_format) ? "reasoned_production"
    : /perform|practic|laboratory|speak|pronunc/i.test(goal.target_format) ? "observable_performance_with_modality_limits"
      : /code|debug|program/i.test(goal.target_format) ? "code_and_explanation"
        : /choice|mcq|select|discrimin/i.test(goal.target_format) ? "selection_and_optional_reasoning" : "problem_or_retrieval_as_specified";
  const rank = (id: string) => importance(id) === "high" ? 2 : importance(id) === "low" ? 0 : 1;
  const priorities = [...views].sort((a, b) => rank(b.component_revision_id) - rank(a.component_revision_id))
    .slice(0, 4).map(v => {
      const latest = v.observations.filter(o => o.outcome !== "not_observed").at(-1);
      const gap = latest?.outcome === "failure" || latest?.outcome === "partial" ? "observed_gap_candidate_for_bounded_repair"
        : !v.independent_performance.success ? "independence_unknown" : !v.transfer_evidence.success ? "changed_task_unknown" : "current_success_not_permanent_mastery";
      return { component_revision_id: v.component_revision_id, exam_importance: importance(v.component_revision_id), gap, evidence_event_ids: v.evidence_ids.slice(-2) };
    });
  return {
    regime, profile, minutes_to_deadline: remaining, budget_minutes: goal.budget_minutes ?? null,
    time_pressure: regime === "learn" ? "informational_not_advancement" : "respect_declared_mode_constraints",
    learn_progression: regime === "learn" ? views.map(view => learnReadiness(view, metadata.get(view.component_revision_id))) : null,
    feasible_session_minutes: remaining === null && windowMinutes === null ? goal.budget_minutes ?? null : Math.min(remaining ?? Infinity, windowMinutes ?? Infinity, goal.budget_minutes ?? Infinity),
    available_study_windows: availableWindows, feasible_window_minutes: windowMinutes,
    separated_recheck: feasibleWindows === null ? "windows_unknown" : feasibleWindows.length > 1 ? "separate_window_feasible" : "after_intervening_material_if_feasible",
    cram_sequence: regime === "cram" ? ["small_representative_diagnostic", "important_recoverable_gaps_and_prerequisites", "concise_refresher_retrieval_corrective_feedback", "intervening_material_then_feasible_recheck", "fresh_exam_format_mini_set", "honest_coverage_gap_report"] : [],
    coverage: views.map(v => ({ component_revision_id: v.component_revision_id, importance: importance(v.component_revision_id), independent_observed: v.independent_performance.success > 0, changed_task_observed: v.transfer_evidence.success > 0, unvalidated_criteria: v.observations.at(-1)?.criterion_evidence.filter(c => !c.satisfied).map(c => c.criterion) ?? null })),
    coverage_limit: goal.exam?.syllabus.length ? "Declared syllabus is not a verified complete coverage map" : "Syllabus unknown; observed components do not establish exam coverage",
    spacing_window: remaining === null ? "unspecified" : remaining === 0 ? "deadline_passed" : "within_remaining_window_if_feasible",
    target_format: goal.target_format.slice(0, 300), task_demand: demand, task_demands: examFormats(goal), allowed_aids: goal.allowed_aids.slice(0, 8).map(a => a.slice(0, 200)),
    blueprint: { format: (goal.exam?.format ?? goal.target_format).slice(0, 300), grading_criteria: (goal.exam?.grading_criteria ?? goal.criteria).slice(0, 4).map(c => c.slice(0, 200)), time_limit_minutes: goal.exam?.time_limit_minutes ?? null },
    priorities, compression_eligible_component_ids: regime === "accelerate" ? views.filter(v => canCompressPractice(v, metadata.get(v.component_revision_id))).map(v => v.component_revision_id) : [],
    compression_requires: "independent_changed_task_and_target_dimensions", learner_can_continue: true,
    reason_codes: [remaining === null ? "deadline_unknown" : remaining === 0 ? "deadline_passed" : "deadline_window_observed", "preserve_exam_task_demand", "target_observed_recoverable_gaps"],
    confidence: "engineering_policy_not_calibrated", limitation: "Allocations are engineering defaults, not proved optima. No universal spacing, predicted score, mastery or sleep-sacrifice recommendation. Text does not observe physical/oral performance; compression does not establish retention.",
  };
}
