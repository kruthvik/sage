import { Type } from "typebox";
import { validate } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { projectLearningState } from "./learning-state.ts";

const id = Type.String({ minLength: 1, maxLength: 180 });
const SkipSchema = Type.Object({ operation_id: id, expected_goal_revision_id: id, expected_state_revision: Type.String({ minLength: 1, maxLength: 300 }), instance_revision_id: id }, { additionalProperties: false });
interface SkipRequest { operation_id: string; expected_goal_revision_id: string; expected_state_revision: string; instance_revision_id: string }

export function assertLearningTransition(store: LearningStore, sessionId: string, expectedState: string | undefined, delivering: boolean) {
  const state = projectLearningState(store, sessionId);
  if (expectedState !== undefined && expectedState !== state.state_revision) throw new Error("Stale learning state; refresh learning_context before acting");
  if (delivering && (state.pending_count > 0 || state.phase === "stopped")) throw new Error("The current task is pending or stopped; wait for work, assess it, or let the learner explicitly skip before delivering another task");
}

export function assertCurrentLearningTask(store: LearningStore, sessionId: string, instanceId: string, allowStopped = false) {
  const state = projectLearningState(store, sessionId);
  if (state.current_task?.instance_revision_id !== instanceId || state.current_task.overridden || (!allowStopped && state.phase === "stopped")) throw new Error("Task is no longer current or is stopped; refresh local learning state");
}

/** Trusted native learner control, not a model tool. Receipts do not change marks or erase delivery. */
export function skipLearningTask(store: LearningStore, input: unknown, sessionId: string) {
  validate<SkipRequest>(SkipSchema, input);
  return store.db.transaction(() => {
    const frozenGoal = store.revision(input.expected_goal_revision_id, "goal");
    const delivery = store.events().find(e => e.kind === "task_delivered" && e.session_id === sessionId && e.payload.instance_revision_id === input.instance_revision_id);
    if (!delivery) throw new Error("Task control belongs to another conversation");
    const payload = { action: "learning_task_skipped", lesson_goal_entity_id: frozenGoal.entity_id, goal_revision_id: input.expected_goal_revision_id, instance_revision_id: input.instance_revision_id, reason: "Learner explicitly skipped the pending task; no response or successful performance is inferred", evidence_event_ids: [delivery.event_id], user_override: true };
    const existing = store.events().find(e => e.operation_id === input.operation_id);
    if (!existing) {
      if (store.lessonGoal(sessionId)?.revision_id !== input.expected_goal_revision_id) throw new Error("Stale goal; refresh local learning state");
      assertLearningTransition(store, sessionId, input.expected_state_revision, false);
      assertCurrentLearningTask(store, sessionId, input.instance_revision_id, true);
      if (!projectLearningState(store, sessionId).pending_count) throw new Error("Only the currently pending task can be skipped");
    }
    const receipt = store.append("decision", payload, input.operation_id, "learner", sessionId, store.now(), input);
    if (!existing) store.rebuild();
    return receipt;
  })();
}
