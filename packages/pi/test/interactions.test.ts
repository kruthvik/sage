import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, RegisteredCommand, ToolDefinition, InputEvent } from "@earendil-works/pi-coding-agent";
import { registerActivityInterface } from "../src/interactions.ts";
import { createTutorExtension, type TutorBridge } from "../src/tutor.ts";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";
import { prepareActivity, submitActivity, readFeynmanReview, saveFeynmanReview } from "../../runtime/src/interactions.ts";
import { captureInput } from "../../runtime/src/submissions.ts";
import { skipLearningTask } from "../../runtime/src/learning-controller.ts";
import { projectLearningState } from "../../runtime/src/learning-state.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import type { FeynmanRequest } from "../../core/src/feynman.ts";

const roots: string[] = [];
const stores: Array<ReturnType<typeof learningFixture>["store"]> = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function harness(format: "mcq" | "explain" = "mcq") {
  const f = learningFixture(); stores.push(f.store);
  const root = await mkdtemp(join(tmpdir(), "sage-activity-ui-")); roots.push(root);
  const paths = createSagePaths({ home: root });
  const definition = f.task(format === "mcq" ? "Which method preserves equality?" : "Explain why changing both sides preserves equality.", format === "mcq" ? {
    format: "mcq", scoring: "exact", answer: "B", choices: [{ id: "A", text: "Change just one side" }, { id: "B", text: "Change both sides equally" }],
  } : { format: "explain" });
  const instance = f.deliver(definition);
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, RegisteredCommand>();
  const hooks = new Map<string, (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>>();
  const sent: string[] = [], notices: string[] = [], selections: string[][] = [], widgets: unknown[] = [], requests: FeynmanRequest[] = [];
  let choose = true, explanation: string | undefined = "Both sides stay equal because I make the same change.", consent = true, fail = false;
  const api = { registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    on(name: string, handler: (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>) { hooks.set(name, handler); return () => {}; }, sendUserMessage(text: string) { sent.push(text); } } as unknown as ExtensionAPI;
  const bridge: TutorBridge = {
    operation: async (name, body) => name === "learning_activity" ? prepareActivity(f.store, body, "test") : { goal: f.goal, task: { instance }, learning_state: projectLearningState(f.store, "test") },
    // Input-sharing fixture only; production arrival admission is tested with the real host.
    inputAdmission: () => ({ assertCurrent() {}, assertScopeCurrent() {}, goalCreated() {} }),
    input: (text, session, images, instanceId, admission) => captureInput(f.store, paths, text, session, images, instanceId, undefined, () => admission?.assertCurrent()),
    activitySubmit: async (request, submission, session) => submitActivity(f.store, request, submission, session),
    feynmanResult: async (request, session) => readFeynmanReview(f.store, request, session),
    saveFeynman: async (request, review, session) => saveFeynmanReview(f.store, request, review, session),
    goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {},
  };
  const options = { feynman: async (request: FeynmanRequest) => { requests.push(request); if (fail) throw new Error("Provider offline"); return { summary: "A relation is explained", strengths: ["Both sides are considered"], gaps: [], follow_up: "What if you changed only one side?", uncertainty: "Explanation only; application untested" }; } };
  const activity = registerActivityInterface(api, bridge, options);
  const ctx = { hasUI: true, mode: "rpc", model: { id: "offline", provider: "offline", input: ["text", "image"] }, isIdle: () => true, sessionManager: { getSessionId: () => "test" },
    ui: { select: async (_title: string, labels: string[]) => { selections.push(labels); return choose ? labels[1] : undefined; }, editor: async () => explanation,
      confirm: async () => consent, notify: (text: string) => { notices.push(text); }, setStatus() {}, setWidget: (...args: unknown[]) => { widgets.push(args); } },
  } as unknown as ExtensionToolContext;
  const request = { action: format === "mcq" ? "mcq" as const : "feynman" as const, operation_id: "ui-1", expected_goal_revision_id: f.goal.revision_id, instance_revision_id: instance.revision_id };
  const execute = async (input: unknown = request) => tools.get("learning_activity")!.execute("call", input, new AbortController().signal, undefined, ctx);
  return { f, definition, paths, api, bridge, options, activity, ctx, request, execute, tools, commands, hooks, sent, notices, selections, widgets, requests,
    cancel: () => { choose = false; explanation = undefined; }, deny: () => { consent = false; }, failChild: () => { fail = true; } };
}

test("MCQ selector displays frozen choices, captures actual selection once and cancellation makes no attempt", async () => {
  const h = await harness();
  const first = await h.execute(); const second = await h.execute();
  expect(JSON.parse((second.content[0] as { text: string }).text)).toEqual(JSON.parse((first.content[0] as { text: string }).text));
  expect(h.selections).toEqual([["A. Change just one side", "B. Change both sides equally"]]);
  expect(h.f.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(1);
  expect(h.f.store.events().find(e => e.kind === "learner_response")?.payload.selected_choice_id).toBe("B");
  const cancelled = await harness(); cancelled.cancel(); const seq = cancelled.f.store.throughSeq;
  expect(JSON.parse(((await cancelled.execute()).content[0] as { text: string }).text)).toMatchObject({ cancelled: true, evidence_recorded: false });
  expect(cancelled.f.store.throughSeq).toBe(seq);
});

test("Feynman editor uses actual learner words, saves a novice clarification and does not grade", async () => {
  const h = await harness("explain");
  const first = await h.execute();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]!.explanation).toBe("Both sides stay equal because I make the same change.");
  expect(JSON.stringify(first)).toContain("What if you changed only one side?");
  expect(h.f.store.events().filter(e => e.kind === "assessment")).toEqual([]);
  expect(h.f.store.events().filter(e => e.kind === "assistance")).toHaveLength(1);
  expect(await h.execute()).not.toBeUndefined(); expect(h.requests).toHaveLength(1);
  const cancelled = await harness("explain"); cancelled.cancel(); const seq = cancelled.f.store.throughSeq;
  await cancelled.execute(); expect(cancelled.f.store.throughSeq).toBe(seq); expect(cancelled.requests).toEqual([]);
});

test("failed Feynman child preserves the explanation; print mode does not invent a selection", async () => {
  const h = await harness("explain"); h.failChild();
  expect(JSON.stringify(await h.execute())).toContain("Provider offline");
  expect(h.f.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(1);
  expect(h.f.store.events().filter(e => e.kind === "assistance")).toEqual([]);
  const print = await harness(); print.ctx.hasUI = false;
  const seq = print.f.store.throughSeq;
  expect(JSON.parse(((await print.execute()).content[0] as { text: string }).text)).toMatchObject({ interactive_ui_required: true });
  expect(print.f.store.throughSeq).toBe(seq);
});

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=" };
test("scrap-work prompt uses native image editor, captures image-only input and rejects denied/nonvision sharing", async () => {
  const h = await harness();
  const request = { ...h.request, action: "scrap_work" as const };
  await h.tools.get("learning_activity")!.execute("scrap", request, new AbortController().signal, undefined, h.ctx);
  expect(h.widgets.length).toBeGreaterThan(0);
  expect(await h.activity.input({ type: "input", source: "interactive", text: "", images: [image] }, h.ctx)).toEqual({ action: "continue" });
  const response = h.f.store.events().find(e => e.kind === "learner_response")!;
  expect(response.payload.instance_revision_id).toBe(h.request.instance_revision_id);
  expect(response.payload.images).toHaveLength(1);
  expect(h.f.store.revisions("artifact")).toHaveLength(1);
  const denied = await harness(); denied.deny(); const seq = denied.f.store.throughSeq;
  expect(await denied.activity.input({ type: "input", source: "interactive", text: "", images: [image] }, denied.ctx)).toEqual({ action: "handled" });
  expect(denied.f.store.throughSeq).toBe(seq);
  const textOnly = await harness(); textOnly.ctx.model = { ...textOnly.ctx.model!, input: ["text"] };
  expect(await textOnly.activity.input({ type: "input", source: "interactive", text: "", images: [image] }, textOnly.ctx)).toEqual({ action: "handled" });
  expect(textOnly.f.store.revisions("artifact")).toEqual([]);
});

test("tutor input hook rejects image-only provider requests without consent", async () => {
  const h = await harness();
  await createTutorExtension({ ...h.bridge, operation: async () => ({ goal: null }) }, h.options)(h.api);
  expect(await h.hooks.get("input")!({ type: "input", source: "interactive", text: "", images: [image] }, h.ctx)).toEqual({ action: "handled" });
  expect(await h.hooks.get("input")!({ type: "input", source: "interactive", text: "/unknown inspect my photo", images: [image] }, h.ctx)).toEqual({ action: "handled" });
  expect(h.f.store.revisions("artifact")).toEqual([]);
});

test("image receipt captions cannot turn model vision guesses into canonical success or failure", async () => {
  const h = await harness("explain");
  await h.activity.input({ type: "input", source: "interactive", text: "", images: [image] }, h.ctx);
  const response = h.f.store.events().find(e => e.kind === "learner_response")!;
  h.f.record("attempt_submitted", { attempt_id: "image-attempt", instance_revision_id: h.request.instance_revision_id, response_event_id: response.event_id, declared_aids: [] });
  for (const outcome of ["success", "failure"]) expect(() => h.f.assess("image-attempt", h.definition, response.payload.text as string, outcome)).toThrow("learner-confirmed text");
  h.f.record("assessment", { attempt_id: "image-attempt", rubric_revision_id: h.definition.body.rubric_revision_id, outcome: "not_observed", scores: [], feedback: "Please confirm this handwriting in text", uncertainty: "Only the photo is observed" });
  expect(h.f.state().independent_performance.success).toBe(0);
  expect(h.f.state().independent_performance.failure).toBe(0);
});

test("image-only numeric and MCQ not-observed checks never become deterministic failures", async () => {
  for (const mcq of [false, true]) {
    const h = await harness();
    const state = projectLearningState(h.f.store, "test");
    skipLearningTask(h.f.store, { operation_id: `image-fixture-skip:${mcq}`, expected_goal_revision_id: h.f.goal.revision_id, expected_state_revision: state.state_revision, instance_revision_id: h.request.instance_revision_id }, "test");
    const definition = mcq ? h.definition : h.f.task("Solve 3x + 5 = 20. Respond with only the numerical value of x.", { format: "solve", answer: "5", scoring: "numeric" });
    const instance = h.f.deliver(definition);
    const response = await captureInput(h.f.store, h.paths, "", "test", [image], instance.revision_id);
    h.f.record("attempt_submitted", { attempt_id: "image-attempt", instance_revision_id: instance.revision_id, response_event_id: response.response_event_id, declared_aids: [] });
    const assessment = h.f.record("assessment", { attempt_id: "image-attempt", rubric_revision_id: definition.body.rubric_revision_id, outcome: "not_observed", scores: [], feedback: "Confirm handwriting", uncertainty: "No typed answer" });
    expect(assessment.payload.outcome).toBe("not_observed");
    expect(h.f.state().independent_performance.failure).toBe(0);
    expect(() => h.f.record("assessment", { attempt_id: "image-attempt", rubric_revision_id: definition.body.rubric_revision_id, outcome: "not_observed", scores: [], component_outcomes: [{ component_revision_id: h.f.component.revision_id, outcome: "success" }], feedback: "Guessed vision result", uncertainty: "Unknown" })).toThrow("learner-confirmed text");
  }
});

test("RPC images follow the same consent/capture gates; extension-authored images are not learner input", async () => {
  const h = await harness();
  expect(await h.activity.input({ type: "input", source: "rpc", text: "", images: [image] }, h.ctx)).toEqual({ action: "continue" });
  expect(h.f.store.revisions("artifact")).toHaveLength(1);
  const seq = h.f.store.throughSeq;
  expect(await h.activity.input({ type: "input", source: "extension", text: "Learner work", images: [image] }, h.ctx)).toEqual({ action: "handled" });
  expect(h.f.store.throughSeq).toBe(seq);
  const denied = await harness(); denied.deny();
  expect(await denied.activity.input({ type: "input", source: "rpc", text: "", images: [image] }, denied.ctx)).toEqual({ action: "handled" });
  expect(await denied.activity.input({ type: "input", source: "interactive", text: "/unknown inspect this", images: [image] }, denied.ctx)).toEqual({ action: "handled" });
  expect(denied.f.store.revisions("artifact")).toEqual([]);
});

test("state and confirmation errors explicitly consume input rather than fail open in Pi", async () => {
  const h = await harness();
  h.ctx.ui.confirm = async () => { throw new Error("Dialog connection lost"); };
  expect(await h.activity.input({ type: "input", source: "interactive", text: "", images: [image] }, h.ctx)).toEqual({ action: "handled" });
  expect(h.f.store.revisions("artifact")).toEqual([]);
  await createTutorExtension({ ...h.bridge, operation: async () => { throw new Error("Local service down"); } }, h.options)(h.api);
  expect(await h.hooks.get("input")!({ type: "input", source: "rpc", text: "", images: [image] }, h.ctx)).toEqual({ action: "handled" });
  expect(await h.hooks.get("input")!({ type: "input", source: "interactive", text: "Private response" }, h.ctx)).toEqual({ action: "handled" });
});

test("optional activity commands ask the AI for current-lesson activities, without needing matching tasks or capturing fake answers", async () => {
  for (const command of ["mcq", "feynman"] as const) {
    const h = await harness();
    h.bridge.operation = async () => ({ goal: h.f.goal, working_outline: { body: { component_revision_ids: [h.f.component.revision_id] } }, components: [{ component_revision_id: h.f.component.revision_id }] });
    const seq = h.f.store.throughSeq;
    await h.commands.get(command)!.handler("", h.ctx as unknown as ExtensionCommandContext);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain(`learning_activity with action ${command}`);
    expect(h.sent[0]).toContain("current working outline");
    expect(h.sent[0]).toContain("Do not make me find a task ID");
    expect(h.selections).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.f.store.throughSeq).toBe(seq);
    expect(h.notices).toEqual([]);
  }
});

test("shortcut focus is optional learner data; matching tasks still go through AI and consent/model checks remain enforced", async () => {
  const h = await harness();
  await h.commands.get("mcq")!.handler("method selection", h.ctx as unknown as ExtensionCommandContext);
  expect(h.sent[0]).toContain('"method selection"');
  expect(h.selections).toEqual([]);
  const missingModel = await harness(); missingModel.ctx.model = undefined;
  await missingModel.commands.get("feynman")!.handler("", missingModel.ctx as unknown as ExtensionCommandContext);
  expect(missingModel.sent).toEqual([]);
  expect(missingModel.notices.join(" ")).toContain("Choose a model");
  const denied = await harness(); denied.bridge.operation = async () => ({ goal: { ...denied.f.goal, body: { ...denied.f.goal.body, provider_sharing: false } } });
  await denied.commands.get("mcq")!.handler("", denied.ctx as unknown as ExtensionCommandContext);
  expect(denied.sent).toEqual([]);
  expect(denied.notices.join(" ")).toContain("consent");
  const tooLong = await harness();
  await tooLong.commands.get("feynman")!.handler("x".repeat(501), tooLong.ctx as unknown as ExtensionCommandContext);
  expect(tooLong.sent).toEqual([]);
});

test("native open response uses the stored question and criteria without a model, child or webview", async () => {
  const h = await harness("explain");
  registerActivityInterface(h.api, h.bridge, {});
  h.ctx.model = undefined;
  const titles: string[] = [];
  h.ctx.ui.editor = async title => { titles.push(title); return "The same change preserves equality; changing only one side supplies a counterexample."; };
  const request = { ...h.request, action: "open_response" };
  const first = await h.execute(request), second = await h.execute(request);
  expect(JSON.parse((second.content[0] as { text: string }).text)).toEqual(JSON.parse((first.content[0] as { text: string }).text));
  expect(titles).toHaveLength(1);
  expect(titles[0]).toContain(h.definition.body.prompt);
  expect(titles[0]).toContain(h.f.goal.body.objective);
  expect(JSON.parse((first.content[0] as { text: string }).text).instruction).toContain("already recorded");
  expect(h.requests).toEqual([]); expect(h.sent).toEqual([]); expect(h.selections).toEqual([]);
  expect(h.f.store.events().filter(event => event.kind === "attempt_submitted")).toHaveLength(1);
  expect(h.f.store.events().filter(event => ["assessment", "assistance"].includes(event.kind))).toEqual([]);
});

test("native open response cancellation or blank work creates no learner evidence", async () => {
  for (const text of [undefined, "   "]) {
    const h = await harness("explain");
    h.ctx.ui.editor = async () => text;
    const before = h.f.store.throughSeq;
    const result = await h.execute({ ...h.request, action: "open_response" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ cancelled: true, evidence_recorded: false });
    expect(h.f.store.throughSeq).toBe(before); expect(h.requests).toEqual([]);
  }
});

test("native open response checks cancellation after the editor before saving", async () => {
  const h = await harness("explain"), controller = new AbortController();
  const before = h.f.store.throughSeq;
  h.ctx.ui.editor = async () => { controller.abort(new Error("Stopped while answering")); return "Unsubmitted work"; };
  await expect(h.tools.get("learning_activity")!.execute("call", { ...h.request, action: "open_response" }, controller.signal, undefined, h.ctx)).rejects.toThrow("Stopped while answering");
  expect(h.f.store.throughSeq).toBe(before); expect(h.requests).toEqual([]);
});

test("native open response without interactive UI leaves capture to actual conversation", async () => {
  const h = await harness("explain");
  h.ctx.hasUI = false; h.ctx.model = undefined;
  h.ctx.ui.editor = async () => { throw new Error("No native editor is available"); };
  const before = h.f.store.throughSeq;
  const result = await h.execute({ ...h.request, action: "open_response" });
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ awaiting_submission: true, interactive_ui_required: true, prompt: h.definition.body.prompt });
  expect(h.f.store.throughSeq).toBe(before); expect(h.requests).toEqual([]);
});

test("native open response rejects a changed goal before committing text from an old editor", async () => {
  const h = await harness("explain");
  h.ctx.ui.editor = async () => { h.f.define("goal", { ...h.f.goal.body, objective: "Different goal" }, h.f.goal); return "Old-scope words"; };
  await expect(h.execute({ ...h.request, action: "open_response" })).rejects.toThrow("changed");
  expect(h.f.store.events().filter(event => ["learner_response", "attempt_submitted"].includes(event.kind))).toEqual([]);
  expect(h.requests).toEqual([]);
});
