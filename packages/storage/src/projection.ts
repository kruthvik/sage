import type { Assessment, Assistance, Attempt, Hypothesis, LearningEvent, Revision, Rubric, TaskDefinition, TaskFamily, TaskInstance } from "../../core/src/contracts.ts";
import { componentOutcome, taskReviewRole, evidenceSummary, PROJECTOR_VERSION, type EvidenceSummary, type FamilyExposure, type HypothesisView } from "../../core/src/learning.ts";
import type { LearningStore } from "./store.ts";

export interface Observation {
  assessment_event_id: string; attempt_id: string; component_revision_id: string; outcome: Assessment["outcome"];
  observed_at: string; eligibility: "independent" | "supported" | "uncertain"; assistance_event_ids: string[];
  task_family_revision_id: string; purpose: TaskInstance["purpose"]; allowed_aids: string[];
  delay_days: number | null; changes: string[]; uncertainty: string;
  definition_revision_id: string; representation: string; variation_dimensions: string[];
  transfer_eligible: boolean; claims: NonNullable<Assessment["claims"]>; error_category?: Assessment["error_category"];
  criterion_evidence: Array<{ name: string; criterion: string; observed: boolean; satisfied: boolean }>;
}
export interface ComponentView {
  component_revision_id: string; observations: Observation[];
  independent: Observation[]; supported: Observation[]; retained: Observation[]; applied: Observation[];
  current_claim: "unverified"; through_seq: number; as_of_time: string; projector_version: typeof PROJECTOR_VERSION;
  acquisition_evidence: EvidenceSummary; independent_performance: EvidenceSummary; supported_performance: EvidenceSummary; uncertain_performance: EvidenceSummary;
  retention_evidence: EvidenceSummary & { tested_delays_days: number[]; minimum_delay_days: number };
  transfer_evidence: EvidenceSummary; discrimination_evidence: EvidenceSummary; explanation_evidence: EvidenceSummary; fluency_evidence: EvidenceSummary; execution_evidence: EvidenceSummary;
  support_dependency: "observed" | "unknown" | "not_recently_observed";
  uncertainty: "high" | "medium";
  guidance_state: "needs_orientation" | "needs_worked_example" | "needs_scaffold" | "fade_support" | "independent_familiar" | "independent_across_forms" | "retention_evidenced" | "transfer_evidenced";
  last_attempt_at?: string; last_independent_success_at?: string; last_independent_failure_at?: string; last_relevant_practice_at?: string; last_delayed_check_at?: string;
  family_exposure: FamilyExposure[]; representation_exposure: Array<{ representation: string; attempts: number; independent_successes: number }>;
  unresolved_gaps: HypothesisView[]; misconception_hypotheses: HypothesisView[]; candidate_prerequisite_issues: HypothesisView[];
  coverage_debt: string[]; evidence_ids: string[];
  exposure_evidence: { tasks_delivered: number; assistance_exposures: number; unassessed_attempts: number };
  diagnostic_steps: Array<{ assessment_event_id: string; step_attempt_id: string; outcome: string; eligibility: "independent" | "supported" | "uncertain"; assistance_event_ids: string[]; observed_at: string }>;
}
const promptTemplate = (task: TaskDefinition) => task.prompt.toLowerCase().replace(/(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/g, "#").replace(/\s+/g, " ").trim();

/** Union related family revisions by lineage and explicit structural signature, not title. */
export function familyKeys(store: LearningStore, throughSeq: number, asOfTime = "9999-12-31T23:59:59.999Z"): Map<string, string> {
  const families = store.revisions("task_family", throughSeq).filter(r => r.created_at <= asOfTime);
  const parent = new Map(families.map(f => [f.revision_id, f.revision_id]));
  const root = (id: string): string => { const p = parent.get(id); return p && p !== id ? root(p) : id; };
  const union = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) { const roots = [root(a), root(b)].sort(); parent.set(roots[1]!, roots[0]!); } };
  const entities = new Map<string, string>(), signatures = new Map<string, string>();
  for (const family of families) {
    // SAFETY: The store returns schema-validated task_family revisions from this kind-filtered query.
    const body = family.body as unknown as TaskFamily;
    const prior = entities.get(family.entity_id); if (prior) union(prior, family.revision_id); else entities.set(family.entity_id, family.revision_id);
    for (const related of body.lineage_revision_ids) union(family.revision_id, related);
    if (body.structural_signature) { const previous = signatures.get(body.structural_signature); if (previous) union(previous, family.revision_id); else signatures.set(body.structural_signature, family.revision_id); }
  }
  // Exact wording with only numeric substitutions is a conservative cosmetic alias.
  // This is not a semantic similarity model; unknown structural relationships stay unknown.
  const templates = new Map<string, string>();
  for (const definition of store.revisions("task_definition", throughSeq).filter(r => r.created_at <= asOfTime)) {
    // SAFETY: The kind-filtered query returns schema-validated task_definition bodies.
    const task = definition.body as unknown as TaskDefinition;
    const prompt = promptTemplate(task);
    const key = JSON.stringify([[...task.component_revision_ids].sort(), task.format, prompt]);
    const prior = templates.get(key);
    if (prior) union(prior, task.family_revision_id); else templates.set(key, task.family_revision_id);
  }
  return new Map(families.map(f => [f.revision_id, root(f.revision_id)]));
}

