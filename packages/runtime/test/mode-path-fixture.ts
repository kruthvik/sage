import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionToolContext, ExtensionCommandContext, RegisteredCommand, ToolDefinition, InputEvent } from "@earendil-works/pi-coding-agent";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { createTutorExtension } from "../../pi/src/tutor.ts";
import type { Assessment, Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { profilePreferences } from "../../core/src/experience.ts";

// Only native UI/registration are simulated; context, tools, input and ledger use the owned HTTP service.
export async function modePath(run: (f: {
  service: LearningService; notices: string[]; messages: string[]; nativeUi(overrides: Record<string, unknown>): void; command(name: string, args: string): Promise<void>;
  context(): Promise<Record<string, unknown>>; input(text: string): Promise<void>; reopen(): Promise<void>; tool(name: string, body: unknown): Promise<Record<string, unknown>>; task(prompt: string, extra?: Partial<TaskDefinition>, guided?: boolean): TaskDefinition & { revision_id: string };
  work(taskId: string, text: string, scores: Array<{ dimension: string; score: number; evidence: string }>, assisted?: boolean, outcome?: Assessment["outcome"], componentOutcomes?: Assessment["component_outcomes"], claims?: Assessment["claims"]): Promise<Record<string, unknown>>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sage-mode-path-")), paths = createSagePaths({ home: root });
  await bootstrapSageHome(paths);
  let service = new LearningService(paths); service.activateSession("modes");
  let server = startLearningServer(service), bridge = createTutorBridge(paths, service, server);
  try {
    const commands = new Map<string, RegisteredCommand>(), tools = new Map<string, ToolDefinition>(), hooks = new Map<string, (e: InputEvent, c: ExtensionToolContext) => Promise<unknown>>(), notices: string[] = [], messages: string[] = [];
    const ctx = { hasUI: true, isIdle: () => true, abort() {}, model: { id: "offline", provider: "offline", input: ["text"] }, sessionManager: { getSessionId: () => "modes" }, ui: { notify: (s: string) => notices.push(s), setStatus() {}, setWidget() {}, select: async () => "Continue", confirm: async () => true, input() { throw new Error("No required questionnaire"); } } } as unknown as ExtensionToolContext;
    const register = () => createTutorExtension(bridge)({ registerCommand: (n: string, c: RegisteredCommand) => commands.set(n, c), registerTool: (t: ToolDefinition) => tools.set(t.name, t), on: (n: string, h: (e: InputEvent, c: ExtensionToolContext) => Promise<unknown>) => hooks.set(n, h), sendUserMessage: (text: string) => messages.push(text) } as unknown as ExtensionAPI);
    register();
    const tool = async (name: string, body: unknown) => {
      const result = await tools.get(name)!.execute(randomUUID(), body, undefined, undefined, ctx);
      return JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
    };
    const define = (kind: string, body: unknown) => service.store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: service.store.lessonGoal("modes")!.revision_id, body }, "human", "modes");
    const seed: Goal = { mode: "learn", objective: "Solve and explain proportional change", subject: "math", horizon_days: 2, deadline: new Date(Date.now() + 86400000).toISOString(), budget_minutes: 20, target_format: "open response", criteria: ["Solve", "Explain the invariant"], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [], learning_preferences: profilePreferences("balanced") };
    await bridge.goal(seed, "modes");
    const component = define("component", { title: seed.objective, behavior: seed.objective, subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], target_dimensions: ["execution", "explanation"], uncertainty: "Owned uncalibrated fixture" });
    const rubric = define("rubric", { title: "Original demand", dimensions: [{ name: "solve", criterion: "Solve proportional change", max_score: 85 }, { name: "reason", criterion: "Explain the invariant", max_score: 15 }], provisional: false, source_span_ids: [] });
    const family = define("task_family", { title: "Ratios", construct: seed.objective, variation: "Interpret relations", lineage_revision_ids: [], structural_signature: "ratios:v1" });
    await run({ get service() { return service; }, notices, messages, nativeUi: overrides => { Object.assign(ctx.ui, overrides); },
      command: async (name, args) => { const c = commands.get(name); if (!c) throw new Error(`Unregistered mode control: ${name}`); await c.handler(args, ctx as unknown as ExtensionCommandContext); },
      context: () => service.context({}, "modes"), input: async text => { await hooks.get("input")!({ type: "input", source: "interactive", text }, ctx); }, tool,
      reopen: async () => { server.stop(); service.close(); service = new LearningService(paths); service.activateSession("modes"); server = startLearningServer(service); bridge = createTutorBridge(paths, service, server); register(); },
      task: (prompt, extra = {}, guided = false) => {
        const instruction = guided ? define("artifact", { capability: "teaching", goal_revision_id: service.store.lessonGoal("modes")!.revision_id, author: "tutor", provenance: "Reviewed synthetic guided-practice fixture", media_type: "text/plain", content: "Compare ratios in consistent units. Example: doubling both quantities preserves their ratio; now explain the changed relation.", evidence_kind: "artifact_only", interpretation_uncertainty: "Not calibrated", assistance_event_ids: [] }) : null;
        const revision = define("task_definition", { title: prompt, prompt, component_revision_ids: [component.revision_id], family_revision_id: family.revision_id, rubric_revision_id: rubric.revision_id, source_span_ids: [], format: "free_response", allowed_aids: [], steps: [], scoring: "rubric", status: "practice_ready", review: { method: "curated", reason: "Owned software fixture, not calibration" }, stakes: "low", partition: "practice", changes: [], uncertainty: "Uncalibrated", representation: "symbolic", ...extra, ...(instruction ? { artifact_revision_ids: [instruction.revision_id] } : {}) }); return { ...revision.body, revision_id: revision.revision_id } as unknown as TaskDefinition & { revision_id: string }; },
      work: async (taskId, text, scores, assisted = false, outcome, componentOutcomes, claims) => {
        const goal = service.store.lessonGoal("modes")!;
        const definition = service.store.revision<TaskDefinition>(taskId, "task_definition");
        const state = (await service.context({}, "modes")).learning_state as { state_revision: string; pending_count: number; current_task?: { definition_revision_id: string; instance_revision_id: string } };
        const selection = (await service.context({}, "modes")).next_task_selection as { definition_revision_id: string; purpose: string } | null;
        if (!state.pending_count && selection?.definition_revision_id === taskId && selection.purpose === "practice" && definition.body.artifact_revision_ids?.length) {
          await tool("learning_activity", { action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: goal.revision_id, unit_id: randomUUID(), component_revision_id: definition.body.component_revision_ids[0], definition_revision_id: taskId, instruction_revision_id: definition.body.artifact_revision_ids[0] });
          const released = (await service.context({}, "modes")).learning_state as typeof state;
          Object.assign(state, released);
        }
        let instance: { revision_id: unknown };
        if (state.pending_count && state.current_task?.definition_revision_id === taskId) instance = service.store.revision(state.current_task.instance_revision_id, "task_instance");
        else if (goal.body.mode === "learn") {
          const released = service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, acknowledge_gaps: true, definition_revision_id: taskId, expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision }, "modes");
          const question = released.teaching_request ? await (await service.offerTeaching(released.teaching_request, "modes")).continue() : released;
          if (!question.instance_revision_id) throw new Error("Native fixture did not release a question");
          instance = { revision_id: question.instance_revision_id };
        } else instance = await tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision, body: { definition_revision_id: taskId, goal_revision_id: goal.revision_id, purpose: definition.body.variation ? "application" : "independent", conditions: ["Declared exam aids only"] } }) as { revision_id: unknown };
        if (assisted) service.store.record({ operation_id: randomUUID(), kind: "assistance", expected_goal_revision_id: goal.revision_id, payload: { assistance_id: randomUUID(), instance_revision_id: instance.revision_id, kind: "hint", component_revision_ids: definition.body.component_revision_ids, answer_bearing: true, content: "Use the ratio invariant", stage: "exposed" } }, "modes");
        await hooks.get("input")!({ type: "input", source: "interactive", text }, ctx);
        const response = service.store.events().filter(e => e.kind === "learner_response" && e.payload.text === text).at(-1)!;
        const attemptId = randomUUID();
        await tool("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attemptId, instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] } });
        return tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attemptId, rubric_revision_id: definition.body.rubric_revision_id, outcome: outcome ?? (service.store.revision<{ dimensions: Array<{ name: string; max_score: number }> }>(definition.body.rubric_revision_id, "rubric").body.dimensions.every(d => scores.some(s => s.dimension === d.name && s.score === d.max_score)) ? "success" : "partial"), scores, feedback: "Check the invariant against your work.", uncertainty: "Semantic rubric proposal, not calibrated", claims: claims ?? definition.body.component_revision_ids.flatMap(id => [{ component_revision_id: id, dimension: "execution", outcome: scores.some(s => s.dimension === "solve" && s.score > 0) ? "success" : "failure", evidence: text }, { component_revision_id: id, dimension: "explanation", outcome: scores.some(s => s.dimension === "reason") ? scores.some(s => s.dimension === "reason" && s.score > 0) ? "success" : "failure" : "not_observed", evidence: text }]), ...(componentOutcomes ? { component_outcomes: componentOutcomes } : {}), feedback_review: { issues: [], ready_to_continue: true } } });
      },
    });
  } finally { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); }
}
