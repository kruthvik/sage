import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTutorExtension, type TutorBridge, type TutorExtensionOptions } from "../src/tutor.ts";

const inertBridge: TutorBridge = { operation: async () => ({}), input: async () => ({}), goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {} };
function tools(options: TutorExtensionOptions = {}, bridge = inertBridge) {
  const registered: ToolDefinition[] = [];
  // Test the public registration contract; no terminal/session/provider is launched.
  createTutorExtension(bridge, options)({ registerTool: (tool: ToolDefinition) => { registered.push(tool); }, on: () => {}, registerCommand: () => {} } as unknown as ExtensionAPI);
  return registered;
}
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const context = { isError: false } as RenderContext;
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
function render(tool: ToolDefinition, text: string, expanded = false, isError = false, isPartial = false) {
  return tool.renderResult!(result(text), { expanded, isPartial }, theme, { ...context, isError }).render(160).join("\n");
}

test("all seven native educational tools register working compact and expandable renderers", () => {
  const registered = tools(); expect(registered).toHaveLength(7);
  for (const tool of registered) {
    expect(typeof tool.renderCall).toBe("function"); expect(typeof tool.renderResult).toBe("function");
    expect(tool.renderCall!({}, theme, context).render(40).join("\n")).toContain(tool.name);
    const text = JSON.stringify({ detail: "Detailed evidence remains available", kind: "assessment", payload: { outcome: "partial" } });
    const before = result(text);
    expect(tool.renderResult!(before, { expanded: false, isPartial: false }, theme, context).render(160).join("\n")).not.toContain("Detailed evidence remains available");
    expect(tool.renderResult!(before, { expanded: true, isPartial: false }, theme, context).render(160).join("\n")).toContain("Detailed evidence remains available");
    expect(before.content[0]!.text).toBe(text);
  }
});

test("native assessment summaries preserve the backend mark and proposal authority, not flattering feedback", () => {
  const tool = tools().find(t => t.name === "learning_record")!;
  const text = JSON.stringify({ kind: "assessment", payload: { outcome: "partial", assessor: "pi_rubric_proposal", marking_summary: { earned: 85, maximum: 100, percentage: 85 }, feedback: "Encouraging words: full marks!" } });
  expect(render(tool, text)).toContain("85/100"); expect(render(tool, text)).toContain("proposal");
  expect(render(tool, text)).not.toContain("full marks");
});

test("error, partial, cancellation and waiting render states never imply saved successful evidence", () => {
  const tool = tools().find(t => t.name === "learning_activity")!;
  expect(render(tool, "Failure details", false, true)).toContain("failed");
  expect(render(tool, "Failure details", false, true)).not.toContain("✓");
  expect(render(tool, "Partial details", false, false, true)).toContain("Working");
  expect(render(tool, JSON.stringify({ cancelled: true, evidence_recorded: false }))).toContain("Cancelled");
  expect(render(tool, JSON.stringify({ awaiting_submission: true }))).toContain("Waiting");
});

test("native teaching awaiting continuation renders pending release, never a saved activity receipt", () => {
  const tool = tools().find(t => t.name === "learning_activity")!;
  for (const expanded of [false, true]) for (const cancelled of [false, true]) {
    const text = JSON.stringify({ awaiting_continuation: true, cancelled, unit_id: "pinned-unit" });
    const before = result(text), original = JSON.stringify(before);
    const rendered = tool.renderResult!(before, { expanded, isPartial: false }, theme, context).render(160).join("\n");
    expect(rendered).toContain("Waiting for explicit continuation.");
    expect(rendered).not.toContain("Activity receipt saved");
    expect(JSON.stringify(before)).toBe(original);
  }
  expect(render(tool, JSON.stringify({ response_event_id: "owned-response", attempt_id: "owned-attempt" }))).toContain("Activity receipt saved; assessment is separate");
  expect(render(tool, JSON.stringify({ awaiting_submission: true }))).toContain("Waiting for learner work");
  expect(render(tool, JSON.stringify({ cancelled: true }))).toContain("Cancelled; no learner evidence recorded");
});

