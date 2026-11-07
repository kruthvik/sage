import { randomUUID } from "node:crypto";
import type { Assessment, Component, DrillRound, Goal, Revision, TaskInstance, TaskDefinition, Rubric } from "../../core/src/contracts.ts";
import type { ComponentView } from "../../storage/src/projection.ts";
import { componentOutcome } from "../../core/src/learning.ts";
import { canonical } from "../../storage/src/store.ts";
import { selectPracticeTask } from "./practice-policy.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { projectLearningState } from "./learning-state.ts";

export interface CreateDrillRoundInput {
  ordinal: number;
  task_instance_ids: string[];
  source_anchor_span_ids: string[];
  format: string;
  conditions: string[];
  prior_round_revision_id?: string;
  difficulty_target: "similar" | "harder";
  learner_instructions?: string;
}
export interface DrillItemSubmission { instance_id: string; text: string; declared_aids?: string[] }
export interface DrillRoundSubmissionResult {
  round_revision_id: string;
  attempts: Array<{ attempt_id: string; instance_revision_id: string; response: string }>;
}
export interface DrillDiagnostics {
  round_revision_id: string;
  items_delivered: number;
  items_submitted: number;
  items_evaluated: number;
  items_unassessed: number;
  evidenced_components: string[];
  unobserved_components: string[];
  summary: string;
  gap_teaching: { enabled: boolean; ready: boolean; assessment_event_ids: string[]; guidance: string };
}

export function drillGapTeachingEnabled(store: LearningStore, sessionId: string, throughSeq = store.throughSeq, asOfTime = store.now()): boolean {
  const goal = store.lessonGoal(sessionId, throughSeq);
  return !!goal && store.events(throughSeq).filter(e => e.kind === "decision" && e.actor === "learner" && e.branch === "real" && e.session_id === sessionId && e.occurred_at <= asOfTime && e.payload.action === "drill_gap_teaching_changed" && e.payload.goal_revision_id === goal.revision_id).at(-1)?.payload.enabled === true;
}

/** Native learner setting, never a model recording or a change to frozen work. */
export function setDrillGapTeaching(store: LearningStore, sessionId: string, enabled: boolean, expectedState: string) {
  const state = projectLearningState(store, sessionId);
  if (state.state_revision !== expectedState) throw new Error("Stale learning state; refresh before changing drill teaching");
  if (typeof enabled !== "boolean" || state.mode !== "drill" || !state.goal_revision_id) throw new Error("Start a drill lesson before changing gap teaching");
  const round = currentDrillRound(store, sessionId), progress = round && diagnoseDrill(store, round.revision_id, sessionId);
  if (state.phase === "stopped" || state.pending_count || (progress && (progress.items_evaluated !== progress.items_delivered || progress.items_unassessed))) throw new Error("Change gap teaching only between fully assessed rounds; finish or resume current work first");
  if (drillGapTeachingEnabled(store, sessionId) !== enabled) {
    store.db.transaction(() => {
      store.append("decision", { action: "drill_gap_teaching_changed", goal_revision_id: state.goal_revision_id, enabled, reason: "Native learner preference; no work, teaching completion or competence inferred" }, randomUUID(), "learner", sessionId);
      store.rebuild();
    })();
  }
  return { enabled };
}

export function continueDrillGapTeaching(store: LearningStore, sessionId: string): boolean {
  const state = projectLearningState(store, sessionId), round = currentDrillRound(store, sessionId);
  if (state.phase === "stopped" || state.pending_count || !round) return false;
  const progress = diagnoseDrill(store, round.revision_id, sessionId);
  if (!progress.gap_teaching.ready) return false;
  store.db.transaction(() => {
    store.append("decision", { action: "drill_gap_teaching_continued", goal_revision_id: state.goal_revision_id, round_revision_id: round.revision_id, assessment_event_ids: progress.gap_teaching.assessment_event_ids, reason: "Native Continue requests fresh work; not proof that an explanation was delivered, read or understood" }, randomUUID(), "learner", sessionId);
    store.rebuild();
  })();
  return true;
}

