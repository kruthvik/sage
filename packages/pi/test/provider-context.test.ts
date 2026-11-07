import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPi } from "../src/sdk.ts";
import { guardModelRuntime, installDisclosureGate } from "../src/context.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import type { DisclosurePermit } from "../../runtime/src/disclosure.ts";
import type { PiSdk } from "../src/sdk.ts";
import type { Goal, Revision } from "../../core/src/contracts.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { createTutorRuntime } from "../src/tutor.ts";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const marker = "PRIVATE-SOURCE-MARKER";
async function fixture(config: { contextWindow?: number; maxTokens?: number; inputTokens?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sage-provider-scope-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const sdk = await loadPi(paths);
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const outgoing: unknown[] = [], providerEntries: unknown[] = [];
  let allowed = true, revision = "scope-1", beforePayload: (() => void | Promise<void>) | undefined;
  runtime.registerProvider("sage-recording", { api: "sage-recording-api", baseUrl: "https://example.invalid", apiKey: "offline", models: ["tutor", "switched"].map(id => ({ id, name: `Recording ${id}`, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: config.contextWindow ?? 32000, maxTokens: config.maxTokens ?? 2000 })), streamSimple(model, context, options) {
    providerEntries.push({ model: model.id, messages: context.messages });
    const stream = ai.createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "A scoped teaching response" }], api: model.api, provider: model.provider, model: model.id, usage: { input: config.inputTokens ?? 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: (config.inputTokens ?? 1) + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    void (async () => {
      try {
        await beforePayload?.();
        const payload = { model: model.id, messages: context.messages, transport: options?.transport, maxRetries: options?.maxRetries };
        const replacement = await options?.onPayload?.(payload, model);
        outgoing.push(replacement ?? payload);
        stream.push({ type: "done", reason: "stop", message });
      } catch (error) { stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: error instanceof Error ? error.message : "Denied" } }); }
      stream.end();
    })();
    return stream;
  } });
  const manager = sdk.SessionManager.create(paths.cwd, paths.sessions);
  manager.appendMessage({ role: "user", content: `${marker}: old copied source`, timestamp: Date.now() });
  manager.appendCustomMessageEntry("sage-context", `${marker}: old hidden packet`, false);
  manager.appendCompaction(`${marker}: old summary`, null, 1000);
  const originals = JSON.stringify(manager.getEntries());
  const settings = sdk.SettingsManager.inMemory({ enableInstallTelemetry: false, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
  const loader = new sdk.DefaultResourceLoader({ cwd: paths.config, agentDir: paths.agent, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Native trusted tutoring policy" }); await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: paths.cwd, agentDir: paths.agent, modelRuntime: guardModelRuntime(runtime), model: runtime.getModel("sage-recording", "tutor")!, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [], noTools: "all" });
  const authorize = async (): Promise<DisclosurePermit> => {
    if (!allowed) throw new Error("Disclosure authorization denied");
    return { session_id: manager.getSessionId(), revision, packet: { goal: { body: { provider_sharing: true, objective: "Current scoped objective" } }, latest_learner_response: { payload: { text: "Current actual learner work" } } } };
  };
  installDisclosureGate(session, authorize);
  return { paths, sdk, session, outgoing, providerEntries, manager, originals, runtime, authorize, revoke: () => { allowed = false; }, change: () => { revision = "scope-2"; }, queue: (fn: () => void | Promise<void>) => { beforePayload = fn; } };
}

test("public SDK learn requests expose the host job and phase-specific tools without changing seven-tool registration", async () => {
  const f = await fixture(); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service), bridge = createTutorBridge(f.paths, service, server);
  const runtime = await createTutorRuntime(f.paths, bridge, { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) });
  try {
    const owner = runtime.session.sessionId;
    await bridge.goal({ mode: "learn", objective: "Explain method selection under changing assumptions", subject: "practical", horizon_days: 2, target_format: "explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    const wire = () => (f.outgoing.at(-1) as { messages: Array<{ role: string; content?: unknown; toolsAdded?: Array<{ name: string; parameters: { properties?: { kind?: { const?: string } } } }> }> }).messages.find(message => message.role === "system")!;
    await runtime.session.prompt("Execute only the host job", { source: "extension" });
    expect(JSON.stringify(wire().content)).toContain("host_learn_step");
    expect(wire().toolsAdded?.find(tool => tool.name === "learning_define")?.parameters.properties?.kind?.const).toBe("learn_step");
    expect(wire().toolsAdded?.map(tool => tool.name).sort()).toEqual(["learning_context", "learning_define", "learning_skill", "learning_source"]);
    expect(JSON.stringify(wire().toolsAdded).length).toBeLessThan(20000);
    const state = (await service.context({}, owner)).learning_state as { state_revision: string; learn_flow: { step_id: string } };
    const goal = service.store.lessonGoal(owner)!;
    const prepared = await service.operation("learning_define", { operation_id: randomUUID(), kind: "learn_step", expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision, step_id: state.learn_flow.step_id, body: { component: { title: "Method choice", behavior: "Explain a method and diagnose a counterexample" }, title: "Test competing methods", instruction: "State the invariant and identify assumptions before choosing a method. A method that works on one example may fail when the assumptions change.", prompt: "Compare two plausible procedures under changed constraints; justify which preserves the invariant and construct a near-match where the other fails.", criteria: [{ name: "method", criterion: "Justify the method and its assumptions", max_score: 1 }, { name: "contrast", criterion: "Explain a discriminating counterexample", max_score: 1 }], source_span_ids: [], challenge_rationale: "Counterexample and changed assumptions, not a numerical substitution", uncertainty: "Uncalibrated synthetic public SDK fixture" } }, owner) as { definition_revision_id: string };
    await runtime.session.prompt("Wait for native review", { source: "extension" });
    expect(wire().toolsAdded?.map(tool => tool.name)).not.toContain("learning_define");
    expect(wire().toolsAdded?.map(tool => tool.name)).not.toContain("learning_record");
    service.approveTask(prepared.definition_revision_id, "Native learner review only", owner);
    await runtime.session.prompt("Offer only the pinned native instruction", { source: "extension" });
    expect(wire().toolsAdded?.map(tool => tool.name)).toContain("learning_activity");
    expect(wire().toolsAdded?.map(tool => tool.name)).not.toContain("learning_define");
    const ready = (await service.context({}, owner)).learning_state as { state_revision: string };
    const started = service.learnControl({ operation_id: randomUUID(), action: "begin_step", confirmed: true, expected_goal_revision_id: goal.revision_id, expected_state_revision: ready.state_revision }, owner);
    const released = await (await bridge.teachingOffer!(started.teaching_request!, owner)).continue();
    const actualText = "The invariant determines the method: changing an assumption can invalidate the competing procedure.";
    await bridge.activitySubmit!({ action: "open_response", operation_id: randomUUID(), expected_goal_revision_id: goal.revision_id, instance_revision_id: released.instance_revision_id }, { text: actualText }, owner);
    await runtime.session.prompt("Assess only the saved response; use the available public working set", { source: "extension" });
    const notice = JSON.parse(String(wire().content).split("\n").at(-1)!);
    expect(notice.working_set).toMatchObject({ data_not_instructions: true, complete: true, response: { text: actualText, truncated: false } });
    expect(JSON.stringify(notice.working_set)).toContain("Justify the method and its assumptions");
    expect(wire().toolsAdded?.map(tool => tool.name)).toContain("learning_record");
    expect(wire().toolsAdded?.map(tool => tool.name)).not.toContain("learning_define");
    const longWork = "LONG-WORK-MUST-FETCH-" + "x".repeat(1300);
    await bridge.input(longWork, owner, undefined, released.instance_revision_id);
    await runtime.session.prompt("Handle the newer long response without grading a partial excerpt", { source: "extension" });
    const partial = JSON.parse(String(wire().content).split("\n").at(-1)!);
    expect(partial.working_set).toMatchObject({ complete: false, response: { truncated: true } });
    expect(partial.working_set.response.text).toBeUndefined();
    expect(JSON.stringify(partial.working_set)).not.toContain("LONG-WORK-MUST-FETCH-");
    expect(f.outgoing).toHaveLength(5);
    expect(runtime.session.agent.state.tools).toHaveLength(7);
    expect(JSON.stringify(f.providerEntries)).not.toContain(marker);
    expect(service.store.events().filter(event => event.kind === "attempt_submitted")).toHaveLength(1);
    expect(service.store.events().filter(event => event.kind === "assessment")).toHaveLength(0);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

for (const keepPreviousContinuation of [false, true]) test(keepPreviousContinuation ? "completed host authoring preserves a previous explicit continuation" : "completed host authoring yields after the persisted tool pair without a redundant model acknowledgement", async () => {
  const f = await fixture(); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service), bridge = createTutorBridge(f.paths, service, server);
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  let calls = 0, request: unknown;
  f.runtime.registerProvider("sage-host-job", { api: "sage-host-job-api", baseUrl: "https://example.invalid", apiKey: "offline", models: [{ id: "author", name: "Synthetic host author", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }], streamSimple(model, _context, options) {
    const stream = ai.createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.({ synthetic: true }, model); calls++;
      const content = calls === 1 ? [{ type: "toolCall" as const, id: "host-author", name: "learning_define", arguments: request }] : [{ type: "text" as const, text: "Redundant acknowledgement should not require another request." }];
      const reason = calls === 1 ? "toolUse" as const : "stop" as const;
      stream.push({ type: "done", reason, message: { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() } }); stream.end();
    })();
    return stream;
  } });
  const runtime = await createTutorRuntime(f.paths, bridge, { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }), createAgentSessionFromServices: async options => {
    const result = await f.sdk.createAgentSessionFromServices(options);
    if (keepPreviousContinuation) {
      const agent = result.session.agent, previous = agent.finishTurn;
      let forwarded = false;
      agent.finishTurn = async (turn, signal) => {
        const decision = (await previous?.call(agent, turn, signal)) ?? undefined;
        if (!forwarded && turn.toolResults.some(message => message.toolName === "learning_define" && !message.isError)) {
          forwarded = true;
          return { action: "continue" };
        }
        return decision;
      };
    }
    return result;
  } });
  try {
    const owner = runtime.session.sessionId;
    await bridge.goal({ mode: "learn", objective: "Explain a method and its limits", subject: "practical", horizon_days: 1, target_format: "explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
    const state = (await service.context({}, owner)).learning_state as { state_revision: string; learn_flow: { step_id: string } };
    request = { operation_id: randomUUID(), kind: "learn_step", expected_goal_revision_id: service.store.lessonGoal(owner)!.revision_id, expected_state_revision: state.state_revision, step_id: state.learn_flow.step_id, body: { component: { title: "Method and counterexample", behavior: "Justify a method under its assumptions" }, title: "Choose a justified procedure", instruction: "State the invariant and check its assumptions. Contrast a near-match where the chosen operation would fail.", prompt: "Choose between plausible procedures when one assumption changes; justify the invariant and give a counterexample to the rejected method.", criteria: [{ name: "justify", criterion: "Explain the invariant and method limits", max_score: 1 }], source_span_ids: [], challenge_rationale: "Changed assumptions and counterexample, not a label or numerical substitution", uncertainty: "Synthetic software fixture, not validated difficulty" } };
    await runtime.session.setModel(f.runtime.getModel("sage-host-job", "author")!);
    await runtime.session.prompt("Execute only the current host content job", { source: "extension" });
    expect(calls).toBe(keepPreviousContinuation ? 2 : 1);
    expect(runtime.session.messages.filter(message => message.role === "toolResult" && message.toolName === "learning_define" && !message.isError)).toHaveLength(1);
    expect((await service.context({}, owner)).learning_state).toMatchObject({ learn_flow: { action: "review_draft" } });
    expect(service.store.revisions("task_definition")).toHaveLength(1);
    expect(service.store.events().filter(event => ["attempt_submitted", "assessment"].includes(event.kind))).toHaveLength(0);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("automatic overflow compatibility: forced public settings cannot bypass the disabled auxiliary summary boundary", async () => {
  // A tiny scripted model/window forces actual SDK recovery, not a manual compact call or real usage claim.
  const f = await fixture({ contextWindow: 1024, maxTokens: 512, inputTokens: 31900 }); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service), bridge = createTutorBridge(f.paths, service, server);
  const injected: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) };
  const runtime = await createTutorRuntime(f.paths, bridge, injected);
  try {
    const owner = runtime.session.sessionId;
    await bridge.goal({ mode: "learn", objective: "Owned automatic recovery compatibility", subject: "math", horizon_days: 1, target_format: "explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    const observed: Array<{ type: string; reason?: string; errorMessage?: string; willRetry?: boolean }> = [];
    runtime.session.subscribe(event => { if (event.type === "compaction_start" || event.type === "compaction_end") observed.push(event); });
    await runtime.session.prompt("Owned first orchestration", { source: "extension" });
    await runtime.session.prompt("Owned second orchestration", { source: "extension" });
    expect(runtime.session.settingsManager.getCompactionEnabled()).toBe(false);
    expect(observed).toEqual([]);
    const originals = JSON.stringify(runtime.session.sessionManager.getEntries()), count = runtime.session.sessionManager.getEntries().length;
    const ledger = service.store.revisions();
    runtime.session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } });
    expect(runtime.session.settingsManager.getCompactionEnabled()).toBe(true);
    await runtime.session.prompt("Owned public-override recovery boundary", { source: "extension" });
    await runtime.session.waitForIdle();
    expect(observed).toContainEqual(expect.objectContaining({ type: "compaction_start", reason: "overflow" }));
    expect(observed).toContainEqual(expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: false, errorMessage: expect.stringContaining("disclosure boundary") }));
    expect(f.providerEntries).toHaveLength(3); expect(f.outgoing).toHaveLength(3);
    expect(JSON.stringify(f.providerEntries)).not.toContain(marker);
    expect(runtime.session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toEqual([]);
    expect(JSON.stringify(runtime.session.sessionManager.getEntries().slice(0, count))).toBe(originals);
    expect(service.store.revisions()).toEqual(ledger);
    expect(service.store.events().filter(event => ["learner_response", "attempt_submitted", "assessment"].includes(event.kind))).toEqual([]);
    expect(service.store.integrity()).toEqual(["ok"]);
    // Characterizes fail-closed unsupported automatic compaction; does not enable it for Sage.
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("actual Pi resume/hidden-context/compaction originals remain local while complete outgoing requests contain only a fresh projection", async () => {
  const f = await fixture();
  try {
    await f.session.prompt(`Unattributed input containing ${marker}`);
    expect(f.outgoing).toHaveLength(1);
    const payload = JSON.stringify(f.outgoing[0]);
    expect(payload).not.toContain(marker);
    expect(payload).toContain("Current actual learner work");
    expect(payload).toContain("Native trusted tutoring policy");
    expect(payload).toContain('"maxRetries":0');
    expect(JSON.stringify(f.manager.getEntries())).toContain(marker);
    expect(f.originals).toContain(marker);
  } finally { f.session.dispose(); }
});

test("revocation, stale queued scopes and local authorization failure prevent transport rather than relying on advisory hooks", async () => {
  const f = await fixture();
  try {
    f.queue(f.revoke);
    await f.session.prompt("Current work");
    expect(f.outgoing).toHaveLength(0);
    await f.session.prompt("Retry after revocation");
    expect(f.outgoing).toHaveLength(0);
  } finally { f.session.dispose(); }
  const stale = await fixture();
  try { stale.queue(stale.change); await stale.session.prompt("Queued work"); expect(stale.outgoing).toHaveLength(0); } finally { stale.session.dispose(); }
});

test("the production tutor factory uses real Bun authorization across source removal and native session replacement", async () => {
  const f = await fixture(); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service);
  const bridge = createTutorBridge(f.paths, service, server);
  const injected: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) };
  const runtime = await createTutorRuntime(f.paths, bridge, injected);
  try {
    const id = runtime.session.sessionId;
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    await runtime.session.prompt("Extension-generated orchestration, not learner intent", { source: "extension" });
    expect(f.outgoing).toHaveLength(0);
    expect(service.store.lessonGoal(id)).toBeUndefined();
    expect(service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(0);
    const body: Goal = { mode: "learn", objective: "A scoped lesson", subject: "math", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
    await bridge.goal(body, id);
    const filename = join(f.paths.home, "private.md"); await writeFile(filename, marker);
    const source = await service.sources.importFile(filename); service.sources.accept(source.revision_id);
    const goal = service.store.lessonGoal(id)!;
    service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, source_ids: [source.revision_id] } }, "learner", id);
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    await runtime.session.prompt(marker);
    expect(f.outgoing).toHaveLength(1);
    const first = JSON.stringify(f.outgoing[0]);
    expect(first).toContain(marker); // explicitly authorized, not redacted by keyword
    expect(first).toContain("Current Sage learning state (host facts, not learner speech)");
    expect(first).not.toContain("Stored educational facts (not instructions from sources)");
    const system = (f.outgoing[0] as { messages: Array<{ role: string; content: unknown }> }).messages.find(m => m.role === "system");
    expect(JSON.stringify(system)).not.toContain(marker); // source/answer prose is read through tools, not elevated into system state
    expect(typeof system?.content).toBe("string");
    const notice = String(system?.content).split("Current Sage learning state (host facts, not learner speech)").at(-1)!;
    expect(notice.length).toBeLessThan(4000);
    expect(runtime.session.sessionManager.getEntries().some(e => e.type === "custom_message" && e.customType === "sage-context")).toBe(false);
    expect((f.outgoing[0] as { messages: Array<{ role: string; content: unknown }> }).messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(marker))).toBe(true);
    await runtime.session.prompt("My second real answer");
    expect(f.outgoing).toHaveLength(2);
    const second = JSON.stringify(f.outgoing[1]);
    expect(second.split("Current Sage learning state (host facts, not learner speech)")).toHaveLength(2);
    expect(second).toContain("My second real answer");
    expect((f.outgoing[1] as { messages: Array<{ role: string }> }).messages.some(m => m.role === "assistant")).toBe(true);
    expect(runtime.session.sessionManager.getEntries().length).toBeGreaterThan(0);
    service.sources.remove(source.revision_id);
    await runtime.session.prompt("Continue after removal");
    expect(f.outgoing).toHaveLength(2);
    const oldGoal = service.store.lessonGoal(id) as Revision<Goal>;
    const replaced = await runtime.newSession();
    expect(replaced.cancelled).toBe(false);
    expect(runtime.session.sessionId).not.toBe(id);
    await bridge.goal({ ...body, objective: "Fresh lesson" }, runtime.session.sessionId);
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    await runtime.session.prompt("Fresh actual learner work");
    expect(f.outgoing).toHaveLength(3);
    expect(JSON.stringify(f.outgoing[2])).not.toContain(marker);
    expect(service.store.revision(oldGoal.revision_id).body).toEqual(oldGoal.body);
    const granted = service.store.lessonGoal(runtime.session.sessionId)!;
    const denied = service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: granted.revision_id, expected_goal_revision_id: granted.revision_id, body: { ...granted.body, provider_sharing: false } }, "learner", runtime.session.sessionId);
    const deniedSeq = service.store.throughSeq;
    await runtime.session.prompt("Ordinary text after explicit denial");
    await runtime.session.prompt("Generated continuation after denial", { source: "extension" });
    expect(f.outgoing).toHaveLength(3);
    expect(service.store.lessonGoal(runtime.session.sessionId)?.revision_id).toBe(denied.revision_id);
    expect(service.store.throughSeq).toBe(deniedSeq);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("e02s01 task 2: real production queued follow-up rejects revoke, changed goal, fork, cancel and stale authorization", async () => {
  for (const action of ["revoke", "goal", "fork", "cancel", "stale"] as const) {
    const f = await fixture(); f.session.dispose();
    const service = new LearningService(f.paths), server = startLearningServer(service);
    const bridge = createTutorBridge(f.paths, service, server);
    const nativeAuthorize = bridge.authorize!;
    let stale = false;
    bridge.authorize = async owner => { const arrivedStale = stale; const permit = await nativeAuthorize(owner); return arrivedStale ? { ...permit, revision: `${permit.revision}:stale` } : permit; };
    const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) };
    const runtime = await createTutorRuntime(f.paths, bridge, sdk);
    try {
      const owner = runtime.session.sessionId;
      const body: Goal = { mode: "learn", objective: "Current queued lesson", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
      await bridge.goal(body, owner);
      await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      f.queue(async () => { entered(); await held; });
      const original = runtime.session;
      const running = original.prompt("ALLOWED-CURRENT", { source: "extension" });
      await ready;
      await original.prompt("QUEUED-SECRET", { source: "extension", streamingBehavior: "followUp" });
      expect(original.pendingMessageCount).toBe(1);
      const goal = service.store.lessonGoal(owner)!;
      if (action === "revoke" || action === "goal") service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...(action === "revoke" ? { provider_sharing: false } : { objective: "Changed scope" }) } }, "learner", owner);
      if (action === "fork") {
        const user = original.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user")!;
        const switching = runtime.fork(user.id, { position: "at" });
        void original.abort(); release();
        await switching;
        expect(service.store.lessonGoal(runtime.session.sessionId)).toBeUndefined();
      }
      if (action === "cancel") void original.abort();
      if (action === "stale") stale = true;
      const seq = service.store.throughSeq;
      release(); await running;
      expect(f.outgoing).toEqual([]);
      expect(service.store.throughSeq).toBe(seq);
      expect(service.store.lessonGoal(owner)?.body.provider_sharing).toBe(action !== "revoke");
      expect(service.store.events().filter(e => e.kind === "learner_response")).toEqual([]);
    } finally { await runtime.dispose(); server.stop(); service.close(); }
  }
});