test("terminal-control input is sanitized without mutating tool result data", () => {
  const tool = tools().find(t => t.name === "learning_define")!;
  const text = JSON.stringify({ kind: "task_definition", body: { title: "\u001b[2JMalicious title\u001b]52;c;payload\u0007" } });
  const rendered = render(tool, text); expect(rendered).toContain("Malicious title");
  expect(rendered).not.toContain("\u001b"); expect(rendered).not.toContain("payload");
  expect(JSON.parse(text).body.title).toContain("\u001b");
});

const toolContext = { sessionManager: { getSessionId: () => "owned-render-session" }, ui: { notify() {} } } as unknown as ExtensionToolContext;
const textOf = (value: Awaited<ReturnType<ToolDefinition["execute"]>>) => value.content.filter(c => c.type === "text").map(c => c.text).join("\n");

test("e02s02 task 1: registered task feedback consent and errors expand without changing native identity or pairing", async () => {
  const task = { kind: "task_definition", revision_id: "owned-task", body: { title: "Find the derivative", prompt: "Differentiate x²", consent: "Review this generated task before submitting work" } };
  const assessment = { kind: "assessment", payload: { outcome: "partial", assessor: "pi_rubric_proposal", marking_summary: { earned: 1, maximum: 2 }, feedback: "Include the power-rule step", consent: "Provider sharing is off; this is not permission to send work" } };
  const calls: unknown[] = [];
  const registered = tools({}, { ...inertBridge, operation: async (name, args, owner) => {
    calls.push({ name, args, owner });
    if (name === "learning_source") throw new Error("Provider sharing is disabled; obtain explicit learner consent");
    return name === "learning_define" ? task : assessment;
  } });
  const pairingHome = await mkdtemp(join(tmpdir(), "sage-pairing-home-"));
  const manager = await withOwnedHome(pairingHome, async () => {
    try {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      return SessionManager.inMemory();
    } finally { await rm(pairingHome, { recursive: true, force: true }); }
  });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const [name, args, expected] of [["learning_define", { kind: "task_definition" }, task], ["learning_record", { kind: "assessment" }, assessment]] as const) {
    const tool = registered.find(t => t.name === name)!;
    const id = `owned-${name}`;
    const output = await tool.execute(id, args, undefined, undefined, toolContext);
    const text = textOf(output), original = JSON.stringify(output);
    expect(JSON.parse(text)).toEqual(expected);
    expect(tool.renderCall!(args, theme, context).render(160).join("\n")).toContain(name);
    expect(render(tool, text)).toContain(name === "learning_define" ? "Find the derivative" : "1/2 · rubric proposal · partial");
    for (const detail of name === "learning_define" ? [task.body.prompt, task.body.consent] : [assessment.payload.feedback, assessment.payload.consent]) expect(render(tool, text, true).replace(/\s+/g, " ")).toContain(detail);
    expect(JSON.stringify(output)).toBe(original);
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "openai-completions", provider: "offline", model: "fixture", usage, stopReason: "toolUse", timestamp: 1 });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: output.content, isError: false, timestamp: 2 });
  }
  const source = registered.find(t => t.name === "learning_source")!;
  let errorText = "";
  try { await source.execute("denied", {}, undefined, undefined, toolContext); } catch (error) { errorText = (error as Error).message; }
  expect(errorText).toContain("explicit learner consent");
  expect(render(source, errorText, false, true)).toContain("learning_source failed");
  expect(render(source, errorText, true, true)).toContain(errorText);
  const messages = manager.buildSessionContext().messages;
  for (const name of ["learning_define", "learning_record"]) {
    expect(messages.find(m => m.role === "toolResult" && m.toolName === name)).toMatchObject({ toolCallId: `owned-${name}`, isError: false });
    expect(messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.id === `owned-${name}` && c.name === name))).toBe(true);
  }
  expect(calls).toHaveLength(3);
  expect(calls.every(call => (call as { owner: string }).owner === "owned-render-session")).toBe(true);
});