function compatibleGoal(a: Revision<Goal>, b: Revision<Goal>): boolean {
  return a.entity_id === b.entity_id && a.body.objective === b.body.objective && a.body.subject === b.body.subject;
}
function ownedRound(store: LearningStore, id: string, sessionId: string, throughSeq = store.throughSeq) {
  const round = store.revision<DrillRound>(id, "drill_round");
  const goal = store.lessonGoal(sessionId, throughSeq);
  const owner = store.events(throughSeq).find(e => e.seq === round.created_seq);
  if (!goal || owner?.session_id !== sessionId || owner.branch !== "real" || !compatibleGoal(goal, store.revision<Goal>(round.body.goal_revision_id, "goal"))) throw new Error("Drill round belongs to another lesson or objective");
  return { round, goal };
}
function roundStop(store: LearningStore, id: string, sessionId: string, throughSeq = store.throughSeq) {
  const checkpoint = store.events(throughSeq).filter(e => e.kind === "checkpoint" && e.branch === "real" && e.session_id === sessionId && e.actor === "learner" && e.payload.round_revision_id === id).at(-1);
  return checkpoint?.payload.stopped ? checkpoint : undefined;
}

export function currentDrillRound(store: LearningStore, sessionId: string, throughSeq = store.throughSeq) {
  const goal = store.lessonGoal(sessionId, throughSeq);
  const owned = new Set(store.events(throughSeq).filter(e => e.session_id === sessionId && e.branch === "real").map(e => e.seq));
  return store.revisions("drill_round", throughSeq).filter(r => owned.has(r.created_seq) && goal && compatibleGoal(goal, store.revision<Goal>(r.body.goal_revision_id as string, "goal"))).at(-1) as Revision<DrillRound> | undefined;
}

