import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { RecordSchema, eventBodies, validate } from "../../core/src/contracts.ts";
import { createTutorExtension, type TutorBridge } from "../src/tutor.ts";
import { nativeToolPresentation } from "../src/presentation.ts";
import { requestLearning } from "../../runtime/src/service.ts";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const invalidKinds = ["round", "observation", "evaluation", "guided_attempt", "independent_attempt"];
const common = { operation_id: "synthetic-operation", expected_goal_revision_id: "synthetic-goal" };
function fixture() {
  const tools = new Map<string, ToolDefinition>(), writes: unknown[] = [], queued: unknown[] = [];
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<unknown> }>();
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  const bridge: TutorBridge = { operation: async (_name, body) => { writes.push(body); return {}; }, input: async () => {}, goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {} };
  createTutorExtension(bridge)({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<unknown> }) { commands.set(name, command); }, sendUserMessage(content: unknown, options: unknown) { queued.push({ content, options }); }, on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  return { tool: tools.get("learning_record")!, tools, writes, handlers, bridge, queued, commands };
}

test("record recovery: advertised tool has an object root and exact event-kind enum without changing authority", () => {
  const { tool, tools } = fixture(), parameters = tool.parameters as unknown as { type: string; properties: { kind: { enum: string[] } } };
  expect(parameters.type).toBe("object");
  expect(parameters.properties.kind.enum).toEqual(Object.keys(eventBodies));
  expect(tools.size).toBe(7);
  expect(tool.description).toContain("not lesson setup");
  const valid = { ...common, kind: "attempt_submitted", payload: { attempt_id: "attempt", instance_revision_id: "instance", response_event_id: "actual-host-response", declared_aids: [] } };
  for (const input of [valid, { ...valid, kind: "assessment" }, { ...valid, payload: {} }, { ...valid, extra: true }, ...invalidKinds.map(kind => ({ ...valid, kind }))]) expect(Value.Check(tool.parameters, input)).toBe(Value.Check(RecordSchema, input));
});

test("record recovery: unknown kinds enumerate real names without repeating private arguments", () => {
  for (const kind of invalidKinds) {
    let error = "";
    try { validate(RecordSchema, { ...common, kind, payload: { note: "PRIVATE-MARKER" } }); } catch (cause) { error = (cause as Error).message; }
    expect(error).toContain("attempt_submitted");
    expect(error).toContain("assessment");
    expect(error).not.toContain("PRIVATE-MARKER");
  }
});

test("record recovery: guessed kinds and mismatched payloads cannot reach execution", () => {
  const { tool, writes } = fixture();
  expect(typeof tool.prepareArguments).toBe("function");
  for (const kind of invalidKinds) {
    expect(() => tool.prepareArguments!({ ...common, kind, payload: { text: "PRIVATE-MARKER" } })).toThrow("attempt_submitted");
  }
  const mismatched = { ...common, kind: "assessment", payload: { attempt_id: "attempt", instance_revision_id: "instance", response_event_id: "response", declared_aids: [] } };
  expect(Value.Check(tool.parameters, tool.prepareArguments!(mismatched))).toBe(false);
  expect(writes).toEqual([]);
});

test("record recovery: pre-validation leaves legitimate optional-null normalization to the SDK", () => {
  const { tool } = fixture();
  const input = { ...common, kind: "attempt_submitted", occurred_at: null, payload: { attempt_id: "attempt", instance_revision_id: "instance", response_event_id: "response", declared_aids: [] } };
  expect(tool.prepareArguments!(input)).toBe(input);
  expect(input.occurred_at).toBeNull();
  expect(Value.Check(RecordSchema, input)).toBe(false); // The SDK must normalize before full validation.
});