test("e02s02 task 1: registered selected reader rejects traversal ambiguity junction escape bounds UTF8 and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-render-resource-"));
  try {
    const dir = join(root, "selected"); await mkdir(dir);
    const filePath = join(dir, "SKILL.md"); await writeFile(filePath, "# Owned trusted guidance\nNot learner evidence or permission");
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "private.md"), "NOT SELECTED");
    await symlink(outside, join(dir, "escape"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(dir, "limit.md"), "é".repeat(16384));
    await writeFile(join(dir, "large.md"), "x".repeat(32769));
    await writeFile(join(dir, "invalid.md"), Buffer.from([0xff]));
    await writeFile(join(dir, "nul.md"), "not\0text");
    let selected = [{ name: "owned", description: "Selected trusted Markdown", filePath }];
    let bridgeCalls = 0;
    const tool = tools({ skills: () => selected }, { ...inertBridge, operation: async () => { bridgeCalls++; throw new Error("Resources cannot write evidence"); } }).find(t => t.name === "learning_skill")!;
    const execute = (args: Record<string, unknown>, signal?: AbortSignal) => tool.execute("selected-read", args, signal, undefined, toolContext);
    expect(JSON.parse(textOf(await execute({})))).toEqual({ skills: [{ name: "owned", description: "Selected trusted Markdown" }], omitted_count: 0 });
    const full = await execute({ name: "owned" });
    expect(render(tool, textOf(full), true)).toContain("Not learner evidence or permission");
    expect(render(tool, textOf(full))).toContain("Selected skill guidance loaded");
    expect(JSON.parse(textOf(await execute({ name: "owned", reference: "limit.md" }))).text).toBe("é".repeat(16384));
    for (const reference of ["../outside/private.md", "..\\outside\\private.md", "C:\\private.md", join(outside, "private.md"), "escape/private.md", "script.ts", "large.md", "invalid.md", "nul.md"]) {
      await expect(execute({ name: "owned", reference })).rejects.toThrow();
    }
    await expect(execute({ name: "ambient" })).rejects.toThrow("selected");
    await expect(execute({ reference: "SKILL.md" })).rejects.toThrow("selected skill name");
    selected = [...selected, ...selected]; await expect(execute({ name: "owned" })).rejects.toThrow("unique"); selected = selected.slice(0, 1);
    const controller = new AbortController(); controller.abort(new Error("Owned cancellation"));
    await expect(execute({ name: "owned" }, controller.signal)).rejects.toThrow("Owned cancellation");
    selected = Array.from({ length: 41 }, (_, i) => ({ name: `owned-${i}`, description: "d".repeat(501), filePath }));
    const bounded = JSON.parse(textOf(await execute({}))); expect(bounded.skills).toHaveLength(40); expect(bounded.omitted_count).toBe(1); expect(bounded.skills[0].description).toHaveLength(500);
    expect(await readFile(filePath, "utf8")).toBe("# Owned trusted guidance\nNot learner evidence or permission");
    expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "escape", "invalid.md", "large.md", "limit.md", "nul.md"]);
    expect(bridgeCalls).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const homeVariables = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
async function withOwnedHome<T>(home: string, work: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true });
  const previous = homeVariables.map(key => [key, process.env[key]] as const);
  const drive = win32.parse(home).root.replace(/[\\/]$/, "");
  try {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) });
    expect(process.env.HOME).toBe(home);
    expect(resolve(homedir())).toBe(resolve(home));
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const [key, value] of previous) expect(process.env[key]).toBe(value);
  }
}

