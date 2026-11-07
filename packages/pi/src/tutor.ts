import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextSchema, DefineSchema, LearningDefineSchema, LearnStepSchema, RecordSchema, SourceSchema, eventBodies, validate, type Goal, type CallEntry, type Revision, type TaskDefinition, type Rubric } from "../../core/src/contracts.ts";
import { validatePlannerDraft, type PlannerDraft, type PlanningRequest, type PlanningCommit } from "../../core/src/planning.ts";
import type { SagePaths } from "../../runtime/src/paths.ts";
import { createSageResourceOptions, createSageSettings, guardSageResourceLoader } from "./runtime.ts";
import { loadPi, type PiSdk } from "./sdk.ts";
import { ensureManagedPackages } from "./plugins.ts";
import { formatLearningStatus } from "../../core/src/status.ts";
import { planWithPi, runBoundedPiChild, type DelegatePlanner } from "./planner.ts";
import { reviewWithPi, type DelegateFeynman } from "./feynman.ts";
import type { FeynmanReview } from "../../core/src/feynman.ts";
import type { ActivityRequest, ActivityReceipt, SubmittedImage } from "../../core/src/interactions.ts";
import { registerActivityInterface } from "./interactions.ts";
import type { TeachingActivityRequest, TeachingActivityOffer } from "../../core/src/interactions.ts";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { learningPreview } from "./experience.ts";
import { profilePreferences, type LearningPreferences } from "../../core/src/experience.ts";
import { collectLessonIntake } from "./intake.ts";
import { confirmLargeSource } from "./source-folder.ts";
import type { ConfirmLargeSource } from "../../sources/src/limits.ts";
import { guardModelRuntime, installDisclosureGate, normalizeProviderImages, type FilterProviderContext } from "./context.ts";
import type { DisclosurePermit } from "../../runtime/src/disclosure.ts";
import { readLearningSkill, type LearningSkill } from "./skills.ts";
import type { LearningState } from "../../runtime/src/learning-state.ts";
import type { NativeInputAdmission } from "../../runtime/src/submissions.ts";
import type { StudioApproval } from "../../runtime/src/service.ts";
import { nativeToolPresentation } from "./presentation.ts";
import { createUsageTracker, type UsageTracker } from "../../runtime/src/usage.ts";
import { registerUsageControls } from "./usage.ts";
import { registerJournalControls } from "./journal.ts";
import type { JournalDraft } from "../../runtime/src/journal.ts";
import type { ResearchDraft } from "../../runtime/src/research.ts";
import { managedResearchTools, reviewResearch, type NativeResearchTools } from "./research.ts";
import { diagramWithPi, type DelegateInstructionDiagram } from "./diagram.ts";
import type { InstructionDiagramResult, ProposeInstructionDiagram } from "../../runtime/src/diagram.ts";

export interface TutorBridge {
  operation(name: string, body: unknown, sessionId: string, signal?: AbortSignal): Promise<unknown>;
  inputAdmission?(sessionId: string): NativeInputAdmission;
  prepareJournal?(sessionId: string): Promise<JournalDraft>;
  prepareResearch?(goal: Goal, sessionId: string): Promise<ResearchDraft>;
  instructionDiagram?(request: unknown, sessionId: string, propose: ProposeInstructionDiagram, signal?: AbortSignal): Promise<InstructionDiagramResult>;
  requestRefresher?(expectedState: string, instanceId: string, sessionId: string): Promise<{ text: string; limitation: string }>;
  input(text: string, sessionId: string, images?: SubmittedImage[], instanceId?: string, admission?: NativeInputAdmission): Promise<unknown>;
  teachingOffer?(request: TeachingActivityRequest, sessionId: string): Promise<TeachingActivityOffer>;
  activitySubmit?(request: ActivityRequest, submission: { text: string; selected_choice_id?: string; reasoning?: string }, sessionId: string): Promise<ActivityReceipt>;
  feynmanResult?(request: ActivityRequest, sessionId: string): Promise<FeynmanReview | undefined>;
  saveFeynman?(request: ActivityRequest, review: FeynmanReview, sessionId: string): Promise<FeynmanReview>;
  goal(body: Goal, sessionId: string, planning?: PlanningCommit): Promise<unknown>;
  drillTeaching?(enabled: boolean | undefined, expectedState: string, sessionId: string): Promise<{ enabled: boolean }>;
  plan?(draft: PlannerDraft, sessionId: string, expectedGoalRevisionId: string, request: unknown): Promise<unknown>;
  planResult?(request: unknown, sessionId: string): Promise<unknown>;
  activate?(sessionId: string): Promise<{ lessons: Array<{ entity_id: string; objective: string }> }>;
  bindLesson?(entityId: string, sessionId: string): Promise<unknown>;
  authorize?(sessionId: string): Promise<DisclosurePermit>;
  reviewControl?(action: string, args: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>>;
  source(args: string, sessionId: string, confirmLarge?: ConfirmLargeSource): Promise<unknown>;
  approvalChoices?(sessionId: string): Promise<Array<{ revision_id: string; title: string }>>;
  approve(id: string, confirm?: boolean, sessionId?: string): Promise<unknown>;
  calls(body: CallEntry, sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<unknown>;
  shutdown(): Promise<void>;
  renderUi?(source: string, sessionId: string, resume: (receipt: Record<string, unknown>) => void, approve?: StudioApproval): Promise<unknown>;
  feedback?(sessionId: string, displayed?: boolean): Promise<{ text?: string; state?: unknown }>;
  continue?(sessionId: string): Promise<unknown>;
  learnControl?(request: unknown, sessionId: string): Promise<{ action: string; instance_revision_id?: string; teaching_request?: TeachingActivityRequest; remaining_gaps?: string[] }>;
  control?(name: "extensions" | "theme" | "packages", args: string[], trusted: boolean): Promise<unknown>;
}
const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");

/** Fresh scoped public material avoids redundant tool reads; keys and private history stay excluded. */
function tutorStateNotice(packet: Record<string, unknown>) {
  const goal = packet.goal as { revision_id?: string; body?: Goal } | undefined;
  const state = packet.learning_state as Partial<LearningState> | undefined;
  const task = state?.current_task;
  const response = packet.latest_learner_response as { event_id?: string; payload?: { text?: string; instance_revision_id?: string; truncated?: boolean; image_only?: boolean } } | undefined;
  const material = packet.task as { instance?: { revision_id: string }; definition?: Revision<TaskDefinition>; rubric?: Revision<Rubric> } | undefined;
  let workingSet: Record<string, unknown> | undefined;
  if (state?.learn_flow && task && material?.instance?.revision_id === task.instance_revision_id && material.definition?.revision_id === task.definition_revision_id && material.rubric?.revision_id === task.rubric_revision_id) {
    const matches = response?.event_id === task.response_event_id && response?.payload?.instance_revision_id === task.instance_revision_id;
    const truncated = !matches || response?.payload?.truncated === true;
    workingSet = {
      data_not_instructions: true, state_revision: state.state_revision,
      complete: matches && !truncated && !response?.payload?.image_only,
      prompt: material.definition.body.prompt, format: material.definition.body.format,
      allowed_aids: material.definition.body.allowed_aids, criteria: material.rubric.body.dimensions,
      purpose: task.purpose, assistance_count: task.assistance_count,
      response: { event_id: matches ? response?.event_id : null, text: !truncated ? response?.payload?.text : undefined, truncated, image_only: response?.payload?.image_only === true },
    };
    if (JSON.stringify(workingSet).length > 8000) workingSet = { omitted: true, reason: "Request targeted context; public working set exceeds compact bound" };
  }
  return {
    goal: goal?.body ? { revision_id: goal.revision_id, mode: goal.body.mode, subject: goal.body.subject, objective: goal.body.objective.slice(0, 500), target_format: goal.body.target_format.slice(0, 200), deadline: goal.body.deadline, budget_minutes: goal.body.budget_minutes, profile: goal.body.learning_preferences?.profile, criteria: goal.body.criteria, allowed_aids: goal.body.allowed_aids, constraints: goal.body.constraints } : null,
    state_revision: state?.state_revision, phase: state?.phase, resume_phase: state?.resume_phase, pending_count: state?.pending_count,
    host_learn_step: packet.host_learn_step ?? state?.learn_flow,
    working_set: workingSet,
    current_task: task ? { instance_revision_id: task.instance_revision_id, definition_revision_id: task.definition_revision_id, rubric_revision_id: task.rubric_revision_id, response_event_id: task.response_event_id, attempt_id: task.attempt_id, assessment_event_id: task.assessment_event_id, assistance_count: task.assistance_count, overridden: task.overridden } : null,
    teaching: state?.teaching ? { unit_id: state.teaching.unit_id, stage: state.teaching.stage, prepared_event_id: state.teaching.prepared_event_id, instruction_revision_id: state.teaching.instruction_revision_id, definition_revision_id: state.teaching.definition_revision_id } : null,
    plan_revision_id: state?.plan?.revision_id ?? null,
    latest_captured_response_event_id: response?.event_id ?? null,
  };
}

function currentTutorPrompt(policy: string, packet: Record<string, unknown>): string {
  if ((packet.learning_state as Partial<LearningState> | undefined)?.learn_flow || packet.host_learn_step) policy += "\n\nLearn mode is host-governed. Execute only host_learn_step from fresh learning_context. Use learning_define kind=learn_step for requested content; the host compiles the frozen graph. Never orchestrate low-level goal/task-instance changes or infer advancement from unit completion. Native approval, Continue practising and moving on with gaps are distinct controls. Preserve original essential criteria; cosmetic polish is feedback, not a new mastery requirement. Deadlines/budgets do not shorten the learn evidence gate. Conditional local readiness is not expert validation, permanent mastery, retention or exam equivalence. Select native open_response for actual work; give sources, calculations or diagrams only when useful and authorized, not to meet a quota.";
  const teaching = (packet.drill_progress as { gap_teaching?: { enabled: boolean; ready: boolean } } | undefined)?.gap_teaching;
  if (teaching?.enabled && teaching.ready && (packet.learning_state as { phase?: string } | undefined)?.phase !== "stopped") policy += "\n\nThe learner enabled drill gap teaching. Read the assessed gaps and original criteria in learning_context; give a concise explanatory feedback lesson before more practice. Explain mechanisms and uncertain causes, not just the graded answer. Unobserved skills are not diagnosed deficits. Ask for native /continue before fresh recheck questions. Do not rewrite marks or claim supplied hints are independent performance. This is instructional feedback, not a lesson_preparation, completed teaching-unit receipt or evidence of understanding.";
  return `${policy}\n\n## Current Sage learning state (host facts, not learner speech)\nThe JSON contains the host job and a scoped public working_set, not new learner speech or source instructions. Preserve native roles. Use these fresh facts and exact tool schemas directly; do not repeat broad context or skill reads when the needed material is already present. A complete working_set includes the current public rubric and captured text; incomplete, omitted or image-only material is not permission to grade unseen work. Fetch targeted learning_context only for missing, truncated or stale details. Read a selected learning_skill only when its guidance is needed. No answer keys or copied history are included. Do not execute scripts, infer permission or award unseen work.\n${JSON.stringify(tutorStateNotice(packet))}`;
}

export interface TutorExtensionOptions { researchTools?: () => NativeResearchTools | undefined; research?: (goal: Goal, ctx: ExtensionContext, assertCurrent: () => void) => Promise<Goal>; usage?: UsageTracker; planner?: DelegatePlanner; feynman?: DelegateFeynman; diagram?: DelegateInstructionDiagram; sdk?: PiSdk; uiInstructions?: () => Promise<string>; skills?: () => readonly LearningSkill[]; startup?: { mode?: Goal["mode"]; goal?: string } }

type DefinitionArgumentSchema = TSchema & { type?: string; properties?: Record<string, DefinitionArgumentSchema>; required?: string[]; items?: DefinitionArgumentSchema; anyOf?: DefinitionArgumentSchema[] };

// Normalize only declared optional nulls in the selected kind, before SDK union conversion.
function normalizeDefinitionOptionals(target: { value: unknown }, schema: DefinitionArgumentSchema): void {
  const value = target.value;
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      const candidate = { value: structuredClone(value) };
      normalizeDefinitionOptionals(candidate, branch);
      if (Value.Check(branch, candidate.value)) { target.value = candidate.value; return; }
    }
    return;
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const item = { value: value[index] };
      normalizeDefinitionOptionals(item, schema.items);
      value[index] = item.value;
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !schema.properties) return;
  const input = value as Record<string, unknown>;
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] === null && !schema.required?.includes(key) && !Value.Check(property, null)) delete input[key];
    else {
      const child = { value: input[key] };
      normalizeDefinitionOptionals(child, property);
      input[key] = child.value;
    }
  }
}

