import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTutorExtension, createTutorRuntime, runTutor, type TutorBridge } from "../src/tutor.ts";
import { loadPi, type PiSdk } from "../src/sdk.ts";
import type { UsageTracker } from "../../runtime/src/usage.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import type { CallEntry } from "../../core/src/contracts.ts";
import { draft } from "../../core/test/planning-fixture.ts";
import type { PlanningRequest } from "../../core/src/planning.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function bridge(calls: CallEntry[] = []): TutorBridge {
  // No learner store in this telemetry fixture; real input admission has integrated host tests.
  return { inputAdmission: () => ({ assertCurrent() {}, assertScopeCurrent() {}, goalCreated() {} }), operation: async () => ({ goal: null, learning_state: { current_task: null } }), input: async () => {}, goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async entry => { calls.push(entry); }, stop: async () => ({}), shutdown: async () => {} };
}

test("local usage integration: native controls register without counting SDK factory sessions or sending model work", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-usage-runtime-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const writes: boolean[] = [], calls: CallEntry[] = [];
  const tracking: UsageTracker = { async start() { throw new Error("SDK factory must not count a launch"); }, async stop() {}, async flush() {}, async setEnabled(value) { writes.push(value); }, snapshot: () => ({ enabled: true, available: true, total_sessions: 0, total_hours: 0 }), subscribe: () => () => {} };
  const options = { guidedStart: false, usage: tracking };
  const runtime = await createTutorRuntime(paths, bridge(calls), undefined, options);
  try {
    await runtime.session.bindExtensions({});
    await runtime.session.prompt("/usage off", { source: "extension" });
    expect(writes).toEqual([false]); expect(calls).toEqual([]);
    expect(runtime.session.getActiveToolNames()).toHaveLength(7);
    expect(await access(join(paths.data, "usage.json")).then(() => true, () => false)).toBe(false);
  } finally { await runtime.dispose(); }
});