test("record recovery: valid payloads retain pinned IDs and stable operation identity", () => {
  const { tool } = fixture();
  expect(typeof tool.prepareArguments).toBe("function");
  const payloads = {
    attempt_submitted: { attempt_id: "attempt", instance_revision_id: "instance", response_event_id: "response", declared_aids: [] },
    step_attempt: { step_attempt_id: "step", attempt_id: "attempt", step: "Actual step", response_event_id: "response", prior_step_ids: [] },
    assistance: { assistance_id: "help", instance_revision_id: "instance", component_revision_ids: [], stage: "offered", kind: "hint", content: "A possible hint", answer_bearing: false },
    assessment: { attempt_id: "attempt", rubric_revision_id: "rubric", outcome: "partial", scores: [], feedback: "A criterion gap", uncertainty: "Provisional rubric judgment" },
    review_scheduled: { component_revision_id: "component", due_at: "2026-10-20T12:00:00.000Z", consent: true, consent_response_event_id: "response", reason: "Learner authorization required by host" },
    checkpoint: { goal_revision_id: "goal", summary: "Saved scope", next_action: "Continue teaching", gaps: [], stopped: false },
    decision: { reason: "A useful next move", evidence_event_ids: [], action: "selection" },
    review_completed: { schedule_event_id: "schedule", assessment_event_id: "assessment" },
  };
  for (const [kind, payload] of Object.entries(payloads)) {
    const input = { ...common, kind, payload }, original = JSON.stringify(input);
    expect(tool.prepareArguments!(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(original);
  }
});

test("record recovery: compact native failures show a bounded sanitized cause without dumping later details", () => {
  const render = nativeToolPresentation("learning_record").renderResult!;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  type Context = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
  const result = { content: [{ type: "text" as const, text: "\u001b[31mUnsupported operation kind; use attempt_submitted\u001b[0m\nPRIVATE-DETAIL" }], details: undefined };
  const compact = render(result, { expanded: false, isPartial: false }, theme, { isError: true } as Context).render(200).join("\n");
  expect(compact).toContain("attempt_submitted"); expect(compact).not.toContain("PRIVATE-DETAIL"); expect(compact).not.toContain("\u001b");
});

test("record recovery: a local socket drop after a saved write is labeled locally and never replayed", async () => {
  const f = learningFixture(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++; const input = await request.json() as { body: unknown; session_id: string };
    f.store.define(input.body, "pi", input.session_id);
    server.stop(true);
    return Response.json({ ok: true });
  } });
  cleanup.push(() => { server.stop(true); f.store.close(); });
  const before = f.store.revisions("component").length;
  const body = { operation_id: "saved-before-socket-drop", kind: "component", expected_goal_revision_id: f.goal.revision_id, body: { ...f.component.body, title: "Saved despite lost response" } };
  await expect(requestLearning({ url: `http://127.0.0.1:${server.port}`, token: "owned-offline", telemetryToken: "owned-offline" }, "learning_define", body, "test")).rejects.toThrow("Local learning service");
  expect(requests).toBe(1); expect(f.store.revisions("component")).toHaveLength(before + 1);
  expect(f.store.integrity()).toEqual(["ok"]);
});

test("record recovery: provider socket failures identify the selected model without echoing payloads or claiming a reset", async () => {
  const { handlers, writes } = fixture(), notices: string[] = [];
  expect(typeof handlers.get("message_end")).toBe("function");
  const ctx = { model: { provider: "google", id: "gemini-synthetic" }, ui: { notify: (text: string) => notices.push(text) } };
  await handlers.get("message_end")!({ message: { role: "assistant", stopReason: "error", errorMessage: "The socket connection was closed unexpectedly. PRIVATE-PAYLOAD" } }, ctx);
  expect(notices.join(" ")).toContain("google/gemini-synthetic"); expect(notices.join(" ")).toContain("saved state"); expect(notices.join(" ")).not.toContain("PRIVATE-PAYLOAD");
  const count = notices.length;
  for (const message of [{ role: "assistant", stopReason: "stop", content: "socket connection was closed" }, { role: "assistant", stopReason: "error", errorMessage: "Invalid tool schema" }]) await handlers.get("message_end")!({ message }, ctx);
  expect(notices).toHaveLength(count); expect(writes).toEqual([]);
});

