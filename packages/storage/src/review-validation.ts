import { validTime, type Goal, type Revision, type LearningEvent, type Assessment, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import { POLICY_VERSION } from "../../core/src/learning.ts";
import type { LearningStore } from "./store.ts";

export class ReviewValidationError extends Error {}
function reject(message: string): never { throw new ReviewValidationError(message); }
const compatible = (a: Revision<Goal>, b: Revision<Goal>) => a.entity_id === b.entity_id && a.body.objective === b.body.objective && a.body.subject === b.body.subject;
function known(event: LearningEvent, seq: number, cutoff: number) { return event.branch === "real" && event.seq <= seq && Date.parse(event.occurred_at) <= cutoff && Date.parse(event.recorded_at) <= cutoff; }
/** Historical selection uses only real records known by BOTH sequence and time. */
export function reviewGoalAt(store: LearningStore, sessionId: string, throughSeq = store.throughSeq, asOfTime = store.now()): Revision<Goal> | undefined {
  const cutoff = Date.parse(validTime(asOfTime));
  const events = store.events(throughSeq).filter(e => e.session_id === sessionId && known(e, throughSeq, cutoff));
  const ids = new Set(events.filter(e => e.kind === "decision" && e.payload.action === "revision_defined" && e.payload.kind === "goal").map(e => e.payload.revision_id));
  const goals = new Map(store.revisions("goal", throughSeq).filter(r => ids.has(r.revision_id)).map(r => [r.entity_id, store.revision<Goal>(r.revision_id, "goal")]));
  const binding = events.filter(e => e.kind === "decision" && e.actor === "host" && e.payload.action === "lesson_bound").at(-1);
  if (binding) return goals.get(String(binding.payload.goal_entity_id));
  if (goals.size > 1) reject("Choose the active lesson before querying reviews in a legacy mixed conversation");
  return [...goals.values()][0];
}
export function assertReviewComponent(store: LearningStore, componentId: string, sessionId: string, goal: Revision<Goal>, throughSeq = store.throughSeq, asOfTime = store.now(), latest = true): void {
  const component = store.revision(componentId, "component");
  const created = store.events(throughSeq).find(e => e.seq === component.created_seq);
  if (!created || created.session_id !== sessionId || !known(created, throughSeq, Date.parse(asOfTime)) || created.kind !== "decision" || created.payload.action !== "revision_defined" || created.payload.kind !== "component" || created.payload.revision_id !== componentId) reject("Review component belongs to another lesson or unknown origin");
  const scope = created.payload.disclosure_scope;
  const goalId = scope && typeof scope === "object" && "goal_revision_id" in scope ? scope.goal_revision_id : undefined;
  if (typeof goalId !== "string" || !compatible(store.revision<Goal>(goalId, "goal"), goal)) reject("Review component belongs to another lesson or objective");
  if (latest && store.revisions("component", throughSeq).filter(r => r.entity_id === component.entity_id).at(-1)?.revision_id !== componentId) reject("Stale review component revision; refresh the review offer");
}
export function assertReviewAuthorization(store: LearningStore, payload: Record<string, unknown>, sessionId: string, goal: Revision<Goal>, occurredAt: string, throughSeq = store.throughSeq): void {
  const consent = store.event(String(payload.consent_response_event_id), "learner_response");
  if (payload.consent !== true) reject("Review scheduling requires learner consent");
  if (typeof payload.authorization_event_id !== "string") reject("Review scheduling requires a trusted host authorization receipt");
  const auth = store.event(String(payload.authorization_event_id), "decision");
  if (Date.parse(occurredAt) < Math.max(Date.parse(auth.occurred_at), Date.parse(consent.occurred_at))) reject("Review consent/authorization cannot be backdated");
  if (auth.actor !== "host" || !known(auth, throughSeq, Date.parse(occurredAt)) || auth.session_id !== sessionId || auth.payload.action !== "review_offer_authorized" || auth.payload.goal_revision_id !== goal.revision_id || auth.payload.lesson_goal_entity_id !== goal.entity_id || !["accept", "reschedule"].includes(String(auth.payload.offer_action))) reject("Review authorization is not a real current-goal trusted-host receipt");
  if (reviewGoalAt(store, sessionId, throughSeq, occurredAt)?.revision_id !== goal.revision_id || auth.payload.component_revision_id !== payload.component_revision_id || auth.payload.due_at !== payload.due_at) reject("Review scheduling does not match the current authorized offer");
  if (consent.actor !== "learner" || consent.session_id !== sessionId || !known(consent, throughSeq, Date.parse(occurredAt)) || consent.seq <= auth.seq || Date.parse(consent.occurred_at) < Date.parse(auth.occurred_at)) reject("Review consent must be real learner control/work following this authorization; no backdating");
  if (payload.policy_version !== undefined && payload.policy_version !== POLICY_VERSION) reject("Unsupported review policy version");
  assertReviewComponent(store, String(payload.component_revision_id), sessionId, goal, throughSeq, occurredAt);
}
function assertReviewWork(store: LearningStore, schedule: LearningEvent, assessment: LearningEvent<Assessment>, sessionId: string, goal: Revision<Goal>, occurredAt: string, throughSeq: number): void {
  if (assessment.actor !== "pi" || assessment.session_id !== sessionId || !known(assessment, throughSeq, Date.parse(occurredAt))) reject("Review completion evidence lacks canonical assessment authority or belongs to another lesson or time");
  if (assessment.payload.step_attempt_id) reject("Review completion requires a whole-task assessment, not step-only evidence");
  const attempt = store.findAttempt(assessment.payload.attempt_id);
  const instance = store.revision<TaskInstance>(attempt.payload.instance_revision_id, "task_instance"), task = store.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition");
  const delivered = store.events(throughSeq).find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instance.revision_id);
  if (attempt.session_id !== sessionId || !known(attempt, throughSeq, Date.parse(occurredAt)) || !delivered || delivered.session_id !== sessionId || !known(delivered, throughSeq, Date.parse(occurredAt)) || !compatible(store.revision<Goal>(instance.body.goal_revision_id, "goal"), goal)) reject("Review completion requires retention work from this lesson");
  if (instance.body.purpose !== "retention" || !task.body.component_revision_ids.includes(String(schedule.payload.component_revision_id)) || assessment.payload.rubric_revision_id !== task.body.rubric_revision_id || attempt.seq <= schedule.seq || delivered.seq <= schedule.seq || Date.parse(attempt.occurred_at) < Date.parse(String(schedule.payload.due_at))) reject("Review completion requires a matching delayed retention attempt after scheduling and its due date");
}
export interface ReviewRecord { schedule: LearningEvent; goal?: Revision<Goal>; status: "pending" | "completed" | "cancelled" | "rescheduled" | "unresolved"; completion?: LearningEvent; unresolved_reason?: string }
/** Read-only, append-only reduction. Invalid legacy/adversarial receipts never retire accepted work. */
export function projectReviewRecords(store: LearningStore, sessionId: string, asOfTime = store.now(), throughSeq = store.throughSeq, includeArchived = false): ReviewRecord[] {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > store.throughSeq) reject("Invalid review sequence boundary");
  const cutoff = Date.parse(validTime(asOfTime)), goal = reviewGoalAt(store, sessionId, throughSeq, asOfTime);
  const records = new Map<string, ReviewRecord>();
  const events = store.events(throughSeq).filter(e => e.session_id === sessionId && known(e, throughSeq, cutoff));
  for (const e of events) {
    try {
      if (e.kind === "review_scheduled") {
        const atGoal = reviewGoalAt(store, sessionId, e.seq, e.recorded_at);
        if (!includeArchived && atGoal && goal && !compatible(atGoal, goal)) continue;
        if (!atGoal || (!includeArchived && !goal)) reject("Review lesson reference is unresolved");
        if (e.actor !== "pi") reject("Review schedule lacks canonical admission actor");
        try { validTime(String(e.payload.due_at)); } catch { reject("Review due date is unresolved"); }
        assertReviewAuthorization(store, e.payload, sessionId, atGoal, e.occurred_at, e.seq - 1);
        if ([...records.values()].some(r => r.status !== "unresolved" && r.schedule.payload.authorization_event_id === e.payload.authorization_event_id)) reject("Review authorization receipt was already used");
        records.set(e.event_id, { schedule: e, goal: atGoal, status: "pending" });
      } else if (e.kind === "review_completed") {
        const item = records.get(String(e.payload.schedule_event_id)); if (e.actor !== "pi" || !item || !item.goal || item.status !== "pending") continue;
        const selected = reviewGoalAt(store, sessionId, e.seq, e.recorded_at); if (!selected || !compatible(selected, item.goal)) continue;
        assertReviewWork(store, item.schedule, store.event<Assessment>(String(e.payload.assessment_event_id), "assessment"), sessionId, item.goal, e.occurred_at, e.seq - 1);
        item.status = "completed"; item.completion = e;
      } else if (e.kind === "decision" && e.actor === "host" && ["review_cancelled", "review_declined", "review_rescheduled"].includes(String(e.payload.action))) {
        const item = records.get(String(e.payload.schedule_event_id)); if (!item || !item.goal || item.status !== "pending" || e.payload.lesson_goal_entity_id !== item.goal.entity_id) continue;
        const selected = reviewGoalAt(store, sessionId, e.seq, e.recorded_at); if (!selected || !compatible(selected, item.goal) || (e.payload.goal_revision_id !== undefined && e.payload.goal_revision_id !== selected.revision_id)) continue;
        if (e.payload.action === "review_rescheduled") {
          const replacement = records.get(String(e.payload.replacement_schedule_event_id));
          if (!replacement || !replacement.goal || replacement.status !== "pending" || !compatible(replacement.goal, item.goal) || replacement.schedule.payload.component_revision_id !== item.schedule.payload.component_revision_id || replacement.schedule.payload.due_at !== e.payload.new_due_at || replacement.schedule.seq <= item.schedule.seq) continue;
          const replacementAuth = store.event(String(replacement.schedule.payload.authorization_event_id), "decision");
          if (replacementAuth.payload.offer_action !== "reschedule" || replacementAuth.payload.schedule_event_id !== item.schedule.event_id) continue;
          item.status = "rescheduled";
        } else item.status = "cancelled";
      }
    } catch (error) {
      // Missing references are legacy data errors; database/runtime failures must still propagate.
      if (!(error instanceof ReviewValidationError) && !(error instanceof Error && /^Missing (component revision|goal revision|decision|learner_response|assessment|task_instance revision|task_definition revision|attempt):/.test(error.message))) throw error;
      if (e.kind === "review_scheduled") records.set(e.event_id, { schedule: e, status: "unresolved", unresolved_reason: error.message });
    }
  }
  return [...records.values()];
}
export function assertReviewCompletion(store: LearningStore, scheduleId: string, assessmentId: string, sessionId: string, goal: Revision<Goal>, occurredAt: string): void {
  const item = projectReviewRecords(store, sessionId).find(r => r.schedule.event_id === scheduleId);
  if (!item || !item.goal || item.status !== "pending" || !compatible(item.goal, goal)) reject("Scheduled review is not pending in this lesson");
  assertReviewWork(store, item.schedule, store.event<Assessment>(assessmentId, "assessment"), sessionId, goal, occurredAt, store.throughSeq);
}
