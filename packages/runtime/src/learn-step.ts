import { LearnStepSchema, validate, type LearnStepRequest, type Component, type Revision, type Rubric, type TaskDefinition } from "../../core/src/contracts.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { currentDisclosure } from "./disclosure.ts";
import { projectLearningState } from "./learning-state.ts";
import { prepareLesson } from "./lesson-preparation.ts";
import type { LearnFlowAction } from "./learn-flow.ts";

export interface PreparedLearnStep {
  kind: "learn_step";
  step_id: string;
  step_action: LearnFlowAction;
  component_revision_id: string;
  rubric_revision_id: string;
  definition_revision_id: string;
  instruction_revision_id?: string;
  purpose: "practice" | "independent" | "application";
  review_required: true;
}
const textShape = (text: string) => text.toLowerCase().replace(/(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/g, "#").replace(/\s+/g, " ").trim();

/** The model supplies content; the host owns the stage, object graph and frozen bindings. */
export function prepareLearnStep(store: LearningStore, input: unknown, sessionId: string): PreparedLearnStep {
  validate<LearnStepRequest>(LearnStepSchema, input);
  return store.db.transaction(() => {
    const goal = store.lessonGoal(sessionId);
    if (!goal || goal.body.mode !== "learn" || goal.revision_id !== input.expected_goal_revision_id) throw new Error("Learning step needs the current learn-mode goal");
    if (!currentDisclosure(store, sessionId).allowed) throw new Error("Learning step needs current sharing and source authorization");
    const operation = `learn-step:${hash(canonical({ sessionId, operation_id: input.operation_id }))}`;
    const cached = store.events().find(event => event.operation_id === operation);
    if (cached) {
      if (cached.actor !== "host" || cached.session_id !== sessionId || cached.payload.action !== "learn_step_prepared" || cached.payload.request_hash !== hash(canonical(input))) throw new Error("Learning step operation ID was reused with different content or scope");
      // SAFETY: this host operation owns the exact content/session-bound receipt shape.
      return cached.payload.preparation as unknown as PreparedLearnStep;
    }
    const state = projectLearningState(store, sessionId), flow = state.learn_flow;
    if (state.state_revision !== input.expected_state_revision || !flow || flow.step_id !== input.step_id) throw new Error("Stale learning step; refresh learning_context before authoring");
    if (!flow.allowed_define_kinds.includes("learn_step")) throw new Error("Host learn flow is not requesting authored content now");
    for (const spanId of input.body.source_span_ids) {
      const span = store.db.query<{ source_revision_id: string }, [string]>("SELECT source_revision_id FROM source_span WHERE span_id=?").get(spanId);
      if (!span || !goal.body.source_ids.includes(span.source_revision_id)) throw new Error("Learning step source spans must belong to selected goal sources");
      store.acceptedSpan(spanId);
    }
    const body = input.body;
    let result: PreparedLearnStep;
    if (flow.action === "draft_instruction") {
      if (!body.component || !body.instruction || !body.criteria?.length) throw new Error("Initial learning step needs component, instruction and public criteria");
      if (flow.component_revision_id && (!("revision_id" in body.component) || body.component.revision_id !== flow.component_revision_id)) throw new Error("Learning step must preserve the agreed current component");
      let component = body.component;
      if (!("revision_id" in component)) {
        const created = store.define({ operation_id: `${operation}:component`, kind: "component", expected_goal_revision_id: goal.revision_id, body: { ...component, subject: goal.body.subject, concept_revision_ids: [], prerequisite_revision_ids: [], target_dimensions: ["execution", "explanation", "discrimination"], uncertainty: body.uncertainty } }, "pi", sessionId);
        component = { revision_id: created.revision_id };
      }
      const prepared = prepareLesson(store, { operation_id: `${hash(operation)}:initial`, kind: "lesson_preparation", expected_goal_revision_id: goal.revision_id, expected_state_revision: projectLearningState(store, sessionId).state_revision, body: { component, title: body.title, instruction: body.instruction, prompt: body.prompt, criteria: body.criteria, construct: body.title, variation: body.challenge_rationale, allowed_aids: goal.body.allowed_aids, source_span_ids: body.source_span_ids, uncertainty: body.uncertainty } }, sessionId);
      result = { kind: "learn_step", step_id: input.step_id, step_action: flow.action, component_revision_id: prepared.component_revision_id, rubric_revision_id: prepared.rubric_revision_id, definition_revision_id: prepared.definition_revision_id, instruction_revision_id: prepared.instruction_revision_id, purpose: "practice", review_required: true };
    } else {
      if (!flow.component_revision_id || !state.current_task) throw new Error("Learning practice needs the pinned current component and original task");
      const component = store.revision<Component>(flow.component_revision_id, "component");
      if (body.component && (!("revision_id" in body.component) || body.component.revision_id !== component.revision_id)) throw new Error("New components cannot bypass the current learning step");
      const first = store.revisions("task_definition").find(task => task.body.component_revision_ids && (task.body.component_revision_ids as string[]).includes(component.revision_id) && store.events().some(event => event.seq === task.created_seq && event.session_id === sessionId));
      const baseline = store.revision<TaskDefinition>(state.teaching?.definition_revision_id ?? first?.revision_id ?? state.current_task.definition_revision_id, "task_definition");
      const rubric = store.revision<Rubric>(baseline.body.rubric_revision_id, "rubric");
      if (body.criteria && canonical(body.criteria) !== canonical(rubric.body.dimensions)) throw new Error("Learning practice cannot weaken or replace the original frozen criteria");
      const repair = flow.action === "draft_repair";
      if (repair && !body.instruction) throw new Error("Repair needs a bounded explanatory instruction");
      if (!repair && body.instruction !== undefined) throw new Error("Independent checks cannot include answer-bearing instruction");
      if (!repair && !body.reasoning_prompt) throw new Error("Learning checks need a public reasoning prompt, not an answer-only question");
      if (["draft_conceptual", "draft_discrimination"].includes(flow.action) && !body.contrast_prompt) throw new Error("Conceptual checks need a counterexample, error diagnosis or discriminating contrast prompt");
      if (flow.action === "draft_application" && !body.application_prompt) throw new Error("Application checks need an unfamiliar context or boundary-case prompt");
      if (!repair && store.revisions("task_definition").some(task => (task.body.component_revision_ids as string[] | undefined)?.includes(component.revision_id) && textShape(task.body.prompt as string) === textShape(body.prompt))) throw new Error("Learning challenge needs changed demand, not a repeated or numerical-only stem");
      const spans = [...new Set([...baseline.body.source_span_ids, ...body.source_span_ids])];
      if (spans.length > 40) throw new Error("Keep the combined learning source references within 40 spans");
      const define = (kind: string, content: Record<string, unknown>, suffix: string): Revision => store.define({ operation_id: `${operation}:${suffix}`, kind, expected_goal_revision_id: goal.revision_id, body: content }, "pi", sessionId);
      const family = define("task_family", { title: body.title, construct: component.body.behavior, variation: body.challenge_rationale, lineage_revision_ids: [baseline.body.family_revision_id], component_revision_ids: [component.revision_id], source_span_ids: spans }, "family");
      const instruction = repair ? define("artifact", { capability: "teaching_instruction", goal_revision_id: goal.revision_id, author: "tutor", provenance: "Model-authored targeted repair; not learner work or verified teaching quality", media_type: "text/markdown", content: body.instruction, evidence_kind: "artifact_only", interpretation_uncertainty: body.uncertainty, assistance_event_ids: [] }, "instruction") : undefined;
      const prompt = [body.prompt, body.reasoning_prompt, body.contrast_prompt, body.application_prompt].filter(Boolean).join("\n\n");
      const definition = define("task_definition", { title: body.title, prompt, family_revision_id: family.revision_id, component_revision_ids: [component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: spans, format: flow.action === "draft_discrimination" ? "discriminate" : flow.action === "draft_conceptual" ? "explain" : "free_response", allowed_aids: baseline.body.allowed_aids, steps: [], scoring: "rubric", status: "candidate", review: { method: "unreviewed", reason: "Model proposal awaiting native review; difficulty and semantic correctness unvalidated" }, stakes: "low", partition: "practice", changes: [body.challenge_rationale], uncertainty: body.uncertainty, ...(!repair ? { variation: { baseline_definition_revision_id: baseline.revision_id, dimensions: flow.action === "draft_application" ? ["structure", "context"] : ["method"], invariant: component.body.behavior, rationale: body.challenge_rationale } } : {}), ...(instruction ? { artifact_revision_ids: [instruction.revision_id] } : {}) }, "question");
      result = { kind: "learn_step", step_id: input.step_id, step_action: flow.action, component_revision_id: component.revision_id, rubric_revision_id: rubric.revision_id, definition_revision_id: definition.revision_id, ...(instruction ? { instruction_revision_id: instruction.revision_id } : {}), purpose: repair ? "practice" : flow.action === "draft_application" ? "application" : "independent", review_required: true };
    }
    store.append("decision", { action: "learn_step_prepared", goal_revision_id: goal.revision_id, request_hash: hash(canonical(input)), preparation: result, reason: "Host-compiled model content for one scoped step; not approval, delivery, expert validation or learner performance", evidence_event_ids: [] }, operation, "host", sessionId, store.now(), input);
    store.rebuild();
    return result;
  })();
}
