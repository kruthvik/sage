import { randomUUID } from "node:crypto";
import type { Revision, TaskDefinition, TaskInstance } from "../../core/src/contracts.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";

export function importProtectedTask(
  store: LearningStore,
  task: Omit<TaskDefinition, "partition">,
  sessionId: string,
  authorizationEventId?: string,
): Revision<TaskDefinition> {
  if (!authorizationEventId) throw new Error("Protected imports require an explicit scoped reviewer attestation; no expert provenance is inferred");
  return store.db.transaction(() => {
    const goal = store.lessonGoal(sessionId);
    if (!goal) throw new Error("Select a lesson before importing protected assessment tasks");
    const receipt = store.event(authorizationEventId, "decision");
    if (receipt.session_id !== sessionId || receipt.branch !== "real" || !["expert", "curator"].includes(receipt.actor) || receipt.payload.action !== "assessment_import_authorized" || receipt.payload.goal_revision_id !== goal.revision_id || receipt.payload.task_hash !== hash(canonical(task))) throw new Error("Protected import attestation is foreign, hypothetical, stale or does not match this exact task");
    if (!task.review.reviewer_provenance?.trim() || task.review.reviewer_role !== receipt.actor || !["human", "curated"].includes(task.review.method)) throw new Error("Protected import attestation must preserve explicit reviewer role/provenance and review method");
    // The receipt is an attributable assertion, not verification of credentials or calibration.
    // Never upgrade stakes, readiness, review method or source provenance on import.
    const created = store.define({ operation_id: `protected-import:${authorizationEventId}`, kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...task, partition: "protected" } }, receipt.actor, sessionId);
    return store.revision<TaskDefinition>(created.revision_id, "task_definition");
  })();
}

export function deliverProtectedAssessment(
  store: LearningStore,
  taskDefinitionRevisionId: string,
  sessionId: string,
  conditions: string[] = ["Timed assessment", "No aids permitted"],
): Revision<TaskInstance> {
  const goal = store.lessonGoal(sessionId);
  if (!goal) throw new Error("Select a lesson before delivering an assessment");
  const task = store.revision<TaskDefinition>(taskDefinitionRevisionId, "task_definition");
  if (task.body.partition !== "protected") {
    throw new Error("Only protected partition tasks can be delivered as formal assessments");
  }

  // Delivery under host/assessment control with purpose "exam"
  const created = store.define({
    operation_id: randomUUID(),
    kind: "task_instance",
    expected_goal_revision_id: goal.revision_id,
    body: {
      definition_revision_id: task.revision_id,
      goal_revision_id: goal.revision_id,
      purpose: "exam",
      conditions,
    },
  }, "host", sessionId);
  return store.revision<TaskInstance>(created.revision_id, "task_instance");
}