test.each([false, true])("local usage integration: one interactive launch counts once across native replacements and cleanup (throw=%s)", async fail => {
  const root = await mkdtemp(join(tmpdir(), "sage-usage-launch-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const sdk = await loadPi(paths);
  class OwnedInteractiveMode {
    constructor(private runtime: Awaited<ReturnType<typeof createTutorRuntime>>) {}
    async run() { await this.runtime.newSession(); await this.runtime.newSession(); if (fail) throw new Error("Owned UI exit"); }
  }
  const supplied: PiSdk = { ...sdk, InteractiveMode: OwnedInteractiveMode as unknown as PiSdk["InteractiveMode"] };
  if (fail) await expect(runTutor(paths, bridge(), supplied)).rejects.toThrow("Owned UI exit");
  else await runTutor(paths, bridge(), supplied);
  const saved = JSON.parse(await readFile(join(paths.data, "usage.json"), "utf8"));
  expect(saved.total_sessions).toBe(1); expect(saved.total_hours).toBeGreaterThanOrEqual(0);
  expect(Object.keys(saved).sort()).toEqual(["total_hours", "total_sessions"]);
});

test("local usage native exit: awaited runtime disposal saves the final interval before process.exit bypasses launcher finally", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-usage-native-exit-")); roots.push(root);
  const home = join(root, "home"), script = join(root, "native-exit.ts");
  await writeFile(script, `
    import { runTutor } from ${JSON.stringify(new URL("../src/tutor.ts", import.meta.url).href)};
    import { loadPi } from ${JSON.stringify(new URL("../src/sdk.ts", import.meta.url).href)};
    import { createSagePaths } from ${JSON.stringify(new URL("../../runtime/src/paths.ts", import.meta.url).href)};
    import { bootstrapSageHome } from ${JSON.stringify(new URL("../../runtime/src/bootstrap.ts", import.meta.url).href)};
    const paths = createSagePaths({ home: process.env.SAGE_HOME }); await bootstrapSageHome(paths);
    const sdk = await loadPi(paths);
    class NativeExit { constructor(runtime) { this.runtime = runtime; } async run() {
      await this.runtime.session.bindExtensions({});
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.runtime.dispose(); process.exit(0);
    } }
    const bridge = { operation: async () => ({ goal: null }), input: async () => {}, goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {} };
    await runTutor(paths, bridge, { ...sdk, InteractiveMode: NativeExit });
  `);
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, SAGE_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 15_000);
  try {
    const [, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(exit).toBe(0);
    const totals = JSON.parse(await readFile(join(home, "data/usage.json"), "utf8"));
    expect(totals.total_sessions).toBe(1); expect(totals.total_hours).toBeGreaterThan(0);
  } finally { clearTimeout(deadline); }
}, 20_000);

test("bundled Pi SDK loads the native tutor, isolated policy and seven educational tools without model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-native-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const calls: CallEntry[] = [];
  const runtime = await createTutorRuntime(paths, bridge(calls));
  try {
    expect(runtime.session.getActiveToolNames().sort()).toEqual(["learning_activity", "learning_context", "learning_define", "learning_record", "learning_skill", "learning_source", "render_ui"]);
    expect(runtime.services.resourceLoader.getExtensions().errors).toEqual([]);
    const policy = runtime.services.resourceLoader.getSystemPrompt();
    expect(policy).toContain("learner's personal tutor");
    expect(policy).toContain("scoped roadmap");
    expect(policy).toContain("exercise success is not goal completion");
    expect(policy).toContain("mechanisms and worked reasoning");
    expect(runtime.services.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(runtime.services.settingsManager.getEnableInstallTelemetry()).toBe(false);
    expect(calls).toEqual([]);
    const skill = runtime.session.agent.state.tools.find(tool => tool.name === "learning_skill")!;
    expect(skill).toBeDefined();
    const skillList = await skill.execute("list-skills", {}, new AbortController().signal);
    expect(JSON.parse((skillList.content[0] as { text: string }).text).skills).toContainEqual(expect.objectContaining({ name: "learning" }));
    const skillText = await skill.execute("read-skill", { name: "learning" }, new AbortController().signal);
    const guidance = JSON.stringify(skillText);
    expect(guidance).toContain("SKILL.md");
    expect(guidance).toContain("Depth and coverage");
    expect(guidance).toContain("explanation is not observed competence");
    expect(guidance).toContain("task_family");
    expect(guidance).toContain("task_definition");
    const render = runtime.session.agent.state.tools.find(tool => tool.name === "render_ui")!;
    const instructions = await render.execute("instructions", {}, new AbortController().signal);
    expect(JSON.stringify(instructions)).toContain("(context, ui)");
    expect(JSON.stringify(instructions)).toContain("design");
    expect(calls).toEqual([]);
  } finally { await runtime.dispose(); }
});

test("native footer advertises registered accelerate and drill commands", async () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>(), commands: string[] = [], statuses: string[] = [];
  const api = { registerTool() {}, registerCommand(name: string) { commands.push(name); }, on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) { handlers.set(name, handler); return () => {}; } };
  await createTutorExtension(bridge())(api as unknown as ExtensionAPI);
  await handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => "footer" }, ui: { setStatus(_key: string, text: string) { statuses.push(text); }, notify() {} } });
  expect(commands).toContain("accelerate"); expect(commands).toContain("drill");
  expect(statuses.join(" ")).toContain("Sage"); expect(statuses.join(" ")).toContain("/accelerate"); expect(statuses.join(" ")).toContain("/drill");
});

test.each(["cancel", "stale", "busy", "invalid", "on"] as const)("native drill teaching menu: %s preserves admission and cancellation", async scenario => {
  const commands = new Map<string, RegisteredCommand>(), writes: boolean[] = [];
  let stale = false, busy = false;
  const api = { registerTool() {}, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on() { return () => {}; } };
  await createTutorExtension({ ...bridge(), inputAdmission: () => ({ assertCurrent() { if (stale) throw new Error("Stale native input"); }, assertScopeCurrent() {}, goalCreated() {} }), operation: async () => ({ goal: { body: { mode: "drill", provider_sharing: false } }, learning_state: { state_revision: "current" } }), drillTeaching: async enabled => { if (enabled !== undefined) writes.push(enabled); return { enabled: enabled ?? false }; } })(api as unknown as ExtensionAPI);
  const ctx = { hasUI: true, isIdle: () => !busy, sessionManager: { getSessionId: () => "menu" }, ui: { notify() {}, select: async (_title: string, labels: string[]) => { stale = scenario === "stale"; busy = scenario === "busy"; return scenario === "cancel" ? undefined : scenario === "invalid" ? "Unknown selection" : labels[1]; } } };
  await commands.get("drill")!.handler("teach-gaps", ctx as unknown as ExtensionCommandContext);
  expect(writes).toEqual(scenario === "on" ? [true] : []);
});