test("a consumed queued start is authorized once, not reused after a valid model tool write", async () => {
  const f = await fixture(); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service), bridge = createTutorBridge(f.paths, service, server);
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  let runtime: Awaited<ReturnType<typeof createTutorRuntime>> | undefined, queued = false, calls = 0;
  const queueSizes: number[] = [];
  f.runtime.registerProvider("sage-queue-write", { api: "sage-queue-write-api", baseUrl: "https://example.invalid", apiKey: "offline", models: [{ id: "tutor", name: "Synthetic queue write", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }], streamSimple(model, context, options) {
    const stream = ai.createAssistantMessageEventStream();
    const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
    void (async () => {
      try {
        await options?.onPayload?.({ messages: context.messages }, model); calls++;
        const content = calls === 1 ? [{ type: "toolCall" as const, id: "queued-component", name: "learning_define", arguments: { operation_id: "queued-component", kind: "component", expected_goal_revision_id: service.store.lessonGoal(runtime!.session.sessionId)!.revision_id, body: { title: "Functions", behavior: "Explain a function parameter", subject: "practical", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Synthetic regression only" } } }] : [{ type: "text" as const, text: "Synthetic write complete" }];
        const reason = calls === 1 ? "toolUse" as const : "stop" as const;
        stream.push({ type: "done", reason, message: { ...base, content, stopReason: reason } });
      } catch (error) { stream.push({ type: "error", reason: "error", error: { ...base, content: [], stopReason: "error", errorMessage: String(error) } }); }
      stream.end();
    })();
    return stream;
  } });
  const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime, resourceLoaderOptions: { ...options.resourceLoaderOptions, extensionFactories: [...(options.resourceLoaderOptions?.extensionFactories ?? []), { name: "synthetic-queued-start", factory: pi => { pi.on("before_agent_start", async () => { if (!queued) { queued = true; await runtime!.session.steer("Synthetic queued start", undefined, { source: "extension" }); } }); } }] } }) };
  try {
    runtime = await createTutorRuntime(f.paths, bridge, sdk);
    const old = runtime.session.sessionId; await runtime.newSession(); expect(runtime.session.sessionId).not.toBe(old);
    await runtime.session.setModel(f.runtime.getModel("sage-queue-write", "tutor")!);
    await runtime.session.bindExtensions({ uiContext: { notify() {}, setStatus() {}, setWidget() {} } as any });
    let finish!: () => void; const ended = new Promise<void>(resolve => { finish = resolve; });
    const unsubscribe = runtime.session.subscribe(event => { if (event.type === "queue_update") queueSizes.push(event.followUp.length + event.steering.length); if (event.type === "agent_end") finish(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await runtime.session.prompt("/learn Synthetic queued lesson");
      await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Queued write did not settle")), 10000); })]);
    } finally { clearTimeout(timer); unsubscribe(); }
    expect(queueSizes).toEqual([1, 0]); expect(calls).toBe(2); expect(service.store.revisions("component")).toHaveLength(1);
    expect(runtime.session.messages.filter(message => message.role === "assistant" && message.errorMessage)).toEqual([]);
    expect(service.store.events().filter(event => event.kind === "assessment")).toEqual([]); expect(service.store.integrity()).toEqual(["ok"]);
  } finally { await runtime?.dispose(); server.stop(); service.close(); }
}, 15000);

test("e02s01 task 2: production model switch and native compact reopen preserve scoped current requests and kept tool groups", async () => {
  const f = await fixture(); f.session.dispose();
  const service = new LearningService(f.paths), server = startLearningServer(service);
  const bridge = createTutorBridge(f.paths, service, server);
  let publicHookCalls = 0;
  const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime, resourceLoaderOptions: { ...options?.resourceLoaderOptions, extensionFactories: [...(options?.resourceLoaderOptions?.extensionFactories ?? []), { name: "offline-advisory-failure", factory: pi => { pi.on("before_provider_request", () => { publicHookCalls++; throw new Error("Offline public hook failure is advisory, not a transport denial"); }); } }] } }) };
  const runtime = await createTutorRuntime(f.paths, bridge, sdk);
  try {
    await bridge.goal({ mode: "learn", objective: "Allowed current request", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, runtime.session.sessionId);
    await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
    const manager = runtime.session.sessionManager;
    const model = runtime.session.model!;
    manager.appendMessage({ role: "user", content: "OLDER-OWNED-WORK " + "bounded facts ".repeat(400), timestamp: 1000 });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "owned-call", name: "learning_context", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    manager.appendMessage({ role: "toolResult", toolCallId: "owned-call", toolName: "learning_context", content: [{ type: "text", text: "Owned local tool result" }], isError: false, timestamp: Date.now() });
    await runtime.switchSession(manager.getSessionFile()!);
    await runtime.session.setModel(model);
    const switched = f.runtime.getModel("sage-recording", "switched")!;
    await runtime.session.setModel(switched);
    expect(runtime.session.model?.id).toBe("switched");
    await runtime.session.prompt("Current authorized request", { source: "extension" });
    expect(f.outgoing).toHaveLength(1);
    expect((f.outgoing[0] as { model: string }).model).toBe("switched");
    expect(publicHookCalls).toBe(1);
    const messages = (f.outgoing[0] as any).messages;
    expect(messages.find((m: any) => m.role === "toolResult").toolCallId).toBe("owned-call");
    expect(messages.find((m: any) => m.role === "assistant").content[0].id).toBe("owned-call");
    runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "kept-call", name: "learning_context", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    runtime.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "kept-call", toolName: "learning_context", content: [{ type: "text", text: "Kept current tool result" }], isError: false, timestamp: Date.now() });
    const originalEntries = runtime.session.sessionManager.getEntries();
    const originalJson = JSON.stringify(originalEntries);
    runtime.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 200, reserveTokens: 100 } });
    const compacted = await runtime.session.compact();
    expect(compacted.summary).toContain("Sage AI context summary");
    expect(f.outgoing).toHaveLength(2);
    const entries = runtime.session.sessionManager.getEntries();
    expect(JSON.stringify(entries.slice(0, originalEntries.length))).toBe(originalJson);
    const compaction = entries.at(-1)!;
    expect(compaction.type).toBe("compaction");
    if (compaction.type !== "compaction") throw new Error("Expected native append");
    expect(compaction.fromHook).toBe(true);
    expect(compaction.firstKeptEntryId).toBe(compacted.firstKeptEntryId);
    expect(compaction.tokensBefore).toBe(compacted.tokensBefore);
    expect(originalEntries.some(entry => entry.id === compaction.firstKeptEntryId)).toBe(true);
    const permit = await bridge.authorize!(runtime.session.sessionId);
    expect(compaction.details).toEqual({ sage_compaction: { session_id: permit.session_id, revision: permit.revision } });
    const ledger = service.store.revisions();
    await runtime.session.prompt("CURRENT-AFTER-COMPACT", { source: "extension" });
    expect(f.outgoing).toHaveLength(3);
    expect(JSON.stringify(f.outgoing[2])).toContain(compacted.summary.replace(/\n/g, "\\n"));
    expect(JSON.stringify(f.outgoing[2])).toContain("kept-call");
    expect(service.store.revisions()).toEqual(ledger);
    const oldGoal = service.store.lessonGoal(runtime.session.sessionId)!;
    service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: oldGoal.entity_id, parent_revision_id: oldGoal.revision_id, expected_goal_revision_id: oldGoal.revision_id, body: { ...oldGoal.body, objective: "New authorized scope after compact" } }, "learner", runtime.session.sessionId);
    const changedLedger = service.store.revisions();
    await runtime.session.prompt("CURRENT-AFTER-SUMMARY-SCOPE-CHANGE", { source: "extension" });
    expect(f.outgoing).toHaveLength(4);
    expect(JSON.stringify(f.outgoing[3])).toContain("CURRENT-AFTER-SUMMARY-SCOPE-CHANGE");
    expect(JSON.stringify(f.outgoing[3])).not.toContain("Sage AI context summary");
    expect(JSON.stringify(f.outgoing[3])).toContain("kept-call");
    expect(service.store.revisions()).toEqual(changedLedger);
    const path = runtime.session.sessionFile!;
    await runtime.switchSession(path); await runtime.session.setModel(switched);
    await runtime.session.prompt("CURRENT-AFTER-COMPACT-REOPEN", { source: "extension" });
    expect(f.outgoing).toHaveLength(5);
    const reopened = JSON.stringify(f.outgoing[4]);
    expect(reopened).toContain("CURRENT-AFTER-COMPACT-REOPEN");
    expect(reopened).toContain("kept-call");
    expect(reopened).toContain("Kept current tool result");
    expect(reopened).not.toContain("OLDER-OWNED-WORK");
    expect(reopened).not.toContain("Sage AI context summary");
    expect(runtime.session.sessionManager.getEntries().some(e => e.id === compaction.id)).toBe(true);
    runtime.session.sessionManager.appendCompaction("FORGED-SUMMARY-METADATA", compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details, true);
    await runtime.switchSession(path); await runtime.session.setModel(switched);
    await runtime.session.prompt("FRESH-AFTER-UNKNOWN-SUMMARY", { source: "extension" });
    expect(f.outgoing).toHaveLength(6);
    expect(JSON.stringify(f.outgoing[5])).toContain("FRESH-AFTER-UNKNOWN-SUMMARY");
    expect(JSON.stringify(f.outgoing[5])).not.toContain("FORGED-SUMMARY-METADATA");
    expect(JSON.stringify(f.outgoing[5])).not.toContain("Sage AI context summary");
    expect(service.store.revisions()).toEqual(changedLedger);
    expect(runtime.session.settingsManager.getCacheWarmingMode()).toBe("off");
    expect(runtime.session.settingsManager.getCompactionEnabled()).toBe(false);
    expect(runtime.session.settingsManager.getRetryEnabled()).toBe(false);
    f.queue(() => {
      const goal = service.store.lessonGoal(runtime.session.sessionId)!;
      service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, provider_sharing: false } }, "learner", runtime.session.sessionId);
    });
    await runtime.session.prompt("Late revoked payload despite advisory hook failure", { source: "extension" });
    expect(publicHookCalls).toBe(6);
    expect(f.outgoing).toHaveLength(6);
    expect(service.store.lessonGoal(runtime.session.sessionId)?.body.provider_sharing).toBe(false);
  } finally { await runtime.dispose(); server.stop(); service.close(); }
});

