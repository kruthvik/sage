import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Artifact, Goal } from "../../core/src/contracts.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { projectLearningState } from "../../runtime/src/learning-state.ts";
import { createTutorExtension } from "../src/tutor.ts";
import { loadPi } from "../src/sdk.ts";
import { diagramWithPi } from "../src/diagram.ts";
const roots: string[] = [], services: LearningService[] = [], servers: ReturnType<typeof startLearningServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const instruction = "A line has constant slope. Slope is change in y divided by change in x. A positive slope rises.";
const sample = { title: "Slope relationships", nodes: [{ id: "constant", label: "constant slope", quote: "A line has constant slope." }, { id: "ratio", label: "change ratio", quote: "Slope is change in y divided by change in x." }], edges: [{ from: "constant", to: "ratio", label: "measured as", quote: "Slope is change in y divided by change in x." }], explanation: "Use the ratio to interpret the rate of change." };
async function fixture(mode = "learn", sharing = true, presented = true) {
  const root = await mkdtemp(join(tmpdir(), "sage-instruction-diagram-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home"), cwd: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service); service.activateSession("diagram");
  const defined = service.store.define({ operation_id: "goal", kind: "goal", body: { mode, objective: "Understand slopes", subject: "math", horizon_days: 30, deadline: "2027-01-01T12:00:00.000Z", target_format: "explanation", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: sharing, source_ids: [] } }, "learner", "diagram");
  const goal = service.store.revision<Goal>(defined.revision_id, "goal"), base = installFixtures(service.store, goal)[0]!;
  const define = (operation_id: string, kind: string, body: unknown) => service.store.define({ operation_id, kind, expected_goal_revision_id: goal.revision_id, body }, "human", "diagram");
  const original = define("instruction", "artifact", { capability: "teaching_instruction", goal_revision_id: goal.revision_id, author: "tutor", provenance: "Owned offline instruction", media_type: "text/plain", content: instruction, evidence_kind: "artifact_only", interpretation_uncertainty: "Software fixture, not teaching validation", assistance_event_ids: [] });
  const task = define("definition", "task_definition", { ...base.body, prompt: "FORBIDDEN_ASSESSMENT_PROMPT", answer: "938271", artifact_revision_ids: [original.revision_id] });
  const annotation = { schema_version: 1, unit_id: "unit", stage: "prepared", goal_revision_id: goal.revision_id, component_revision_id: base.body.component_revision_ids[0], instruction_revision_id: original.revision_id, definition_revision_id: task.revision_id };
  if (["learn", "accelerate"].includes(mode) && sharing) {
    const prepared = service.store.append("decision", { action: "teaching_stage", reason: "Owned fixture", evidence_event_ids: [], teaching: annotation }, "prepared", "host", "diagram");
    if (presented) service.store.append("decision", { action: "teaching_stage", reason: "Owned fixture", evidence_event_ids: [], teaching: { ...annotation, stage: "presented", prepared_event_id: prepared.event_id } }, "presented", "host", "diagram");
  }
  const privateNote = define("private-journal", "artifact", { capability: "study_journal", goal_revision_id: goal.revision_id, author: "tutor", provenance: "Private fixture", media_type: "text/plain", content: "PRIVATE_JOURNAL_SENTINEL", evidence_kind: "artifact_only", interpretation_uncertainty: "Not performance", assistance_event_ids: [] });
  const server = startLearningServer(service); servers.push(server); const bridge = createTutorBridge(paths, service, server), tools = new Map<string, ToolDefinition>();
  const calls: Array<{ instruction_revision_id: string; instruction: string }> = []; let proposal = structuredClone(sample), during: (() => void) | undefined;
  const options = { skills: () => [], diagram: async (brief: { instruction_revision_id: string; instruction: string }) => { calls.push(brief); during?.(); return proposal; } };
  const api = { registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, sendUserMessage() { throw new Error("No orchestration message is needed"); } } as unknown as ExtensionAPI;
  createTutorExtension(bridge, options)(api);
  const screens: string[] = []; let continueNow = false;
  const ctx = { hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "diagram" }, ui: { notify() {}, select: async (title: string) => { screens.push(title); return continueNow ? "Continue" : "Not now"; } } } as unknown as ExtensionToolContext;
  const request = { action: "drawing", operation_id: "diagram-1", expected_goal_revision_id: goal.revision_id, artifact_revision_id: original.revision_id };
  const run = async (body: unknown = request) => tools.get("learning_source")!.execute("call", body, undefined, undefined, ctx);
  const runTeaching = () => tools.get("learning_activity")!.execute("teaching", { action: "teaching", operation_id: "teaching-1", expected_goal_revision_id: goal.revision_id, unit_id: "unit", component_revision_id: annotation.component_revision_id, instruction_revision_id: original.revision_id, definition_revision_id: task.revision_id, diagram: true }, undefined, undefined, ctx);
  return { root, paths, service, goal, original, privateNote, task, annotation, request, calls, run, tools, define, runTeaching, screens, continueNow() { continueNow = true; },
    proposal: () => proposal, during(callback: () => void) { during = callback; },
    artifacts: () => service.store.revisions("artifact").filter(r => r.body.capability === "instruction_diagram"),
  };
}