/** Structural demand checks are inspectable proposals, not semantic difficulty calibration. */
export function selectDrillTask(store: LearningStore, sessionId: string, goal: Goal, views: ComponentView[], tasks: Revision<TaskDefinition>[], rubrics: Revision<Rubric>[], delivered: Set<string>, throughSeq = store.throughSeq) {
  const prior = currentDrillRound(store, sessionId, throughSeq);
  if (prior && drillGapTeachingEnabled(store, sessionId, throughSeq) && diagnoseDrill(store, prior.revision_id, sessionId, throughSeq).gap_teaching.ready) return null;
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.session_id === sessionId);
  const priorTasks = prior?.body.task_instance_ids.map(id => store.revision<TaskDefinition>(store.revision<TaskInstance>(id, "task_instance").body.definition_revision_id, "task_definition")) ?? [];
  const attempts = events.filter(e => e.kind === "attempt_submitted" && prior?.body.task_instance_ids.includes(e.payload.instance_revision_id as string));
  const assessments = attempts.map(a => events.filter(e => e.kind === "assessment" && !e.payload.step_attempt_id && e.payload.attempt_id === a.payload.attempt_id).at(-1));
  if (prior && (roundStop(store, prior.revision_id, sessionId, throughSeq) || attempts.length !== prior.body.task_instance_ids.length || assessments.some(a => !a))) return null;
  const repair = assessments.some((event, index) => {
    if (!event) return true;
    const assessment = store.event<Assessment>(event.event_id, "assessment").payload;
    const instance = store.revision<TaskInstance>(attempts[index]!.payload.instance_revision_id as string, "task_instance");
    const task = store.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition").body;
    const rubric = store.revision<Rubric>(task.rubric_revision_id, "rubric").body;
    return assessment.outcome !== "success"
      || rubric.dimensions.some(d => !assessment.scores.some(s => s.dimension === d.name && s.score === d.max_score))
      || task.component_revision_ids.some(id => componentOutcome(task, assessment, id) !== "success")
      || assessment.claims?.some(c => task.component_revision_ids.includes(c.component_revision_id) && c.outcome !== "success")
      || task.component_revision_ids.some(id => store.revision<Component>(id, "component").body.target_dimensions?.some(d => !assessment.claims?.some(c => c.component_revision_id === id && c.dimension === d && c.outcome === "success")));
  });
  const choices = tasks.flatMap(task => {
    const selected = selectPracticeTask(goal, views, [task], rubrics, delivered);
    if (!selected || task.body.allowed_aids.some(a => !goal.allowed_aids.includes(a))) return [];
    const anchors = [...new Set([...task.body.source_span_ids, ...(rubrics.find(r => r.revision_id === task.body.rubric_revision_id)?.body.source_span_ids ?? [])])];
    if (task.body.drill_source_kind && !anchors.length) return [];
    const changes: string[] = [];
    if (prior) {
      const baseline = priorTasks.find(t => repair ? t.body.rubric_revision_id === task.body.rubric_revision_id : t.revision_id === task.body.variation?.baseline_definition_revision_id);
      if (!baseline || task.body.rubric_revision_id !== baseline.body.rubric_revision_id || !baseline.body.component_revision_ids.every(id => task.body.component_revision_ids.includes(id)) || !prior.body.source_anchor_span_ids.every(id => anchors.includes(id))) return [];
      if (!repair) {
        if (task.body.prompt === baseline.body.prompt) return [];
        const dimensions = task.body.variation?.dimensions ?? [];
        if (dimensions.includes("representation") && (task.body.representation !== baseline.body.representation || task.body.format !== baseline.body.format)) changes.push("representation");
        if (dimensions.some(d => d === "method" || d === "structure") && canonical(task.body.steps) !== canonical(baseline.body.steps) && task.body.steps.length > baseline.body.steps.length) changes.push("steps");
        if (dimensions.includes("component_combination") && task.body.component_revision_ids.length > baseline.body.component_revision_ids.length) changes.push("component_combination");
        if (task.body.allowed_aids.length < baseline.body.allowed_aids.length && task.body.allowed_aids.every(a => baseline.body.allowed_aids.includes(a))) changes.push("reduced_aids");
        if (!changes.length) return [];
      }
    }
    const priority = task.body.drill_source_kind ?? "unanchored_question";
    const rank = priority === "supplied_test_question" ? 0 : priority === "question" ? 1 : priority === "summary" ? 2 : 3;
    const preferred = anchors.some(id => goal.drill?.prioritized_source_span_ids?.includes(id));
    return [{ task, rank, preferred, selection: { ...selected, purpose: prior && !repair ? "application" : "independent", reason: repair ? "repair_original_criterion_gap" : prior ? "inspectable_changed_demand_proposal" : "source_prioritized_question", source_priority: priority, source_anchors: anchors.map(id => { const span = store.acceptedSpan(id); return { span_id: id, source_revision_id: span.source_revision_id, locator: span.locator }; }), declared_aids: task.body.allowed_aids, learner_instructions: goal.drill?.learner_instructions, prior_round_revision_id: prior?.revision_id, demand_changes: changes, difficulty_target: prior && !repair ? "harder" as const : "similar" as const } }];
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.rank - b.rank || b.task.created_seq - a.task.created_seq);
  return choices[0]?.selection ?? null;
}