export function projectHypotheses(store: LearningStore, throughSeq: number, asOfTime: string, sessionId?: string): HypothesisView[] {
  const available = store.events(throughSeq).filter(e => e.branch === "real" && e.occurred_at <= asOfTime && (!sessionId || e.session_id === sessionId));
  const owned = sessionId ? new Set(available.map(e => e.seq)) : undefined;
  const corrected = new Set(available.filter(e => e.kind === "assessment").map(e => e.payload.correction_of_event_id));
  const evidence = new Map(available.filter(e => e.kind === "assessment" && !corrected.has(e.event_id)).map(e => [e.event_id, e]));
  const latest = new Map(store.revisions("hypothesis", throughSeq).filter(r => r.created_at <= asOfTime && (!owned || owned.has(r.created_seq))).map(r => [r.entity_id, r]));
  return [...latest.values()].map(r => {
    // SAFETY: The kind-filtered query returns schema-validated hypothesis bodies.
    const body = r.body as unknown as Hypothesis;
    const relevant = (id: string) => {
      const event = evidence.get(id);
      const attempt = event && available.find(e => e.kind === "attempt_submitted" && e.payload.attempt_id === event.payload.attempt_id);
      if (!event || !attempt) return false;
      const instance = store.revision<TaskInstance>(attempt.payload.instance_revision_id as string, "task_instance");
      const task = store.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition").body;
      return [...body.component_revision_ids, ...(body.prerequisite_component_revision_id ? [body.prerequisite_component_revision_id] : [])].some(c => componentOutcome(task, event.payload as Assessment, c) !== "not_observed");
    };
    const supporting = body.supporting_evidence_ids.filter(relevant);
    const contradicting = body.contradicting_evidence_ids.filter(relevant);
    const balance = supporting.length ? contradicting.length ? "mixed" : "supported_only" : contradicting.length ? "contradicted" : "unknown";
    const status = body.status === "resolved" && contradicting.length ? "resolved" : contradicting.length ? "weakened" : supporting.length ? body.status === "resolved" ? "uncertain" : body.status : "uncertain";
    return { ...body, supporting_evidence_ids: supporting, contradicting_evidence_ids: contradicting, id: r.entity_id, revision_id: r.revision_id, derived_status: status, evidence_balance: balance, uncertainty: "Semantic hypotheses and evidence links are proposals; contradictory/corrected evidence is preserved, not a learner label." };
  });
}