function connectionFixture() {
  const f = fixture(), notices: string[] = [];
  let owner = "owned-session", revision = "owned:goal:1", pending = false;
  f.bridge.authorize = async () => ({ session_id: owner, revision, packet: {} });
  const ctx = { sessionManager: { getSessionId: () => owner }, hasPendingMessages: () => pending, model: { provider: "google", id: "synthetic" }, ui: { notify: (text: string) => notices.push(text) }, abort() {} };
  const failure = { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "The socket connection was closed unexpectedly. PRIVATE-PAYLOAD" } };
  return { ...f, ctx, notices, failure, switchSession: () => { owner = "different-session"; }, changeScope: () => { revision = "owned:goal:2"; }, queueInput: () => { pending = true; } };
}

test("connection recovery: one empty transport failure queues an authorized host continuation, never saved writes", async () => {
  const f = connectionFixture();
  await f.handlers.get("before_provider_request")!({ payload: {} }, f.ctx);
  await f.handlers.get("message_end")!(f.failure, f.ctx);
  expect(f.queued).toHaveLength(1);
  expect(JSON.stringify(f.queued)).toContain("not learner work");
  expect(JSON.stringify(f.queued)).toContain("followUp");
  expect(JSON.stringify(f.queued)).not.toContain("PRIVATE-PAYLOAD");
  expect(f.notices.join(" ")).toContain("once");
  await f.handlers.get("message_end")!(f.failure, f.ctx);
  expect(f.queued).toHaveLength(1);
  expect(f.writes).toEqual([]);
});

for (const boundary of ["scope", "session", "revoked", "pending", "partial", "tool", "schema", "quota", "unobserved"] as const) test(`connection recovery: ${boundary} never queues an automatic continuation`, async () => {
  const f = connectionFixture();
  if (boundary !== "unobserved") await f.handlers.get("before_provider_request")!({ payload: {} }, f.ctx);
  if (boundary === "scope") f.changeScope();
  if (boundary === "session") f.switchSession();
  if (boundary === "revoked") f.bridge.authorize = async () => { throw new Error("Sharing revoked"); };
  if (boundary === "pending") f.queueInput();
  if (boundary === "partial") Object.assign(f.failure.message, { content: [{ type: "text", text: "Partial reply" }] });
  if (boundary === "tool") Object.assign(f.failure.message, { content: [{ type: "toolCall", name: "learning_define", arguments: {} }] });
  if (boundary === "schema") f.failure.message.errorMessage = "fetch failed: invalid tool schema HTTP 400";
  if (boundary === "quota") f.failure.message.errorMessage = "fetch failed HTTP 429 quota exceeded";
  await f.handlers.get("message_end")!(f.failure, f.ctx);
  expect(f.queued).toEqual([]); expect(f.writes).toEqual([]);
});

for (const action of ["stop", "shutdown"] as const) test(`connection recovery: ${action} during authorization prevents the queued continuation`, async () => {
  const f = connectionFixture();
  await f.handlers.get("before_provider_request")!({ payload: {} }, f.ctx);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const authorize = f.bridge.authorize!;
  f.bridge.authorize = async owner => { const permit = await authorize(owner); enter(); await waiting; return permit; };
  const recovery = f.handlers.get("message_end")!(f.failure, f.ctx);
  await entered;
  if (action === "stop") await f.commands.get("stop")!.handler("", f.ctx);
  else await f.handlers.get("session_shutdown")!({}, f.ctx);
  release(); await recovery;
  expect(f.queued).toEqual([]); expect(f.writes).toEqual([]);
});

test("record recovery: backend rejections remain precise while malformed local responses are distinguished", async () => {
  let malformed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return malformed ? new Response("PRIVATE-INVALID-RESPONSE") : Response.json({ error: "Pinned task mismatch" }, { status: 400 }); } });
  cleanup.push(() => server.stop(true));
  const connection = { url: `http://127.0.0.1:${server.port}`, token: "offline", telemetryToken: "offline" };
  await expect(requestLearning(connection, "learning_record", {}, "owned")).rejects.toThrow("Pinned task mismatch");
  malformed = true;
  await expect(requestLearning(connection, "learning_record", {}, "owned")).rejects.toThrow("Local learning service");
});