export function createDrillRound(store: LearningStore, goalRevisionId: string, input: CreateDrillRoundInput, sessionId: string): Revision<DrillRound> {
  return store.db.transaction(() => {
    const goal = store.lessonGoal(sessionId);
    if (!goal || goal.revision_id !== goalRevisionId) throw new Error("Goal revision does not match the active lesson");
    if (new Set(input.task_instance_ids).size !== input.task_instance_ids.length) throw new Error("Duplicate round task instances");
    const events = store.events();
    for (const id of input.task_instance_ids) {
      const instance = store.revision<TaskInstance>(id, "task_instance");
      if (!compatibleGoal(goal, store.revision<Goal>(instance.body.goal_revision_id, "goal")) || !events.some(e => e.kind === "task_delivered" && e.branch === "real" && e.session_id === sessionId && e.payload.instance_revision_id === id)) throw new Error("Round task belongs to another lesson");
      if (events.some(e => e.kind === "attempt_submitted" && e.payload.instance_revision_id === id)) throw new Error("Round tasks must not borrow earlier attempts");
      if (store.revisions("drill_round").some(r => (r.body.task_instance_ids as string[]).includes(id))) throw new Error("Task instance already belongs to a round");
    }
    if (input.prior_round_revision_id) {
      const prior = ownedRound(store, input.prior_round_revision_id, sessionId).round;
      if (roundStop(store, prior.revision_id, sessionId)) throw new Error("Drill round is stopped");
      if (input.ordinal !== prior.body.ordinal + 1) throw new Error("Round ordinal must follow its predecessor");
    } else if (input.ordinal !== 1) throw new Error("A later round requires its predecessor");
    const created = store.define({ operation_id: randomUUID(), kind: "drill_round", expected_goal_revision_id: goal.revision_id, body: { goal_revision_id: goal.revision_id, ...input } }, "pi", sessionId);
    const round = store.revision<DrillRound>(created.revision_id, "drill_round");
    store.append("decision", { action: "drill_round_created", lesson_goal_entity_id: goal.entity_id, goal_revision_id: goal.revision_id, round_revision_id: round.revision_id, ordinal: input.ordinal, difficulty_target: input.difficulty_target, reason: `Created drill round ${input.ordinal}; ${input.difficulty_target} is a design target, not validated difficulty`, evidence_event_ids: [] }, randomUUID(), "host", sessionId);
    return round;
  })();
}

export function submitDrillRound(store: LearningStore, roundRevisionId: string, submissions: DrillItemSubmission[], sessionId: string): DrillRoundSubmissionResult {
  return store.db.transaction(() => {
    const { round, goal } = ownedRound(store, roundRevisionId, sessionId);
    if (roundStop(store, roundRevisionId, sessionId)) throw new Error("Drill round is stopped");
    if (!submissions.length) throw new Error("A round submission requires actual work");
    if (new Set(submissions.map(s => s.instance_id)).size !== submissions.length) throw new Error("Duplicate item submissions");
    const events = store.events();
    for (const sub of submissions) {
      if (!round.body.task_instance_ids.includes(sub.instance_id)) throw new Error("Submitted instance does not belong to this drill round");
      if (events.some(e => e.kind === "attempt_submitted" && e.payload.instance_revision_id === sub.instance_id)) throw new Error("Item already submitted; use a fresh task for a recheck");
      if (!sub.text.trim() || sub.text.length > 8000) throw new Error("Item response must contain bounded actual work");
    }
    const attempts = submissions.map(sub => {
      const response = store.learnerResponse(sub.text, sessionId, randomUUID(), { goal_revision_id: goal.revision_id, instance_revision_id: sub.instance_id });
      const attemptId = randomUUID();
      store.record({ operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attemptId, instance_revision_id: sub.instance_id, response_event_id: response.event_id, declared_aids: sub.declared_aids ?? [] } }, sessionId);
      return { attempt_id: attemptId, instance_revision_id: sub.instance_id, response: sub.text };
    });
    return { round_revision_id: roundRevisionId, attempts };
  })();
}