/** Facts only: this reducer never calls a model, scores prose, or reads the current clock. */
export function projectComponents(store: LearningStore, throughSeq: number, asOfTime: string, sessionId?: string): ComponentView[] {
  const cutoff = Date.parse(asOfTime);
  const events = store.events(throughSeq).filter(e => e.branch === "real" && Date.parse(e.occurred_at) <= cutoff && (!sessionId || e.session_id === sessionId));
  // Read immutable rows once; inner evidence folds must not issue thousands of SQL lookups.
  const revisions = new Map(store.revisions(undefined, throughSeq).map(r => [r.revision_id, r]));
  const revision = <T = Record<string, unknown>>(id: string): Revision<T> => {
    const value = revisions.get(id); if (!value) throw new Error(`Missing historical revision: ${id}`);
    // SAFETY: Callers select IDs through validated typed references; immutable bodies retain their stored schema.
    return value as unknown as Revision<T>;
  };
  const eventById = new Map(events.map(e => [e.event_id, e]));
  const helpEvents = events.filter(e => e.kind === "assistance");
  const deliveredEvents = events.filter(e => e.kind === "task_delivered");
  const views = new Map<string, ComponentView>();
  const empty = () => evidenceSummary([]);
  const components = store.revisions("component", throughSeq).filter(r => r.created_at <= asOfTime);
  // SAFETY: The component-filtered query contains validated Component bodies.
  for (const component of components) views.set(component.revision_id, { component_revision_id: component.revision_id, observations: [], independent: [], supported: [], retained: [], applied: [], current_claim: "unverified", through_seq: throughSeq, as_of_time: asOfTime, projector_version: PROJECTOR_VERSION,
    acquisition_evidence: empty(), independent_performance: empty(), supported_performance: empty(), uncertain_performance: empty(), retention_evidence: { ...empty(), tested_delays_days: [], minimum_delay_days: (/* SAFETY: The store validates this optional numeric field. */ component.body.retention_delay_days as number | undefined) ?? 1 }, transfer_evidence: empty(), discrimination_evidence: empty(), explanation_evidence: empty(), fluency_evidence: empty(), execution_evidence: empty(), support_dependency: "unknown", uncertainty: "high", guidance_state: "needs_orientation", family_exposure: [], representation_exposure: [], unresolved_gaps: [], misconception_hypotheses: [], candidate_prerequisite_issues: [], coverage_debt: [], evidence_ids: [], diagnostic_steps: [], exposure_evidence: { tasks_delivered: 0, assistance_exposures: 0, unassessed_attempts: 0 } });
  // SAFETY: The event-kind filter selects validated Attempt payloads.
  const attempts = new Map(events.filter(e => e.kind === "attempt_submitted").map(e => [e.payload.attempt_id as string, e as unknown as LearningEvent<Attempt>]));
  const corrected = new Set(events.filter(e => e.kind === "assessment").map(e => e.payload.correction_of_event_id).filter(Boolean));
  for (const event of events) {
    if (event.kind !== "assessment" || corrected.has(event.event_id)) continue;
    // SAFETY: The preceding kind check selects validated Assessment payloads.
    const assessment = event.payload as unknown as Assessment;
    const attempt = attempts.get(assessment.attempt_id);
    if (!attempt) continue;
    const instance = revision<TaskInstance>(attempt.payload.instance_revision_id).body;
    const task = revision<TaskDefinition>(instance.definition_revision_id).body;
    // Step evidence supports diagnosis but never adds holistic repetitions or successes.
    if (assessment.step_attempt_id) {
      const step = events.find(e => e.kind === "step_attempt" && e.payload.step_attempt_id === assessment.step_attempt_id);
      const response = step && eventById.get(step.payload.response_event_id as string);
      if (!response) continue;
      for (const component of task.component_revision_ids) {
        const help = helpEvents.filter(e => e.payload.instance_revision_id === attempt.payload.instance_revision_id && ["exposed", "possibly_exposed"].includes(e.payload.stage as string) && e.payload.answer_bearing && ((e.payload.component_revision_ids as string[]).length === 0 || (e.payload.component_revision_ids as string[]).includes(component)) && (e.occurred_at < response.occurred_at || (e.occurred_at === response.occurred_at && e.seq < response.seq)));
        const uncertain = help.some(e => e.payload.stage === "possibly_exposed") || attempt.payload.declared_aids.some(a => !task.allowed_aids.includes(a));
        views.get(component)?.diagnostic_steps.push({ assessment_event_id: event.event_id, step_attempt_id: assessment.step_attempt_id, outcome: componentOutcome(task, assessment, component), eligibility: uncertain ? "uncertain" : help.length ? "supported" : "independent", assistance_event_ids: help.map(e => e.event_id), observed_at: response.occurred_at });
      }
      continue;
    }
    const response = eventById.get(attempt.payload.response_event_id);
    if (!response) continue;
    const submittedAt = response.occurred_at;
    for (const component of task.component_revision_ids) {
      const view = views.get(component);
      if (!view) continue;
      const assistance = helpEvents.filter(e => {
        if (e.occurred_at > response.occurred_at || (e.occurred_at === response.occurred_at && e.seq >= response.seq)) return false;
        // SAFETY: helpEvents contains only schema-validated Assistance payloads.
        const a = e.payload as unknown as Assistance;
        const suppliedTask = revision<TaskDefinition>(revision<TaskInstance>(a.instance_revision_id).body.definition_revision_id).body;
        const sameContent = suppliedTask.prompt === task.prompt;
        return (a.instance_revision_id === attempt.payload.instance_revision_id || sameContent) && (a.component_revision_ids.length === 0 || a.component_revision_ids.includes(component)) && ["exposed", "possibly_exposed"].includes(a.stage) && a.answer_bearing;
      });
      const undeclaredAids = attempt.payload.declared_aids.filter(a => !task.allowed_aids.includes(a));
      const reviewedKey = events.some(e => e.seq < response.seq && e.kind === "decision" && e.payload.action === "task_solution_reviewed" && e.payload.task_entity_id === revision(instance.definition_revision_id).entity_id);
      const eligibility = assistance.some(e => e.payload.stage === "possibly_exposed") || undeclaredAids.length > 0 ? "uncertain" : assistance.length > 0 || reviewedKey ? "supported" : "independent";
      const priorExposures = events.filter(e => {
        if (e.occurred_at > submittedAt || (e.occurred_at === submittedAt && e.seq >= response.seq)) return false;
        if (e.kind === "assistance") {
          // SAFETY: The preceding kind check selects a validated Assistance payload.
          const a = e.payload as unknown as Assistance;
          const relevant = a.component_revision_ids.includes(component) || (a.component_revision_ids.length === 0 && revision<TaskDefinition>(revision<TaskInstance>(a.instance_revision_id).body.definition_revision_id).body.component_revision_ids.includes(component));
          return relevant && ["exposed", "possibly_exposed"].includes(a.stage);
        }
        if (e.kind !== "attempt_submitted" || e.payload.attempt_id === assessment.attempt_id) return false;
        const prior = revision<TaskInstance>(e.payload.instance_revision_id as string).body;
        return revision<TaskDefinition>(prior.definition_revision_id).body.component_revision_ids.includes(component);
      });
      const latestExposure = priorExposures.map(e => e.occurred_at).sort().at(-1);
      const delay = latestExposure ? Math.max(0, (Date.parse(submittedAt) - Date.parse(latestExposure)) / 86400000) : null;
      const dimensions = task.variation?.dimensions ?? [];
      const baseline = task.variation?.baseline_definition_revision_id;
      const baselineSeen = baseline && deliveredEvents.some(e => e.seq < response.seq && revision<TaskInstance>(e.payload.instance_revision_id as string).body.definition_revision_id === baseline);
      const definition = revision<TaskDefinition>(instance.definition_revision_id);
      const reviewer = events.find(e => e.seq === definition.created_seq)?.actor ?? "unknown";
      const variationReviewed = ["expert", "curator"].includes(taskReviewRole(task, reviewer));
      const baselineTask = baseline ? revision<TaskDefinition>(baseline).body : undefined;
      const cosmeticOnly = baselineTask && promptTemplate(baselineTask) === promptTemplate(task) && baselineTask.format === task.format && baselineTask.representation === task.representation && JSON.stringify(baselineTask.source_span_ids) === JSON.stringify(task.source_span_ids) && JSON.stringify(baselineTask.artifact_revision_ids ?? []) === JSON.stringify(task.artifact_revision_ids ?? []);
      // Composite variation does not identify which component's demand changed.
      const transferEligible = task.component_revision_ids.length === 1 && baselineTask?.component_revision_ids.length === 1 && baselineTask.component_revision_ids[0] === component && instance.purpose === "application" && variationReviewed && !!baselineSeen && baseline !== instance.definition_revision_id && !cosmeticOnly && dimensions.some(d => d !== "surface") && baselineTask.prompt !== task.prompt;
      const scopedOutcome = componentOutcome(task, assessment, component);
      const rubric = revision<Rubric>(task.rubric_revision_id).body;
      const criterionEvidence = rubric.dimensions.map(d => {
        const score = assessment.scores.find(s => s.dimension === d.name);
        const marks = event.payload.marking_summary as { unobserved_dimensions?: string[] } | undefined;
        const observed = scopedOutcome !== "not_observed" && !!score && !marks?.unobserved_dimensions?.includes(d.name);
        return { name: d.name, criterion: d.criterion, observed, satisfied: observed && score!.score === d.max_score };
      });
      const observation: Observation = { assessment_event_id: event.event_id, attempt_id: assessment.attempt_id, component_revision_id: component, outcome: scopedOutcome, observed_at: submittedAt, eligibility, assistance_event_ids: assistance.map(e => e.event_id), task_family_revision_id: task.family_revision_id, purpose: instance.purpose, allowed_aids: task.allowed_aids, delay_days: delay, changes: task.changes, uncertainty: assessment.uncertainty,
        definition_revision_id: instance.definition_revision_id, representation: task.representation ?? "unspecified", variation_dimensions: dimensions, transfer_eligible: transferEligible, criterion_evidence: criterionEvidence, claims: (assessment.claims ?? []).filter(c => c.component_revision_id === component).map(c => task.scoring !== "rubric" && task.component_revision_ids.length !== 1 ? { ...c, outcome: "not_observed" as const } : c), error_category: scopedOutcome === "not_observed" ? undefined : assessment.error_category };
      view.observations.push(observation);
      if (eligibility === "independent") view.independent.push(observation); else view.supported.push(observation);
      if (eligibility === "independent" && observation.outcome === "success" && instance.purpose === "retention" && delay !== null && delay >= view.retention_evidence.minimum_delay_days) view.retained.push(observation);
      if (eligibility === "independent" && observation.outcome === "success" && transferEligible) view.applied.push(observation);
    }
  }
  const hypotheses = projectHypotheses(store, throughSeq, asOfTime, sessionId);
  const keys = familyKeys(store, throughSeq, asOfTime);
  for (const view of views.values()) {
    const ordered = [...view.observations].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const independent = ordered.filter(o => o.eligibility === "independent");
    const successes = independent.filter(o => o.outcome === "success");
    const delayed = independent.filter(o => o.purpose === "retention" && o.delay_days !== null && o.delay_days >= view.retention_evidence.minimum_delay_days);
    view.acquisition_evidence = evidenceSummary(ordered);
    view.independent_performance = evidenceSummary(independent);
    view.supported_performance = evidenceSummary(ordered.filter(o => o.eligibility === "supported"));
    view.uncertain_performance = evidenceSummary(ordered.filter(o => o.eligibility === "uncertain"));
    view.retention_evidence = { ...evidenceSummary(delayed), tested_delays_days: delayed.map(o => o.delay_days!), minimum_delay_days: view.retention_evidence.minimum_delay_days };
    view.transfer_evidence = evidenceSummary(independent.filter(o => o.transfer_eligible));
    for (const dimension of ["discrimination", "explanation", "fluency", "execution"] as const) {
      view[`${dimension}_evidence`] = evidenceSummary(independent.flatMap(o => o.claims.filter(c => c.dimension === dimension).map(c => ({ outcome: c.outcome, assessment_event_id: o.assessment_event_id, observed_at: o.observed_at }))));
    }
    view.last_independent_success_at = successes.at(-1)?.observed_at;
    view.last_independent_failure_at = independent.filter(o => o.outcome === "failure").at(-1)?.observed_at;
    view.last_delayed_check_at = delayed.at(-1)?.observed_at;
    const relevantAttempts = [...attempts.values()].filter(a => revision<TaskDefinition>(revision<TaskInstance>(a.payload.instance_revision_id).body.definition_revision_id).body.component_revision_ids.includes(view.component_revision_id));
    const deliveries = deliveredEvents.filter(e => revision<TaskDefinition>(revision<TaskInstance>(e.payload.instance_revision_id as string).body.definition_revision_id).body.component_revision_ids.includes(view.component_revision_id));
    const exposedAssistance = helpEvents.filter(e => ["exposed", "possibly_exposed"].includes(e.payload.stage as string) && ((e.payload.component_revision_ids as string[]).includes(view.component_revision_id) || ((e.payload.component_revision_ids as string[]).length === 0 && revision<TaskDefinition>(revision<TaskInstance>(e.payload.instance_revision_id as string).body.definition_revision_id).body.component_revision_ids.includes(view.component_revision_id))));
    view.exposure_evidence = { tasks_delivered: deliveries.length, assistance_exposures: new Set(exposedAssistance.map(e => e.payload.assistance_id)).size, unassessed_attempts: relevantAttempts.filter(a => !ordered.some(o => o.attempt_id === a.payload.attempt_id)).length };
    view.last_attempt_at = relevantAttempts.map(a => a.occurred_at).sort().at(-1);
    view.last_relevant_practice_at = [...relevantAttempts.map(a => a.occurred_at), ...exposedAssistance.map(e => e.occurred_at)].sort().at(-1);
    const families = new Map<string, FamilyExposure>();
    const representations = new Map<string, { representation: string; attempts: number; independent_successes: number }>();
    for (const attempt of relevantAttempts) {
      const instance = revision<TaskInstance>(attempt.payload.instance_revision_id).body;
      const task = revision<TaskDefinition>(instance.definition_revision_id).body;
      const key = keys.get(task.family_revision_id) ?? task.family_revision_id;
      const family = families.get(key) ?? { family_key: key, family_revision_ids: [], attempts: 0, recent_attempts: 0, independent_successes: 0, definition_revision_ids: [], last_attempt_at: attempt.occurred_at };
      family.attempts++; if (!family.family_revision_ids.includes(task.family_revision_id)) family.family_revision_ids.push(task.family_revision_id);
      if (cutoff - Date.parse(attempt.occurred_at) <= 7 * 86400000) family.recent_attempts++;
      if (!family.definition_revision_ids.includes(instance.definition_revision_id)) family.definition_revision_ids.push(instance.definition_revision_id);
      if (attempt.occurred_at > family.last_attempt_at) family.last_attempt_at = attempt.occurred_at;
      const successful = successes.some(o => o.attempt_id === attempt.payload.attempt_id);
      if (successful) family.independent_successes++;
      families.set(key, family);
      const representation = task.representation ?? "unspecified";
      const rep = representations.get(representation) ?? { representation, attempts: 0, independent_successes: 0 };
      rep.attempts++; if (successful) rep.independent_successes++; representations.set(representation, rep);
    }
    view.family_exposure = [...families.values()]; view.representation_exposure = [...representations.values()];
    const last = ordered.filter(o => o.outcome !== "not_observed").at(-1);
    view.support_dependency = !last ? "unknown" : last.eligibility !== "independent" ? "observed" : "not_recently_observed";
    view.uncertainty = !successes.length || !delayed.length || !view.applied.length ? "high" : "medium";
    const successfulRepresentations = new Set(successes.map(o => o.representation).filter(r => r !== "unspecified"));
    const successfulFamilies = new Set(successes.map(o => keys.get(o.task_family_revision_id) ?? o.task_family_revision_id));
    const forms = successfulRepresentations.size > 1;
    view.guidance_state = !last ? "needs_orientation" : last.outcome === "failure" ? last.error_category === "careless_error" ? "needs_scaffold" : "needs_worked_example" : last.eligibility !== "independent" && last.outcome === "success" ? "fade_support" : last.outcome !== "success" ? "needs_scaffold" : view.applied.length ? "transfer_evidenced" : view.retained.length ? "retention_evidenced" : forms && successfulFamilies.size > 1 ? "independent_across_forms" : "independent_familiar";
    view.misconception_hypotheses = hypotheses.filter(h => h.component_revision_ids.includes(view.component_revision_id));
    view.unresolved_gaps = view.misconception_hypotheses.filter(h => h.derived_status !== "resolved");
    view.candidate_prerequisite_issues = view.unresolved_gaps.filter(h => h.category === "prerequisite");
    view.coverage_debt = [...(!successes.length ? ["independence_unknown"] : []), ...(!delayed.length ? ["retention_unknown"] : []), ...(!view.transfer_evidence.evidence_ids.length ? ["transfer_unknown"] : []), ...(families.size < 2 ? ["limited_family_coverage"] : []), ...(!forms ? ["representation_coverage_unknown"] : [])];
    view.evidence_ids = ordered.map(o => o.assessment_event_id);
  }
  return [...views.values()];
}
