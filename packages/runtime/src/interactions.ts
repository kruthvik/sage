import { ActivitySchema, type ActivityPacket, type ActivityReceipt, type ActivityRequest } from "../../core/src/interactions.ts";
import { validate, type Rubric, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { parseFeynmanReview, type FeynmanReview } from "../../core/src/feynman.ts";
import { assertCurrentLearningTask } from "./learning-controller.ts";

/** Pure validation/read path. Neither task keys nor learner-input writes are model tools. */
export function prepareActivity(store: LearningStore, input: unknown, sessionId: string): ActivityPacket {
  validate<ActivityRequest>(ActivitySchema, input);
  const goal = store.lessonGoal(sessionId);
  if (!goal?.body.provider_sharing || goal.revision_id !== input.expected_goal_revision_id) throw new Error("Goal or sharing permission changed; activity has a different scope or conversation; refresh context");
  const instance = store.revision<TaskInstance>(input.instance_revision_id, "task_instance");
  if (instance.body.goal_revision_id !== goal.revision_id) throw new Error("Activity task is outside the current goal");
  const task = store.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition");
  const latest = store.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1);
  if (task.body.status !== "practice_ready" || latest?.body.status !== "practice_ready") throw new Error("Activity requires a reviewed, available task");
  for (const span of task.body.source_span_ids) if (!goal.body.source_ids.includes(store.acceptedSpan(span).source_revision_id)) throw new Error("Task sources exceed current sharing permissions");
  if (input.action === "mcq" && task.body.format !== "mcq") throw new Error("Ask the tutor for a reviewed MCQ task first");
  if (input.action === "open_response" && !["free_response", "solve", "explain", "discriminate", "code"].includes(task.body.format)) throw new Error("Open response needs a reviewed text-response task; use the appropriate native activity for another modality");
  if (input.action === "feynman" && (task.body.format !== "explain" || task.body.scoring !== "rubric")) throw new Error("Ask the tutor for a reviewed explanation task first");
  const criteria = store.revision<Rubric>(task.body.rubric_revision_id, "rubric").body.dimensions.map(d => d.criterion);
  if (input.action === "feynman" && (task.body.prompt.length > 4000 || criteria.length > 8 || criteria.some(c => c.length > 1200))) throw new Error("Teach-back needs a concise prompt and at most eight short public criteria; ask the tutor to narrow this task");
  const saved = store.events().find(e => e.operation_id === `activity:${input.operation_id}`);
  if (saved && (saved.session_id !== sessionId || saved.payload.request_hash !== hash(canonical(input)))) throw new Error("Activity operation ID reused with different scope");
  if (!saved) assertCurrentLearningTask(store, sessionId, input.instance_revision_id);
  // SAFETY: submitActivity stores ActivityReceipt here; replay creates no new learner evidence.
  return { request: input, objective: goal.body.objective.slice(0, 2000), prompt: task.body.prompt,
    criteria,
    ...(input.action === "mcq" ? { choices: task.body.choices } : {}),
    ...(saved ? { completed: saved.payload.receipt as unknown as ActivityReceipt } : {}) };
}

/** Called only by the trusted UI bridge after a real selection/editor submission. */
export function submitActivity(store: LearningStore, input: ActivityRequest, submission: { text: string; selected_choice_id?: string; reasoning?: string }, sessionId: string): ActivityReceipt {
  return store.db.transaction(() => {
    const packet = prepareActivity(store, input, sessionId);
    if (packet.completed) return packet.completed;
    if (input.action === "scrap_work") throw new Error("Scrap work is submitted through the native input editor");
    if (input.action === "open_response" && (submission.selected_choice_id !== undefined || submission.reasoning !== undefined)) throw new Error("Open response captures actual text, not MCQ selection metadata");
    if (!submission.text.trim() || submission.text.length > 8000 || (submission.reasoning?.length ?? 0) > 2000) throw new Error("Keep the response between 1 and 8000 characters");
    if (input.action === "mcq" && !packet.choices?.some(c => c.id === submission.selected_choice_id)) throw new Error("Select one of the stored choices");
    const response = store.learnerResponse(input.action === "mcq" ? `${submission.selected_choice_id}${submission.reasoning ? `\nReason: ${submission.reasoning}` : ""}` : submission.text,
      sessionId, `activity-response:${input.operation_id}`, { instance_revision_id: input.instance_revision_id, goal_revision_id: input.expected_goal_revision_id,
        ...(input.action === "mcq" ? { selected_choice_id: submission.selected_choice_id, reasoning: submission.reasoning } : {}) });
    const attemptId = `activity-attempt:${input.operation_id}`;
    store.record({ operation_id: `activity-attempt:${input.operation_id}`, kind: "attempt_submitted", expected_goal_revision_id: input.expected_goal_revision_id,
      payload: { attempt_id: attemptId, instance_revision_id: input.instance_revision_id, response_event_id: response.event_id, declared_aids: [] } }, sessionId);
    const receipt: ActivityReceipt = { response_event_id: response.event_id, attempt_id: attemptId, instance_revision_id: input.instance_revision_id,
      ...(input.action === "feynman" ? { explanation: submission.text } : { selected_choice_id: submission.selected_choice_id, reasoning: submission.reasoning }) };
    store.append("decision", { action: "activity_submission", request_hash: hash(canonical(input)), receipt, reason: "Captured actual learner UI submission; external assistance remains unobserved", evidence_event_ids: [response.event_id], policy_version: "transparent-2" }, `activity:${input.operation_id}`, "host", sessionId);
    store.rebuild();
    return receipt;
  })();
}

export function readFeynmanReview(store: LearningStore, input: ActivityRequest, sessionId: string): FeynmanReview | undefined {
  prepareActivity(store, input, sessionId);
  // SAFETY: saveFeynmanReview persists parseFeynmanReview output under this operation ID.
  return store.events().find(e => e.operation_id === `feynman-review:${input.operation_id}`)?.payload.review as unknown as FeynmanReview | undefined;
}
export function saveFeynmanReview(store: LearningStore, input: ActivityRequest, review: FeynmanReview, sessionId: string): FeynmanReview {
  return store.db.transaction(() => {
    const packet = prepareActivity(store, input, sessionId);
    if (!packet.completed?.explanation || input.action !== "feynman") throw new Error("Feynman review needs an actual captured explanation");
    const validated = parseFeynmanReview(JSON.stringify(review), packet.completed.explanation);
    const saved = readFeynmanReview(store, input, sessionId);
    if (saved) return saved;
    assertCurrentLearningTask(store, sessionId, input.instance_revision_id);
    const task = store.revision<TaskDefinition>(store.revision<TaskInstance>(input.instance_revision_id).body.definition_revision_id).body;
    store.record({ operation_id: `feynman-help:${input.operation_id}`, kind: "assistance", expected_goal_revision_id: input.expected_goal_revision_id,
      payload: { assistance_id: `feynman:${input.operation_id}`, instance_revision_id: input.instance_revision_id, attempt_id: packet.completed.attempt_id, component_revision_ids: task.component_revision_ids,
        stage: "possibly_exposed", kind: "feedback", content: validated.follow_up, answer_bearing: true } }, sessionId);
    store.append("decision", { action: "feynman_inversion", reason: "Bounded Pi novice-role clarification; diagnostic proposal, not assessment or mastery", evidence_event_ids: [packet.completed.response_event_id], review: validated, policy_version: "transparent-2" }, `feynman-review:${input.operation_id}`, "host", sessionId);
    store.rebuild();
    return validated;
  })();
}
