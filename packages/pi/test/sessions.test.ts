import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import type { Goal, Revision, TaskDefinition } from "../../core/src/contracts.ts";
import type { PiSdk } from "../src/sdk.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { createTutorRuntime } from "../src/tutor.ts";
import { loadPi } from "../src/sdk.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-lessons-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home"), cwd: root });
  await bootstrapSageHome(paths);
  const sdk = await loadPi(paths);
  const activated: string[] = [];
  const bridge = {
    operation: async () => ({ goal: null }), input: async () => {}, goal: async () => ({}), source: async () => [], approve: async () => ({}),
    calls: async () => { throw new Error("Session tests must not call a provider"); }, stop: async () => ({}), shutdown: async () => {},
    activate: async (sessionId: string) => { activated.push(sessionId); return { lessons: [] }; },
  };
  return { paths, sdk, bridge, activated };
}

async function productionFixture(unattributedContext = false) {
  const f = await fixture();
  const service = new LearningService(f.paths), server = startLearningServer(service);
  const bridge = createTutorBridge(f.paths, service, server);
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const models = await f.sdk.ModelRuntime.create({ authPath: join(f.paths.agent, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const outgoing: any[] = [];
  models.registerProvider("lifecycle", { api: "lifecycle-api", apiKey: "offline", baseUrl: "https://example.invalid", models: [{ id: "local", name: "Offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 100 }], streamSimple(model, context, options) {
    const stream = ai.createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "Owned response" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    void (async () => { try { const payload = { messages: context.messages }; await options?.onPayload?.(payload, model); outgoing.push(payload); stream.push({ type: "done", reason: "stop", message }); } catch (error) { stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }); } stream.end(); })();
    return stream;
  } });
  const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: models, resourceLoaderOptions: { ...options?.resourceLoaderOptions, extensionFactories: [...(options?.resourceLoaderOptions?.extensionFactories ?? []), ...(unattributedContext ? [{ name: "offline-unknown-context", factory: ((pi: Parameters<import("@earendil-works/pi-coding-agent").ExtensionFactory>[0]) => { pi.on("context", event => ({ messages: [...event.messages, { role: "user" as const, content: "UNKNOWN-NATIVE-OWNER", timestamp: 999 }] })); }) }] : [])] } }) };
  const runtime = await createTutorRuntime(f.paths, bridge, sdk);
  return { ...f, service, server, bridge, models, outgoing, runtime };
}