test("e02s02 task 1: owned home isolation restores values and absence even when disposal throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-resource-home-"));
  const previousHomePath = process.env.HOMEPATH;
  try {
    delete process.env.HOMEPATH;
    await expect(withOwnedHome(join(root, "credential-free"), async () => {
      try { expect(await readdir(homedir())).toEqual([]); }
      finally { throw new Error("Owned disposal failure"); }
    })).rejects.toThrow("Owned disposal failure");
    expect(process.env.HOMEPATH).toBeUndefined();
  } finally {
    if (previousHomePath === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = previousHomePath;
    await rm(root, { recursive: true, force: true });
  }
});

test("e02s02 task 1: production native loader supplies on-demand selected Markdown to the actual tool without model or learner writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-native-resource-"));
  try {
    await withOwnedHome(join(root, "credential-free"), async () => {
      const { createSagePaths } = await import("../../runtime/src/paths.ts");
      const { bootstrapSageHome } = await import("../../runtime/src/bootstrap.ts");
      const { loadPi } = await import("../src/sdk.ts");
      const { createTutorRuntime } = await import("../src/tutor.ts");
      const paths = createSagePaths({ home: join(root, "home"), cwd: root }); await bootstrapSageHome(paths);
      const dir = join(paths.agent, "skills", "owned-task1"); await mkdir(join(dir, "references"), { recursive: true });
      const document = "---\nname: owned-task1\ndescription: Owned selected task1 guidance\n---\n# Selected guidance\nNot learner work, consent or execution.";
      await writeFile(join(dir, "SKILL.md"), document); await writeFile(join(dir, "references", "feedback.md"), "Criterion-specific feedback, not fabricated performance.");
      const ancestorSkill = join(root, ".agents", "skills", "owned-ancestor-route"); await mkdir(ancestorSkill, { recursive: true });
      await writeFile(join(ancestorSkill, "SKILL.md"), "---\nname: owned-ancestor-route\ndescription: Owned ancestor discovery sentinel\n---\nNot explicitly selected.");
      const sdk = await loadPi(paths);
      // HOME alone cannot contain ancestor discovery; public untrusted settings disable it.
      const settings = sdk.SettingsManager.create(paths.config, paths.agent, { projectTrusted: false });
      expect(settings.isProjectTrusted()).toBe(false);
      expect(settings.getPackages()).toEqual([]);
      const models = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      let writes = 0;
      const forbidden = async () => { writes++; throw new Error("No provider or learner writes allowed"); };
      const runtime = await createTutorRuntime(paths, { ...inertBridge, operation: async (name) => name === "learning_context" ? { goal: null } : forbidden(), input: forbidden, goal: forbidden, calls: forbidden }, { ...sdk, createAgentSessionServices: options => {
        expect(options?.settingsManager?.isProjectTrusted()).toBe(false);
        return sdk.createAgentSessionServices({ ...options, modelRuntime: models });
      } });
      try {
        expect(runtime.services.resourceLoader.getSkills().skills.some(skill => skill.name === "owned-ancestor-route")).toBe(false);
        const tool = runtime.session.agent.state.tools.find(t => t.name === "learning_skill")!;
        const signal = new AbortController().signal;
        const metadata = await tool.execute("native-list", {}, signal);
        expect(JSON.parse(textOf(metadata)).skills).toContainEqual({ name: "owned-task1", description: "Owned selected task1 guidance" });
        const output = await tool.execute("native-read", { name: "owned-task1" }, signal);
        expect(JSON.parse(textOf(output))).toMatchObject({ name: "owned-task1", text: document, provenance: expect.stringContaining("not learner evidence") });
        expect(JSON.parse(textOf(await tool.execute("native-reference", { name: "owned-task1", reference: "references/feedback.md" }, signal))).text).toBe("Criterion-specific feedback, not fabricated performance.");
        await expect(tool.execute("native-denied", { name: "not-selected" }, signal)).rejects.toThrow("selected");
        expect(runtime.session.getActiveToolNames()).toHaveLength(7);
        expect(runtime.session.sessionManager.getEntries().filter(e => e.type === "message")).toEqual([]);
        expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(document);
        expect(writes).toBe(0);
      } finally { await runtime.dispose(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