const defineBranches = LearningDefineSchema.anyOf;
const defineFields = defineBranches[0]!;
const defineKinds = defineBranches.map(branch => branch.properties.kind.const);
const defineParameters = Type.Union(defineBranches, {
  type: "object", additionalProperties: false, required: defineFields.required,
  properties: { ...defineFields.properties, step_id: Type.Optional(LearnStepSchema.properties.step_id), kind: Type.Enum(defineKinds), body: Type.Union(defineBranches.map(branch => branch.properties.body)) },
});

export function createTutorExtension(bridge: TutorBridge, options: TutorExtensionOptions = {}): ExtensionFactory {
  return pi => {
    if (options.usage) registerUsageControls(pi, options.usage);
    registerJournalControls(pi, bridge.prepareJournal);
    const sessionId = (ctx: { sessionManager: { getSessionId(): string } }) => ctx.sessionManager.getSessionId();
    const conductResearch = options.research ?? (options.researchTools && bridge.prepareResearch ? (goal: Goal, ctx: ExtensionContext, check: () => void) => reviewResearch(goal, ctx, options.researchTools!(), () => bridge.prepareResearch!(goal, sessionId(ctx)), check) : undefined);
    pi.on("tool_call", event => {
      if (options.researchTools?.()?.names.includes(event.toolName)) return { block: true, reason: "Web discovery uses native lesson setup and source preview/acceptance, not model-direct tools" };
      return undefined;
    });
    const activities = registerActivityInterface(pi, bridge, options);
    let connectionEpoch = 0, connectionRetried = false;
    let requestScope: { owner: string; revision: string; epoch: number } | undefined;
    let pendingPlanner: AbortController | undefined;
    let studioHidden = false;
    let startup = options.startup;
    let completedHostDraft: { owner: string; epoch: number; toolCallId: string } | undefined;
    pi.on("turn_end", (event, ctx) => {
      const draft = completedHostDraft; completedHostDraft = undefined;
      if (!draft || draft.owner !== sessionId(ctx) || draft.epoch !== connectionEpoch || ctx.hasPendingMessages() || !event.toolResults.some(result => result.toolCallId === draft.toolCallId && result.toolName === "learning_define" && !result.isError)) return;
      if (ctx.hasUI) ctx.ui.notify("Practice draft saved. Review with /approve, or choose /continue teach to learn without taking a diagnostic.");
      // The public Agent.finishTurn hook below ends the committed host job.
    });
    const delegate = async (request: PlanningRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<PlannerDraft> => {
      if (!options.planner) throw new Error("Planning subagent is not available");
      if (pendingPlanner) throw new Error("A plan is already being prepared; cancel it before starting another");
      const controller = new AbortController();
      pendingPlanner = controller;
      const cancel = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      ctx.ui.setStatus("sage-planner", "Preparing a simple starting plan…");
      const work = async () => {
        controller.signal.throwIfAborted();
        const draft = await options.planner!(request, ctx, controller.signal);
        controller.signal.throwIfAborted();
        validatePlannerDraft(draft);
        return draft;
      };
      try {
        if (ctx.mode === "tui" && ctx.hasUI && options.sdk) {
          const sdk = options.sdk;
          const result = await ctx.ui.custom<{ draft?: PlannerDraft; error?: unknown }>((tui, theme, _keys, done) => {
            const loader = new sdk.BorderedLoader(tui, theme, "Getting a simple plan ready · Esc to cancel");
            loader.onAbort = () => controller.abort(new Error("Planning cancelled"));
            void work().then(draft => done({ draft }), error => done({ error }));
            return loader;
          });
          if (result.error) throw result.error;
          if (!result.draft) throw new Error("Planning cancelled");
          return result.draft;
        }
        return await work();
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (pendingPlanner === controller) pendingPlanner = undefined;
        ctx.ui.setStatus("sage-planner", undefined);
      }
    };
    const showFeedback = async (ctx: ExtensionContext) => {
      const feedback = await bridge.feedback?.(sessionId(ctx));
      if (feedback?.text) { ctx.ui.notify(feedback.text, "info"); await bridge.feedback?.(sessionId(ctx), true); }
    };
    const recordFields = RecordSchema.anyOf[0]!;
    // Redundant object envelope helps provider schemas; the original union stays authoritative.
    const recordParameters = Type.Union(RecordSchema.anyOf, {
      type: "object", additionalProperties: false, required: recordFields.required,
      properties: { ...recordFields.properties, kind: Type.Enum(Object.keys(eventBodies)), payload: Type.Union(Object.values(eventBodies)) },
    });
    const registrations = [
      { name: "learning_context", label: "Learning context", schema: ContextSchema, description: "Read compact component dimensions, competing hypotheses, guidance, review offers and next-action candidates. Pi selects, Bun does not teach. Drill down by component/hypothesis/evidence IDs. Never exposes protected keys." },
      { name: "learning_define", label: "Define learning object", schema: defineParameters, description: "Envelope: operation_id, kind, expected_goal_revision_id, body. Fields belong inside body, not at the root. Omit unused optional fields. For guided learn/accelerate lessons prefer kind=lesson_preparation: supply component (owned revision_id or title/behavior), instruction, prompt, criteria, construct/variation, aids, source spans and uncertainty once; host wires a draft rubric/family/instruction/task. Pin current goal/state and a stable operation_id. Preparation does NOT approve or deliver; follow returned native review/teaching steps. Other kinds still propose immutable goals, components, rubrics, families, tasks, instances or outlines. Never invent review or credentials." },
      { name: "learning_record", label: "Record learning evidence", schema: recordParameters, description: `Record actual evidence, not lesson setup. Exact kinds: ${Object.keys(eventBodies).join(", ")}. Envelope: operation_id, kind, expected_goal_revision_id, payload. Attempts require a captured response_event_id; assessments require the actual attempt and pinned rubric. Never guess event names or invent observations. For guided setup use learning_define kind=lesson_preparation. Read the learning skill for payload examples; omit unused optional fields.` },
      { name: "learning_source", label: "Learning sources and capabilities", schema: SourceSchema, description: "List/status/search accepted selected sources; capabilities discovers tools. artifact retrieves a current-goal artifact by artifact_revision_id with provenance and bounded content. calculate/graph/drawing accept bounded input and stable operation_id/current goal. drawing with artifact_revision_id=current governed instruction and omitted input uses one bounded diagram child while waiting for Continue; no arbitrary artifact, journal, question or measurement work. Tool outputs are tutor artifacts, not learner performance, and possible task assistance. No arbitrary execution or fake unavailable integrations." },
    ];
    for (const tool of registrations) pi.registerTool({ ...nativeToolPresentation(tool.name), name: tool.name, label: tool.label, description: tool.description, parameters: tool.schema as TSchema, executionMode: "sequential",
      prepareArguments: tool.name === "learning_record" ? args => {
        const kind = args && typeof args === "object" && "kind" in args ? args.kind : undefined;
        // Reject aliases early; leave valid-kind normalization/full validation to the SDK.
        if (typeof kind !== "string" || !Object.hasOwn(eventBodies, kind)) validate(RecordSchema, args);
        return args;
      } : tool.name === "learning_define" ? args => {
        const kind = args && typeof args === "object" && "kind" in args ? args.kind : undefined;
        const branch = defineBranches.find(branch => branch.properties.kind.const === kind);
        if (!branch) validate(LearningDefineSchema, args);
        if (branch && args && typeof args === "object") {
          const missing = branch.required.filter(key => !Object.hasOwn(args, key));
          if (missing.length) throw new Error(`learning_define ${kind}: ${missing.map(key => `/${key}`).join(", ")} required. Use operation_id, kind, expected_goal_revision_id and body; lesson_preparation also needs expected_state_revision from learning_context.`);
          const body = "body" in args ? args.body : undefined;
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`learning_define ${kind}: /body must be an object containing this kind's fields. Read learning_skill {\"name\":\"learning\"}; do not switch to a guessed kind.`);
          const required = branch.properties.body.required ?? [];
          const absent = required.filter(key => !Object.hasOwn(body, key));
          if (absent.length) throw new Error(`learning_define ${kind}: ${absent.map(key => `/body/${key}`).join(", ")} required. Keep fields inside body; use the selected learning guide and current learning_context, not invented IDs or kind aliases.`);
          const prepared = { value: structuredClone(args) };
          normalizeDefinitionOptionals(prepared, branch as DefinitionArgumentSchema);
          validate(branch, prepared.value);
          return prepared.value;
        }
        return args;
      } : undefined,
      async execute(_id, params, signal, _update, ctx) {
        if (tool.name === "learning_source" && params !== null && typeof params === "object" && "action" in params && params.action === "drawing" && "artifact_revision_id" in params && typeof params.artifact_revision_id === "string") {
          if (!bridge.instructionDiagram || !options.diagram) throw new Error("The protected instruction diagram helper is unavailable in this host");
          const owner = sessionId(ctx), propose = options.diagram;
          const result = await bridge.instructionDiagram(params, owner, brief => {
            if (sessionId(ctx) !== owner) throw new Error("Instruction diagram conversation changed");
            return propose(brief, ctx, signal ?? new AbortController().signal);
          }, signal);
          if (sessionId(ctx) !== owner) throw new Error("Instruction diagram belongs to an earlier conversation");
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: { sage_instruction_diagram: result.diagram } };
        }
        if (tool.name === "learning_define" && params !== null && typeof params === "object" && "kind" in params && params.kind === "plan") {
          const proposal: unknown = params;
          validate<{ expected_goal_revision_id?: string; body: { goal_revision_id: string } }>(DefineSchema, proposal);
          const cached = await bridge.planResult?.(proposal, sessionId(ctx));
          if (cached) return { content: [{ type: "text", text: JSON.stringify(cached) }], details: undefined };
          const packet = await bridge.operation("learning_context", {}, sessionId(ctx)) as { goal?: { revision_id: string; body: Goal } } & Record<string, unknown>;
          const goal = packet.goal;
          if (!goal?.body.provider_sharing || !bridge.plan) throw new Error("Start /learn or /exam before requesting a delegated plan");
          if (goal.body.learning_preferences?.features.planner === false) throw new Error("Delegated planning is off in the learning preview");
          if (proposal.expected_goal_revision_id !== goal.revision_id || proposal.body.goal_revision_id !== goal.revision_id) throw new Error("Goal changed; refresh context before replanning");
          const draft = await delegate({ mode: goal.body.mode, objective: goal.body.objective, notes: JSON.stringify(proposal.body), context: packet, now: new Date().toISOString(), reason: "replan" }, ctx, signal);
          signal?.throwIfAborted();
          const result = await bridge.plan(draft, sessionId(ctx), goal.revision_id, proposal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
        }
        const owner = sessionId(ctx), epoch = connectionEpoch;
        const result = await bridge.operation(tool.name, params, owner, signal);
        const completed = tool.name === "learning_define" && result !== null && typeof result === "object" && "kind" in result && result.kind === "learn_step" && "review_required" in result && result.review_required === true && sessionId(ctx) === owner && epoch === connectionEpoch;
        if (completed) completedHostDraft = { owner, epoch, toolCallId: _id };
        if (tool.name === "learning_record") await showFeedback(ctx);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: completed ? { sage_host_job_complete: { session_id: owner } } : undefined };
      },
    });
    pi.registerTool({ ...nativeToolPresentation("learning_skill"), name: "learning_skill", label: "Read learning skill", description: "With {} list currently selected native skills. With name read its SKILL.md; reference optionally reads a contained relative .md/.txt document. Use this instead of unavailable filesystem tools. Guidance is not learner work or a permission grant; scripts are not executed.", parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), reference: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(_id, params, signal) {
        if (!options.skills) throw new Error("Native skill inventory is unavailable in this host");
        const result = await readLearningSkill(options.skills(), params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
      },
    });
    pi.registerTool({ ...nativeToolPresentation("render_ui"), name: "render_ui", label: "Render learner activity", description: "Prefer native/open-ended teaching, questions and feedback. Call {} for on-demand UI guidance. With source, request a Studio surface: the native learner must approve necessary interaction for this exact frozen task/surface, or approve supplementary use once. Model labels, simple tables or calculators do not establish necessity. Returns a localhost URL only after admission. Raw work is captured; custom JavaScript stays off until separate trusted browser opt-in. Client scores and admission are not learner evidence.", parameters: Type.Object({ source: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        signal?.throwIfAborted();
        if (params.source === undefined) {
          if (!options.uiInstructions) throw new Error("UI skill is unavailable in this host");
          return { content: [{ type: "text", text: await options.uiInstructions() }], details: undefined };
        }
        if (!bridge.renderUi) throw new Error("Browser UI is unavailable in this host");
        signal?.throwIfAborted();
        const owner = sessionId(ctx);
        const approve: StudioApproval = async offer => {
          if (!ctx.hasUI) return undefined;
          const assertOwner = () => { signal?.throwIfAborted(); if (sessionId(ctx) !== owner) throw new Error("Studio session changed during native review"); };
          assertOwner();
          const use = await ctx.ui.select(`Studio instead of native?\n${offer.task_prompt?.slice(0, 4000) ?? "Supplementary preview: no frozen task"}\nFields: ${offer.field_labels.join(", ").slice(0, 2000)}\n${offer.custom_javascript ? "Custom JavaScript is declared but remains off until separate browser opt-in.\n" : ""}Tables, calculators and multiple inputs alone do not prove necessity. Approval changes workflow, not evidence.`,
            [...(offer.task_prompt ? ["Necessary for this task"] : []), "Supplementary once", "Keep native"]);
          assertOwner();
          if (use === "Supplementary once") return { use: "supplementary" };
          if (use !== "Necessary for this task" || !offer.task_prompt) return undefined;
          const reason = await ctx.ui.input("Which required interaction cannot the native view reliably support?", "For example, editing linked values in a shared layout; explain this task's need.");
          assertOwner();
          return reason?.trim() ? { use: "necessary", reason } : undefined;
        };
        const result = await bridge.renderUi(params.source, owner, receipt => {
          if (sessionId(ctx) !== owner) throw new Error("Work saved for an earlier session; resume that session to review it");
          activities.cancel(ctx);
          pi.sendUserMessage(`A learner browser submission was captured by the host: ${JSON.stringify(receipt)}. Read the actual work and assess against the pinned rubric using the learner's selected feedback approach. ${receipt.review_required ? "Give actionable feedback_review; do not advance before review/repair or explicit learner override." : "Review-before-advance is off; offer useful feedback without imposing a repair gate."}`, { deliverAs: "followUp" });
        }, approve);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
      },
    });
    pi.on("session_start", async (_event, ctx) => {
      const activated = await bridge.activate?.(sessionId(ctx));
      if (activated && activated.lessons.length > 1 && bridge.bindLesson) {
        if (!ctx.hasUI) throw new Error("Legacy conversation has multiple lessons; resume interactively to select one");
        const labels = activated.lessons.map((g, i) => `${i + 1}. ${g.objective.slice(0, 160)}`);
        const selected = await ctx.ui.select("Choose a lesson from this legacy mixed session", labels);
        if (selected) await bridge.bindLesson(activated.lessons[labels.indexOf(selected)]!.entity_id, sessionId(ctx));
      }
      ctx.ui.setStatus("sage", "Sage · /sage /learn /exam /accelerate /drill /studio /status /stop");
      ctx.ui.notify("Use /sage, /learn or /exam for lesson setup. /studio prepares a browser activity; /extensions and /theme manage this isolated tutor. /login and /model select your model; /stop saves your place.", "info");
      if (options.startup && ctx.hasUI && ctx.model) {
        const packet = await bridge.operation("learning_context", {}, sessionId(ctx)) as { goal?: unknown };
        const requested = startup;
        startup = undefined;
        if (!packet.goal) await intake(requested?.mode ?? "learn")(requested?.goal ?? "", ctx);
      }
    });
    pi.on("input", async (event, ctx) => {
      // Extension-authored orchestration is transport text, never actual learner intent/work.
      if (event.source === "extension") return activities.input(event, ctx);
      connectionEpoch++; connectionRetried = false;
      try {
        const sid = sessionId(ctx);
        if (!bridge.inputAdmission) throw new Error("Native input admission is unavailable in this host");
        const admission = bridge.inputAdmission(sid);
        const packet = await bridge.operation("learning_context", {}, sid) as { goal?: { body: Goal }; disclosure?: { allowed: boolean } };
        if (sessionId(ctx) !== sid) throw new Error("Native input session changed");
        admission.assertCurrent();
        if (packet.disclosure?.allowed === false || (packet.goal && !packet.goal.body.provider_sharing)) {
          ctx.ui.notify("This lesson's stored sharing/source permission remains off. Ordinary text does not reverse that decision; explicitly resolve the local permission or use /new for a separate lesson.", "warning");
          return { action: "handled" };
        }
        const text = ("text" in event && typeof event.text === "string" ? event.text : "").trim();
        const hasImages = "images" in event && Array.isArray((event as { images?: unknown[] }).images) && ((event as { images?: unknown[] }).images?.length ?? 0) > 0;
        if (!packet.goal && hasImages && !text) {
          ctx.ui.notify("Set a goal with /learn or /exam before sharing scrap-work images.", "warning");
          return { action: "handled" };
        }
        if (!packet.goal) {
          if (ctx.sessionManager.getHeader?.()?.parentSession) {
            ctx.ui.notify("This fork has no sharing authorization. Explicitly start its separate lesson with /learn or /exam; copied work is not new learner evidence.", "warning");
            return { action: "handled" };
          }
          if (text.startsWith("/")) return { action: "handled" };
          const initial: Goal = {
            mode: startup?.mode ?? "learn",
            objective: startup?.goal?.trim() || text.slice(0, 500) || "General learning",
            subject: "practical",
            horizon_days: 7,
            budget_minutes: 30,
            target_format: "Goal-appropriate independent work",
            criteria: ["Demonstrate understanding and application"],
            allowed_aids: [],
            constraints: [],
            prior_experience: "unsure",
            probe: "offer",
            provider_sharing: true,
            source_ids: [],
          };
          let goal = options.startup ? await collectLessonIntake(ctx, initial, (args, confirmLarge) => bridge.source(args, sid, confirmLarge), () => {
            if (sessionId(ctx) !== sid) throw new Error("Native intake session changed");
            admission.assertCurrent();
          }) : initial;
          if (!goal) return { action: "handled" };
          if (ctx.hasUI && conductResearch) goal = await conductResearch(goal, ctx, () => { if (sessionId(ctx) !== sid) throw new Error("Native intake session changed"); admission.assertCurrent(); });
          admission.assertCurrent();
          const created = await bridge.goal(goal, sid);
          if (sessionId(ctx) !== sid) throw new Error("Native intake session changed");
          admission.goalCreated((created as { revision_id: string }).revision_id);
          startup = undefined;
        }
        return await activities.input(event, ctx, admission);
      } catch {
        try { ctx.ui.notify("Submission paused: permission or local-state checks failed. Retry when the local service is available.", "warning"); }
        catch { console.error("Sage could not display the local-state warning; submission remains blocked."); }
        return { action: "handled" };
      }
    });
    pi.on("context", async event => ({ messages: event.messages.filter(message => message.role !== "custom" || !["sage-context", "sato-context"].includes(message.customType)) }));
    pi.on("before_agent_start", async (event, ctx) => {
      if (!bridge.authorize) throw new Error("Current disclosure authorization is unavailable");
      const context = await bridge.operation("learning_context", {}, sessionId(ctx)) as { goal?: unknown };
      if (!context.goal) throw new Error("Start a lesson with actual learner intent before requesting tutoring");
      const permit = await bridge.authorize(sessionId(ctx));
      const studioOff = (permit.packet.goal as { body?: Goal } | undefined)?.body?.learning_preferences?.features.browser_ui === false;
      const previousTools = pi.getActiveTools(), researchNames = new Set(options.researchTools?.()?.names ?? []);
      const active = previousTools.filter(name => !researchNames.has(name));
      if (active.length !== previousTools.length) pi.setActiveTools(active);
      if (studioOff && active.includes("render_ui")) {
        pi.setActiveTools(active.filter(name => name !== "render_ui")); studioHidden = true;
      } else if (!studioOff && studioHidden) {
        if (!active.includes("render_ui")) pi.setActiveTools([...active, "render_ui"]);
        studioHidden = false;
      }
      // Public hook returns this turn's prompt; no accumulating hidden user-role messages.
      return { systemPrompt: currentTutorPrompt(event.systemPrompt, permit.packet) };
    });
    const intake = (mode: Goal["mode"], selectedPreferences?: LearningPreferences) => async (args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Let this response finish, or stop it before changing the goal.", "info"); return; }
      if (!ctx.model) { ctx.ui.notify("Choose a model with /login and /model first.", "info"); return; }
      const sid = sessionId(ctx), admission = bridge.inputAdmission?.(sid);
      const assertCurrent = () => { if (sessionId(ctx) !== sid) throw new Error("Native intake session changed"); admission?.assertCurrent(); };
      let saved = false;
      try {
        const packet = await bridge.operation("learning_context", {}, sid) as { goal?: { body: Goal }; disclosure?: { allowed?: boolean } };
        assertCurrent();
        if (packet.disclosure?.allowed === false) { ctx.ui.notify("This lesson's earlier source/provenance scope is not authorized. Use /new for a fresh lesson, or explicitly reselect all still-accepted sources. Originals remain local.", "warning"); return; }
        const previous = packet.goal?.body;
        const preferences = selectedPreferences ?? previous?.learning_preferences ?? profilePreferences("balanced");
        const objective = args.trim() || previous?.objective || (!options.startup || !ctx.hasUI ? await ctx.ui.input(mode === "exam" ? "What are you getting ready for?" : mode === "drill" ? "What topic or concept are we drilling?" : "What would you like to learn?") : "");
        assertCurrent();
        if (!objective?.trim() && (!options.startup || !ctx.hasUI)) return;
        const initial: Goal = previous ? { ...previous, mode, objective: objective?.trim() || previous.objective, learning_preferences: preferences } : {
          mode, objective: objective?.trim() ?? "", subject: "practical", horizon_days: preferences.profile === "cram" ? 1 : 7,
          budget_minutes: 30, target_format: "Goal-appropriate independent work; refine in conversation",
          criteria: ["Independent performance on the selected goal; clarify relevant criteria in conversation"], allowed_aids: [], constraints: [], prior_experience: "unsure", probe: "offer", learning_preferences: preferences, provider_sharing: true, source_ids: [],
        };
        let goal = previous || !options.startup ? initial : await collectLessonIntake(ctx, initial, (args, confirmLarge) => bridge.source(args, sid, confirmLarge), assertCurrent);
        if (!goal) return;
        if (ctx.hasUI && conductResearch) goal = await conductResearch(goal, ctx, assertCurrent);
        assertCurrent();
        const created = await bridge.goal(goal, sid);
        saved = true;
        if (sessionId(ctx) !== sid) throw new Error("Native intake session changed after the goal was saved");
        if (!previous) admission?.goalCreated((created as { revision_id: string }).revision_id);
        startup = undefined;
        activities.cancel(ctx);
        pi.sendUserMessage(`Begin /${mode} for: ${goal.objective}. Choose a small useful starting move in this conversation. Prepare concrete activities before offering them. ${preferences.features.planner ? "A consequential bounded plan is optional, not an intake prerequisite." : "Planning delegation is off."}`);
      } catch (error) {
        ctx.ui.notify(`${saved ? "Your goal was saved, but tutoring couldn't start. Try sending a message." : "Couldn't start."} ${error instanceof Error ? error.message.slice(0, 300) : "Try again or choose another model."}`, "warning");
      }
    };
    pi.registerCommand("learn", { description: "Learn a skill for independent understanding, retention and application", handler: intake("learn") });
    pi.registerCommand("exam", { description: "Prepare a test, essay, speech, interview or practical performance", handler: intake("exam") });
    pi.registerCommand("cram", { description: "Constrained exam preparation using declared deadline and study windows", handler: intake("cram") });
    pi.registerCommand("mode", { description: "mode learn|exam|cram|accelerate|drill [JSON exam/deadline/study_windows]; preserves current work", handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Finish or stop the current response before changing mode."); return; }
      const sid = sessionId(ctx);
      const packet = await bridge.operation("learning_context", {}, sid) as { goal?: { body: Goal } };
      if (!packet.goal) { ctx.ui.notify("Start a lesson with /learn or /exam first."); return; }
      if (!args.trim()) { ctx.ui.notify(`Current mode: ${packet.goal.body.mode}. Mode is independent of your learning profile.`); return; }
      const match = /^(learn|exam|cram|accelerate|drill)(?:\s+([\s\S]+))?$/.exec(args.trim());
      if (!match) { ctx.ui.notify("Use /mode learn|exam|cram|accelerate|drill [JSON declarations]", "warning"); return; }
      try {
        const declarations: unknown = match[2] ? JSON.parse(match[2]) : {};
        const allowed = ["deadline", "study_windows", "exam", "target_format", "allowed_aids", "criteria", "budget_minutes"];
        if (!declarations || typeof declarations !== "object" || Array.isArray(declarations) || Object.keys(declarations).some(k => !allowed.includes(k))) throw new Error("Only declared deadline, study windows, exam blueprint, format, aids, criteria and budget may be changed here");
        // SAFETY: The regex enumerates Goal modes; the host validates the complete goal and temporal fields.
        await bridge.goal({ ...packet.goal.body, ...declarations, mode: match[1] as Goal["mode"] }, sid);
        activities.cancel(ctx);
        ctx.ui.notify(`Mode: ${match[1]}. Existing responses, marks, pending tasks and their frozen criteria/aids are unchanged. Unknown exam coverage or timing stays unknown.`);
      } catch (error) { ctx.ui.notify(`Mode unchanged: ${error instanceof Error ? error.message : "Invalid declarations"}`, "warning"); }
    } });
    pi.registerCommand("refresh", { description: "Explicitly request a concise reviewed refresher for the pending task; recorded as help", handler: async (_args, ctx) => {
      if (!ctx.isIdle() || !bridge.requestRefresher) { ctx.ui.notify("Finish this response first; requested refreshers require native host support."); return; }
      try {
        const sid = sessionId(ctx);
        const packet = await bridge.operation("learning_context", {}, sid) as { learning_state?: LearningState };
        const state = packet.learning_state;
        if (!state?.current_task || !state.pending_count) { ctx.ui.notify("No pending task to refresh; no assistance or work was recorded."); return; }
        const refresher = await bridge.requestRefresher(state.state_revision, state.current_task.instance_revision_id, sid);
        ctx.ui.notify(`${refresher.text}\n\n${refresher.limitation}`);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Refresher unavailable", "warning"); }
    } });
    pi.registerCommand("drill", { description: "Focused practice; /drill teach-gaps [on|off|status] toggles explanations between assessed rounds", handler: async (args, ctx) => {
      const match = /^teach-gaps(?:\s+(on|off|status))?$/.exec(args.trim());
      if (!args.trim().startsWith("teach-gaps")) return intake("drill")(args, ctx);
      if (!match) { ctx.ui.notify("Use /drill teach-gaps [on|off|status]", "warning"); return; }
      if (!ctx.isIdle() || !bridge.drillTeaching) { ctx.ui.notify("Finish the current response; gap teaching requires native host support."); return; }
      const sid = sessionId(ctx), admission = bridge.inputAdmission?.(sid);
      const assertCurrent = () => { if (sessionId(ctx) !== sid) throw new Error("Drill control session changed"); if (!admission) throw new Error("Native drill admission unavailable"); admission.assertCurrent(); };
      try {
        const packet = await bridge.operation("learning_context", {}, sid) as { goal?: { body: Goal }; learning_state?: LearningState; disclosure?: { allowed?: boolean } };
        assertCurrent();
        if (packet.goal?.body.mode !== "drill" || !packet.learning_state || packet.disclosure?.allowed === false) throw new Error("Start or resume an authorized drill lesson first");
        const state = packet.learning_state.state_revision;
        const current = await bridge.drillTeaching(undefined, state, sid); assertCurrent();
        let choice = match[1];
        if (!choice) {
          if (!ctx.hasUI) { ctx.ui.notify(`Teach gaps: ${current.enabled ? "on" : "off"}. Use /drill teach-gaps on|off.`); return; }
          const labels = ["Off — practice only", "On — explain assessed gaps before fresh rechecks"];
          const selected = await ctx.ui.select(`Teach gaps (currently ${current.enabled ? "on" : "off"})`, labels); assertCurrent();
          if (!selected || !labels.includes(selected)) return; choice = selected === labels[1] ? "on" : "off";
        }
        if (choice === "status") { ctx.ui.notify(`Teach gaps: ${current.enabled ? "on" : "off"}. Changes apply between fully assessed rounds.`); return; }
        assertCurrent();
        if (!ctx.isIdle()) throw new Error("Finish the current response before changing drill teaching");
        const result = await bridge.drillTeaching(choice === "on", state, sid);
        if (sessionId(ctx) !== sid) throw new Error("Drill setting saved for an earlier session; resume it to review");
        activities.cancel(ctx);
        ctx.ui.notify(`Teach gaps: ${result.enabled ? "on" : "off"}. ${result.enabled ? "Observed gaps get explanatory feedback between assessed rounds; /continue requests fresh rechecks." : "Practice-only loop retained."} Original marks and frozen work are unchanged.`);
        if (result.enabled && ctx.model && packet.goal.body.provider_sharing) pi.sendUserMessage("Native learner control enabled drill gap teaching. Read fresh learning_context: if gap_teaching.ready, explain the assessed gaps and ask for native /continue before fresh work. Otherwise keep practicing until there is an observed assessed gap. This control is not learner work or proof of understanding.");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Drill teaching unchanged", "warning"); }
    } });
    pi.registerCommand("accelerate", { description: "High-paced adaptive advancement past verified competencies", handler: intake("accelerate") });
    pi.registerCommand("sage", { description: "Learning preview: /sage [learn|exam|cram|drill|accelerate] [goal]", handler: async (args, ctx) => {
      const match = /^(learn|exam|cram|drill|accelerate)(?:\s+(.*))?$/s.exec(args.trim());
      const selectedMode = (match?.[1] ?? "learn") as Goal["mode"];
      const goalArg = match ? match[2] ?? "" : args;
      if (!ctx.isIdle()) { ctx.ui.notify("Finish or stop this response before changing lesson settings.", "info"); return; }
      const sid = sessionId(ctx), admission = bridge.inputAdmission?.(sid);
      const assertCurrent = () => { if (sessionId(ctx) !== sid) throw new Error("Native preview session changed"); admission?.assertCurrent(); };
      try {
        const packet = await bridge.operation("learning_context", {}, sid) as { goal?: { body: Goal } };
        assertCurrent();
        const preferences = await learningPreview(ctx, packet.goal?.body.learning_preferences);
        assertCurrent();
        if (preferences) await intake(selectedMode, preferences)(goalArg, ctx);
      } catch (error) {
        ctx.ui.notify(`Lesson setup paused: ${error instanceof Error ? error.message.slice(0, 300) : "Refresh the current lesson before retrying."}`, "warning");
      }
    } });
    pi.registerCommand("studio", { description: "Prepare a reviewed browser activity for the current lesson", handler: async (args, ctx) => {
      const packet = await bridge.operation("learning_context", {}, sessionId(ctx)) as { goal?: { body: Goal } };
      if (!packet.goal?.body.provider_sharing || packet.goal.body.learning_preferences?.features.browser_ui === false) { ctx.ui.notify("Start a sharing-authorized goal with browser UI enabled in /sage first.", "warning"); return; }
      pi.sendUserMessage(`Prepare a concrete browser activity aligned to my current lesson${args.trim() ? `: ${args.slice(0, 2000)}` : "."} Use the on-demand ui skill and render_ui. First establish an appropriate rubric and reviewed practice-ready task and frozen instance. Show enough instructions and editable work to be useful; no empty surface. Submit raw work for host review, not client-generated grades.`);
    } });
    const continueLesson: Parameters<typeof pi.registerCommand>[1]["handler"] = async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Finish or stop the current response first."); return; }
      const owner = sessionId(ctx);
      const assertOwner = () => { if (sessionId(ctx) !== owner || !ctx.isIdle()) throw new Error("Native learning choice changed session or became busy"); };
      try {
        const packet = await bridge.operation("learning_context", {}, owner) as { goal?: { revision_id: string; body: Goal }; learning_state?: { state_revision: string; current_task?: { instance_revision_id: string; purpose?: string; assessment_event_id?: string | null } | null; learn_flow?: import("../../runtime/src/learn-flow.ts").LearnFlow } };
        assertOwner();
        if (!packet.goal?.body.provider_sharing) { ctx.ui.notify("No provider sharing permission; no tutor request started.", "warning"); return; }
        const state = packet.learning_state, flow = state?.learn_flow;
        const pendingTask = state?.current_task && !state.current_task.assessment_event_id ? state.current_task : undefined;
        if (args.trim() === "skip" && pendingTask && bridge.continue) {
          ctx.ui.notify(JSON.stringify(await bridge.continue(owner), null, 2));
          return;
        }
        if (flow && bridge.learnControl) {
          if (!ctx.hasUI) { ctx.ui.notify("Native learning controls require an interactive session; saved work is unchanged.", "warning"); return; }
          if (flow.action === "stopped") { ctx.ui.notify("Resume the saved lesson before continuing.", "warning"); return; }
          const request = (action: string) => ({ operation_id: randomUUID(), action, confirmed: true, expected_goal_revision_id: packet.goal!.revision_id, expected_state_revision: state!.state_revision });
          const askForStep = () => pi.sendUserMessage("Execute only the current host learn_flow step using the fresh host snapshot and exact schemas. Fetch targeted context only for missing details; do not repeat planning or broad skill reads. Preserve criteria, work and gaps; do not advance another topic.");
          const response = async (instanceId: string) => {
            const receipt = await activities.run({ action: "open_response", operation_id: randomUUID(), expected_goal_revision_id: packet.goal!.revision_id, instance_revision_id: instanceId }, ctx);
            assertOwner();
            if ("attempt_id" in receipt) askForStep();
          };
          const explicit = args.trim() === "skip" ? "gaps" : args.trim();
          if (explicit && !["teach", "practice", "advance", "gaps"].includes(explicit)) { ctx.ui.notify("Use /continue [teach|practice|advance|gaps].", "warning"); return; }
          const teachInstead = async () => {
            await bridge.learnControl!(request("skip_diagnostic"), owner);
            assertOwner();
            ctx.ui.notify("Diagnostic skipped. Teaching can continue on the same topic; no answer, mark or advancement was recorded.");
            askForStep();
          };
          if (explicit === "teach") { await teachInstead(); return; }
          if (!explicit) {
            if (flow.action === "teach_explanation") {
              const choice = await ctx.ui.select("Keep explaining or try optional guided practice? No diagnostic is required.", ["Keep explaining", "Try guided practice", "Not now"]);
              assertOwner();
              if (choice === "Try guided practice") { await bridge.learnControl(request("practice"), owner); assertOwner(); askForStep(); }
              else if (choice === "Keep explaining") askForStep();
              return;
            }
            if (flow.action === "review_draft") {
              const choice = await ctx.ui.select("This question is optional; approval is not required for teaching.", ["Review this question", "Teach without a diagnostic", "Not now"]);
              assertOwner();
              if (choice === "Teach without a diagnostic") await teachInstead();
              else if (choice === "Review this question") ctx.ui.notify("Use /approve to review this question and its public criteria. Acceptance is not expert validation.");
              return;
            }
            if (flow.action === "present_instruction" || flow.action === "start_practice") {
              const started = await bridge.learnControl(request("begin_step"), owner);
              assertOwner();
              if (started.teaching_request) {
                const released = await activities.run(started.teaching_request, ctx);
                assertOwner();
                if ("instance_revision_id" in released && typeof released.instance_revision_id === "string") await response(released.instance_revision_id);
              } else if (started.instance_revision_id) await response(started.instance_revision_id);
              return;
            }
            if (flow.action === "collect_response" && state?.current_task) {
              if (state.current_task.purpose === "practice") {
                await response(state.current_task.instance_revision_id);
                return;
              }
            }
            if (flow.action === "present_feedback") {
              const feedback = await bridge.feedback?.(owner);
              assertOwner();
              if (feedback?.text) { ctx.ui.notify(feedback.text); await bridge.feedback?.(owner, true); }
              return;
            }
            if (!["wait_for_continue", "ready_to_advance"].includes(flow.action)) {
              if (bridge.continue && pendingTask) {
                ctx.ui.notify(JSON.stringify(await bridge.continue(owner), null, 2));
                return;
              }
              askForStep(); return;
            }
          }
          const choices = ["Continue practising", ...(flow.can_move_on ? ["Advance to the next target"] : []), "Move on with gaps", "Not now"];
          const choice = explicit || await ctx.ui.select(`Learning checkpoint — ${flow.readiness?.unmet_requirements.join(", ") || "conditional local readiness; not permanent mastery"}`, choices);
          assertOwner();
          const action = choice === "practice" || choice === choices[0] ? "practice" : choice === "advance" || choice === "Advance to the next target" ? "advance" : choice === "gaps" || choice === "Move on with gaps" ? "move_on_with_gaps" : undefined;
          if (!action) return;
          if (action === "move_on_with_gaps" && !await ctx.ui.confirm("Leave this target with gaps?", `Unresolved evidence stays recorded: ${flow.readiness?.unmet_requirements.join(", ") || "unknown"}. This does not award credit or establish mastery.`)) return;
          assertOwner();
          const receipt = await bridge.learnControl(request(action), owner);
          assertOwner();
          ctx.ui.notify(JSON.stringify(receipt));
          askForStep();
          return;
        }
        if (!bridge.continue) { ctx.ui.notify("Review override is unavailable in this host.", "warning"); return; }
        ctx.ui.notify(JSON.stringify(await bridge.continue(owner), null, 2));
        pi.sendUserMessage("I explicitly choose to continue or skip. If the current review is unresolved, I override its workflow gate, not its evidence. Preserve actual outcomes and remaining uncertainty; do not invent a successful repair. Offer the next appropriate teaching move.");
      } catch (error) { ctx.ui.notify(`Learning continuation paused: ${error instanceof Error ? error.message.slice(0, 300) : "refresh the current lesson"}`, "warning"); }
    };
    pi.registerCommand("continue", { description: "Native learning step: /continue [teach|practice|advance|gaps]; teach skips the diagnostic", handler: continueLesson });
    pi.registerCommand("skip", { description: "Choose to leave the current target with recorded gaps; requires confirmation", handler: (args, ctx) => continueLesson(args || "skip", ctx) });
    for (const name of ["extensions", "theme", "packages"] as const) pi.registerCommand(name, { description: `Manage isolated native Pi ${name}; list | add/install | enable/disable/set | remove/update`, handler: async (args, ctx) => {
      if (!bridge.control) { ctx.ui.notify("Customization is unavailable in this host.", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Finish or stop this response before changing resources."); return; }
      const tokens = Array.from(args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), match => match[1] ?? match[2] ?? match[3]!);
      if (!tokens.length) tokens.push("list");
      const executing = name === "extensions" && ["add", "enable"].includes(tokens[0]!) || name === "packages" && ["install", "update"].includes(tokens[0]!);
      const trusted = executing ? await ctx.ui.confirm("Trust native code?", "Pi extensions and packages run with your operating-system privileges, not the browser sandbox. Install/enable only code you trust.") : false;
      if (executing && !trusted) return;
      const result = await bridge.control(name, tokens, trusted);
      if (name === "theme" && tokens[0] === "set" && tokens[1] && ctx.hasUI) ctx.ui.setTheme(tokens[1]);
      ctx.ui.notify(`${JSON.stringify(result, null, 2)}\nResource changes are stored in this Sage home. Use /reload to load changed extensions/packages.`, "info");
    } });
    pi.registerCommand("status", { description: "Read evidence, gaps, checkpoint and due reviews", handler: async (_args, ctx) => { ctx.ui.notify(formatLearningStatus(await bridge.operation("learning_context", {}, sessionId(ctx)) as Record<string, unknown>)); } });
    pi.registerCommand("source", { description: "folder DIRECTORY | add PATH | ocr PDF_PATH | list | preview ID | accept ID | attach ID | remove ID", handler: async (args, ctx) => {
      const owner = sessionId(ctx), attach = args.trim().match(/^attach\s+(.+)$/);
      if (attach) {
        const admission = bridge.inputAdmission?.(owner);
        const source = await bridge.source(`status ${unquote(attach[1]!)}`, owner) as { mime?: string };
        if (source?.mime === "image/png" || source?.mime === "image/jpeg") {
          if (!ctx.hasUI || !ctx.isIdle() || !admission) { ctx.ui.notify("Finish the response and use native lesson setup to confirm original-image sharing.", "warning"); return; }
          admission.assertCurrent();
          if (!await ctx.ui.confirm("Share this original source image?", "The original image, not just OCR text, may be sent to your selected vision-capable model for this lesson. Check for unrelated private content. Text-only models or disabled image reading receive OCR text only.")) return;
          admission.assertCurrent();
          if (sessionId(ctx) !== owner) throw new Error("Native source session changed");
        }
      }
      const admission = bridge.inputAdmission?.(owner);
      ctx.ui.notify(JSON.stringify(await bridge.source(args, owner, file => {
        if (!ctx.hasUI || !ctx.isIdle() || !admission) throw new Error("Use the native source dialog to decide on a file over 50 MiB, or the CLI --allow-large flag");
        return confirmLargeSource(ctx, file, () => {
          admission.assertCurrent();
          if (sessionId(ctx) !== owner || !ctx.isIdle()) throw new Error("Native large-file source session changed");
        });
      }), null, 2));
    } });
    pi.registerCommand("approve", { description: "Review current lesson practice; no ID needed. Explicit ID [confirm] is also available.", handler: async (args, ctx) => {
      if (args.trim()) {
        const parts = args.trim().split(/\s+/);
        ctx.ui.notify(JSON.stringify(await bridge.approve(unquote(parts[0]!), parts[1] === "confirm", sessionId(ctx)), null, 2));
        return;
      }
      if (!ctx.isIdle() || !ctx.hasUI || !bridge.approvalChoices || !bridge.inputAdmission) {
        ctx.ui.notify("Finish the response and use /approve in the native interface, or /approve TASK_REVISION_ID to inspect a specific draft.", "warning"); return;
      }
      const owner = sessionId(ctx), admission = bridge.inputAdmission(owner);
      const assertSession = () => {
        if (sessionId(ctx) !== owner || !ctx.isIdle()) throw new Error("Native approval session changed; review the current lesson again");
      };
      const choices = await bridge.approvalChoices(owner);
      assertSession(); admission.assertCurrent(); admission.assertScopeCurrent();
      if (!choices.length) { ctx.ui.notify("No pending low-stakes practice draft for this lesson. Ask your tutor to prepare or continue the current activity."); return; }
      const labels = choices.map((choice, index) => `${index + 1}. ${choice.title}`);
      const selected = choices.length === 1 ? labels[0] : await ctx.ui.select("Choose practice to review", labels);
      if (selected === undefined) return;
      assertSession(); admission.assertCurrent(); admission.assertScopeCurrent();
      const choice = choices[labels.indexOf(selected)];
      if (!choice) throw new Error("Practice selection changed; use /approve again");
      const preview = await bridge.approve(choice.revision_id, false, owner);
      assertSession(); admission.assertCurrent();
      ctx.ui.notify(JSON.stringify(preview, null, 2));
      // Previewing a key can append a support receipt; pin the scope after that write.
      const reviewAdmission = bridge.inputAdmission(owner);
      const packet = await bridge.operation("learning_context", {}, owner) as { goal?: { revision_id: string }; learning_state?: { state_revision: string; learn_flow?: import("../../runtime/src/learn-flow.ts").LearnFlow } };
      assertSession(); reviewAdmission.assertCurrent(); reviewAdmission.assertScopeCurrent();
      if (packet.learning_state?.learn_flow?.protocol_active && packet.learning_state.learn_flow.draft?.definition_revision_id === choice.revision_id && bridge.learnControl) {
        const decision = await ctx.ui.select("Accept this question for learner practice, not expert validation. Teaching does not require taking a diagnostic.", ["Accept for practice", "Teach without a diagnostic", "Not now"]);
        assertSession(); reviewAdmission.assertCurrent(); reviewAdmission.assertScopeCurrent();
        if (decision === "Teach without a diagnostic") {
          await bridge.learnControl({ operation_id: randomUUID(), action: "skip_diagnostic", confirmed: true, expected_goal_revision_id: packet.goal!.revision_id, expected_state_revision: packet.learning_state.state_revision }, owner);
          assertSession();
          ctx.ui.notify("Diagnostic skipped; the same topic stays active and ability remains unassessed.");
          pi.sendUserMessage("The learner declined the optional diagnostic, not the lesson. Follow the current host teach_explanation step: explain the same topic without requiring question approval, a diagnostic, or learner work. Preserve unknowns and marks.", { deliverAs: "followUp" });
          return;
        }
        if (decision !== "Accept for practice") return;
      } else if (!await ctx.ui.confirm("Accept this low-stakes practice?", "Review the question and rubric just shown. Accept for learner practice, not expert validation. Viewing an answer key makes this item supported evidence. Cancel keeps the draft unapproved.")) return;
      assertSession(); reviewAdmission.assertCurrent(); reviewAdmission.assertScopeCurrent();
      const approved = await bridge.approve(choice.revision_id, true, owner);
      assertSession();
      ctx.ui.notify(JSON.stringify(approved, null, 2));
      pi.sendUserMessage("The learner accepted the practice draft through native /approve. Use the fresh host snapshot for its approved revision and next bounded step; fetch context only for missing details. Approval is not learner work, delivery or competence.", { deliverAs: "followUp" });
    } });
    pi.registerCommand("reviews", { description: "Inspect or manage scheduled reviews: list | accept COMPONENT_ID [DATE] | decline COMPONENT_ID | cancel SCHEDULE_ID | reschedule SCHEDULE_ID DATE", handler: async (args, ctx) => {
      if (!bridge.reviewControl) { ctx.ui.notify("Review controls are unavailable in this host.", "warning"); return; }
      const sid = sessionId(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "list";
      if (sub === "list") {
        const result = await bridge.reviewControl("list", {}, sid);
        ctx.ui.notify(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === "accept" && parts[1]) {
        const result = await bridge.reviewControl("accept", { component_revision_id: unquote(parts[1]), due_at: parts[2] ? unquote(parts[2]) : undefined }, sid);
        ctx.ui.notify(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === "decline" && parts[1]) {
        const result = await bridge.reviewControl("decline", { component_revision_id: unquote(parts[1]) }, sid);
        ctx.ui.notify(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === "cancel" && parts[1]) {
        const result = await bridge.reviewControl("cancel", { schedule_event_id: unquote(parts[1]) }, sid);
        ctx.ui.notify(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === "reschedule" && parts[1] && parts[2]) {
        const result = await bridge.reviewControl("reschedule", { schedule_event_id: unquote(parts[1]), due_at: unquote(parts[2]) }, sid);
        ctx.ui.notify(JSON.stringify(result, null, 2));
        return;
      }
      ctx.ui.notify("Usage: /reviews [list | accept COMPONENT_ID [DATE] | decline COMPONENT_ID | cancel SCHEDULE_ID | reschedule SCHEDULE_ID DATE]");
    } });
    pi.registerCommand("stop", { description: "Stop tutoring and save a resumable checkpoint", handler: async (_args, ctx) => { connectionEpoch++; requestScope = undefined; pendingPlanner?.abort(new Error("Planning cancelled")); activities.cancel(ctx); ctx.abort(); ctx.ui.notify(JSON.stringify(await bridge.stop(sessionId(ctx)), null, 2)); } });
    pi.on("session_shutdown", async (_event, ctx) => { connectionEpoch++; requestScope = undefined; pendingPlanner?.abort(new Error("Session closed")); activities.cancel(ctx); await bridge.stop(sessionId(ctx)); });

    // These hooks observe provider requests/responses. Message completion cannot prove
    // every hidden retry/compaction call, so terminal records declare that coverage gap.
    const active: Array<{ id: string; provider: string; model: string; responded: boolean }> = [];
    pi.on("before_provider_request", async (event, ctx) => {
      requestScope = undefined;
      const owner = sessionId(ctx), epoch = connectionEpoch;
      const permit = await bridge.authorize?.(owner).catch(() => undefined);
      if (permit?.session_id === owner && sessionId(ctx) === owner && epoch === connectionEpoch) requestScope = { owner, revision: permit.revision, epoch };
      const call = { id: randomUUID(), provider: ctx.model?.provider ?? "unknown", model: ctx.model?.id ?? "unknown", responded: false };
      active.push(call);
      const payload = JSON.stringify(event.payload);
      await bridge.calls({ call_id: call.id, phase: "started", provider: call.provider, model: call.model, operation: "pi_provider_request", request_hash: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)).then(b => Buffer.from(b).toString("hex")), gap: "Provider-hook coverage only; opaque retry/compaction paths may not be observable" }, sessionId(ctx));
    });
    pi.on("after_provider_response", async (event, ctx) => {
      const call = active.find(c => !c.responded);
      if (!call) return;
      call.responded = true;
      await bridge.calls({ call_id: call.id, phase: event.status >= 400 ? "failed" : "response", provider: call.provider, model: call.model, operation: "pi_provider_request", status: event.status }, sessionId(ctx));
      if (event.status >= 400) { requestScope = undefined; active.splice(active.indexOf(call), 1); }
    });
    pi.on("message_end", async (event, ctx) => {
      const message = event.message, scope = requestScope;
      requestScope = undefined;
      if (message.role !== "assistant" || message.stopReason !== "error" || !/socket connection was closed|ECONNRESET|connection reset|fetch failed/i.test(message.errorMessage ?? "") || /schema|validation|quota|unauthori|API key|HTTP\s*4\d\d/i.test(message.errorMessage ?? "")) return;
      const model = `${message.provider || ctx.model?.provider || "unknown"}/${message.model || ctx.model?.id || "unknown"}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 180);
      if (scope && !connectionRetried && message.content.length === 0 && sessionId(ctx) === scope.owner && !ctx.hasPendingMessages() && scope.epoch === connectionEpoch) {
        connectionRetried = true;
        const permit = await bridge.authorize?.(scope.owner).catch(() => undefined);
        if (permit?.session_id === scope.owner && permit.revision === scope.revision && sessionId(ctx) === scope.owner && scope.epoch === connectionEpoch && !ctx.hasPendingMessages()) {
          // A new governed turn, not an opaque HTTP/tool retry or a captured learner response.
          pi.sendUserMessage("Host connection recovery (not learner work): the previous provider response ended before any content. Read learning_context and continue from saved state. Preserve existing IDs; do not repeat committed operations, lesson setup, answers or assessments.", { deliverAs: "followUp" });
          ctx.ui.notify(`Model/provider connection interrupted (${model}); continuing once from saved state. No saved operation is automatically replayed.`, "warning");
          return;
        }
      }
      ctx.ui.notify(`Model/provider connection interrupted (${model}). Check /status and resume from saved state; do not rerun lesson setup. Report this provider/model if it repeats.`, "warning");
    });
    pi.on("agent_end", async (_event, ctx) => {
      await showFeedback(ctx);
      for (const call of active.splice(0)) await bridge.calls({ call_id: call.id, phase: "unknown", provider: call.provider, model: call.model, operation: "pi_provider_request", gap: "Agent ended; exact stream terminal status, usage and internal retry correlation were not exposed by these hooks" }, sessionId(ctx));
    });
  };
}

export async function createTutorRuntime(paths: SagePaths, bridge: TutorBridge, suppliedSdk?: PiSdk, launchOptions: { mode?: Goal["mode"]; goal?: string; guidedStart?: boolean; usage?: UsageTracker } = {}) {
  const sdk = suppliedSdk ?? await loadPi(paths);
  const authorize = (owner: string) => {
    if (!bridge.authorize) return Promise.reject(new Error("Current disclosure authorization is unavailable"));
    return bridge.authorize(owner);
  };
  const policy = await readFile(join(paths.builtIn.prompts, "tutor-policy.md"), "utf8");
  return sdk.createAgentSessionRuntime(async options => {
    const settings = createSageSettings(paths, sdk);
    await settings.flush();
    await ensureManagedPackages(paths, sdk, settings);
    const producedSummaries = new Set<string>();
    let generated: { summary: string; revision: string } | undefined;
    let compactionInput: ((permit: DisclosurePermit) => ReturnType<PiSdk["convertToLlm"]>) | undefined;
    const services = await sdk.createAgentSessionServices({ cwd: paths.config, agentDir: paths.agent, settingsManager: settings,
      resourceLoaderOptions: { ...createSageResourceOptions(paths, settings, sdk), systemPrompt: policy.replace(/^---[\s\S]*?---\s*/, ""), extensionFactories: [{ name: "sage-tutor", factory: createTutorExtension(bridge, { sdk, researchTools: () => managedResearchTools(paths, services.resourceLoader), usage: launchOptions.usage, startup: launchOptions.guidedStart ? launchOptions : undefined, skills: () => services.resourceLoader.getSkills().skills, uiInstructions: async () => (await Promise.all(["SKILL.md", "design.md"].map(file => readFile(join(paths.builtIn.skills, "ui", file), "utf8")))).join("\n\n"), planner: async (request, ctx, signal) => {
        if (!ctx.model) throw new Error("Choose a model with /model before planning");
        const owner = ctx.sessionManager.getSessionId();
        return planWithPi(paths, request, { sdk, model: ctx.model, modelRuntime: services.modelRuntime, thinkingLevel: ctx.thinkingLevel, sessionId: owner, calls: bridge.calls.bind(bridge), authorize: () => authorize(owner), signal });
      }, feynman: async (request, ctx, signal) => {
        if (!ctx.model) throw new Error("Choose a model with /model before teach-back");
        const owner = ctx.sessionManager.getSessionId();
        return reviewWithPi(paths, request, { sdk, model: ctx.model, modelRuntime: services.modelRuntime, thinkingLevel: ctx.thinkingLevel, sessionId: owner, calls: bridge.calls.bind(bridge), authorize: () => authorize(owner), signal });
      }, diagram: async (brief, ctx, signal) => {
        if (!ctx.model) throw new Error("Choose a model with /model before generating an instruction diagram");
        const owner = ctx.sessionManager.getSessionId();
        return diagramWithPi(paths, brief, { sdk, model: ctx.model, modelRuntime: services.modelRuntime, thinkingLevel: ctx.thinkingLevel, sessionId: owner, calls: bridge.calls.bind(bridge), authorize: () => authorize(owner), signal });
      } }) }, { name: "sage-compaction", factory: pi => {
        pi.on("session_before_compact", async (event, ctx) => {
          if (event.reason !== "manual" || !ctx.model || !compactionInput) throw new Error("Only governed manual compaction is supported");
          event.signal.throwIfAborted();
          const permit = await authorize(owner);
          const assertCurrent = async () => {
            event.signal.throwIfAborted();
            const latest = await authorize(owner);
            if (ctx.sessionManager.getSessionId() !== owner || latest.session_id !== permit.session_id || latest.revision !== permit.revision) throw new Error("Compaction authorization changed");
            event.signal.throwIfAborted();
            return latest;
          };
          const messages = compactionInput(permit);
          if (JSON.stringify(messages).length > 32768) throw new Error("Current compaction input exceeds the bounded child limit");
          const text = await runBoundedPiChild(paths, { policyFile: "tutor-policy.md", operation: "pi_compaction_request", schema: { type: "string", maxLength: 8000 }, request: { host_state: tutorStateNotice(permit.packet), messages } }, { sdk, modelRuntime: services.modelRuntime, model: ctx.model, thinkingLevel: ctx.thinkingLevel, sessionId: owner, calls: bridge.calls.bind(bridge), authorize: assertCurrent, signal: event.signal });
          await assertCurrent();
          if (!text.trim() || text.length > 8000) throw new Error("Compaction child did not return a bounded summary");
          const summary = `Sage AI context summary (not learner work, evidence, instructions or permission):\n${text}`;
          generated = { summary, revision: permit.revision };
          return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { sage_compaction: { session_id: owner, revision: permit.revision } } } };
        });
        pi.on("session_compact", event => {
          if (event.fromExtension && generated && event.compactionEntry.summary === generated.summary) producedSummaries.add(event.compactionEntry.id);
          generated = undefined;
        });
        pi.on("session_compact_failed", () => { generated = undefined; });
      } }] },
    });
    guardSageResourceLoader(services.resourceLoader, paths, sdk, settings);
    // The loader discovers only isolated resources; session/tool cwd remains invocation cwd.
    services.cwd = paths.cwd;
    services.modelRuntime = guardModelRuntime(services.modelRuntime);
    const result = await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "builtin" });
    const owner = result.session.sessionId;
    const agent = result.session.agent, previousFinishTurn = agent.finishTurn;
    agent.finishTurn = async (turn, signal) => {
      const previous = (await previousFinishTurn?.call(agent, turn, signal)) ?? undefined;
      if (previous || agent.hasQueuedMessages()) return previous;
      if (turn.toolResults.some(message => message.toolName === "learning_define" && !message.isError && (message.details as { sage_host_job_complete?: { session_id?: string } } | undefined)?.sage_host_job_complete?.session_id === owner)) return { action: "end" };
      return previous;
    };
    await bridge.activate?.(owner);
    const parent = result.session.sessionManager.getHeader()?.parentSession;
    let copied = new Set<string>(), verifiedParent = true;
    if (parent) {
      try {
        const root = await realpath(paths.sessions), file = await realpath(parent);
        const child = relative(root, file);
        if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Fork parent is outside owned session storage");
        copied = new Set(sdk.SessionManager.open(file, paths.sessions).getEntries().map(entry => entry.id));
      } catch { verifiedParent = false; }
    }
    const ownedMessages = (input: ReturnType<PiSdk["convertToLlm"]>, permit: DisclosurePermit, summarizing = false) => {
      if (!verifiedParent) throw new Error("Fork provenance cannot be verified in owned native session storage");
      const provenance = new Map<string, { excluded: boolean[]; next: number }>();
      for (const entry of result.session.sessionManager.buildSessionProjection().entries) {
        const source = entry.sourceEntry;
        const marker = source.type === "compaction" ? (source.details as { sage_compaction?: { session_id?: unknown; revision?: unknown }; sato_compaction?: { session_id?: unknown; revision?: unknown } } | undefined)?.sage_compaction ?? (source.details as { sato_compaction?: { session_id?: unknown; revision?: unknown } } | undefined)?.sato_compaction : undefined;
        // A saved scope only disqualifies; current producer identity is runtime-local.
        const excluded = copied.has(source.id) || source.type === "branch_summary" || source.type === "compaction" && (summarizing || !producedSummaries.has(source.id) || typeof marker?.session_id !== "string" || typeof marker.revision !== "string" || marker.session_id !== permit.session_id || marker.revision !== permit.revision);
        for (const message of normalizeProviderImages(sdk.convertToLlm(entry.messages), settings.getBlockImages())) {
          const key = JSON.stringify(message), occurrences = provenance.get(key) ?? { excluded: [], next: 0 };
          occurrences.excluded.push(excluded);
          provenance.set(key, occurrences);
        }
      }
      const messages = input.filter(message => {
        if (message.role === "system") return false;
        const occurrences = provenance.get(JSON.stringify(message));
        if (!occurrences || occurrences.next === occurrences.excluded.length) throw new Error(`Fork ${message.role} context has no public native entry provenance`);
        return !occurrences.excluded[occurrences.next++];
      });
      const calls = new Set(messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []));
      const paired = messages.filter(message => message.role !== "toolResult" || calls.has(message.toolCallId));
      const pending = new Set<string>();
      for (const message of paired) {
        if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
        if (message.role === "toolResult" && !pending.delete(message.toolCallId)) throw new Error("Fork tool result has no current native call");
      }
      if (pending.size) throw new Error("Fork native tool group is incomplete");
      return paired;
    };
    compactionInput = permit => ownedMessages(normalizeProviderImages(sdk.convertToLlm(result.session.sessionManager.buildSessionProjection().messages), settings.getBlockImages()), permit, true);
    const filter: FilterProviderContext = (context, permit) => {
      const projectionRequired = parent || result.session.sessionManager.getEntries().some(entry => entry.type === "compaction" || entry.type === "branch_summary");
      const messages = projectionRequired ? ownedMessages(context.messages, permit) : context.messages.filter(message => message.role !== "system");
      const flow = (permit.packet.host_learn_step ?? (permit.packet.learning_state as Partial<LearningState> | undefined)?.learn_flow) as LearningState["learn_flow"];
      // Advertisement reduces orchestration load; the service remains the transition authority.
      const toolsAdded = result.session.agent.state.tools.filter(tool => {
        if (!flow) return true;
        if (tool.name === "learning_define") return flow.allowed_define_kinds.length > 0;
        if (tool.name === "learning_record") return flow.allowed_record_kinds.length > 0;
        if (tool.name === "learning_activity") return flow.required_tool === "learning_activity";
        if (tool.name === "render_ui") return flow.action === "collect_response";
        return true;
      }).map(tool => {
        let parameters = tool.parameters;
        if (flow && tool.name === "learning_define") parameters = LearnStepSchema;
        if (flow && tool.name === "learning_record") {
          const branches = RecordSchema.anyOf.filter(branch => flow.allowed_record_kinds.includes(branch.properties.kind.const));
          if (branches.length) parameters = Type.Union(branches, { type: "object", additionalProperties: false, required: branches[0]!.required, properties: { ...branches[0]!.properties, kind: Type.Enum(branches.map(branch => branch.properties.kind.const)), payload: Type.Union(branches.map(branch => branch.properties.payload)) } });
        }
        return { name: tool.name, description: tool.description, parameters };
      });
      return { ...context, messages: [{ role: "system", content: currentTutorPrompt(policy.replace(/^---[\s\S]*?---\s*/, ""), permit.packet), timestamp: Date.now(), toolsAdded }, ...messages] };
    };
    installDisclosureGate(result.session, () => authorize(owner), false, filter);
    const existing = await bridge.operation("learning_context", {}, owner) as { goal?: unknown };
    if (!launchOptions.guidedStart && (launchOptions.mode || launchOptions.goal) && !existing.goal && !parent) {
      await bridge.goal({
        mode: launchOptions.mode ?? "learn",
        objective: launchOptions.goal?.trim() || "General learning",
        subject: "practical",
        horizon_days: 7,
        budget_minutes: 30,
        target_format: "Goal-appropriate independent work",
        criteria: ["Demonstrate understanding and application"],
        allowed_aids: [],
        constraints: [],
        prior_experience: "unsure",
        probe: "offer",
        provider_sharing: true,
        source_ids: [],
      }, owner);
    }
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: paths.cwd, agentDir: paths.agent, sessionManager: sdk.SessionManager.create(paths.cwd, paths.sessions) });
}

export async function runTutor(paths: SagePaths, bridge: TutorBridge, suppliedSdk?: PiSdk, launchOptions: { mode?: Goal["mode"]; goal?: string } = {}): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousSkip = process.env.PI_SKIP_VERSION_CHECK;
  process.env.PI_CODING_AGENT_DIR = paths.agent;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  try {
    const sdk = suppliedSdk ?? await loadPi(paths);
    const usage = await createUsageTracker(paths);
    const runtime = await createTutorRuntime(paths, bridge, sdk, { ...launchOptions, guidedStart: true, usage });
    try { await usage.start(); await new sdk.InteractiveMode(runtime, { verbose: false }).run(); }
    finally { try { await usage.stop(); } finally { await runtime.dispose(); } }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousSkip;
  }
}
