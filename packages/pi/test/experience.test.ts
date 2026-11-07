import { expect, test } from "bun:test";
import type { ExtensionContext, ExtensionAPI, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTutorExtension, type TutorBridge } from "../src/tutor.ts";
import { learningPreview } from "../src/experience.ts";

test("learning preview uses a radio profile and independent feature switches with editable parameters", async () => {
  const menus: string[][] = []; let turn = 0;
  const ctx = { hasUI: true, ui: { select: async (_title: string, options: string[]) => {
    menus.push(options); const wanted = ["Cram", "MCQ", "Specific learning parameters", "Start with these settings"][turn++]!;
    return options.find(option => option.includes(wanted));
  }, editor: async () => "Exam tomorrow. Prioritize proofs and precise notation." } } as unknown as ExtensionContext;
  const result = await learningPreview(ctx);
  expect(result?.profile).toBe("cram");
  expect(result?.features.mcq).toBe(false);
  expect(result?.features.planner).toBe(false);
  expect(result?.parameters).toContain("precise notation");
  expect(menus[0]?.some(option => option.includes("○"))).toBe(true);
  expect(menus[0]?.some(option => option.includes("☑"))).toBe(true);
});

test("one render_ui tool returns a URL and resumes the tutor only after a real host receipt", async () => {
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, RegisteredCommand>(), sent: string[] = [];
  let resume: ((receipt: Record<string, unknown>) => void) | undefined;
  const bridge: TutorBridge = { operation: async () => ({}), input: async () => ({}), goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {}, renderUi: async (_source, _session, done) => { resume = done; return { id: "ui", url: "http://127.0.0.1:123/ui/capability", awaiting_submission: true }; } };
  const api = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command), on: () => () => {}, sendUserMessage: (text: string) => { sent.push(text); } } as unknown as ExtensionAPI;
  await createTutorExtension(bridge, { uiInstructions: async () => "On-demand UI DSL and design instructions" })(api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "fixture" }, ui: { notify() {} } } as unknown as ExtensionToolContext;
  const help = await tools.get("render_ui")!.execute("help", {}, new AbortController().signal, undefined, ctx);
  expect(JSON.stringify(help)).toContain("On-demand UI DSL");
  expect(resume).toBeUndefined();
  const result = await tools.get("render_ui")!.execute("call", { source: 'text "Work"' }, new AbortController().signal, undefined, ctx);
  expect(JSON.stringify(result)).toContain("http://127.0.0.1");
  expect(sent).toEqual([]);
  resume!({ response_event_id: "actual-response", attempt_id: "actual-attempt", review_required: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("review");
  resume!({ response_event_id: "other-work", review_required: false });
  expect(sent[1]).toContain("off");
  for (const name of ["sage", "continue", "studio", "extensions", "theme"]) expect(commands.has(name)).toBe(true);
});

test("recorded feedback is queued natively and acknowledged before another automatic teaching move", async () => {
  const tools = new Map<string, ToolDefinition>(), notices: string[] = [];
  let displayed = false;
  const bridge: TutorBridge = { operation: async () => ({ event_id: "assessment" }), input: async () => ({}), goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {}, feedback: async (_sid, receipt) => { if (receipt) displayed = true; return displayed ? {} : { text: "Specific flaw and actionable repair" }; } };
  const api = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, on: () => () => {} } as unknown as ExtensionAPI;
  await createTutorExtension(bridge)(api);
  const ctx = { sessionManager: { getSessionId: () => "fixture" }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionToolContext;
  await tools.get("learning_record")!.execute("assessment", { operation_id: "assessment", kind: "assessment", expected_goal_revision_id: "goal", payload: { attempt_id: "attempt", rubric_revision_id: "rubric", outcome: "partial", scores: [{ dimension: "target", score: 1, evidence: "actual words" }], feedback: "Specific flaw", uncertainty: "Semantic proposal", feedback_review: { ready_to_continue: false, issues: [] } } }, new AbortController().signal, undefined, ctx);
  expect(notices).toEqual(["Specific flaw and actionable repair"]);
  expect(displayed).toBe(true);
});

test("cancelled preview changes no settings; noninteractive use has bounded defaults", async () => {
  expect(await learningPreview({ hasUI: true, ui: { select: async () => undefined } } as unknown as ExtensionContext)).toBeUndefined();
  expect((await learningPreview({ hasUI: false } as unknown as ExtensionContext))?.profile).toBe("balanced");
});
