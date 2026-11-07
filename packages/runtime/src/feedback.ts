import { randomUUID } from "node:crypto";
import type { Assessment, LearningEvent, TaskInstance } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { assertCurrentLearningTask } from "./learning-controller.ts";

/** Workflow facts, not a second scorer or a mastery gate. Legacy goals keep their behavior. */
export function feedbackState(store: LearningStore, sessionId: string, throughSeq = store.throughSeq, asOfTime?: string) {
  const goal = store.lessonGoal(sessionId, throughSeq);
  if (!goal?.body.learning_preferences?.review_before_advance) return { phase: "idle" as const };
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.session_id === sessionId && (!asOfTime || e.occurred_at <= asOfTime));
  const attempt = events.filter(e => e.kind === "attempt_submitted" && store.revision(store.revision<TaskInstance>(e.payload.instance_revision_id as string, "task_instance").body.goal_revision_id, "goal").entity_id === goal.entity_id).at(-1);
  if (!attempt) return { phase: "idle" as const };
  const scope = { attempt_id: attempt.payload.attempt_id as string, instance_revision_id: attempt.payload.instance_revision_id as string, response_event_id: attempt.payload.response_event_id as string };
  if (events.some(e => e.kind === "decision" && e.actor === "learner" && e.seq > attempt.seq && (e.payload.action === "response_review_override" && (e.payload.evidence_event_ids as string[]).includes(attempt.event_id) || e.payload.action === "learning_task_skipped" && e.payload.instance_revision_id === scope.instance_revision_id))) return { phase: "overridden" as const, ...scope };
  const assessment = events.filter(e => e.kind === "assessment" && e.payload.attempt_id === scope.attempt_id && !e.payload.step_attempt_id).at(-1) as LearningEvent<Assessment> | undefined;
  if (!assessment?.payload.feedback_review) return { phase: "awaiting_review" as const, ...scope };
  const presented = events.some(e => e.kind === "decision" && e.actor === "host" && e.payload.action === "response_feedback_presented" && (e.payload.evidence_event_ids as string[]).includes(assessment.event_id));
  if (!presented) return { phase: "awaiting_feedback" as const, ...scope, assessment_event_id: assessment.event_id };
  return { phase: assessment.payload.feedback_review.ready_to_continue ? "ready" as const : "needs_revision" as const, ...scope, assessment_event_id: assessment.event_id };
}
export function assertCanAdvance(store: LearningStore, sessionId: string) {
  const state = feedbackState(store, sessionId);
  if (["awaiting_review", "awaiting_feedback", "needs_revision"].includes(state.phase)) throw new Error("Review and present feedback on the learner's current work before advancing; repair blocking issues or let the learner explicitly use /continue. /stop remains available.");
}
export function presentFeedback(store: LearningStore, assessmentId: string, sessionId: string) {
  return store.db.transaction(() => {
    const state = feedbackState(store, sessionId);
    if (!("assessment_event_id" in state) || state.assessment_event_id !== assessmentId) throw new Error("Feedback display receipt must match the current response review and conversation");
    const saved = store.events().find(e => e.operation_id === `feedback-presented:${assessmentId}`);
    if (saved) return saved;
    assertCurrentLearningTask(store, sessionId, state.instance_revision_id);
    const receipt = store.append("decision", { action: "response_feedback_presented", reason: "Trusted native interface queued the recorded feedback for display; this is not proof the learner read or agreed with it", evidence_event_ids: [assessmentId] }, `feedback-presented:${assessmentId}`, "host", sessionId);
    store.rebuild(); return receipt;
  })();
}
export function overrideFeedback(store: LearningStore, sessionId: string) {
  const state = feedbackState(store, sessionId);
  if (!("attempt_id" in state) || !["awaiting_review", "awaiting_feedback", "needs_revision"].includes(state.phase)) return { phase: state.phase, overridden: false };
  const attempt = store.events().find(e => e.kind === "attempt_submitted" && e.payload.attempt_id === state.attempt_id)!;
  store.append("decision", { action: "response_review_override", reason: "Learner explicitly chose to continue without completing the review/repair; original evidence and uncertainty are unchanged", evidence_event_ids: [attempt.event_id], user_override: true }, randomUUID(), "learner", sessionId);
  store.rebuild(); return { overridden: true, attempt_id: state.attempt_id };
}
export function feedbackText(assessment: Assessment & { marking_summary?: { earned: number; maximum: number; unobserved_dimensions: string[]; authority: string } }): string {
  const review = assessment.feedback_review, marks = assessment.marking_summary;
  const authority = marks?.authority === "pi_rubric_proposal" ? "rubric proposal" : marks?.authority === "deterministic" ? "objective answer match" : "recorded assessment";
  const marking = marks ? [`Marks: ${marks.earned}/${marks.maximum} · ${authority}`, ...assessment.scores.map(score => `${score.dimension}: ${score.score}`), ...(marks.unobserved_dimensions.length ? [`Unobserved criteria: ${marks.unobserved_dimensions.join(", ")}`] : [])].join("\n") : undefined;
  return [...(marking ? [marking] : []), assessment.feedback, ...(review?.issues.map(issue => `[${issue.severity}] “${issue.quote}”\n${issue.problem}\nCorrection: ${issue.suggestion}`) ?? []), review ? review.ready_to_continue ? "Review complete: you may continue. Precision/polish suggestions are not new rubric penalties." : "Repair the blocking issue, or use /continue to override; /stop always works." : "Detailed response review remains pending."].join("\n\n");
}