test("extension telemetry records actual hook starts/HTTP failures and explicitly unknown stream completion", async () => {
  const calls: CallEntry[] = [];
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  const commands: string[] = [];
  const api = { registerTool() {}, registerCommand(name: string) { commands.push(name); }, on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) { handlers.set(name, handler); return () => {}; } };
  await createTutorExtension(bridge(calls))(api as unknown as ExtensionAPI);
  const ctx = { model: { provider: "fixture", id: "fixture" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  await handlers.get("before_provider_request")!({ payload: { prompt: "private" } }, ctx);
  await handlers.get("after_provider_response")!({ status: 500 }, ctx);
  await handlers.get("before_provider_request")!({ payload: { prompt: "retry" } }, ctx);
  await handlers.get("after_provider_response")!({ status: 200 }, ctx);
  await handlers.get("agent_end")!({}, ctx);
  expect(calls.map(c => c.phase)).toEqual(["started", "failed", "started", "response", "unknown"]);
  expect(calls[0]!.request_hash).toHaveLength(64);
  expect(JSON.stringify(calls)).not.toContain('"private"');
  expect(commands).toContain("learn"); expect(commands).toContain("exam"); expect(commands).toContain("drill"); expect(commands).toContain("accelerate"); expect(commands).toContain("skip");
  expect(await handlers.get("input")!({ source: "interactive", text: "Start a model request without consent" }, ctx)).toEqual({ action: "continue" });
});

test("extension-generated input neither creates a goal nor becomes learner evidence, and context filtering preserves native tool pairing", async () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  const saved: unknown[] = [], responses: string[] = [];
  const api = { registerTool() {}, registerCommand() {}, on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) { handlers.set(name, handler); return () => {}; } };
  await createTutorExtension({ ...bridge(), goal: async value => { saved.push(value); return {}; }, input: async text => { responses.push(text); } })(api as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => "native" }, ui: { notify() {} } };
  expect(await handlers.get("input")!({ source: "extension", text: "Generated activity orchestration" }, ctx)).toEqual({ action: "continue" });
  expect(saved).toEqual([]); expect(responses).toEqual([]);
  const messages = [{ role: "user", content: "Real work" }, { role: "custom", customType: "sage-context", content: "Obsolete copied facts" }, { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "learning_context", arguments: {} }] }, { role: "toolResult", toolCallId: "t1", toolName: "learning_context", content: [] }, { role: "custom", customType: "other-extension", content: "Keep native custom content" }];
  expect(await handlers.get("context")!({ messages }, ctx)).toEqual({ messages: [messages[0], messages[2], messages[3], messages[4]] });
  expect(messages).toHaveLength(5); // outgoing projection must not mutate the original transcript
});

test("ordinary input does not replace a quarantined lesson or reverse stored sharing denial", async () => {
  for (const packet of [{ goal: null, disclosure: { allowed: false, reason: "sharing_disabled" } }, { goal: { body: { provider_sharing: false } } }]) {
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
    const saved: unknown[] = [], responses: string[] = [];
    const api = { registerTool() {}, registerCommand() {}, on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) { handlers.set(name, handler); return () => {}; } };
    await createTutorExtension({ ...bridge(), operation: async () => packet, goal: async value => { saved.push(value); return {}; }, input: async text => { responses.push(text); } })(api as unknown as ExtensionAPI);
    const ctx = { sessionManager: { getSessionId: () => "denied" }, ui: { notify() {} } };
    expect(await handlers.get("input")!({ source: "interactive", text: "Continue" }, ctx)).toEqual({ action: "handled" });
    expect(saved).toEqual([]); expect(responses).toEqual([]);
  }
});

