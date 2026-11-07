import { Type } from "typebox";
import { validate, type Component, type LearningEvent, type Rubric, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import type { PreparedLearnStep } from "./learn-step.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import type { LearningState } from "./learning-state.ts";
import { learnReadiness, type LearnReadiness } from "./practice-policy.ts";

export type LearnFlowAction = "teach_explanation" | "draft_instruction" | "review_draft" | "start_practice" | "present_instruction" | "collect_response" | "classify_response" | "assess_response" | "present_feedback" | "wait_for_continue" | "draft_repair" | "draft_conceptual" | "draft_discrimination" | "draft_application" | "draft_independent" | "ready_to_advance" | "stopped";
export interface LearnFlow {
  controller: "host";
  policy_version: "learn-flow-1";
  step_id: string;
  action: LearnFlowAction;
  component_revision_id: string | null;
  can_move_on: boolean;
  protocol_active: boolean;
  diagnostic_preference: "offer" | "skip";
  required_tool: "learning_define" | "learning_activity" | "learning_record" | null;
  allowed_define_kinds: string[];
  allowed_record_kinds: string[];
  instruction: string;
  readiness: Omit<LearnReadiness, "component_revision_id" | "evidence_event_ids"> | null;
  draft?: LearnDraft;
}
export interface LearnDraft extends Omit<PreparedLearnStep, "review_required"> {
  review_required: boolean;
  prepared_event_id: string;
  unit_id: string;
}
const bindingId = Type.String({ minLength: 1, maxLength: 180 });
const preparedSchema = Type.Object({
  kind: Type.Literal("learn_step"), step_id: bindingId,
  step_action: Type.Enum(["draft_instruction", "draft_repair", "draft_conceptual", "draft_discrimination", "draft_application", "draft_independent"]),
  component_revision_id: bindingId, rubric_revision_id: bindingId, definition_revision_id: bindingId,
  instruction_revision_id: Type.Optional(bindingId), purpose: Type.Enum(["practice", "independent", "application"]), review_required: Type.Literal(true),
}, { additionalProperties: false });

/** Accept only owned host receipts whose graph still matches their frozen proposal. */
export function pendingLearnDraft(store: LearningStore, state: LearningState, sessionId: string, events: LearningEvent[]): LearnDraft | undefined {
  const event = [...events].reverse().find(item => item.session_id === sessionId && item.kind === "decision" && item.actor === "host" && item.payload.action === "learn_step_prepared" && item.payload.goal_revision_id === state.goal_revision_id && item.operation_id.startsWith("learn-step:"));
  if (!event || events.some(item => item.seq > event.seq && item.kind === "decision" && item.actor === "learner" && item.payload.action === "learn_draft_skipped" && item.payload.goal_revision_id === state.goal_revision_id && Array.isArray(item.payload.evidence_event_ids) && item.payload.evidence_event_ids.includes(event.event_id))) return undefined;
  try {
    const preparation = event.payload.preparation;
    validate<PreparedLearnStep>(preparedSchema, preparation);
    const original = store.revision<TaskDefinition>(preparation.definition_revision_id, "task_definition");
    const creator = events.find(item => item.seq === original.created_seq);
    if (!creator || original.created_seq >= event.seq || original.created_at > state.as_of_time || original.body.component_revision_ids.length !== 1 || original.body.component_revision_ids[0] !== preparation.component_revision_id || original.body.rubric_revision_id !== preparation.rubric_revision_id || original.body.partition !== "practice" || original.body.stakes !== "low") return undefined;
    if (preparation.instruction_revision_id && !original.body.artifact_revision_ids?.includes(preparation.instruction_revision_id)) return undefined;
    const latest = store.revisions("task_definition", state.through_seq).filter(item => item.entity_id === original.entity_id && item.created_at <= state.as_of_time).at(-1);
    if (!latest || ["rejected", "retired"].includes(latest.body.status as string)) return undefined;
    if (canonical({ ...latest.body, status: original.body.status, review: original.body.review }) !== canonical(original.body)) return undefined;
    const delivered = events.some(item => item.seq > event.seq && item.kind === "task_delivered" && (() => {
      const instance = store.revision<TaskInstance>(item.payload.instance_revision_id as string, "task_instance");
      return store.revision(instance.body.definition_revision_id, "task_definition").entity_id === original.entity_id;
    })());
    if (delivered) return undefined;
    return { ...preparation, definition_revision_id: latest.revision_id, review_required: latest.body.status !== "practice_ready" || (latest.body.review as { method: string }).method === "unreviewed", prepared_event_id: event.event_id, unit_id: `learn:${preparation.step_id}` };
  } catch { return undefined; } // Invalid or finished latest bindings must not revive an older draft.
}
const instructions: Record<LearnFlowAction, string> = {
  draft_instruction: "Author this learning step only: mechanism, worked reasoning and a challenging guided check. Use reusable component-level public criteria; never put task answers or worked solutions in the rubric. Criteria must still apply to later changed questions. No delivery, grading or new-topic advancement.",
  teach_explanation: "Teach the current topic with mechanisms and worked examples, without a diagnostic or question approval prerequisite. Keep ability unknown; do not grade, advance or demand practice. Offer /continue practice only when the learner wants it.",
  review_draft: "Native review is required only to start this question, not to receive teaching. If the learner declines a diagnostic, teach instead and offer /continue teach to retire it without advancing. A proposal is not performance.",
  start_practice: "Wait for native Continue to release this exact approved practice question. Do not construct task_instance bookkeeping or another topic.",
  present_instruction: "Use the pinned native teaching activity and wait for learner Continue. Presentation and continuing are not performance evidence.",
  collect_response: "Collect actual work with the native response activity. No answer, grade or next question before captured work; clarification stays clarification.",
  classify_response: "Read the pinned captured text: link actual work only, or answer its clarification. Controls, receipts and assistant prose are not learner answers.",
  assess_response: "Assess the actual pinned attempt against its frozen rubric. Use targeted component IDs and exact response substrings alone in every scores[].evidence and claims[].evidence field, preserving whitespace. For absent reasoning quote the submitted response verbatim, mark the missing dimension not_observed, and explain missing work in feedback, not in evidence. Do not label missing work as a conceptual error or diagnose a misconception. Do not infer unshown work or resubmit the attempt.",
  present_feedback: "Present the host criterion feedback. Do not create another task or move topics before native Continue or explicit move-on-with-gaps control.",
  wait_for_continue: "Wait for explicit native Continue for more practice, move-on-with-gaps, or stop. Feedback queued is not reading, readiness or permission to rush ahead.",
  draft_repair: "Author targeted repair for the observed original-criterion gap, then a fresh check. Do not turn an unknown into a diagnosed misconception.",
  draft_conceptual: "Author a demanding open-ended why, invariant, counterexample or error-diagnosis check under the original criteria. No solution or hints.",
  draft_discrimination: "Author an open-ended method-selection or near-miss contrast requiring a justified choice, not recognition alone. No solution or hints.",
  draft_application: "Author an unfamiliar application with a meaningful changed demand, not merely new numbers. Preserve original criteria and disclose unvalidated difficulty.",
  draft_independent: "Author fresh demanding independent work for the remaining evidence requirement. Preserve original criteria; do not supply its answer or count repeats.",
  ready_to_advance: "Offer native Continue to the next agreed target. This is conditional local readiness, not goal completion, permanent mastery or demonstrated retention.",
  stopped: "Wait for actual learner resumption. Keep saved work and gaps; do not teach, grade, author another task or advance automatically.",
};

/** Conditional application evidence is not expert validation or the storage transfer metric. */
function hostLearnEvidence(store: LearningStore, state: LearningState, events: LearningEvent[], componentId: string) {
  const preparations = events.filter(event => event.actor === "host" && event.kind === "decision" && event.payload.action === "learn_step_prepared" && event.operation_id.startsWith("learn-step:") && typeof event.payload.request_hash === "string");
  const initial = preparations.find(event => {
    const preparation = event.payload.preparation as PreparedLearnStep | undefined;
    if (events.some(control => control.seq > event.seq && control.actor === "learner" && control.payload.action === "learn_draft_skipped" && Array.isArray(control.payload.evidence_event_ids) && control.payload.evidence_event_ids.includes(event.event_id))) return false;
    if (preparation?.component_revision_id !== componentId || preparation.step_action !== "draft_instruction" || typeof event.payload.goal_revision_id !== "string") return false;
    const old = store.revision<import("../../core/src/contracts.ts").Goal>(event.payload.goal_revision_id, "goal"), current = store.revision<import("../../core/src/contracts.ts").Goal>(state.goal_revision_id!, "goal");
    return old.entity_id === current.entity_id && old.body.objective === current.body.objective && old.body.subject === current.body.subject;
  });
  const conditionalApplications = new Set<string>();
  if (!initial) return { conditionalApplications };
  const preparation = initial.payload.preparation;
  validate<PreparedLearnStep>(preparedSchema, preparation);
  const baseline = store.revision<TaskDefinition>(preparation.definition_revision_id, "task_definition");
  const rubric = store.revision<Rubric>(baseline.body.rubric_revision_id, "rubric");
  const definitions = store.revisions("task_definition", state.through_seq).map(task => store.revision<TaskDefinition>(task.revision_id, "task_definition"));
  const originalDefinitions = new Set(definitions.filter(task => task.body.component_revision_ids.length === 1 && task.body.component_revision_ids[0] === componentId && task.body.rubric_revision_id === rubric.revision_id && canonical(task.body.allowed_aids) === canonical(baseline.body.allowed_aids)).map(task => task.revision_id));
  for (const event of preparations) {
    const application = event.payload.preparation;
    try {
      validate<PreparedLearnStep>(preparedSchema, application);
      if (application.component_revision_id !== componentId || application.step_action !== "draft_application" || application.purpose !== "application" || application.instruction_revision_id) continue;
      const original = store.revision<TaskDefinition>(application.definition_revision_id, "task_definition");
      if (!originalDefinitions.has(original.revision_id) || original.created_seq >= event.seq || !events.some(owner => owner.seq === original.created_seq) || !original.body.variation?.dimensions.some(dimension => ["structure", "context", "method"].includes(dimension)) || original.body.prompt === baseline.body.prompt) continue;
      for (const reviewed of definitions) {
        if (reviewed.entity_id === original.entity_id && reviewed.body.status === "practice_ready" && reviewed.body.review.method !== "unreviewed" && originalDefinitions.has(reviewed.revision_id) && canonical({ ...reviewed.body, status: original.body.status, review: original.body.review }) === canonical(original.body)) conditionalApplications.add(reviewed.revision_id);
      }
    } catch { /* Invalid proposals never grant readiness. */ }
  }
  return { criteria: rubric.body.dimensions, originalDefinitions, conditionalApplications };
}

/** One readonly host job; task completion and broad readiness are separate facts. */
export function projectLearnFlow(store: LearningStore, state: LearningState, sessionId: string): LearnFlow | undefined {
  if (state.mode !== "learn" || !state.goal_revision_id) return undefined;
  const events = store.events(state.through_seq).filter(event => event.branch === "real" && event.session_id === sessionId && event.occurred_at <= state.as_of_time);
  const draft = pendingLearnDraft(store, state, sessionId, events);
  const task = state.current_task ? store.revision<TaskDefinition>(state.current_task.definition_revision_id, "task_definition") : undefined;
  const advanced = events.filter(event => event.kind === "decision" && event.actor === "learner" && event.payload.action === "learn_progression_advanced" && event.payload.goal_revision_id === state.goal_revision_id).at(-1);
  const declined = events.filter(event => event.kind === "decision" && event.actor === "learner" && event.payload.action === "learn_diagnostic_declined" && event.payload.goal_revision_id === state.goal_revision_id).at(-1);
  const currentDecline = declined && (!advanced || declined.seq > advanced.seq) ? declined : undefined;
  const practiceAfterDecline = currentDecline && events.some(event => event.seq > currentDecline.seq && event.actor === "learner" && event.payload.action === "learn_practice_requested" && event.payload.goal_revision_id === state.goal_revision_id && event.payload.component_revision_id === currentDecline.payload.component_revision_id);
  const teachingOnly = !!currentDecline && !practiceAfterDecline;
  const declinedFocus = typeof currentDecline?.payload.component_revision_id === "string" ? currentDecline.payload.component_revision_id : null;
  const agreedNext = typeof advanced?.payload.next_component_revision_id === "string" ? advanced.payload.next_component_revision_id : null;
  const focus = draft?.component_revision_id ?? state.teaching?.component_revision_id ?? task?.body.component_revision_ids[0] ?? agreedNext ?? declinedFocus;
  const view = focus ? projectComponents(store, state.through_seq, state.as_of_time, sessionId).find(v => v.component_revision_id === focus) : undefined;
  const evidence = focus ? hostLearnEvidence(store, state, events, focus) : undefined;
  const readiness = view ? learnReadiness(view, store.revision<Component>(view.component_revision_id, "component").body, evidence?.criteria, evidence?.conditionalApplications, evidence?.originalDefinitions) : undefined;
  const assessmentId = state.current_task?.assessment_event_id;
  const assessment = events.find(event => event.kind === "assessment" && event.event_id === assessmentId);
  const feedback = assessment && events.filter(event => event.seq > assessment.seq && event.kind === "decision" && event.actor === "host" && event.payload.action === "response_feedback_presented" && Array.isArray(event.payload.evidence_event_ids) && event.payload.evidence_event_ids.includes(assessmentId)).at(-1);
  const practiceRequested = feedback && events.some(event => event.seq > feedback.seq && event.kind === "decision" && event.actor === "learner" && event.payload.action === "learn_practice_requested" && event.payload.goal_revision_id === state.goal_revision_id && event.payload.component_revision_id === focus && Array.isArray(event.payload.evidence_event_ids) && event.payload.evidence_event_ids.includes(assessmentId));
  let action: LearnFlowAction;
  if (state.phase === "stopped") action = "stopped";
  else if (teachingOnly) action = "teach_explanation";
  else if (draft && (!state.pending_count || !!state.current_task?.assessment_event_id)) action = draft.review_required ? "review_draft" : draft.instruction_revision_id ? "present_instruction" : "start_practice";
  else if (["instruction_pending", "question_pending"].includes(state.phase)) action = "present_instruction";
  else if (state.phase === "awaiting_answer") action = "collect_response";
  else if (state.phase === "submission_pending") action = "classify_response";
  else if (state.phase === "assessment_pending") action = "assess_response";
  else if (state.phase === "feedback" && !feedback) action = "present_feedback";
  else if (!readiness || !state.current_task && !state.teaching && !readiness.ready) action = "draft_instruction";
  else if (readiness.ready && !practiceRequested) action = "ready_to_advance";
  else if (assessmentId && !practiceRequested) action = "wait_for_continue";
  else if (state.phase === "repair") action = "draft_repair";
  else if (readiness.unmet_requirements.some(reason => ["original_criteria", "blocking_gap"].includes(reason))) action = "draft_repair";
  else if (readiness.unmet_requirements.includes("conceptual_explanation")) action = "draft_conceptual";
  else if (readiness.unmet_requirements.includes("method_discrimination")) action = "draft_discrimination";
  else if (readiness.unmet_requirements.includes("changed_application")) action = "draft_application";
  else action = "draft_independent";
  const drafting = action.startsWith("draft_");
  const records = action === "classify_response" ? ["attempt_submitted", "assistance"] : action === "assess_response" ? ["assessment", "assistance"] : action === "collect_response" ? ["assistance"] : [];
  return {
    controller: "host", policy_version: "learn-flow-1",
    step_id: hash(canonical({ session_id: sessionId, state_revision: state.state_revision, goal_revision_id: state.goal_revision_id, focus, action })),
    action, component_revision_id: focus, can_move_on: action === "ready_to_advance",
    required_tool: drafting ? "learning_define" : ["present_instruction", "collect_response"].includes(action) ? "learning_activity" : action === "assess_response" ? "learning_record" : null,
    protocol_active: !!declined || events.some(event => event.actor === "host" && event.kind === "decision" && event.payload.action === "learn_step_prepared" && event.payload.goal_revision_id === state.goal_revision_id),
    diagnostic_preference: declined || store.revision<import("../../core/src/contracts.ts").Goal>(state.goal_revision_id, "goal").body.probe === "skip" ? "skip" : "offer",
    allowed_define_kinds: drafting ? ["learn_step"] : [], allowed_record_kinds: records,
    instruction: instructions[action], ...(draft ? { draft } : {}),
    readiness: readiness ? { ready: readiness.ready, independent_definition_count: readiness.independent_definition_count, unmet_requirements: readiness.unmet_requirements, epistemic_status: readiness.epistemic_status } : null,
  };
}