export function diagnoseDrill(store: LearningStore, roundRevisionId: string, sessionId: string, throughSeq = store.throughSeq, asOfTime = store.now()): DrillDiagnostics {
  const { round } = ownedRound(store, roundRevisionId, sessionId, throughSeq);
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.session_id === sessionId && e.seq > round.created_seq && e.occurred_at <= asOfTime);
  const attempts = events.filter(e => e.kind === "attempt_submitted" && round.body.task_instance_ids.includes(e.payload.instance_revision_id as string));
  const attemptIds = new Set(attempts.map(e => e.payload.attempt_id as string));
  const assessedAttempts = new Set(events.filter(e => e.kind === "assessment" && !e.payload.step_attempt_id && attemptIds.has(e.payload.attempt_id as string)).map(e => e.payload.attempt_id as string));
  const submitted = new Set(attempts.map(e => e.payload.instance_revision_id as string));
  const evaluated = new Set(attempts.filter(e => assessedAttempts.has(e.payload.attempt_id as string)).map(e => e.payload.instance_revision_id as string));
  const views = projectComponents(store, throughSeq, asOfTime, sessionId);
  const tasks = round.body.task_instance_ids.map(id => store.revision<TaskDefinition>(store.revision<TaskInstance>(id, "task_instance").body.definition_revision_id, "task_definition").body);
  const evidenced: string[] = [], unobserved: string[] = [];
  for (const id of new Set(tasks.flatMap(t => t.component_revision_ids))) {
    const observed = views.find(v => v.component_revision_id === id)?.observations.some(o => attemptIds.has(o.attempt_id) && o.eligibility === "independent" && o.outcome === "success");
    (observed ? evidenced : unobserved).push(id);
  }
  const components = new Set(tasks.flatMap(task => task.component_revision_ids));
  const gaps = [...new Set(views.filter(view => components.has(view.component_revision_id)).flatMap(view => view.observations.filter(o => attemptIds.has(o.attempt_id) && (o.outcome === "failure" || o.outcome === "partial" || o.criterion_evidence.some(c => c.observed && !c.satisfied))).map(o => o.assessment_event_id)))].sort();
  const enabled = drillGapTeachingEnabled(store, sessionId, throughSeq, asOfTime);
  const released = events.some(e => e.kind === "decision" && e.actor === "learner" && e.payload.action === "drill_gap_teaching_continued" && e.payload.round_revision_id === roundRevisionId && Array.isArray(e.payload.assessment_event_ids) && canonical(e.payload.assessment_event_ids) === canonical(gaps));
  const ready = enabled && gaps.length > 0 && submitted.size === round.body.task_instance_ids.length && evaluated.size === submitted.size && !released && !roundStop(store, roundRevisionId, sessionId, throughSeq);
  return { round_revision_id: roundRevisionId, items_delivered: round.body.task_instance_ids.length, items_submitted: submitted.size, items_evaluated: evaluated.size, items_unassessed: submitted.size - evaluated.size, evidenced_components: evidenced, unobserved_components: unobserved,
    gap_teaching: { enabled, ready, assessment_event_ids: gaps, guidance: "When ready, explain only observed assessed gaps between rounds, with cause uncertainty. Then ask for native /continue before fresh questions. Do not repeat graded answers, alter prior marks, treat unobserved skills as deficits, or claim supported work is independent." },
    summary: `Round ${round.body.ordinal}: ${round.body.task_instance_ids.length} delivered, ${submitted.size} submitted, ${evaluated.size} assessed; ${evidenced.length} component(s) independently evidenced in this round, ${unobserved.length} unobserved. Difficulty target and longer-term retention are not validated by delivery.` };
}

export function stopDrill(store: LearningStore, roundRevisionId: string, sessionId: string) {
  return store.db.transaction(() => {
    const { round, goal } = ownedRound(store, roundRevisionId, sessionId);
    const existing = roundStop(store, roundRevisionId, sessionId); if (existing) return existing;
    const diag = diagnoseDrill(store, roundRevisionId, sessionId);
    const checkpoint = store.append("checkpoint", { goal_revision_id: goal.revision_id, round_revision_id: roundRevisionId, summary: `Drill round ${round.body.ordinal} stopped at learner request: ${diag.summary}`, next_action: "Keep actual work and unresolved gaps; continue only at learner request", gaps: diag.unobserved_components.length ? [`Unobserved components: ${diag.unobserved_components.join(", ")}`] : ["Retention and unfamiliar transfer remain untested"], stopped: true }, randomUUID(), "learner", sessionId);
    store.rebuild(); return checkpoint;
  })();
}