async function intakeHarness({ consent = true, answers = ["Learn Python", ""], fail = false }: { consent?: boolean; answers?: Array<string | undefined>; fail?: boolean } = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, ToolDefinition>();
  const questions: string[] = [], sent: string[] = [], notices: string[] = [];
  const requests: PlanningRequest[] = [], saved: unknown[] = [];
  let cached: unknown;
  let packet: unknown = { goal: null };
  const api = { registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on() { return () => {}; }, sendUserMessage(text: string) { sent.push(text); } };
  const base = bridge();
  await createTutorExtension({ ...base,
    operation: async () => packet,
    goal: async (body, _sid, planning) => { saved.push({ body, planning }); return {}; },
    planResult: async () => cached,
    plan: async () => { cached = { revision_id: "delegated-outline" }; return cached; },
  }, { planner: async (request, _ctx, signal) => { requests.push(request); signal.throwIfAborted(); if (fail) throw new Error("Offline planner failure"); return draft; } })(api as unknown as ExtensionAPI);
  const ctx = { model: { provider: "fixture", id: "fixture" }, mode: "print", hasUI: false, isIdle: () => true, abort() {}, sessionManager: { getSessionId: () => "parent" },
    ui: { input: async (title: string) => { questions.push(title); return answers.shift(); }, confirm: async (title: string) => { questions.push(title); return consent; }, notify: (text: string) => { notices.push(text); }, setStatus() {} },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  return { commands, tools, ctx, requests, saved, questions, sent, notices, setPacket: (value: unknown) => { packet = value; } };
}

test("simple opening records actual learner intent before any model call and starts in the main conversation", async () => {
  const h = await intakeHarness();
  await h.commands.get("learn")!.handler("", h.ctx);
  expect(h.questions).toEqual(["What would you like to learn?"]);
  expect(h.requests).toEqual([]);
  expect(h.saved).toHaveLength(1);
  expect(h.saved[0]).toMatchObject({ body: { objective: "Learn Python", subject: "practical", prior_experience: "unsure", provider_sharing: true, source_ids: [] } });
  expect((h.saved[0] as { planning?: unknown }).planning).toBeUndefined();
  expect(h.sent).toHaveLength(1);
  expect(h.questions.some(question => question.toLowerCase().includes("subject"))).toBe(false);
});

test("exam objective skips the goal prompt; cancellation saves nothing and ordinary intake does not depend on a planner", async () => {
  const exam = await intakeHarness();
  await exam.commands.get("exam")!.handler("Python interview", exam.ctx);
  expect(exam.questions).toHaveLength(0);
  expect(exam.requests).toEqual([]);
  expect(exam.saved[0]).toMatchObject({ body: { objective: "Python interview", mode: "exam" } });
  const independent = await intakeHarness({ fail: true });
  await independent.commands.get("learn")!.handler("", independent.ctx);
  expect(independent.saved).toHaveLength(1);
  expect(independent.requests).toEqual([]);
  const cancelled = await intakeHarness({ answers: [undefined] });
  await cancelled.commands.get("learn")!.handler("", cancelled.ctx);
  expect(cancelled.saved).toEqual([]); expect(cancelled.sent).toEqual([]);
});

test("cram intake and its plan toggle avoid a mandatory planner without losing the teaching start", async () => {
  const h = await intakeHarness();
  const { profilePreferences } = await import("../../core/src/experience.ts");
  h.setPacket({ goal: { revision_id: "previous", body: { ...draft.goal, learning_preferences: profilePreferences("cram") } } });
  await h.commands.get("sage")!.handler("exam Python interview", h.ctx);
  expect(h.requests).toEqual([]);
  expect(h.saved[0]).toMatchObject({ body: { mode: "exam", subject: "computing", learning_preferences: { profile: "cram", features: { planner: false } } } });
  expect(h.sent[0]).toContain("Planning delegation is off");
  h.setPacket({ goal: { revision_id: "goal-1", body: { ...draft.goal, provider_sharing: true, learning_preferences: profilePreferences("cram") } } });
  await expect(h.tools.get("learning_define")!.execute("plan", { operation_id: "plan", kind: "plan", expected_goal_revision_id: "goal-1", body: { goal_revision_id: "goal-1", component_revision_ids: [], ...draft.outline } }, new AbortController().signal, undefined, h.ctx)).rejects.toThrow("off");
  expect(h.requests).toEqual([]);
});

test("tutor plan tool delegates consequential replanning and reuses completed operation receipts", async () => {
  const h = await intakeHarness();
  h.setPacket({ goal: { revision_id: "goal-1", body: { ...draft.goal, mode: "learn", objective: "Learn Python", provider_sharing: true } } });
  const tool = h.tools.get("learning_define")!;
  const proposal = { operation_id: "plan-1", kind: "plan", expected_goal_revision_id: "goal-1", body: { goal_revision_id: "goal-1", component_revision_ids: [], ...draft.outline } };
  const first = await tool.execute("call-1", proposal, new AbortController().signal, undefined, h.ctx);
  const second = await tool.execute("call-2", proposal, new AbortController().signal, undefined, h.ctx);
  expect(second).toEqual(first);
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]!.reason).toBe("replan");
  const stale = await intakeHarness(); stale.setPacket({ goal: { revision_id: "new-goal", body: { provider_sharing: true } } });
  await expect(stale.tools.get("learning_define")!.execute("stale", proposal, new AbortController().signal, undefined, stale.ctx)).rejects.toThrow("changed");
  expect(stale.requests).toEqual([]);
});