test("e02s01 task 2: native manual compaction denies late revoke, goal, fork, cancel, stale and failed generation without default fallback", async () => {
  for (const action of ["revoke", "goal", "fork", "cancel", "stale", "failed"] as const) {
    const f = await fixture(); f.session.dispose();
    const service = new LearningService(f.paths), server = startLearningServer(service);
    const bridge = createTutorBridge(f.paths, service, server), nativeAuthorize = bridge.authorize!;
    let stale = false;
    bridge.authorize = async owner => { const wasStale = stale; const permit = await nativeAuthorize(owner); return wasStale ? { ...permit, revision: permit.revision + ":stale" } : permit; };
    const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) };
    const runtime = await createTutorRuntime(f.paths, bridge, sdk);
    try {
      const owner = runtime.session.sessionId;
      await bridge.goal({ mode: "learn", objective: "Scoped compaction", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
      await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
      const user = runtime.session.sessionManager.appendMessage({ role: "user", content: "Native current compaction work ".repeat(50), timestamp: 1000 });
      const model = runtime.session.model!;
      runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier native assistant context, not learner evidence" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1001 });
      await runtime.switchSession(runtime.session.sessionFile!); await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
      await runtime.session.bindExtensions({});
      runtime.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0, reserveTokens: 100 } });
      const original = runtime.session, entries = JSON.stringify(original.sessionManager.getEntries());
      let attempts = 0;
      let switching: ReturnType<typeof runtime.fork> | undefined;
      f.queue(async () => {
        attempts++;
        const goal = service.store.lessonGoal(owner)!;
        if (action === "revoke" || action === "goal") service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...(action === "revoke" ? { provider_sharing: false } : { objective: "Changed during compaction" }) } }, "learner", owner);
        if (action === "fork") { original.abortCompaction(); switching = runtime.fork(user, { position: "at" }); }
        if (action === "cancel") original.abortCompaction();
        if (action === "stale") stale = true;
        if (action === "failed") throw new Error("Offline summary provider failed before sending");
      });
      await expect(original.compact()).rejects.toThrow();
      await switching;
      expect(f.outgoing).toEqual([]);
      expect(attempts).toBe(1);
      expect(JSON.stringify(original.sessionManager.getEntries())).toBe(entries);
      expect(service.store.lessonGoal(owner)?.body.provider_sharing).toBe(action !== "revoke");
      expect(service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    } finally { await runtime.dispose(); server.stop(); service.close(); }
  }
});