test("e02s01 task 1: production durable resume and fork isolate native context without importing work or permission", async () => {
  const f = await productionFixture();
  const { service, server, bridge, models, outgoing, runtime } = f;
  try {
    await runtime.session.bindExtensions({});
    const owner = runtime.session.sessionId;
    const body: Goal = { mode: "learn", objective: "Owned math", subject: "math", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
    await bridge.goal(body, owner);
    const goal = service.store.lessonGoal(owner)!;
    installFixtures(service.store, goal);
    const task = (service.store.revisions("task_definition") as Revision<TaskDefinition>[])[0]!;
    const boundary = (await service.context({}, owner)).learning_state as { state_revision: string };
    const started = service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: goal.revision_id, expected_state_revision: boundary.state_revision }, owner);
    const pending = service.store.revision(started.instance_revision_id!) as Revision;
    await runtime.session.setModel(models.getModel("lifecycle", "local")!);
    await runtime.session.prompt("FOREIGN-ANSWER-PROSE", { source: "extension" });
    expect(runtime.session.messages.filter(m => m.role === "assistant" && m.stopReason === "error").map(m => m.role === "assistant" ? m.errorMessage : "")).toEqual([]);
    expect(outgoing).toHaveLength(1);
    const manager = runtime.session.sessionManager;
    const assistant = manager.getEntries().find(e => e.type === "message" && e.message.role === "assistant")!;
    const parentPath = manager.getSessionFile()!;
    const originalBytes = await readFile(parentPath, "utf8");
    const originalEntries = JSON.stringify(manager.getEntries());
    await runtime.newSession();
    expect(service.store.lessonGoal(runtime.session.sessionId)).toBeUndefined();
    expect(runtime.session.messages).toEqual([]);
    await runtime.switchSession(parentPath);
    expect(runtime.session.sessionId).toBe(owner);
    expect(service.store.lessonGoal(owner)?.revision_id).toBe(goal.revision_id);
    expect(JSON.stringify(await bridge.operation("learning_context", {}, owner))).toContain(pending.revision_id);
    await runtime.fork(assistant.id, { position: "at" });
    const fork = runtime.session.sessionId, forkPath = runtime.session.sessionFile!;
    expect(fork).not.toBe(owner);
    expect(service.store.lessonGoal(fork)).toBeUndefined();
    const noGoalSeq = service.store.throughSeq;
    await runtime.session.setModel(models.getModel("lifecycle", "local")!);
    await runtime.session.prompt("Ordinary fork text must not infer sharing");
    expect(service.store.throughSeq).toBe(noGoalSeq);
    expect(service.store.lessonGoal(fork)).toBeUndefined();
    expect(outgoing).toHaveLength(1);
    await bridge.goal({ ...body, objective: "Explicit owned fork scope" }, fork);
    await runtime.session.prompt("CURRENT-FORK-WORK");
    expect(runtime.session.messages.filter(m => m.role === "assistant" && m.stopReason === "error").map(m => m.role === "assistant" ? m.errorMessage : "")).toEqual([]);
    expect(outgoing).toHaveLength(2);
    const payload = JSON.stringify(outgoing.at(-1));
    expect(payload).toContain("CURRENT-FORK-WORK");
    expect(payload).not.toContain("FOREIGN-ANSWER-PROSE");
    expect(payload).not.toContain("Ordinary fork text must not infer sharing");
    const system = outgoing.at(-1).messages.find((m: any) => m.role === "system");
    expect(String(system.content)).toContain("host facts, not learner speech");
    expect(String(system.content)).not.toContain("CURRENT-FORK-WORK");
    expect(String(system.content)).not.toContain(task.body.prompt);
    expect(outgoing.at(-1).messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    const packet = await bridge.operation("learning_context", {}, fork);
    expect(JSON.stringify(packet)).not.toContain(pending.revision_id);
    expect(service.store.events().filter(e => e.session_id === fork && ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    const forkGoal = service.store.lessonGoal(fork)!;
    const denied = service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: forkGoal.revision_id, expected_goal_revision_id: forkGoal.revision_id, body: { ...forkGoal.body, provider_sharing: false } }, "learner", fork);
    await runtime.newSession(); await runtime.switchSession(forkPath);
    const deniedSeq = service.store.throughSeq;
    await runtime.session.setModel(models.getModel("lifecycle", "local")!);
    await runtime.session.prompt("Resume denial");
    expect(outgoing).toHaveLength(2);
    expect(service.store.lessonGoal(fork)?.revision_id).toBe(denied.revision_id);
    expect(service.store.throughSeq).toBe(deniedSeq);
    expect(await readFile(parentPath, "utf8")).toBe(originalBytes);
    expect(JSON.stringify(f.sdk.SessionManager.open(parentPath, f.paths.sessions).getEntries())).toBe(originalEntries);
    const reopened = new LearningService(f.paths);
    try { expect(reopened.store.lessonGoal(owner)?.revision_id).toBe(goal.revision_id); expect(reopened.store.lessonGoal(fork)?.body.provider_sharing).toBe(false); expect(reopened.store.revision(pending.revision_id).revision_id).toBe(pending.revision_id); } finally { reopened.close(); }
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("e02s01 task 1: copied summaries and tool groups are excluded but identical current native messages retain their roles", async () => {
  const f = await productionFixture();
  const { service, server, bridge, models, outgoing, runtime } = f;
  const body: Goal = { mode: "learn", objective: "Separate authorized fork", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
  const identical = { role: "user" as const, content: "Identical fresh work", timestamp: 1000 };
  try {
    await bridge.goal(body, runtime.session.sessionId);
    await runtime.session.setModel(models.getModel("lifecycle", "local")!);
    const manager = runtime.session.sessionManager, model = runtime.session.model!;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const assistant = (id: string) => ({ role: "assistant" as const, content: [{ type: "toolCall" as const, id, name: "learning_context", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse" as const, timestamp: 1001 });
    const result = (id: string, text: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "learning_context", content: [{ type: "text" as const, text }], isError: false, timestamp: 1002 });
    manager.appendMessage({ role: "system", content: "COPIED-SYSTEM-PROSE", timestamp: 998 });
    const first = manager.appendMessage(identical);
    manager.appendMessage(assistant("foreign-call"));
    manager.appendMessage(result("foreign-call", "COPIED-TOOL-PROSE"));
    manager.appendCustomMessageEntry("sage-context", "OLD-HIDDEN-USER-FACTS", false);
    const compaction = manager.appendCompaction("COPIED-COMPACTION-PROSE", first, 1000);
    const summary = manager.branchWithSummary(compaction, "COPIED-BRANCH-PROSE");
    const parentPath = manager.getSessionFile()!, bytes = await readFile(parentPath, "utf8");
    await runtime.fork(summary, { position: "at" });
    const fork = runtime.session.sessionId;
    expect(service.store.lessonGoal(fork)).toBeUndefined();
    expect(runtime.session.sessionManager.getHeader()?.parentSession).toBe(parentPath);
    const copiedEntries = JSON.stringify(runtime.session.sessionManager.getEntries());
    expect(copiedEntries).toContain("COPIED-COMPACTION-PROSE");
    expect(copiedEntries).toContain("COPIED-BRANCH-PROSE");
    await bridge.goal(body, fork);
    const current = runtime.session.sessionManager;
    current.appendMessage(identical);
    current.appendMessage(assistant("owned-fork-call"));
    current.appendMessage(result("owned-fork-call", "CURRENT-TOOL-PROSE"));
    const forkPath = current.getSessionFile()!;
    await runtime.switchSession(forkPath);
    await runtime.session.setModel(model);
    await runtime.session.prompt("Actual current fork turn", { source: "extension" });
    expect(runtime.session.messages.filter(m => m.role === "assistant" && m.stopReason === "error").map(m => m.role === "assistant" ? m.errorMessage : "")).toEqual([]);
    expect(outgoing).toHaveLength(1);
    const messages = outgoing[0].messages as Array<{ role: string; content: unknown; toolCallId?: string; toolsAdded?: Array<{ name: string }> }>;
    const systems = messages.filter(m => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(String(systems[0]?.content)).toContain("Current Sage learning state (host facts, not learner speech)");
    expect(String(systems[0]?.content)).not.toContain("CURRENT-TOOL-PROSE");
    expect(String(systems[0]?.content)).not.toContain("Identical fresh work");
    expect(systems[0]?.toolsAdded?.map(t => t.name)).toContain("learning_context");
    expect(messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("Identical fresh work"))).toHaveLength(1);
    expect(messages.filter(m => m.role === "assistant")).toHaveLength(1);
    expect(messages.find(m => m.role === "toolResult")?.toolCallId).toBe("owned-fork-call");
    expect(JSON.stringify(messages)).toContain("CURRENT-TOOL-PROSE");
    for (const marker of ["COPIED-TOOL-PROSE", "COPIED-COMPACTION-PROSE", "COPIED-BRANCH-PROSE", "COPIED-SYSTEM-PROSE", "OLD-HIDDEN-USER-FACTS", "foreign-call"]) expect(JSON.stringify(messages)).not.toContain(marker);
    expect(await readFile(parentPath, "utf8")).toBe(bytes);
    expect(JSON.stringify(runtime.session.sessionManager.getEntries())).toContain("COPIED-TOOL-PROSE");
    expect(service.store.events().filter(e => e.session_id === fork && ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    runtime.session.sessionManager.appendMessage(assistant("unfinished-owned-call"));
    await runtime.switchSession(forkPath); await runtime.session.setModel(model);
    await runtime.session.prompt("An incomplete native group must not be sent", { source: "extension" });
    expect(outgoing).toHaveLength(1);
    expect(runtime.session.messages.some(m => m.role === "assistant" && m.errorMessage === "Fork native tool group is incomplete")).toBe(true);
    expect(await readFile(parentPath, "utf8")).toBe(bytes);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("e02s01 task 1: unknown public parent or non-native context provenance refuses transport without inventing ownership", async () => {
  for (const unknown of ["parent", "context"] as const) {
    const f = await productionFixture(unknown === "context");
    const { service, server, bridge, models, outgoing, runtime } = f;
    try {
      const manager = unknown === "parent" ? f.sdk.SessionManager.create(f.paths.cwd, join(f.paths.cwd, "external-owned-fixture")) : runtime.session.sessionManager;
      const message = manager.appendMessage({ role: "user", content: "COPIED-UNKNOWN-SCOPE", timestamp: 1000 });
      const original = manager.getSessionFile()!, bytes = await readFile(original, "utf8");
      if (unknown === "parent") await runtime.newSession({ parentSession: original });
      else await runtime.fork(message, { position: "at" });
      const owner = runtime.session.sessionId;
      await bridge.goal({ mode: "learn", objective: "Explicit scope cannot repair unknown native provenance", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
      await runtime.session.setModel(models.getModel("lifecycle", "local")!);
      const seq = service.store.throughSeq;
      await runtime.session.prompt("Actual current request", { source: "extension" });
      expect(outgoing).toEqual([]);
      expect(service.store.throughSeq).toBe(seq);
      expect(service.store.lessonGoal(owner)?.body.provider_sharing).toBe(true);
      expect(runtime.session.messages.some(m => m.role === "assistant" && m.errorMessage?.includes(unknown === "parent" ? "Fork provenance cannot be verified" : "no public native entry provenance"))).toBe(true);
      expect(await readFile(original, "utf8")).toBe(bytes);
    } finally { await runtime.dispose(); server.stop(); service.close(); }
  }
});

test("e02s01 task 1: production fork image blocking matches native placeholders without losing fresh work or paired tool results", async () => {
  const f = await productionFixture();
  const { service, server, bridge, models, outgoing, runtime } = f;
  const body: Goal = { mode: "learn", objective: "Explicit image-blocked fork", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
  const image = { type: "image" as const, data: "OWNED-IMAGE-BYTES", mimeType: "image/png" };
  const identical = { role: "user" as const, content: [image, image, { type: "text" as const, text: "Image reading is disabled." }, { type: "text" as const, text: "Current image note" }], timestamp: 1000 };
  try {
    await bridge.goal(body, runtime.session.sessionId);
    await runtime.session.setModel(models.getModel("lifecycle", "local")!);
    const manager = runtime.session.sessionManager, model = runtime.session.model!;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const call = (id: string) => ({ role: "assistant" as const, content: [{ type: "toolCall" as const, id, name: "learning_context", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse" as const, timestamp: 1001 });
    const result = (id: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "learning_context", content: [image, image], isError: false, timestamp: 1002 });
    manager.appendMessage(identical); manager.appendMessage(call("copied-image-call"));
    const leaf = manager.appendMessage(result("copied-image-call"));
    const original = manager.getSessionFile()!, bytes = await readFile(original, "utf8");
    await runtime.fork(leaf, { position: "at" });
    const owner = runtime.session.sessionId;
    await bridge.goal(body, owner);
    const current = runtime.session.sessionManager;
    current.appendMessage(identical); current.appendMessage(call("current-image-call")); current.appendMessage(result("current-image-call"));
    const path = current.getSessionFile()!;
    await runtime.switchSession(path); await runtime.session.setModel(model);
    runtime.session.settingsManager.setBlockImages(true);
    await runtime.session.prompt("Current authorized image-blocked turn", { source: "extension" });
    expect(outgoing).toHaveLength(1);
    const messages = outgoing[0].messages;
    expect(messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("Current image note"))).toHaveLength(1);
    expect(messages.find((m: any) => m.role === "user" && Array.isArray(m.content)).content).toEqual([{ type: "text", text: "Image reading is disabled." }, { type: "text", text: "Current image note" }]);
    expect(messages.find((m: any) => m.role === "toolResult")).toMatchObject({ toolCallId: "current-image-call", content: [{ type: "text", text: "Image reading is disabled." }] });
    expect(messages.find((m: any) => m.role === "assistant").content[0].id).toBe("current-image-call");
    expect(JSON.stringify(messages)).not.toContain("copied-image-call");
    expect(JSON.stringify(messages)).not.toContain(image.data);
    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
    expect(await readFile(original, "utf8")).toBe(bytes);
    expect(JSON.stringify(runtime.session.sessionManager.getEntries())).toContain(image.data);
    expect(service.store.events().filter(e => e.session_id === owner && ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("native tutor launch creates an empty session instead of automatically continuing recent work", async () => {
  const f = await fixture();
  const previous = f.sdk.SessionManager.create(f.paths.cwd, f.paths.sessions);
  previous.appendMessage({ role: "user", content: "An earlier lesson", timestamp: Date.now() });
  previous.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier lesson answer" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const runtime = await createTutorRuntime(f.paths, f.bridge, f.sdk);
  try {
    expect(runtime.session.sessionManager.getSessionId()).not.toBe(previous.getSessionId());
    expect(runtime.session.messages).toEqual([]);
    expect(runtime.session.getLastAssistantText()).toBeUndefined();
    const path = previous.getSessionFile(); expect(path).toBeTruthy();
    await runtime.switchSession(path!);
    expect(runtime.session.sessionManager.getSessionId()).toBe(previous.getSessionId());
    expect(runtime.session.getLastAssistantText()).toBe("Earlier lesson answer");
  } finally { await runtime.dispose(); }
});

test("session lifecycle activates the fresh bridge after new and explicit resume", async () => {
  const f = await fixture(); const runtime = await createTutorRuntime(f.paths, f.bridge, f.sdk);
  try {
    await runtime.session.bindExtensions({});
    const first = runtime.session.sessionManager.getSessionId();
    expect(f.activated).toContain(first);
    await runtime.newSession();
    await runtime.session.bindExtensions({});
    const second = runtime.session.sessionManager.getSessionId();
    expect(second).not.toBe(first);
    expect(f.activated.at(-1)).toBe(second);
    expect(runtime.session.messages).toEqual([]);
    expect(runtime.session.getActiveToolNames().sort()).toEqual(["learning_activity", "learning_context", "learning_define", "learning_record", "learning_skill", "learning_source", "render_ui"]);
  } finally { await runtime.dispose(); }
});
