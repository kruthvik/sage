import { Type } from "typebox";
import { validate, type TaskDefinition } from "../../core/src/contracts.ts";
import type { TeachingActivityRequest } from "../../core/src/interactions.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { currentDisclosure } from "./disclosure.ts";
import { projectLearningState } from "./learning-state.ts";
import { skipLearningTask } from "./learning-controller.ts";
import { overrideFeedback } from "./feedback.ts";
import type { PreparedLearnStep } from "./learn-step.ts";

const id = Type.String({ minLength: 1, maxLength: 180 });
const controlSchema = Type.Object({
  operation_id: id, expected_goal_revision_id: id,
  expected_state_revision: Type.String({ minLength: 1, maxLength: 300 }),
  action: Type.Enum(["practice", "advance", "move_on_with_gaps", "begin_step", "direct_practice", "skip_diagnostic"]),
  confirmed: Type.Literal(true), definition_revision_id: Type.Optional(id), acknowledge_gaps: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
interface ControlRequest {
  operation_id: string; expected_goal_revision_id: string; expected_state_revision: string;
  action: "practice" | "advance" | "move_on_with_gaps" | "begin_step" | "direct_practice" | "skip_diagnostic";
  confirmed: true; definition_revision_id?: string; acknowledge_gaps?: boolean;
}
export interface LearnControlReceipt {
  action: "practice_requested" | "advanced" | "instruction_ready" | "question_started" | "diagnostic_skipped";
  instance_revision_id?: string;
  prompt?: string;
  teaching_request?: TeachingActivityRequest;
  remaining_gaps?: string[];
}

/** Native bridge only, deliberately absent from model tools and HTTP operation dispatch. */
export function controlLearnFlow(store: LearningStore, input: unknown, sessionId: string): LearnControlReceipt {
  validate<ControlRequest>(controlSchema, input);
  return store.db.transaction(() => {
    const goal = store.lessonGoal(sessionId);
    if (!goal || goal.body.mode !== "learn" || goal.revision_id !== input.expected_goal_revision_id || !currentDisclosure(store, sessionId).allowed) throw new Error("Learning control goal or source permission changed");
    const operation = `learn-control:${hash(canonical({ sessionId, operation_id: input.operation_id }))}`;
    const cached = store.events().find(event => event.operation_id === operation);
    if (cached) {
      if (cached.actor !== "learner" || cached.session_id !== sessionId || cached.payload.action !== "learn_native_control" || cached.payload.request_hash !== hash(canonical(input))) throw new Error("Learning control operation ID reused with different scope");
      // SAFETY: native control owns this exact input/session-bound receipt.
      return cached.payload.receipt as unknown as LearnControlReceipt;
    }
    let state = projectLearningState(store, sessionId);
    if (state.state_revision !== input.expected_state_revision) throw new Error("Stale learning control; review the current native choice");
    const flow = state.learn_flow;
    if (!flow || state.phase === "stopped") throw new Error("Resume the saved lesson before continuing learning");
    const evidence = state.current_task?.assessment_event_id ? [state.current_task.assessment_event_id] : [];
    const remaining = flow.readiness?.unmet_requirements ?? ["learning_evidence_unknown"];
    const decision = (action: string, payload: Record<string, unknown>, suffix: string) => store.append("decision", { action, goal_revision_id: goal.revision_id, reason: "Explicit native learner choice; original marks, work and unresolved gaps remain unchanged", evidence_event_ids: evidence, ...payload }, `${operation}:${suffix}`, "learner", sessionId);
    const retirePending = (allowUnanswered: boolean) => {
      state = projectLearningState(store, sessionId);
      if (state.pending_count && state.current_task) {
        if (!state.current_task.assessment_event_id && !allowUnanswered) throw new Error("Finish or explicitly skip the current question before another one");
        if (state.current_task.assessment_event_id) overrideFeedback(store, sessionId);
        else skipLearningTask(store, { operation_id: `${operation}:skip`, expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision, instance_revision_id: state.current_task.instance_revision_id }, sessionId);
      }
      state = projectLearningState(store, sessionId);
    };
    let receipt: LearnControlReceipt;
    if (input.action === "skip_diagnostic") {
      retirePending(true);
      if (state.teaching && !["unit_complete", "checkpoint"].includes(state.teaching.stage)) decision("learn_unit_skipped", { unit_id: state.teaching.unit_id, evidence_event_ids: [state.teaching.prepared_event_id] }, "unit-skip");
      if (flow.draft) decision("learn_draft_skipped", { definition_revision_id: flow.draft.definition_revision_id, evidence_event_ids: [flow.draft.prepared_event_id] }, "draft-skip");
      decision("learn_diagnostic_declined", { component_revision_id: flow.component_revision_id, diagnostic_preference: "skip" }, "diagnostic-declined");
      receipt = { action: "diagnostic_skipped", remaining_gaps: remaining };
    } else if (input.action === "practice") {
      if (flow.action !== "teach_explanation" && (!["wait_for_continue", "ready_to_advance"].includes(flow.action) || !evidence.length)) throw new Error("Finish the current assessment and native feedback before requesting more practice");
      retirePending(false);
      decision("learn_practice_requested", { component_revision_id: flow.component_revision_id }, "practice");
      receipt = { action: "practice_requested", remaining_gaps: remaining };
    } else if (input.action === "advance" || input.action === "move_on_with_gaps") {
      if (input.action === "advance" && !flow.can_move_on) throw new Error("More evidence is required; only a separate explicit move-on-with-gaps choice can override");
      retirePending(input.action === "move_on_with_gaps");
      if (state.teaching && !["unit_complete", "checkpoint"].includes(state.teaching.stage)) decision("learn_unit_skipped", { unit_id: state.teaching.unit_id, evidence_event_ids: [state.teaching.prepared_event_id] }, "unit-skip");
      if (flow.draft) decision("learn_draft_skipped", { definition_revision_id: flow.draft.definition_revision_id, evidence_event_ids: [flow.draft.prepared_event_id] }, "draft-skip");
      const plan = state.plan && store.revision(state.plan.revision_id, "plan").body.component_revision_ids as string[] | undefined;
      const index = plan?.indexOf(flow.component_revision_id ?? "") ?? -1;
      const next = plan?.slice(index + 1).find(component => component !== flow.component_revision_id) ?? null;
      decision("learn_progression_advanced", { component_revision_id: flow.component_revision_id, next_component_revision_id: next, remaining_gaps: remaining, user_override: input.action === "move_on_with_gaps" }, "advance");
      receipt = { action: "advanced", remaining_gaps: remaining };
    } else {
      const draft = flow.draft;
      const direct = input.action === "direct_practice";
      const definitionId = direct ? input.definition_revision_id : draft?.definition_revision_id;
      if (!definitionId || !direct && (draft!.review_required || !["start_practice", "present_instruction"].includes(flow.action))) throw new Error("Review the current host question before starting it");
      const task = store.revision<TaskDefinition>(definitionId, "task_definition");
      const owner = store.events().find(event => event.seq === task.created_seq);
      if (owner?.session_id !== sessionId || task.body.status !== "practice_ready" || task.body.review.method === "unreviewed" || task.body.partition !== "practice" || task.body.stakes !== "low" || store.revisions("task_definition").filter(item => item.entity_id === task.entity_id).at(-1)?.revision_id !== task.revision_id) throw new Error("Native practice requires a current owned reviewed low-stakes question");
      if (task.body.allowed_aids.some(aid => !goal.body.allowed_aids.includes(aid))) throw new Error("Native practice aids exceed the current goal; explicitly change the goal first");
      for (const span of [...task.body.source_span_ids, ...store.revision<{ source_span_ids: string[] }>(task.body.rubric_revision_id, "rubric").body.source_span_ids]) if (!goal.body.source_ids.includes(store.acceptedSpan(span).source_revision_id)) throw new Error("Native practice sources exceed current permission");
      if (flow.component_revision_id && !task.body.component_revision_ids.includes(flow.component_revision_id) && !flow.can_move_on && !input.acknowledge_gaps) throw new Error("Changing the current component requires explicit gap acknowledgement");
      retirePending(input.acknowledge_gaps === true);
      const instruction = direct ? task.body.artifact_revision_ids?.find(artifact => store.revision(artifact, "artifact").body.capability === "teaching_instruction") : draft?.instruction_revision_id;
      let binding = draft;
      if (direct) {
        const preparation: PreparedLearnStep = { kind: "learn_step", step_id: hash(operation), step_action: instruction ? "draft_instruction" : "draft_independent", component_revision_id: task.body.component_revision_ids[0]!, rubric_revision_id: task.body.rubric_revision_id, definition_revision_id: task.revision_id, ...(instruction ? { instruction_revision_id: instruction } : {}), purpose: instruction ? "practice" : "independent", review_required: true };
        const prepared = store.append("decision", { action: "learn_step_prepared", goal_revision_id: goal.revision_id, preparation, reason: "Native learner selected this reviewed question; no delivery or performance inferred", evidence_event_ids: [] }, `learn-step:native:${hash(operation)}`, "host", sessionId);
        binding = { ...preparation, prepared_event_id: prepared.event_id, review_required: false, unit_id: `learn:${preparation.step_id}` };
      }
      if (!binding) throw new Error("Native learning question has no owned binding");
      if (instruction) receipt = { action: "instruction_ready", teaching_request: { action: "teaching", operation_id: hash(`${operation}:offer`), expected_goal_revision_id: goal.revision_id, unit_id: binding.unit_id, component_revision_id: binding.component_revision_id, instruction_revision_id: instruction, definition_revision_id: task.revision_id } };
      else {
        const instance = store.define({ operation_id: `${operation}:question`, kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: binding.purpose, conditions: ["Explicit native question release; no answer-bearing instruction supplied for this check"] } }, "host", sessionId);
        receipt = { action: "question_started", instance_revision_id: instance.revision_id, prompt: task.body.prompt };
      }
    }
    store.append("decision", { action: "learn_native_control", request_hash: hash(canonical(input)), receipt, goal_revision_id: goal.revision_id, reason: "Native workflow choice only; not a learner answer or mastery claim", evidence_event_ids: evidence }, operation, "learner", sessionId, store.now(), input);
    store.rebuild();
    return receipt;
  })();
}
