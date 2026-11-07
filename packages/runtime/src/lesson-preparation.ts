import { randomUUID } from "node:crypto";
import { LessonPreparationSchema, validate, type Component, type LessonPreparation, type Revision } from "../../core/src/contracts.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { currentDisclosure } from "./disclosure.ts";
import { assertCanAdvance } from "./feedback.ts";
import { assertLearningTransition } from "./learning-controller.ts";
import { projectLearningState } from "./learning-state.ts";

interface PreparedLesson {
  kind: "lesson_preparation";
  component_revision_id: string;
  rubric_revision_id: string;
  family_revision_id: string;
  instruction_revision_id: string;
  definition_revision_id: string;
  review_required: true;
  next_action: string;
}

/** Draft authoring only. Review, teaching release and learner evidence retain their native authorities. */
export function prepareLesson(store: LearningStore, input: unknown, sessionId: string): PreparedLesson {
  validate<LessonPreparation>(LessonPreparationSchema, input);
  return store.db.transaction(() => {
    const goal = store.lessonGoal(sessionId);
    if (!goal || goal.revision_id !== input.expected_goal_revision_id) throw new Error("Stale goal; refresh learning_context before preparing a lesson");
    if (!currentDisclosure(store, sessionId).allowed) throw new Error("Lesson preparation requires current disclosure authorization");
    if (!["learn", "accelerate"].includes(goal.body.mode)) throw new Error("Lesson preparation is for guided learn/accelerate lessons; preserve the governed exam, cram or drill selection");
    const operation = `lesson-preparation:${input.operation_id}`;
    const cached = store.events().find(event => event.operation_id === operation);
    if (cached) {
      if (cached.session_id !== sessionId) throw new Error("Lesson preparation receipt belongs to another conversation");
      if (cached.actor !== "host" || cached.payload.action !== "lesson_prepared" || cached.payload.request_hash !== hash(canonical(input))) throw new Error("Lesson preparation operation ID was reused with different content");
      // SAFETY: This host operation owns the receipt shape; its conversation and exact request hash match above.
      return cached.payload.preparation as unknown as PreparedLesson;
    }
    assertCanAdvance(store, sessionId);
    assertLearningTransition(store, sessionId, input.expected_state_revision, true);
    const state = projectLearningState(store, sessionId);
    if (state.teaching && !["unit_complete", "checkpoint"].includes(state.teaching.stage)) throw new Error("Resume the current teaching unit before preparing another lesson question");
    const body = input.body;
    for (const spanId of body.source_span_ids) {
      const span = store.db.query<{ source_revision_id: string }, [string]>("SELECT source_revision_id FROM source_span WHERE span_id=?").get(spanId);
      if (!span || !goal.body.source_ids.includes(span.source_revision_id)) throw new Error("Lesson source spans must belong to selected goal sources");
    }
    const define = (kind: string, value: Record<string, unknown>): Revision => store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: goal.revision_id, body: value }, "pi", sessionId);
    let component: Revision;
    if ("revision_id" in body.component) {
      component = store.revision<Component>(body.component.revision_id, "component");
      if (component.body.subject !== goal.body.subject || !store.events().some(event => event.seq === component.created_seq && event.session_id === sessionId && event.branch === "real")) throw new Error("Lesson component must belong to this conversation and subject");
    } else {
      component = define("component", { ...body.component, subject: goal.body.subject, concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: body.uncertainty });
    }
    const rubric = define("rubric", { title: body.title, dimensions: body.criteria, provisional: true, source_span_ids: body.source_span_ids });
    const family = define("task_family", { title: body.title, construct: body.construct, variation: body.variation, lineage_revision_ids: [], component_revision_ids: [component.revision_id], source_span_ids: body.source_span_ids });
    const instruction = define("artifact", { capability: "teaching_instruction", goal_revision_id: goal.revision_id, author: "tutor", provenance: "Model-authored instruction; not learner work, consent, review or validated teaching quality", media_type: "text/markdown", content: body.instruction, evidence_kind: "artifact_only", interpretation_uncertainty: body.uncertainty, assistance_event_ids: [] });
    const definition = define("task_definition", { title: body.title, prompt: body.prompt, family_revision_id: family.revision_id, component_revision_ids: [component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: body.source_span_ids, format: body.format ?? "free_response", allowed_aids: body.allowed_aids, steps: [], scoring: "rubric", status: "candidate", review: { method: "unreviewed", reason: "Model proposal awaiting explicit learner review; no expert validation inferred" }, stakes: "low", partition: "practice", changes: [], uncertainty: body.uncertainty, artifact_revision_ids: [instruction.revision_id] });
    const result: PreparedLesson = { kind: "lesson_preparation", component_revision_id: component.revision_id, rubric_revision_id: rubric.revision_id, family_revision_id: family.revision_id, instruction_revision_id: instruction.revision_id, definition_revision_id: definition.revision_id, review_required: true, next_action: "Ask the learner to inspect /approve with definition_revision_id; preparation is not approval. After trusted approval, refresh learning_context and use learning_activity action=teaching with the approved definition and these component/instruction pins. Do not deliver a supported-practice task_instance directly." };
    store.append("decision", { action: "lesson_prepared", request_hash: hash(canonical(input)), goal_revision_id: goal.revision_id, preparation: result, reason: "Atomic draft authoring only; no task delivery, performance or learner consent", evidence_event_ids: [] }, operation, "host", sessionId, store.now(), input);
    return result;
  })();
}
