import { Value } from "typebox/value";
import { CramSelectionSchema, type Component, type Goal, type Revision, type Rubric, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import type { ComponentView, Observation } from "../../storage/src/projection.ts";
import { examFormats } from "./practice-policy.ts";
import { teachingSupport } from "./candidates.ts";

const demand = (format: TaskDefinition["format"]) => ["free_response", "explain"].includes(format) ? "reasoned" : ["mcq", "discriminate"].includes(format) ? "selection" : format;
const template = (t: TaskDefinition) => t.prompt.toLowerCase().replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
const criterionKey = (c: { name: string; criterion: string }) => `${c.name}\n${c.criterion}`;

/** Replays owned host annotations and actual work; annotations allocate defaults, never establish performance. */
export function cramProgress(store: LearningStore, sessionId: string, goal: Revision<Goal>, views: ComponentView[], components: Revision<Component>[], tasks: Revision<TaskDefinition>[], rubrics: Revision<Rubric>[], asOf: string, throughSeq = store.throughSeq) {
  const events = store.events(throughSeq).filter(e => e.session_id === sessionId && e.branch === "real" && e.occurred_at <= asOf);
  const scopedTasks = tasks.filter(t => {
    const definition = events.find(e => e.seq === t.created_seq && e.payload.action === "revision_defined");
    const scope = definition?.payload.disclosure_scope as { goal_revision_id?: string } | undefined;
    if (!scope?.goal_revision_id) return false;
    const frozen = store.revision<Goal>(scope.goal_revision_id, "goal");
    return frozen.entity_id === goal.entity_id && frozen.body.objective === goal.body.objective && frozen.body.subject === goal.body.subject;
  });
  const taskMap = new Map(scopedTasks.map(t => [t.revision_id, t]));
  const rubricMap = new Map(rubrics.map(r => [r.revision_id, r.body]));
  const observations = views.flatMap(v => v.observations).filter(o => taskMap.has(o.definition_revision_id) && events.some(e => e.kind === "assessment" && e.event_id === o.assessment_event_id));
  const records = events.flatMap(e => {
    if (e.actor !== "host" || e.kind !== "decision" || e.payload.action !== "cram_task_selected" || e.payload.lesson_goal_entity_id !== goal.entity_id || !Value.Check(CramSelectionSchema, e.payload.cram_selection)) return [];
    const annotation = e.payload.cram_selection;
    const delivery = events.find(d => d.kind === "task_delivered" && d.event_id === (e.payload.evidence_event_ids as string[])[0] && d.payload.instance_revision_id === annotation.instance_revision_id);
    if (!delivery) return [];
    const instance = store.revision<TaskInstance>(annotation.instance_revision_id, "task_instance");
    const frozen = store.revision<Goal>(instance.body.goal_revision_id, "goal");
    if (frozen.entity_id !== goal.entity_id || frozen.body.objective !== goal.body.objective || frozen.body.subject !== goal.body.subject) return [];
    const task = taskMap.get(instance.body.definition_revision_id);
    if (!task) return [];
    const observed = observations.filter(o => o.definition_revision_id === task.revision_id && events.some(a => a.kind === "attempt_submitted" && a.payload.instance_revision_id === instance.revision_id && a.payload.attempt_id === o.attempt_id));
    const presented = observed.filter(o => events.some(f => f.actor === "host" && f.payload.action === "response_feedback_presented" && (f.payload.evidence_event_ids as string[]).includes(o.assessment_event_id)));
    const overridden = events.some(c => c.actor === "learner" && c.kind === "decision" && (c.payload.action === "learning_task_skipped" && c.payload.instance_revision_id === instance.revision_id || c.payload.action === "response_review_override" && observed.some(o => events.some(a => a.kind === "attempt_submitted" && a.payload.attempt_id === o.attempt_id && (c.payload.evidence_event_ids as string[]).includes(a.event_id)))));
    return [{ annotation, task, observed: presented, complete: presented.length > 0 || overridden, overridden, at: delivery.occurred_at, seq: delivery.seq }];
  });
  const formats = examFormats(goal.body);
  const compatible = scopedTasks.filter(t => t.body.status === "practice_ready" && t.body.partition === "practice" && t.body.review.method !== "unreviewed" && (!formats.length || formats.includes(t.body.format)) && t.body.allowed_aids.every(a => goal.body.allowed_aids.includes(a)));
  const importance = (id: string) => goal.body.exam?.topic_weights.find(w => w.component_revision_id === id)?.importance ?? "unknown";
  const rank = (id: string) => importance(id) === "high" ? 2 : importance(id) === "low" ? 0 : 1;
  const observedComponents = [...new Set(observations.map(o => o.component_revision_id))];
  const declaredComponents = goal.body.exam?.topic_weights.length ? goal.body.exam.topic_weights.map(w => w.component_revision_id) : observedComponents.length ? observedComponents : [...new Set(compatible.flatMap(t => t.body.component_revision_ids))];
  const demands = [...new Set((formats.length ? formats : compatible.map(t => t.body.format)).map(demand))];
  const diagnosticTargets = records[0]?.annotation.diagnostic_targets ?? demands.flatMap(d => {
    const id = [...declaredComponents].sort((a, b) => rank(b) - rank(a)).find(c => compatible.some(t => t.body.component_revision_ids.includes(c) && demand(t.body.format) === d));
    return id ? [{ component_revision_id: id, demand: d }] : [];
  }).slice(0, 3);
  const delivered = new Set(events.filter(e => e.kind === "task_delivered").map(e => store.revision<TaskInstance>(e.payload.instance_revision_id as string, "task_instance").body.definition_revision_id));
  const relevantComponents = new Set([...declaredComponents, ...components.filter(c => declaredComponents.includes(c.revision_id)).flatMap(c => c.body.prerequisite_revision_ids)]);
  const fresh = compatible.filter(t => !delivered.has(t.revision_id) && t.body.component_revision_ids.some(id => relevantComponents.has(id)));
  const keyMatches = (t: Revision<TaskDefinition>, target: { component_revision_id: string; demand: string }) => t.body.component_revision_ids.includes(target.component_revision_id) && demand(t.body.format) === target.demand;
  const originalGaps = records.filter(r => ["diagnostic", "mini_set", "recheck"].includes(r.annotation.stage)).flatMap(r => r.observed.map(o => {
    const unresolved = o.criterion_evidence.filter(c => !c.satisfied);
    return { observation: o, task: r.task, criteria: o.outcome === "not_observed" || o.outcome !== "success" && !unresolved.length ? o.criterion_evidence : unresolved };
  }).filter(g => g.criteria.length > 0));
  const gapOpen = (gap: typeof originalGaps[number]) => !records.some(r => r.annotation.stage === "recheck" && r.annotation.baseline_assessment_event_id === gap.observation.assessment_event_id && r.observed.some(o => o.component_revision_id === gap.observation.component_revision_id && o.outcome === "success" && o.eligibility === "independent" && o.transfer_eligible && gap.criteria.every(c => o.criterion_evidence.some(s => criterionKey(s) === criterionKey(c) && s.satisfied))));
  const evidenceSeq = new Map(events.map(e => [e.event_id, e.seq]));
  const openGaps = originalGaps.filter(gapOpen).sort((a, b) => rank(b.observation.component_revision_id) - rank(a.observation.component_revision_id) || (evidenceSeq.get(b.observation.assessment_event_id) ?? 0) - (evidenceSeq.get(a.observation.assessment_event_id) ?? 0));
  const coverage = declaredComponents.map(id => ({ component_revision_id: id, importance: importance(id), observed_demands: [...new Set(records.filter(r => r.observed.some(o => o.component_revision_id === id && o.outcome !== "not_observed")).map(r => demand(r.task.body.format)))], unobserved_demands: demands.filter(d => !records.some(r => demand(r.task.body.format) === d && r.observed.some(o => o.component_revision_id === id && o.outcome !== "not_observed"))), original_gaps: openGaps.filter(g => g.observation.component_revision_id === id).flatMap(g => g.criteria.map(c => c.criterion)) }));
  let stage: "diagnostic" | "repair" | "intervening" | "recheck" | "mini_set" | "report" = "diagnostic";
  let pool: Revision<TaskDefinition>[] = [];
  let baseline: Observation | undefined;
  let notBefore: string | undefined;
  const missingDiagnostic = diagnosticTargets.find(target => !records.some(r => r.annotation.stage === "diagnostic" && r.complete && keyMatches(r.task, target)));
  const gap = openGaps.find(g => !records.some(r => r.annotation.baseline_assessment_event_id === g.observation.assessment_event_id && r.overridden));
  const sampled = records.some(r => r.annotation.stage === "diagnostic" && r.observed.some(o => o.outcome !== "not_observed"));
  // Brief actual sampling permits repair/evaluation; unsampled demands remain in coverage and the mixed mini-set.
  if (missingDiagnostic && !gap && !sampled) pool = fresh.filter(t => keyMatches(t, missingDiagnostic));
  else {
    if (gap) {
      baseline = gap.observation;
      const cycle = records.filter(r => r.annotation.baseline_assessment_event_id === baseline!.assessment_event_id);
      const repair = cycle.filter(r => r.annotation.stage === "repair" && r.complete).at(-1);
      const intervening = repair && cycle.find(r => r.annotation.stage === "intervening" && r.observed.some(o => o.outcome !== "not_observed") && r.seq > repair.seq);
      const checks = cycle.filter(r => r.annotation.stage === "recheck" && r.complete);
      const failedCheck = checks.at(-1);
      const lastRepairIndex = repair ? records.indexOf(repair) : -1;
      if (!repair || failedCheck && records.indexOf(failedCheck) > lastRepairIndex) {
        stage = "repair";
        const comp = components.find(c => c.revision_id === baseline!.component_revision_id);
        const blocked = views.find(v => v.component_revision_id === baseline!.component_revision_id)?.unresolved_gaps.find(h => h.category === "prerequisite" && h.prerequisite_component_revision_id && comp?.body.prerequisite_revision_ids.includes(h.prerequisite_component_revision_id) && observations.some(o => o.component_revision_id === h.prerequisite_component_revision_id && o.eligibility === "independent" && o.outcome === "failure"));
        const target = blocked?.prerequisite_component_revision_id ?? baseline.component_revision_id;
        pool = fresh.filter(t => t.body.component_revision_ids.includes(target) && (blocked || gap.criteria.every(c => rubricMap.get(t.body.rubric_revision_id)?.dimensions.some(s => criterionKey(s) === criterionKey(c)))));
      } else if (!intervening) {
        stage = "intervening";
        pool = fresh.filter(t => !t.body.component_revision_ids.includes(baseline!.component_revision_id) || demand(t.body.format) !== demand(repair.task.body.format));
      } else {
        stage = "recheck";
        const nextWindow = goal.body.study_windows?.find(w => Date.parse(w.start) > Date.parse(repair.observed.at(-1)?.observed_at ?? repair.at) && (!goal.body.deadline || Date.parse(w.start) < Date.parse(goal.body.deadline)));
        notBefore = nextWindow?.start;
        pool = fresh.filter(t => t.body.component_revision_ids.includes(baseline!.component_revision_id) && t.body.variation?.baseline_definition_revision_id === gap.task.revision_id && t.body.variation.dimensions.some(d => d !== "surface") && (t.body.representation !== gap.task.body.representation || t.body.format !== gap.task.body.format || template(t.body) !== template(gap.task.body)) && gap.criteria.every(c => rubricMap.get(t.body.rubric_revision_id)?.dimensions.some(s => criterionKey(s) === criterionKey(c))) && t.body.allowed_aids.every(a => gap.task.body.allowed_aids.includes(a)));
      }
    } else {
      const missingMini = diagnosticTargets.find(target => !records.some(r => r.annotation.stage === "mini_set" && r.complete && keyMatches(r.task, target)));
      if (missingMini) { stage = "mini_set"; pool = fresh.filter(t => keyMatches(t, missingMini)); }
      else stage = "report";
    }
  }
  const now = Date.parse(asOf), deadline = goal.body.deadline ? Date.parse(goal.body.deadline) : null;
  const windows = goal.body.study_windows?.filter(w => Date.parse(w.end) > now && (deadline === null || Date.parse(w.start) < deadline));
  const currentWindow = windows?.find(w => Date.parse(w.start) <= now);
  const allocated = records.reduce((sum, r) => sum + r.annotation.allocated_minutes, 0);
  const budget = goal.body.budget_minutes === undefined ? null : Math.max(0, goal.body.budget_minutes - allocated);
  const windowRemaining = currentWindow ? (Math.min(Date.parse(currentWindow.end), deadline ?? Infinity) - now) / 60000 : null;
  const defaults = { diagnostic: 2, repair: 3, intervening: 2, recheck: 3, mini_set: 2 };
  const urgent = deadline !== null && deadline - now <= 86400000;
  const allowance = stage === "report" ? 0 : Math.max(0, Math.min(defaults[stage] * (urgent ? 1 : 2), budget ?? Infinity, windowRemaining ?? Infinity, deadline === null ? Infinity : (deadline - now) / 60000));
  if (stage === "mini_set") pool = pool.filter(t => !tasks.some(previous => delivered.has(previous.revision_id) && previous.body.format === t.body.format && previous.body.representation === t.body.representation && template(previous.body) === template(t.body)));
  let status = !diagnosticTargets.length ? "blueprint_or_reviewed_tasks_unknown" : stage === "report" ? "coverage_report" : "ready";
  if (deadline !== null && deadline <= now) status = "deadline_passed";
  else if (windows && !currentWindow) status = windows.length ? "await_declared_window" : "no_feasible_declared_window";
  else if (notBefore && Date.parse(notBefore) > now) status = "await_separated_recheck_window";
  else if (stage !== "report" && allowance <= 0) status = "allocation_budget_exhausted";
  const selected = status === "ready" ? pool.filter(t => (t.body.estimated_minutes ?? allowance) <= allowance).sort((a, b) => (urgent ? 1 : -1) * ((a.body.estimated_minutes ?? allowance) - (b.body.estimated_minutes ?? allowance)) || a.created_seq - b.created_seq)[0] : undefined;
  if (status === "ready" && !selected) status = pool.length ? "no_task_fits_declared_allocation" : stage === "repair" ? "prepare_compatible_repair" : "prepare_fresh_reviewed_task_for_stage";
  const support = selected && (stage === "repair" || stage === "intervening") ? selected.body.component_revision_ids.map(id => teachingSupport(views.find(v => v.component_revision_id === id), components.find(c => c.revision_id === id)?.body, views)).sort((a, b) => ["scaffold", "faded", "light"].indexOf(a.support) - ["scaffold", "faded", "light"].indexOf(b.support))[0] ?? null : null;
  return {
    stage, status, selection: selected ? { definition_revision_id: selected.revision_id, rubric_revision_id: selected.body.rubric_revision_id, component_revision_ids: selected.body.component_revision_ids, format: selected.body.format, allowed_aids: selected.body.allowed_aids, teaching_support: support, purpose: support && support.support !== "light" ? "practice" : stage === "recheck" ? "application" : "independent", reason: `cram_${stage}`, confidence: "engineering_default_not_calibrated", cram: { stage, allocated_minutes: selected.body.estimated_minutes ?? allowance, ...(selected.body.estimated_minutes === undefined ? {} : { estimated_minutes: selected.body.estimated_minutes }), ...(baseline ? { baseline_assessment_event_id: baseline.assessment_event_id } : {}), ...(notBefore ? { not_before: notBefore } : {}), diagnostic_targets: diagnosticTargets } } : null,
    allocation_minutes_remaining: budget, current_window_minutes_remaining: windowRemaining, next_window_start: windows?.find(w => Date.parse(w.start) > now)?.start ?? null,
    timing: goal.body.study_windows === undefined ? "windows_unknown" : "declared_windows_only", coverage, diagnostic_targets: diagnosticTargets,
    completed_stages: records.filter(r => r.complete).map(r => ({ stage: r.annotation.stage, instance_revision_id: r.annotation.instance_revision_id, observed: r.observed.some(o => o.outcome !== "not_observed"), overridden: r.overridden })),
    limits: "Ordinal estimates/default allocations are not measured effort or optima. Unknown weights, syllabus coverage and task duration remain unknown. Skips/overrides grant no marks. Semantic task/review quality and long-term retention are unverified.",
    syllabus_coverage: "Declared syllabus text is not a verified topic-to-demand map; this reports only owned observed components.",
  };
}
export type CramProgress = ReturnType<typeof cramProgress>;
