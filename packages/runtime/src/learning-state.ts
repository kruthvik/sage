import { validTime, type Goal, type Revision, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { projectTeachingState, type TeachingState } from "./teaching.ts";
import { projectLearnFlow, type LearnFlow } from "./learn-flow.ts";

export type LearningPhase = "instruction_pending" | "question_pending" | "unit_complete" | "orient" | "prepare" | "awaiting_answer" | "submission_pending" | "assessment_pending" | "feedback" | "repair" | "checkpoint" | "stopped";
export interface CurrentLearningTask {
  instance_revision_id: string;
  definition_revision_id: string;
  rubric_revision_id: string;
  purpose: TaskInstance["purpose"];
  response_event_id: string | null;
  attempt_id: string | null;
  assessment_event_id: string | null;
  assistance_event_ids: string[];
  assistance_count: number;
  overridden: boolean;
}
export interface LearningState {
  schema_version: 1;
  state_revision: string;
  through_seq: number;
  as_of_time: string;
  lesson_goal_entity_id: string | null;
  goal_revision_id: string | null;
  mode: Goal["mode"] | null;
  phase: LearningPhase;
  resume_phase?: LearningPhase;
  current_task: CurrentLearningTask | null;
  teaching?: TeachingState;
  learn_flow?: LearnFlow;
  pending_count: number;
  plan: { revision_id: string; next_activities: string[]; known_gaps: string[]; uncertain_assumptions: string[] } | null;
  next_action: string;
}
const actions: Record<LearningPhase, string> = {
  instruction_pending: "Offer the pinned bounded instruction through the native activity; wait for explicit trusted Continue before its question can release.",
  question_pending: "Release only the authorized pinned guided question; continuation is not delivery, reading, understanding or learner work.",
  unit_complete: "The unit has observed criterion feedback, not mastery or consent. Choose the next useful unit from scoped evidence.",
  orient: "Ask for the learner's objective; do not infer ability.",
  prepare: "Prepare one useful task with pinned criteria, then wait for actual work.",
  awaiting_answer: "Keep the current task; wait for work or answer a clarification without revealing its solution.",
  submission_pending: "Read the captured message. Classify work versus clarification/control before recording an attempt; do not score a receipt alone.",
  assessment_pending: "Assess only the actual attempt against its pinned rubric; award no unseen reasoning credit.",
  feedback: "Give concise criterion-specific feedback; separate observed marks from encouragement and offer a fresh less-supported check.",
  repair: "Offer targeted correction and a fresh less-supported check; honor explicit skip/continue/stop without changing outcomes.",
  checkpoint: "Honor the learner's workflow override; preserve unresolved evidence and choose a useful next move.",
  stopped: "Keep the saved task and plan. Resume only on actual learner input; stopping is not successful completion.",
};

/** Model-independent operational projection over the original seven-table ledger.
 * Does not mint answers, infer semantic correctness, write a second memory, or rewind evidence.
 * Provider callers must apply current disclosure authorization before exposing this state.
 */
export function projectLearningState(store: LearningStore, sessionId: string, throughSeq = store.throughSeq, asOfTime = store.now()): LearningState {
  if (!Number.isInteger(throughSeq) || throughSeq < 0 || throughSeq > store.throughSeq) throw new Error("Invalid learning-state sequence");
  const asOf = validTime(asOfTime);
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.session_id === sessionId && e.occurred_at <= asOf);
  const ownedSeqs = new Set(events.map(e => e.seq));
  const revisions = store.revisions(undefined, throughSeq).filter(r => r.created_at <= asOf);
  const selected = store.lessonGoal(sessionId, throughSeq);
  const goal = revisions.filter(r => r.kind === "goal" && r.entity_id === selected?.entity_id).at(-1) as Revision<Goal> | undefined;
  const compatible = (revisionId: unknown) => {
    if (typeof revisionId !== "string" || !goal) return false;
    const frozen = revisions.find(r => r.revision_id === revisionId && r.kind === "goal");
    return frozen?.entity_id === goal.entity_id && frozen.body.objective === goal.body.objective && frozen.body.subject === goal.body.subject;
  };
  const plan = revisions.filter(r => r.kind === "plan" && ownedSeqs.has(r.created_seq) && compatible(r.body.goal_revision_id)).at(-1);
  const state: LearningState = {
    schema_version: 1, state_revision: `${goal?.entity_id ?? sessionId}:${throughSeq}`, through_seq: throughSeq, as_of_time: asOf,
    lesson_goal_entity_id: goal?.entity_id ?? null, goal_revision_id: goal?.revision_id ?? null, mode: goal?.body.mode ?? null,
    phase: goal ? "prepare" : "orient", current_task: null, pending_count: 0,
    plan: plan ? { revision_id: plan.revision_id, next_activities: (plan.body.next_activities as string[]).slice(0, 3).map(v => v.slice(0, 300)), known_gaps: (plan.body.known_gaps as string[]).slice(0, 3).map(v => v.slice(0, 300)), uncertain_assumptions: (plan.body.uncertain_assumptions as string[]).slice(0, 3).map(v => v.slice(0, 300)) } : null,
    next_action: actions[goal ? "prepare" : "orient"],
  };
  if (!goal) return state;
  const byId = new Map(events.map(e => [e.event_id, e]));
  const learnerInputs = events.filter(e => e.kind === "learner_response" && e.actor === "learner" && !["control", "message"].includes(e.payload.input_kind as string));
  const advance = goal.body.mode === "learn" ? events.filter(e => e.kind === "decision" && e.actor === "learner" && e.operation_id.startsWith("learn-control:") && e.payload.action === "learn_progression_advanced" && compatible(e.payload.goal_revision_id)).at(-1) : undefined;
  const requireReview = goal.body.learning_preferences?.review_before_advance === true;
  const tasks = revisions.filter(r => r.kind === "task_instance" && ownedSeqs.has(r.created_seq) && compatible(r.body.goal_revision_id)).flatMap(instance => {
    const delivered = events.find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instance.revision_id);
    if (!delivered) return [];
    const definition = store.revision<TaskDefinition>(instance.body.definition_revision_id as string, "task_definition");
    const response = learnerInputs.filter(e => e.seq > delivered.seq && e.payload.instance_revision_id === instance.revision_id && (!e.payload.goal_revision_id || compatible(e.payload.goal_revision_id))).at(-1);
    const attempt = events.filter(e => e.kind === "attempt_submitted" && e.payload.instance_revision_id === instance.revision_id && (() => {
      const work = byId.get(e.payload.response_event_id as string);
      return work && learnerInputs.includes(work) && work.seq > delivered.seq && (!work.payload.instance_revision_id || work.payload.instance_revision_id === instance.revision_id) && (!work.payload.goal_revision_id || compatible(work.payload.goal_revision_id));
    })()).at(-1);
    const attemptResponse = attempt && byId.get(attempt.payload.response_event_id as string);
    const assessment = attempt && events.filter(e => e.kind === "assessment" && e.payload.attempt_id === attempt.payload.attempt_id && !e.payload.step_attempt_id && e.payload.rubric_revision_id === definition.body.rubric_revision_id).at(-1);
    const skipped = events.some(e => e.kind === "decision" && e.actor === "learner" && e.seq > delivered.seq && e.payload.action === "learning_task_skipped" && e.payload.instance_revision_id === instance.revision_id && (e.payload.evidence_event_ids as string[] | undefined)?.includes(delivered.event_id));
    const override = attempt && events.some(e => e.kind === "decision" && e.actor === "learner" && e.seq > attempt.seq && e.payload.action === "response_review_override" && (e.payload.evidence_event_ids as string[] | undefined)?.includes(attempt.event_id));
    const presented = assessment && events.some(e => e.kind === "decision" && e.actor === "host" && e.seq > assessment.seq && e.payload.action === "response_feedback_presented" && (e.payload.evidence_event_ids as string[] | undefined)?.includes(assessment.event_id));
    const review = assessment?.payload.feedback_review as { ready_to_continue: boolean } | undefined;
    const help = events.filter(e => e.kind === "assistance" && e.payload.instance_revision_id === instance.revision_id && ["exposed", "possibly_exposed"].includes(e.payload.stage as string));
    let phase: LearningPhase = "awaiting_answer", pending = true;
    const newerResponse = response && (!attemptResponse || response.seq > attemptResponse.seq);
    if (skipped) { phase = "checkpoint"; pending = false; }
    else if (newerResponse) phase = "submission_pending";
    else if (override) { phase = "checkpoint"; pending = false; }
    else if (attempt) {
      if (!assessment || (requireReview && !review)) phase = "assessment_pending";
      else if (requireReview && presented && !review?.ready_to_continue) phase = "repair";
      else { phase = "feedback"; pending = requireReview && !presented; }
    }
    const task: CurrentLearningTask = { instance_revision_id: instance.revision_id, definition_revision_id: definition.revision_id, rubric_revision_id: definition.body.rubric_revision_id, purpose: instance.body.purpose as TaskInstance["purpose"], response_event_id: (newerResponse ? response.event_id : attemptResponse?.event_id) ?? null, attempt_id: newerResponse ? null : (attempt?.payload.attempt_id as string | undefined) ?? null, assessment_event_id: newerResponse ? null : assessment?.event_id ?? null, assistance_event_ids: help.slice(-8).map(e => e.event_id), assistance_count: help.length, overridden: Boolean(skipped || (override && !newerResponse)) };
    return [{ task, phase, pending, delivery_seq: delivered.seq }];
  });
  const activeTasks = advance ? tasks.filter(task => task.delivery_seq > advance.seq) : tasks;
  const pending = activeTasks.filter(t => t.pending);
  const current = pending[0] ?? activeTasks.at(-1);
  state.pending_count = pending.length;
  if (current) { state.current_task = current.task; state.phase = current.phase; }
  const teaching = projectTeachingState(store, sessionId, goal.revision_id, throughSeq, asOf, tasks);
  if (teaching && (!advance || (byId.get(teaching.prepared_event_id)?.seq ?? 0) > advance.seq)) {
    state.teaching = teaching;
    if ((!pending.length && !["unit_complete", "checkpoint"].includes(teaching.stage)) || current?.task.instance_revision_id === teaching.instance_revision_id) {
      state.phase = teaching.stage;
      state.current_task = tasks.find(t => t.task.instance_revision_id === teaching.instance_revision_id)?.task ?? null;
      state.pending_count = Math.max(pending.length, ["unit_complete", "checkpoint"].includes(teaching.stage) ? 0 : 1);
    }
  }
  const checkpoint = events.filter(e => e.kind === "checkpoint" && compatible(e.payload.goal_revision_id)).at(-1);
  const latestInput = learnerInputs.filter(e => (!e.payload.goal_revision_id || compatible(e.payload.goal_revision_id)) && (!e.payload.instance_revision_id || e.payload.instance_revision_id === state.current_task?.instance_revision_id)).at(-1);
  const learnerControl = events.filter(e => e.kind === "decision" && e.actor === "learner" && e.payload.action === "learning_task_skipped" && compatible(e.payload.goal_revision_id)).at(-1);
  if (checkpoint?.payload.stopped && (goal.body.mode === "drill" || (!latestInput || latestInput.seq <= checkpoint.seq) && (!learnerControl || learnerControl.seq <= checkpoint.seq))) { state.resume_phase = state.phase; state.phase = "stopped"; }
  state.next_action = actions[state.phase];
  const flow = projectLearnFlow(store, state, sessionId);
  if (flow) { state.learn_flow = flow; state.next_action = flow.instruction; }
  return state;
}