test("protected diagram derives only from current instruction, displays natively and replays without another child", async () => {
  const f = await fixture(); const before = f.service.store.events().filter(e => e.kind !== "decision");
  const first = await f.run(), data = JSON.parse(first.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
  expect(f.calls).toEqual([{ instruction_revision_id: f.original.revision_id, instruction }]);
  const childInput = JSON.stringify(f.calls); for (const secret of ["PRIVATE_JOURNAL_SENTINEL", "FORBIDDEN_ASSESSMENT_PROMPT", "938271"]) expect(childInput).not.toContain(secret);
  expect(f.artifacts()).toHaveLength(1); expect(data.native_preview).toBe(true); expect(data.diagram).toEqual(sample);
  const tool = f.tools.get("learning_source")!, theme = { fg: (_color: string, text: string) => text } as Theme;
  type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
  const visible = tool.renderResult!(first, { expanded: false, isPartial: false }, theme, { isError: false } as RenderContext).render(80).join("\n");
  expect(visible).toContain("AI instruction diagram"); expect(visible).toContain("constant slope"); expect(visible).toContain("measured as"); expect(visible).toContain("not learner performance"); expect(visible).not.toContain("<svg");
  const again = await f.run(); expect(JSON.parse(again.content.filter(c => c.type === "text").map(c => c.text).join("\n")).artifact_revision_id).toBe(data.artifact_revision_id);
  expect(f.calls).toHaveLength(1); expect(f.artifacts()).toHaveLength(1);
  expect(f.service.store.events().filter(e => e.kind !== "decision")).toEqual(before);
  expect(projectLearningState(f.service.store, "diagram")).toMatchObject({ phase: "question_pending", teaching: { instance_revision_id: null } });
});

for (const mode of ["exam", "cram", "drill"]) test(`instruction diagram refuses ${mode} before generation`, async () => {
  const f = await fixture(mode); await expect(f.run()).rejects.toThrow(/diagram|instruction|scope|goal|mode/i); expect(f.calls).toHaveLength(0); expect(f.artifacts()).toHaveLength(0);
});
for (const condition of ["sharing", "stopped", "journal", "foreign_goal", "ambiguous_input", "pending_question"] as const) test(`instruction diagram refuses ${condition} without dispatch`, async () => {
  const f = await fixture("learn", condition !== "sharing"); let request: unknown = f.request;
  if (condition === "stopped") f.service.store.record({ operation_id: "stop", kind: "checkpoint", expected_goal_revision_id: f.goal.revision_id, payload: { goal_revision_id: f.goal.revision_id, summary: "Paused", next_action: "Resume current work", gaps: [], stopped: true } }, "diagram");
  if (condition === "journal") request = { ...f.request, artifact_revision_id: f.privateNote.revision_id };
  if (condition === "foreign_goal") request = { ...f.request, expected_goal_revision_id: "foreign" };
  if (condition === "ambiguous_input") request = { ...f.request, input: "PRIVATE_RAW_INPUT" };
  if (condition === "pending_question") f.define("instance", "task_instance", { definition_revision_id: f.task.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: ["No aids"] });
  await expect(f.run(request)).rejects.toThrow(/diagram|instruction|scope|goal|sharing|disclosure/i); expect(f.calls).toHaveLength(0); expect(f.artifacts()).toHaveLength(0);
});
for (const bad of ["quote", "reference", "duplicate", "terminal_control", "stale_reply", "mutable_brief"] as const) test(`instruction diagram rejects ${bad} before publication`, async () => {
  const f = await fixture(), proposal = f.proposal();
  if (bad === "quote") proposal.edges[0]!.quote = "Not in the instruction";
  if (bad === "reference") proposal.edges[0]!.to = "missing";
  if (bad === "duplicate") proposal.nodes[1]!.id = proposal.nodes[0]!.id;
  if (bad === "terminal_control") proposal.title = "\u001b]52;c;unsafe\u0007";
  if (bad === "mutable_brief") f.during(() => { f.calls[0]!.instruction = "INJECTED_OUTSIDE_FACT"; for (const item of [...proposal.nodes, ...proposal.edges]) item.quote = "INJECTED_OUTSIDE_FACT"; });
  if (bad === "stale_reply") f.during(() => f.service.store.define({ operation_id: "changed-goal", kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Changed scope" } }, "learner", "diagram"));
  await expect(f.run()).rejects.toThrow(/diagram|proposal|quote|scope|goal/i); expect(f.calls).toHaveLength(1); expect(f.artifacts()).toHaveLength(0);
});

test("real native teaching can include a diagram without stale Continue or automatic question release", async () => {
  const f = await fixture("accelerate", true, false);
  expect(projectLearningState(f.service.store, "diagram").phase).toBe("instruction_pending");
  const held = await f.runTeaching();
  const offered = JSON.parse(held.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
  expect(offered.diagram_offered).toBe(true);
  expect(offered.diagram_artifact_revision_id).toBe(f.artifacts()[0]!.revision_id);
  expect(f.screens.at(-1)).toContain("AI instruction diagram"); expect(f.screens.at(-1)).toContain(instruction);
  expect(f.calls).toHaveLength(1); expect(f.artifacts()).toHaveLength(1);
  expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(0);
  expect(projectLearningState(f.service.store, "diagram").phase).toBe("instruction_pending");
  f.continueNow(); const released = await f.runTeaching();
  expect(JSON.parse(released.content.filter(c => c.type === "text").map(c => c.text).join("\n")).diagram_offered).toBe(true);
  expect(f.calls).toHaveLength(1); expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
  expect(projectLearningState(f.service.store, "diagram").phase).toBe("awaiting_answer");
  expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toHaveLength(0);
});

test("unavailable diagram leaves native instruction intact and reports no offered aid or question release", async () => {
  const f = await fixture("learn", true, false); f.proposal().edges[0]!.quote = "UNSUPPORTED_QUOTE";
  const result = await f.runTeaching(), data = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
  expect(data.diagram_offered).toBe(false); expect(f.calls).toHaveLength(1); expect(f.artifacts()).toHaveLength(0);
  expect(f.screens.at(-1)).toContain(instruction); expect(f.screens.at(-1)).not.toContain("AI instruction diagram");
  expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(0);
});

test("instruction diagram artifact read is gated after question release and model cannot forge its capability", async () => {
  const f = await fixture(); await f.run(); const id = f.artifacts()[0]!.revision_id, artifact = f.service.store.revision<Artifact>(id, "artifact");
  await expect(f.service.operation("learning_define", { operation_id: "forged", kind: "artifact", expected_goal_revision_id: f.goal.revision_id, body: artifact.body }, "diagram")).rejects.toThrow(/diagram/i);
  f.define("instance", "task_instance", { definition_revision_id: f.task.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: ["No aids"] });
  await expect(f.service.operation("learning_source", { action: "artifact", artifact_revision_id: id }, "diagram")).rejects.toThrow(/diagram|instruction|pending/i);
  await expect(f.run()).rejects.toThrow(/diagram|instruction|pending/i); expect(f.calls).toHaveLength(1);
});

test("approved diagram policy pair uses the real isolated SDK, one scripted request and disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-diagram-sdk-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths); await mkdir(paths.config, { recursive: true });
  await writeFile(join(paths.config, "AGENTS.md"), "AMBIENT_UNAUTHORIZED");
  const sdk = await loadPi(paths), entry = import.meta.resolve("@earendil-works/pi-coding-agent"), manifest = await Bun.file(new URL("../package.json", entry)).json();
  const name = Object.keys(manifest.dependencies ?? {}).find(name => name.endsWith("/pi-ai")); if (!name) throw new Error("SDK AI dependency missing");
  const ai = await import(import.meta.resolve(name, fileURLToPath(entry)));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let calls = 0, disposed = 0, seen = "";
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=";
  runtime.registerProvider("diagram-offline", { api: "diagram-offline-api", baseUrl: "https://example.invalid", apiKey: "offline", models: [{ id: "diagram", name: "Scripted diagram", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }], streamSimple(model, context, options) {
    calls++; seen = JSON.stringify(context); expect(seen).not.toContain("AMBIENT_UNAUTHORIZED"); expect(options?.maxTokens).toBe(4096);
    const stream = ai.createAssistantMessageEventStream(), message = { role: "assistant" as const, content: [{ type: "text" as const, text: JSON.stringify(sample) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
    void (async () => { await options?.onPayload?.({ scripted: true }, model); await options?.onResponse?.({ status: 200, headers: {} }, model); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); })(); return stream;
  } });
  const supplied = { ...sdk, createAgentSession: async (...args: Parameters<typeof sdk.createAgentSession>) => { const result = await sdk.createAgentSession(...args), dispose = result.session.dispose.bind(result.session); result.session.dispose = () => { disposed++; return dispose(); }; return result; } };
  const diagram = await diagramWithPi(paths, { instruction_revision_id: "owned", instruction }, { sdk: supplied, modelRuntime: runtime, model: runtime.getModel("diagram-offline", "diagram")!, sessionId: "diagram", signal: new AbortController().signal, calls: async () => {}, authorize: async () => ({ session_id: "diagram", revision: "owned-scope", packet: { goal: { body: { provider_sharing: true } }, private_parent_fact: "OUTSIDE_PARENT_PACKET" }, images: [{ type: "image", data: image, mimeType: "image/png" }] }) });
  expect(diagram).toEqual(sample); expect(calls).toBe(1); expect(disposed).toBe(1);
  expect(seen).not.toContain(image); expect(seen).not.toContain("Authorized original images"); expect(seen).not.toContain("OUTSIDE_PARENT_PACKET");
});