test("e02s01 task 2: post-generation owner goal source revocation and cancellation prevent native append and stale return", async () => {
  for (const action of ["revoke", "goal", "owner", "source-remove", "source-scope", "cancel"] as const) {
    const f = await fixture(); f.session.dispose();
    const service = new LearningService(f.paths), server = startLearningServer(service);
    const bridge = createTutorBridge(f.paths, service, server), log = bridge.calls.bind(bridge);
    const sdk: PiSdk = { ...f.sdk, createAgentSessionServices: options => f.sdk.createAgentSessionServices({ ...options, modelRuntime: f.runtime }) };
    const runtime = await createTutorRuntime(f.paths, bridge, sdk);
    try {
      const owner = runtime.session.sessionId;
      const filename = join(f.paths.home, "compaction-source.md"); await writeFile(filename, marker);
      const source = await service.sources.importFile(filename); service.sources.accept(source.revision_id);
      await bridge.goal({ mode: "learn", objective: "Authorized source compaction", subject: "writing", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [source.revision_id] }, owner);
      await runtime.session.setModel(f.runtime.getModel("sage-recording", "tutor")!);
      const model = runtime.session.model!, manager = runtime.session.sessionManager;
      manager.appendMessage({ role: "user", content: `${marker} current owned context `.repeat(50), timestamp: 1000 });
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "post-generation-call", name: "learning_context", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1001 });
      manager.appendMessage({ role: "toolResult", toolCallId: "post-generation-call", toolName: "learning_context", content: [{ type: "text", text: "Current owned source result" }], isError: false, timestamp: 1002 });
      await runtime.switchSession(runtime.session.sessionFile!); await runtime.session.setModel(model);
      await runtime.session.bindExtensions({});
      runtime.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0, reserveTokens: 100 } });
      const original = runtime.session, entries = JSON.stringify(original.sessionManager.getEntries());
      let completed = 0, boundarySeq = 0, boundaryRevisions = service.store.revisions();
      let boundaryGoal = service.store.lessonGoal(owner)!;
      const nextOwner = f.sdk.SessionManager.create(f.paths.cwd, f.paths.sessions).getSessionId();
      bridge.calls = async (entry, sessionId) => {
        await log(entry, sessionId);
        if (entry.operation !== "pi_compaction_request" || entry.phase !== "completed") return;
        completed++;
        // The child has already returned its terminal assistant message; this is not a pre-send denial.
        expect(sessionId).toBe(owner);
        expect(entry.output_tokens).toBe(1);
        expect(f.outgoing).toHaveLength(1);
        const goal = service.store.lessonGoal(owner)!;
        if (action === "revoke" || action === "goal" || action === "source-scope") service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...(action === "revoke" ? { provider_sharing: false } : action === "source-scope" ? { source_ids: [] } : { objective: "Changed after generation" }) } }, "learner", owner);
        if (action === "source-remove") service.sources.remove(source.revision_id);
        if (action === "owner") await bridge.activate!(nextOwner);
        if (action === "cancel") original.abortCompaction();
        boundarySeq = service.store.throughSeq;
        boundaryRevisions = service.store.revisions();
        boundaryGoal = service.store.lessonGoal(owner)!;
      };
      await expect(original.compact()).rejects.toThrow();
      expect(completed).toBe(1);
      expect(f.outgoing).toHaveLength(1); // Earlier authorized generation is legitimate; no default/fallback or later send.
      expect(JSON.stringify(f.outgoing[0])).toContain(marker);
      const messages = JSON.stringify(f.outgoing[0]);
      expect(messages).toContain("post-generation-call");
      expect(messages).toContain("toolResult");
      expect(JSON.stringify(original.sessionManager.getEntries())).toBe(entries);
      expect(original.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
      expect(original.sessionId).toBe(owner);
      expect(service.store.lessonGoal(owner)).toEqual(boundaryGoal);
      expect(service.store.revisions()).toEqual(boundaryRevisions);
      expect(service.store.throughSeq).toBe(boundarySeq);
      expect(service.store.sourceStatus(source.revision_id)).toBe(action === "source-remove" ? "removed" : "indexed");
      if (action === "owner") {
        expect(() => service.assertActiveSession(owner)).toThrow("inactive");
        expect(() => service.assertActiveSession(nextOwner)).not.toThrow();
        expect(service.store.lessonGoal(nextOwner)).toBeUndefined();
      } else expect(() => service.assertActiveSession(owner)).not.toThrow();
      if (["revoke", "owner", "source-remove", "source-scope"].includes(action)) {
        await original.prompt("Forbidden later continuation", { source: "extension" });
        expect(f.outgoing).toHaveLength(1);
        expect(service.store.throughSeq).toBe(boundarySeq);
        expect(service.store.revisions()).toEqual(boundaryRevisions);
      }
      expect(service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
      bridge.calls = log;
      await runtime.newSession(); await runtime.session.setModel(model);
      const fresh = runtime.session.sessionId;
      await bridge.goal({ ...boundaryGoal.body, objective: "Fresh explicitly authorized work", provider_sharing: true, source_ids: [] }, fresh);
      await runtime.session.prompt("FRESH-AUTHORIZED-AFTER-BOUNDARY", { source: "extension" });
      expect(f.outgoing).toHaveLength(2);
      expect(JSON.stringify(f.outgoing[1])).toContain("FRESH-AUTHORIZED-AFTER-BOUNDARY");
      expect(JSON.stringify(f.outgoing[1])).not.toContain(marker);
      expect(JSON.stringify(f.outgoing[1])).not.toContain("Sage AI context summary");
      expect(service.store.lessonGoal(owner)).toEqual(boundaryGoal);
      expect(service.store.lessonGoal(fresh)?.body.provider_sharing).toBe(true);
      expect(service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    } finally { await runtime.dispose(); server.stop(); service.close(); }
  }
});

test("unguarded model-runtime calls and virtual routing are disabled", async () => {
  const f = await fixture();
  try {
    const guarded = guardModelRuntime(f.runtime), model = f.runtime.getModel("sage-recording", "tutor")!;
    expect(() => guarded.streamSimple(model, { messages: [] })).toThrow("disclosure");
    expect(() => guarded.completeSimple(model, { messages: [] })).toThrow("disabled");
    const virtualModel = { ...model, api: "virtual-model" as any };
    expect(() => guarded.resolveModel(virtualModel, [], { reason: "direct", thinkingLevel: "off" })).toThrow("disabled");
    expect(f.outgoing).toHaveLength(0);
  } finally { f.session.dispose(); }
});
