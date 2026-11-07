import { afterEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { createTutorExtension } from "../../pi/src/tutor.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, InputEvent, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createSagePaths } from "../src/paths.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { projectLearningState } from "../src/learning-state.ts";
import { learningFixture } from "./learning-fixture.ts";
import type { Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { modePath } from "./mode-path-fixture.ts";
import { prepareActivity, submitActivity, saveFeynmanReview } from "../src/interactions.ts";
import { presentFeedback } from "../src/feedback.ts";
import { profilePreferences } from "../../core/src/experience.ts";

const roots: string[] = [], services: LearningService[] = [];
afterEach(async () => { for (const s of services.splice(0)) s.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(subject = "math", review = false, prompt?: string, learnerNotes?: string) {
  const root = await mkdtemp(join(tmpdir(), "sage-controller-")); roots.push(root);
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service); service.activateSession("lesson");
  const body: Goal = { mode: "learn", objective: "Linear equations", subject, ...(review ? { learning_preferences: profilePreferences("thorough") } : {}), ...(learnerNotes ? { learner_notes: learnerNotes } : {}), horizon_days: 7, target_format: "solve and explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
  const created = service.store.define({ operation_id: randomUUID(), kind: "goal", body }, "learner", "lesson");
  const goal = service.store.revision<Goal>(created.revision_id, "goal");
  const curated = installFixtures(service.store, goal)[0]!;
  const definition = prompt ? service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...curated.body, prompt, review: { method: "human", reason: "Reviewed source-free owned routing fixture; no educational-quality claim" } } }, "human", "lesson") : curated;
  const request = () => ({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } });
  const first = service.store.define(request(), "human", "lesson");
  return { service, goal, first, request };
}
async function nativeRelease(f: Awaited<ReturnType<typeof fixture>>, definitionId = f.first.body.definition_revision_id as string) {
  const goal = f.service.store.lessonGoal("lesson")!;
  const started = f.service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, acknowledge_gaps: true, definition_revision_id: definitionId, expected_goal_revision_id: goal.revision_id, expected_state_revision: projectLearningState(f.service.store, "lesson").state_revision }, "lesson");
  const question = started.teaching_request ? await (await f.service.offerTeaching(started.teaching_request, "lesson")).continue() : started;
  return f.service.store.revision(question.instance_revision_id!, "task_instance");
}
function studio(f: Awaited<ReturnType<typeof fixture>>, approve?: Parameters<LearningService["renderUi"]>[4], source = 'page "Structured task"\ninput a "First value"\ninput b "Second value"') {
  return f.service.renderUi(source, "lesson", "http://127.0.0.1:3000", () => {}, approve);
}

test("Task74 Studio rejects unapproved creation without learner evidence or URL", async () => {
  const f = await fixture(), before = ledgerRows(f.service.store);
  await expect(studio(f)).rejects.toThrow("Studio requires explicit native approval");
  expect(ledgerRows(f.service.store)).toEqual(before);
});

test("Task74 Studio necessity is reviewed once for the exact frozen task and surface", async () => {
  const f = await fixture(); let calls = 0;
  const approve = async () => { calls++; return { use: "necessary" as const, reason: "Edit interdependent values together; native text cannot reliably preserve their mapping." }; };
  const first = await studio(f, approve), second = await studio(f, approve);
  expect(calls).toBe(1);
  expect(second.id).not.toBe(first.id);
  const approvals = f.service.store.events().filter(e => e.payload.action === "studio_approval");
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({ actor: "host", session_id: "lesson", branch: "real" });
  expect(approvals[0]!.payload).toMatchObject({ use: "necessary", goal_revision_id: f.goal.revision_id, instance_revision_id: f.first.revision_id, definition_revision_id: f.first.body.definition_revision_id });
  expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toHaveLength(0);
  await expect(studio(f, undefined, 'page "Different surface"\ninput a')).rejects.toThrow("Studio requires explicit native approval");
});

test("Task74 supplementary Studio is approved once per opening and cancellation writes nothing", async () => {
  const f = await fixture(); let calls = 0;
  const approve = async () => { calls++; return { use: "supplementary" as const }; };
  await studio(f, approve); await studio(f, approve);
  expect(calls).toBe(2);
  const before = ledgerRows(f.service.store);
  await expect(studio(f, async () => undefined)).rejects.toThrow("Studio was not approved");
  expect(ledgerRows(f.service.store)).toEqual(before);
  for (const decision of [{ use: "necessary", reason: " " }, { use: "automatic", reason: "model says necessary" }, true]) {
    // Exercise runtime validation of an invalid trusted-host return value.
    await expect(Reflect.apply(f.service.renderUi, f.service, ['page\ninput a', "lesson", "http://127.0.0.1:3000", () => {}, async () => decision])).rejects.toThrow("Studio was not approved");
  }
  expect(ledgerRows(f.service.store)).toEqual(before);
});

test("Task74 Studio approval cannot cross session epochs or a stop during native review", async () => {
  const f = await fixture(), before = ledgerRows(f.service.store);
  await expect(studio(f, async () => { f.service.activateSession("foreign"); f.service.activateSession("lesson"); return { use: "necessary", reason: "Structured linked edits" }; })).rejects.toThrow("Studio scope changed");
  expect(ledgerRows(f.service.store)).toEqual(before);
  await expect(studio(f, async () => { f.service.store.append("checkpoint", { stopped: true, reason: "Learner stopped" }, randomUUID(), "host", "lesson"); return { use: "supplementary" }; })).rejects.toThrow("Studio scope changed");
  expect(f.service.store.events().filter(e => e.payload.action === "studio_approval")).toHaveLength(0);
});

test("Task74 Studio preview has no task necessity and changed goal needs fresh approval", async () => {
  const f = await fixture();
  await studio(f, async () => ({ use: "necessary", reason: "Structured linked edits" }));
  f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Another goal" } }, "learner", "lesson");
  await expect(studio(f)).rejects.toThrow("Studio requires explicit native approval");
  await expect(studio(f, async () => ({ use: "necessary", reason: "Preview is nicer" }))).rejects.toThrow("Studio was not approved");
  expect((await studio(f, async () => ({ use: "supplementary" })))).toHaveProperty("url");
});

test("Task74 registered native Studio obtains task necessity, reuses it, and leaves JavaScript off", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const input = nativeInputHook(bridge); let selections = 0, reasons = 0;
    Object.assign(input.ctx.ui, { select: async () => { selections++; return "Necessary for this task"; }, input: async () => { reasons++; return "Linked values must stay in their editable layout."; } });
    const tool = input.tools.get("render_ui")!, source = 'page "Linked values"\ninput a\ninput b\n---js\nexport function recalc() {}';
    const open = () => tool.execute("studio", { source }, new AbortController().signal, undefined, input.ctx);
    const first = await open(), second = await open();
    expect(first.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("off until explicit trusted browser opt-in") })]);
    expect(second.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("awaiting_submission") })]);
    expect(selections).toBe(1); expect(reasons).toBe(1);
    expect(f.service.store.events().filter(e => e.payload.action === "studio_approval")).toHaveLength(1);
    expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toHaveLength(0);
  });
});

test("Task74 registered native Studio rejects missing UI, cancellation and foreign native session", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const input = nativeInputHook(bridge), tool = input.tools.get("render_ui")!, before = ledgerRows(f.service.store);
    const open = () => tool.execute("studio", { source: 'page\ninput answer' }, new AbortController().signal, undefined, input.ctx);
    Object.assign(input.ctx, { hasUI: false });
    await expect(open()).rejects.toThrow("Studio was not approved");
    Object.assign(input.ctx, { hasUI: true }); Object.assign(input.ctx.ui, { select: async () => undefined });
    await expect(open()).rejects.toThrow("Studio was not approved");
    Object.assign(input.ctx.ui, { select: async () => { input.setSession("foreign"); return "Supplementary once"; } });
    await expect(open()).rejects.toThrow("Studio session changed");
    expect(ledgerRows(f.service.store)).toEqual(before);
  });
});

test("Task74 frozen task replacement and hypothetical approvals cannot authorize automatic Studio", async () => {
  const f = await fixture();
  const source = 'page\ninput a\ninput b';
  await studio(f, async () => ({ use: "necessary", reason: "Edit linked values in place" }), source);
  const approval = f.service.store.events().find(e => e.payload.action === "studio_approval")!;
  f.service.skipTask(skipRequest(f), "lesson");
  const next = await nativeRelease(f);
  f.service.store.append("decision", { ...approval.payload, instance_revision_id: next.revision_id, scope: { ...(approval.payload.scope as Record<string, unknown>), instance_revision_id: next.revision_id } }, randomUUID(), "host", "lesson", undefined, undefined, "hypothetical");
  await expect(studio(f, undefined, source)).rejects.toThrow("Studio requires explicit native approval");
  expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
});

test("Task74 disabled Studio is hidden from active tools and explicit re-enabling restores it", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const input = nativeInputHook(bridge), original = input.activeTools();
    const preferences = profilePreferences("thorough"); preferences.features.browser_ui = false;
    const disabled = f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learning_preferences: preferences } }, "learner", "lesson");
    await input.beforeStart();
    expect(input.activeTools()).toEqual(original.filter(name => name !== "render_ui"));
    preferences.features.browser_ui = true;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: disabled.entity_id, parent_revision_id: disabled.revision_id, expected_goal_revision_id: disabled.revision_id, body: { ...f.goal.body, learning_preferences: preferences } }, "learner", "lesson");
    await input.beforeStart();
    expect(input.activeTools().sort()).toEqual(original.sort());
    expect(input.tools.size).toBe(7);
  });
});

function skipRequest(f: Awaited<ReturnType<typeof fixture>>) {
  return { operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, expected_state_revision: projectLearningState(f.service.store, "lesson").state_revision, instance_revision_id: f.first.revision_id };
}
function reopened(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new LearningStore(join(f.service.paths.data, "learning.sqlite"));
  try { return { state: projectLearningState(store, "lesson"), events: store.events(), integrity: store.integrity(), tables: store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length }; }
  finally { store.close(); }
}
async function withBridge(f: Awaited<ReturnType<typeof fixture>>, run: (bridge: ReturnType<typeof createTutorBridge>) => Promise<void>) {
  const server = startLearningServer(f.service);
  try { await run(createTutorBridge(f.service.paths, f.service, server)); } finally { server.stop(); }
}
async function capturedAttempt(f: Awaited<ReturnType<typeof fixture>>, bridge: ReturnType<typeof createTutorBridge>, submit = true) {
  const receipt = await bridge.input("5", "lesson", [], f.first.revision_id) as { response_event_id: string };
  const attempt = { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: randomUUID(), instance_revision_id: f.first.revision_id, response_event_id: receipt.response_event_id, declared_aids: [] } };
  if (submit) await f.service.operation("learning_record", attempt, "lesson");
  const definition = f.service.store.revision(f.first.body.definition_revision_id as string, "task_definition");
  const assessment = { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: definition.body.rubric_revision_id, outcome: "success", scores: [{ dimension: "answer", score: 1, evidence: "5" }], feedback: "The value satisfies the equation.", uncertainty: "Only this item was checked." } };
  return { attempt, assessment };
}

function ledgerRows(store: LearningStore) {
  return {
    event: store.db.query("SELECT * FROM event ORDER BY seq").all(),
    object_revision: store.db.query("SELECT * FROM object_revision ORDER BY rowid").all(),
    projection: store.db.query("SELECT * FROM projection ORDER BY rowid").all(),
    blob_manifest: store.db.query("SELECT * FROM blob_manifest ORDER BY rowid").all(),
    source_span: store.db.query("SELECT * FROM source_span ORDER BY rowid").all(),
    model_call_log: store.db.query("SELECT * FROM model_call_log ORDER BY seq").all(),
    job: store.db.query("SELECT * FROM job ORDER BY rowid").all(),
  };
}
function nativeInputHook(bridge: ReturnType<typeof createTutorBridge>, confirm: () => Promise<boolean> = async () => true, sessionId = "lesson") {
  const hooks = new Map<string, (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>>();
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, RegisteredCommand>();
  const widgets: unknown[][] = [], notices: string[] = [];
  let session = sessionId, active: string[] = [];
  // SAFETY: Only registration/UI are faked; admission and storage use the actual production bridge.
  const api = { getActiveTools: () => [...active], setActiveTools(names: string[]) { active = [...names]; }, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); active.push(tool.name); }, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on(name: string, handler: (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>) { hooks.set(name, handler); }, sendUserMessage() {} } as unknown as ExtensionAPI;
  // SAFETY: This offline native context invokes the registered hook without starting a provider.
  const ctx = { hasUI: true, mode: "rpc", model: { id: "offline", provider: "offline", input: ["text", "image"] }, isIdle: () => true, abort() {}, sessionManager: { getSessionId: () => session }, ui: { notify(text: string) { notices.push(text); }, setStatus() {}, setWidget(...args: unknown[]) { widgets.push(args); }, confirm } } as unknown as ExtensionToolContext;
  createTutorExtension(bridge)(api);
  const input = (text: string, image = false, source: InputEvent["source"] = "interactive") => hooks.get("input")!({ type: "input", source, text, ...(image ? { images: [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=" }] } : {}) }, ctx);
  return Object.assign(input, { tools, widgets, notices, ctx, activeTools: () => [...active], beforeStart: () => Reflect.apply(hooks.get("before_agent_start")!, undefined, [{ type: "before_agent_start", systemPrompt: "Owned test policy" }, ctx]), setSession(id: string) { session = id; }, command(name: string, args = "") { return commands.get(name)!.handler(args, ctx as unknown as ExtensionCommandContext); } });
}

async function contextWithStateForm(bridge: ReturnType<typeof createTutorBridge>, form: "compact" | "phase_only") {
  for (let budget = 2000; budget <= 4000; budget += 100) {
    let packet: Record<string, unknown>;
    try { packet = await bridge.operation("learning_context", { budget_chars: budget }, "lesson") as Record<string, unknown>; }
    catch (error) { if (error instanceof Error && error.message.includes("Budget cannot preserve")) continue; throw error; }
    const state = packet.learning_state as Record<string, unknown>;
    if (!Object.hasOwn(state, "current_task") && Object.hasOwn(state, "instance_revision_id") === (form === "compact")) return { budget, packet };
  }
  throw new Error(`Actual context did not emit ${form} within supported small budgets`);
}

async function nativeTeachingFixture(mode: Goal["mode"] = "learn", allowedAids: string[] = []) {
  const f = await fixture();
  f.service.skipTask(skipRequest(f), "lesson");
  if (mode !== "learn") {
    const changed = f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, mode } }, "learner", "lesson");
    f.goal = f.service.store.revision<Goal>(changed.revision_id, "goal");
  }
  const previous = f.service.store.revision(f.first.body.definition_revision_id as string, "task_definition");
  const instruction = f.service.store.define({ operation_id: randomUUID(), kind: "artifact", expected_goal_revision_id: f.goal.revision_id, body: { capability: "teaching", goal_revision_id: f.goal.revision_id, author: "tutor", provenance: "Synthetic reviewed instruction", media_type: "text/plain", content: "Keep equality: apply the same change to both sides. Example: x + 2 = 4 gives x = 2.", evidence_kind: "artifact_only", interpretation_uncertainty: "Not calibrated", assistance_event_ids: [] } }, "human", "lesson");
  const definition = f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: f.goal.revision_id, body: { ...previous.body, allowed_aids: allowedAids, artifact_revision_ids: [instruction.revision_id] } }, "human", "lesson");
  const request = { action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, unit_id: randomUUID(), component_revision_id: (previous.body.component_revision_ids as string[])[0]!, instruction_revision_id: instruction.revision_id, definition_revision_id: definition.revision_id };
  return { ...f, instruction, definition, teachingRequest: request };
}

for (const mode of ["exam", "cram", "drill"] as const) {
  test(`native teaching constrained ${mode} rejects before preparation or UI exposure and preserves ordinary delivery restrictions`, async () => {
    const f = await nativeTeachingFixture(mode, mode === "exam" ? ["calculator"] : []);
    expect(f.goal.body.allowed_aids).toEqual([]);
    expect(f.definition.body.status).toBe("practice_ready");
    await withBridge(f, async bridge => {
      const before = ledgerRows(f.service.store);
      if (mode === "exam") {
        expect(f.definition.body.allowed_aids).toEqual(["calculator"]);
        await expect(bridge.operation("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: f.definition.revision_id, goal_revision_id: f.goal.revision_id, purpose: "practice", conditions: [] } }, "lesson")).rejects.toThrow("allowed aids");
        expect(ledgerRows(f.service.store)).toEqual(before);
      }
      const native = nativeInputHook(bridge), offers: string[] = [];
      Object.assign(native.ctx.ui, { select: async (title: string) => { offers.push(title); return "Continue"; } });
      await expect(native.tools.get("learning_activity")!.execute("constrained-teaching", f.teachingRequest as never, undefined, undefined, native.ctx)).rejects.toThrow("not supported");
      expect(offers).toEqual([]);
      expect(native.notices).toEqual([]);
      expect(ledgerRows(f.service.store)).toEqual(before);
      expect(f.service.store.events().filter(e => e.kind === "decision" && e.payload.action === "teaching_stage")).toEqual([]);
      expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
      expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual([]);
    });
  });

  test(`native teaching callback revalidates a learner switch to ${mode} before release writes`, async () => {
    const f = await nativeTeachingFixture();
    await withBridge(f, async bridge => {
      const native = nativeInputHook(bridge);
      let changed: ReturnType<typeof ledgerRows> | undefined;
      Object.assign(native.ctx.ui, { select: async () => {
        f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, mode } }, "learner", "lesson");
        changed = ledgerRows(f.service.store);
        return "Continue";
      } });
      await expect(native.tools.get("learning_activity")!.execute("changed-mode", f.teachingRequest as never, undefined, undefined, native.ctx)).rejects.toThrow();
      if (!changed) throw new Error("Native selection was not offered before the learner mode switch");
      expect(ledgerRows(f.service.store)).toEqual(changed);
      expect(f.service.store.events().filter(e => e.kind === "decision" && e.payload.action === "teaching_stage")).toHaveLength(1);
      expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
      expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual([]);
    });
  });
}

test("Task3 integration: unknown supported practice requires native instruction while frozen cold measurement remains available", async () => {
  const f = await nativeTeachingFixture();
  await withBridge(f, async bridge => {
    const native = nativeInputHook(bridge);
    const before = ledgerRows(f.service.store);
    const request = (purpose: string) => ({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: f.definition.revision_id, goal_revision_id: f.goal.revision_id, purpose, conditions: [] } });
    await expect(native.tools.get("learning_define")!.execute("bypass", request("practice") as never, undefined, undefined, native.ctx)).rejects.toThrow("Host learn flow");
    await expect(native.tools.get("learning_define")!.execute("cold", request("independent") as never, undefined, undefined, native.ctx)).rejects.toThrow("Host learn flow");
    expect(ledgerRows(f.service.store)).toEqual(before);
    await nativeRelease(f, f.definition.revision_id);
    expect(projectLearningState(f.service.store, "lesson").current_task?.purpose).toBe("independent");
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
  });
});

test("native teaching registered activity offers instruction and cancellation keeps the pinned question pending", async () => {
  const f = await nativeTeachingFixture();
  await withBridge(f, async bridge => {
    const native = nativeInputHook(bridge), offers: string[] = [];
    Object.assign(native.ctx.ui, { select: async (title: string) => { offers.push(title); return undefined; } });
    let failure: unknown;
    try { await native.tools.get("learning_activity")!.execute("teaching", f.teachingRequest as never, undefined, undefined, native.ctx); } catch (error) { failure = error; }
    expect(offers).toHaveLength(1);
    expect(failure).toBeUndefined();
    expect(offers[0]).toContain("apply the same change");
    expect(projectLearningState(f.service.store, "lesson")).toMatchObject({ phase: "instruction_pending", current_task: null });
    expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
    expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment", "learner_response"].includes(e.kind))).toHaveLength(0);
  });
});

test("native teaching Continue releases exactly the pinned guided question, then real work and feedback repair survive reopen", async () => {
  const f = await nativeTeachingFixture();
  await withBridge(f, async bridge => {
    const native = nativeInputHook(bridge);
    Object.assign(native.ctx.ui, { select: async () => "Continue" });
    const result = await native.tools.get("learning_activity")!.execute("teaching", f.teachingRequest as never, undefined, undefined, native.ctx);
    const released = JSON.parse((result.content[0] as { text: string }).text) as { instance_revision_id: string };
    expect(projectLearningState(f.service.store, "lesson")).toMatchObject({ phase: "awaiting_answer", current_task: { instance_revision_id: released.instance_revision_id, definition_revision_id: f.definition.revision_id, purpose: "practice", assistance_count: 1 } });
    const help = f.service.store.events().find(e => e.kind === "assistance")!;
    expect(help.payload).toMatchObject({ answer_bearing: true, stage: "possibly_exposed", instance_revision_id: released.instance_revision_id });
    expect(String(help.payload.content)).toContain(f.instruction.revision_id);
    expect(f.service.store.revision(released.instance_revision_id, "task_instance").body.goal_revision_id).toBe(f.goal.revision_id);
    expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment", "learner_response"].includes(e.kind))).toHaveLength(0);
    expect(reopened(f).state.phase).toBe("awaiting_answer");
    await expect(native.tools.get("learning_activity")!.execute("replay", f.teachingRequest as never, undefined, undefined, native.ctx)).rejects.toThrow();
    await expect(f.service.operation("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: f.definition.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: [] } }, "lesson")).rejects.toThrow("pending");
    expect(await native("AI continue", false, "extension")).toEqual({ action: "continue" });
    expect(f.service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(0);
    await native("I subtract two from both sides.");
    const response = f.service.store.events().filter(e => e.kind === "learner_response").at(-1)!;
    const attemptId = randomUUID();
    await bridge.operation("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: attemptId, instance_revision_id: released.instance_revision_id, response_event_id: response.event_id, declared_aids: [] } }, "lesson");
    await bridge.operation("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: attemptId, rubric_revision_id: f.definition.body.rubric_revision_id, outcome: "partial", scores: [{ dimension: "answer", score: 0, evidence: "Incomplete answer" }], feedback: "Keep both sides equal and finish the calculation.", uncertainty: "Synthetic conditional criterion feedback" } }, "lesson");
    await bridge.feedback!("lesson", true);
    expect(projectLearningState(f.service.store, "lesson").phase).toBe("repair");
    expect(reopened(f).state.phase).toBe("repair");
    expect(f.service.store.revision(f.definition.revision_id, "task_definition").body.allowed_aids).toEqual(f.definition.body.allowed_aids);
  });
});

test("native teaching missing UI, denied and unknown choices cannot release work or accept model markers", async () => {
  for (const choice of [undefined, "Not now", "forged", "missing-ui"] as const) {
    const f = await nativeTeachingFixture();
    await withBridge(f, async bridge => {
      const native = nativeInputHook(bridge);
      native.ctx.hasUI = choice !== "missing-ui";
      Object.assign(native.ctx.ui, { select: async () => choice });
      await native.tools.get("learning_activity")!.execute("teaching", f.teachingRequest as never, undefined, undefined, native.ctx);
      expect(projectLearningState(f.service.store, "lesson").phase).toBe("instruction_pending");
      const before = ledgerRows(f.service.store);
      await f.service.operation("learning_activity", f.teachingRequest, "lesson");
      await expect(f.service.operation("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: f.definition.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: [] } }, "lesson")).rejects.toThrow("pending");
      await expect(f.service.operation("learning_record", { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: f.goal.revision_id, payload: { action: "teaching_stage", reason: "Continue", evidence_event_ids: [] } }, "lesson")).rejects.toThrow("host");
      expect(ledgerRows(f.service.store)).toEqual(before);
      expect(reopened(f).state.phase).toBe("instruction_pending");
    });
  }
});

test("native teaching callbacks reject stop, goal change, revocation, foreign session, abort and failed UI", async () => {
  for (const change of ["stop", "goal", "revoke", "session", "abort", "failed-ui"] as const) {
    const f = await nativeTeachingFixture();
    await withBridge(f, async bridge => {
      const native = nativeInputHook(bridge), controller = new AbortController();
      Object.assign(native.ctx.ui, { select: async () => {
        if (change === "stop") await bridge.stop("lesson");
        if (change === "session") f.service.activateSession("other");
        if (change === "abort") controller.abort(new Error("Cancelled"));
        if (change === "failed-ui") throw new Error("UI failed");
        if (change === "goal" || change === "revoke") f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, ...(change === "goal" ? { objective: "Changed objective" } : { provider_sharing: false }) } }, "learner", "lesson");
        return "Continue";
      } });
      await expect(native.tools.get("learning_activity")!.execute("teaching", f.teachingRequest as never, controller.signal, undefined, native.ctx)).rejects.toThrow();
      expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
      expect(f.service.store.events().filter(e => e.kind === "assistance")).toHaveLength(0);
      if (change === "stop") {
        expect(reopened(f).state.phase).toBe("stopped");
        await bridge.continue!("lesson");
        expect(projectLearningState(f.service.store, "lesson").phase).toBe("instruction_pending");
      }
    });
  }
});

test("native teaching newer producers revoke old callbacks and consumed callbacks cannot replay", async () => {
  const f = await nativeTeachingFixture();
  await withBridge(f, async bridge => {
    const first = await bridge.teachingOffer!(f.teachingRequest as never, "lesson");
    const second = await bridge.teachingOffer!({ ...f.teachingRequest, operation_id: randomUUID() } as never, "lesson");
    await expect(first.continue()).rejects.toThrow("stale");
    const result = await second.continue();
    await expect(second.continue()).rejects.toThrow("consumed");
    expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(2);
    expect(projectLearningState(f.service.store, "lesson").current_task?.instance_revision_id).toBe(result.instance_revision_id);
  });
});

test("native teaching cannot overwrite legacy pending work or substitute foreign pins", async () => {
  const f = await nativeTeachingFixture();
  await withBridge(f, async bridge => {
    const other = await nativeTeachingFixture();
    await expect(bridge.teachingOffer!({ ...f.teachingRequest, instruction_revision_id: other.instruction.revision_id } as never, "lesson")).rejects.toThrow();
    f.service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: f.definition.revision_id, goal_revision_id: f.goal.revision_id, purpose: "practice", conditions: [] } }, "human", "lesson");
    const native = nativeInputHook(bridge), offers: string[] = [];
    Object.assign(native.ctx.ui, { select: async (title: string) => { offers.push(title); return "Continue"; } });
    await expect(native.tools.get("learning_activity")!.execute("teaching", f.teachingRequest as never, undefined, undefined, native.ctx)).rejects.toThrow("pending");
    expect(offers).toEqual([]);
    expect(projectLearningState(f.service.store, "lesson").current_task).not.toBeNull();
  });
});

test("e01s03 task 1: budget-omitted rich20k scrap task retains valid prompt on transactional save error and binds retry once", async () => {
  const f = await fixture("math", false, "Solve 3x + 5 = 20. ".padEnd(20000, " "));
  await withBridge(f, async bridge => {
    const packet = await bridge.operation("learning_context", {}, "lesson") as Record<string, unknown>;
    expect(packet.task).toBeUndefined();
    expect(packet.learning_state).toMatchObject({ current_task: { instance_revision_id: f.first.revision_id } });
    expect(packet.omissions).toContain("task: exceeds packet budget; request a targeted read");
    const definition = f.service.store.revision(f.first.body.definition_revision_id as string, "task_definition");
    expect(definition.body).toMatchObject({ source_span_ids: [], status: "practice_ready" });
    expect((definition.body.prompt as string).length).toBe(20000);
    const input = nativeInputHook(bridge);
    await input.tools.get("learning_activity")!.execute("scrap-large", { action: "scrap_work", operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, instance_revision_id: f.first.revision_id }, new AbortController().signal, undefined, input.ctx);
    expect(input.widgets.at(-1)?.[1]).toBeDefined();
    const before = ledgerRows(f.service.store), goals = f.service.store.revisions("goal"), widgets = [...input.widgets];
    const rebuild = f.service.store.rebuild.bind(f.service.store);
    f.service.store.rebuild = () => { rebuild(); throw new Error("Injected capture rebuild failure"); };
    try { expect(await input("Actual A work", true)).toEqual({ action: "handled" }); }
    finally { f.service.store.rebuild = rebuild; }
    expect(ledgerRows(f.service.store)).toEqual(before);
    expect(input.widgets).toEqual(widgets);
    expect(input.notices.join(" ")).toContain("Injected capture rebuild failure");
    expect(await input("Actual A work", true)).toEqual({ action: "continue" });
    const saved = reopened(f), responses = saved.events.filter(e => e.kind === "learner_response");
    expect(responses).toHaveLength(1);
    expect(responses[0]!.payload).toMatchObject({ instance_revision_id: f.first.revision_id, text: "Actual A work" });
    expect(saved.state).toMatchObject({ phase: "submission_pending", current_task: { instance_revision_id: f.first.revision_id, response_event_id: responses[0]!.event_id } });
    expect(saved.events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    expect(f.service.store.revisions("goal")).toEqual(goals);
    expect(input.widgets.at(-1)?.[1]).toBeUndefined();
    expect(saved.integrity).toEqual(["ok"]); expect(saved.tables).toBe(7);
  });
});

test("e01s03 task 1: native ordinary and default scrap routing use actual full/compact identity without rich20k task", async () => {
  for (const form of ["full", "compact"] as const) for (const route of ["ordinary", "scrap"] as const) {
    const f = await fixture("math", false, "Solve 3x + 5 = 20. ".padEnd(20000, " "), "Context budget fixture. ".padEnd(1200, " "));
    await withBridge(f, async bridge => {
      const operation = bridge.operation;
      const budget = form === "compact" ? (await contextWithStateForm(bridge, "compact")).budget : undefined;
      bridge.operation = async (name, body, ...rest) => {
        const packet = await operation(name, name === "learning_context" && budget ? { ...body as object, budget_chars: budget } : body, ...rest);
        if (name === "learning_context") {
          expect((packet as Record<string, unknown>).task).toBeUndefined();
          expect((packet as Record<string, unknown>).learning_state).toMatchObject(form === "full" ? { current_task: { instance_revision_id: f.first.revision_id } } : { instance_revision_id: f.first.revision_id });
        }
        return packet;
      };
      const input = nativeInputHook(bridge), goals = f.service.store.revisions("goal");
      if (route === "scrap") { await input.command("scrap"); expect(input.widgets.at(-1)?.[1]).toBeDefined(); }
      expect(await input("Fresh owned A answer")).toEqual({ action: "continue" });
      const saved = reopened(f), responses = saved.events.filter(e => e.kind === "learner_response");
      expect(responses).toHaveLength(1); expect(responses[0]!.payload.instance_revision_id).toBe(f.first.revision_id);
      expect(saved.state.current_task?.response_event_id).toBe(responses[0]!.event_id);
      expect(saved.events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
      expect(f.service.store.revisions("goal")).toEqual(goals);
    });
  }
});

test("e01s03 task 1: actual phase-only identity omission fails closed without ledger writes or valid scrap prompt loss", async () => {
  for (const route of ["ordinary", "scrap"] as const) {
    const f = await fixture("math", false, "Solve 3x + 5 = 20. ".padEnd(20000, " "), "Context budget fixture. ".padEnd(1200, " "));
    await withBridge(f, async bridge => {
      const input = nativeInputHook(bridge);
      if (route === "scrap") await input.command("scrap", f.first.revision_id);
      const { budget, packet } = await contextWithStateForm(bridge, "phase_only");
      expect(packet.task).toBeUndefined();
      const state = packet.learning_state as Record<string, unknown>;
      expect(state.phase).toBe("awaiting_answer");
      expect(Object.hasOwn(state, "current_task")).toBe(false); expect(Object.hasOwn(state, "instance_revision_id")).toBe(false);
      const operation = bridge.operation;
      bridge.operation = (name, body, ...rest) => operation(name, name === "learning_context" ? { ...body as object, budget_chars: budget } : body, ...rest);
      const before = ledgerRows(f.service.store), widgets = [...input.widgets];
      expect(await input("Work with unknown transport identity")).toEqual({ action: "handled" });
      await input.command("scrap");
      expect(ledgerRows(f.service.store)).toEqual(before); expect(input.widgets).toEqual(widgets);
      bridge.operation = operation;
      expect(await input("Fresh A work after full context returns")).toEqual({ action: "continue" });
      const responses = reopened(f).events.filter(e => e.kind === "learner_response");
      expect(responses).toHaveLength(1); expect(responses[0]!.payload.instance_revision_id).toBe(f.first.revision_id);
      expect(reopened(f).state.current_task?.response_event_id).toBe(responses[0]!.event_id);
    });
  }
});

test("e01s03 task 1: actual full/compact authoritative null supports no-task work while omitted identity remains unknown", async () => {
  for (const form of ["full", "compact", "phase_only"] as const) {
    const f = await fixture("math", false, undefined, "Context budget fixture. ".padEnd(1200, " "));
    await withBridge(f, async bridge => {
      await bridge.goal({ ...f.goal.body, objective: "New objective without delivered tasks" }, "lesson");
      expect(reopened(f).state.current_task).toBeNull();
      const operation = bridge.operation;
      const selected = form === "full" ? { budget: undefined, packet: await operation("learning_context", {}, "lesson") as Record<string, unknown> } : await contextWithStateForm(bridge, form);
      expect(selected.packet.task).toBeUndefined();
      const state = selected.packet.learning_state as Record<string, unknown>;
      if (form === "full") expect(state.current_task).toBeNull();
      else if (form === "compact") expect(state.instance_revision_id).toBeNull();
      else { expect(Object.hasOwn(state, "current_task")).toBe(false); expect(Object.hasOwn(state, "instance_revision_id")).toBe(false); }
      bridge.operation = (name, body, ...rest) => operation(name, name === "learning_context" && selected.budget ? { ...body as object, budget_chars: selected.budget } : body, ...rest);
      const input = nativeInputHook(bridge), before = ledgerRows(f.service.store), goals = f.service.store.revisions("goal");
      expect(await input("Legitimate no-task work")).toEqual({ action: form === "phase_only" ? "handled" : "continue" });
      if (form === "phase_only") expect(ledgerRows(f.service.store)).toEqual(before);
      else {
        const responses = reopened(f).events.filter(e => e.kind === "learner_response");
        expect(responses).toHaveLength(1); expect(responses[0]!.payload.instance_revision_id).toBeUndefined();
      }
      expect(f.service.store.revisions("goal")).toEqual(goals);
      expect(reopened(f).events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    });
  }
});

test("e01s03 task 1: registered scrap_work rejects delayed A after native skip/continue and captures fresh B once", async () => {
  for (const command of ["skip", "continue"] as const) {
    const f = await fixture(); const second = f.service.store.define(f.request(), "human", "lesson");
    await withBridge(f, async bridge => {
      const input = nativeInputHook(bridge);
      const beforePrompt = ledgerRows(f.service.store), goals = f.service.store.revisions("goal");
      const result = await input.tools.get("learning_activity")!.execute("scrap-A", { action: "scrap_work", operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, instance_revision_id: f.first.revision_id }, new AbortController().signal, undefined, input.ctx);
      expect(JSON.stringify(result)).toContain("awaiting_submission");
      expect(input.widgets.at(-1)?.[1]).toBeDefined();
      expect(ledgerRows(f.service.store)).toEqual(beforePrompt);
      let release!: () => void, entered!: () => void, pause = true;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const operation = bridge.operation;
      bridge.operation = async (...args) => { if (pause && args[0] === "learning_context") { pause = false; entered(); await gate; } return operation(...args); };
      const delayed = input("Old A work", command === "continue"); await waiting;
      await input.command(command);
      const afterControl = ledgerRows(f.service.store);
      expect(reopened(f).state.current_task?.instance_revision_id).toBe(second.revision_id);
      release(); expect(await delayed).toEqual({ action: "handled" });
      expect(ledgerRows(f.service.store)).toEqual(afterControl);
      expect(input.widgets.at(-1)?.[1]).toBeDefined();
      expect(await input("Fresh B work", command === "continue")).toEqual({ action: "continue" });
      const saved = reopened(f);
      const responses = saved.events.filter(e => e.kind === "learner_response");
      expect(responses).toHaveLength(1);
      expect(responses[0]!.payload).toMatchObject({ text: "Fresh B work", instance_revision_id: second.revision_id });
      expect(saved.state.current_task).toMatchObject({ instance_revision_id: second.revision_id, response_event_id: responses[0]!.event_id });
      expect(saved.events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
      expect(f.service.store.revisions("goal")).toEqual(goals);
      expect(input.widgets.at(-1)?.[1]).toBeUndefined();
      expect(saved.integrity).toEqual(["ok"]); expect(saved.tables).toBe(7);
    });
  }
});

test("e01s03 task 1: registered scrap prompt retires after assessment advancement without changing original marks", async () => {
  const f = await fixture(); const second = f.service.store.define(f.request(), "human", "lesson");
  await withBridge(f, async bridge => {
    const input = nativeInputHook(bridge); await input.command("scrap");
    expect(input.widgets.at(-1)?.[1]).toBeDefined();
    const { assessment } = await capturedAttempt(f, bridge);
    const receipt = await f.service.operation("learning_record", assessment, "lesson");
    expect(reopened(f).state.current_task?.instance_revision_id).toBe(second.revision_id);
    expect(await input("New work for B")).toEqual({ action: "continue" });
    const assessments = reopened(f).events.filter(e => e.kind === "assessment");
    expect(assessments).toHaveLength(1); expect(receipt).toEqual(assessments[0]);
    const responses = reopened(f).events.filter(e => e.kind === "learner_response");
    expect(responses).toHaveLength(2);
    expect(responses.at(-1)?.payload.instance_revision_id).toBe(second.revision_id);
    expect(input.widgets.at(-1)?.[1]).toBeUndefined();
  });
});

test("e01s03 task 1: valid registered scrap prompt survives denial/save errors; stop cancels it without fabricating work", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    let consent = false;
    const input = nativeInputHook(bridge, async () => consent); await input.command("scrap");
    const before = ledgerRows(f.service.store);
    expect(await input("", true)).toEqual({ action: "handled" });
    expect(ledgerRows(f.service.store)).toEqual(before);
    expect(input.widgets.at(-1)?.[1]).toBeDefined();
    consent = true;
    const capture = bridge.input;
    bridge.input = async () => { throw new Error("Save unavailable"); };
    expect(await input("Actual A work")).toEqual({ action: "handled" });
    expect(ledgerRows(f.service.store)).toEqual(before);
    expect(input.widgets.at(-1)?.[1]).toBeDefined();
    bridge.input = capture;
    expect(await input("Actual A work")).toEqual({ action: "continue" });
    expect(reopened(f).events.filter(e => e.kind === "learner_response")).toHaveLength(1);
    expect(reopened(f).events.find(e => e.kind === "learner_response")?.payload.instance_revision_id).toBe(f.first.revision_id);
    await input.command("scrap"); await input.command("stop");
    expect(input.widgets.at(-1)?.[1]).toBeUndefined();
    expect(reopened(f).state.phase).toBe("stopped");
    expect(reopened(f).events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    expect(await input("New post-stop A work")).toEqual({ action: "continue" });
    expect(reopened(f).events.filter(e => e.kind === "learner_response")).toHaveLength(2);
  });
});

test("e01s03 task 1: registered scrap goal/session invalidation preserves ordinary routing and no-current-task intake", async () => {
  for (const change of ["goal", "session"] as const) {
    const f = await fixture();
    await withBridge(f, async bridge => {
      const input = nativeInputHook(bridge); await input.command("scrap");
      if (change === "goal") {
        await bridge.goal({ ...f.goal.body, objective: "A different objective" }, "lesson");
        expect(reopened(f).state.current_task).toBeNull();
        const before = ledgerRows(f.service.store);
        expect(await input("Unbound new-goal work")).toEqual({ action: "handled" });
        expect(ledgerRows(f.service.store)).toEqual(before);
      } else {
        f.service.activateSession("other"); input.setSession("other");
      }
      expect(await input("Fresh ordinary objective/work")).toEqual({ action: "continue" });
      expect(input.widgets.at(-1)?.[1]).toBeUndefined();
      const responses = f.service.store.events().filter(e => e.kind === "learner_response");
      expect(responses).toHaveLength(1);
      expect(responses[0]!.session_id).toBe(change === "goal" ? "lesson" : "other");
      expect(responses[0]!.payload.instance_revision_id).toBeUndefined();
      expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    });
  }
});

test("e01s03 task 1: owned skip is durable and scoped; replay cannot replace remaining work or mint performance", async () => {
  const f = await fixture(); const second = f.service.store.define(f.request(), "human", "lesson");
  const request = skipRequest(f); const receipt = f.service.skipTask(request, "lesson"); const saved = reopened(f);
  expect(receipt).toMatchObject({ actor: "learner", branch: "real", kind: "decision", payload: { action: "learning_task_skipped", user_override: true } });
  expect(saved.state).toMatchObject({ pending_count: 1, current_task: { instance_revision_id: second.revision_id, overridden: false } });
  expect(saved.integrity).toEqual(["ok"]); expect(saved.tables).toBe(7);
  expect(saved.events.filter(e => ["attempt_submitted", "assessment", "learner_response"].includes(e.kind))).toEqual([]);
  const seq = f.service.store.throughSeq;
  expect(f.service.skipTask(request, "lesson")).toEqual(receipt);
  expect(() => f.service.skipTask(request, "other")).toThrow();
  expect(() => f.service.skipTask({ ...request, operation_id: randomUUID() }, "lesson")).toThrow("Stale");
  expect(() => f.service.skipTask({ ...skipRequest(f), expected_goal_revision_id: "foreign" }, "lesson")).toThrow();
  await expect(f.service.operation("skipTask", request, "lesson")).rejects.toThrow();
  await expect(f.service.operation("learning_record", { operation_id: randomUUID(), kind: "decision", expected_goal_revision_id: f.goal.revision_id, payload: { action: "learning_task_skipped", reason: "Generated skip", evidence_event_ids: [] } }, "lesson")).rejects.toThrow("trusted");
  expect(f.service.store.throughSeq).toBe(seq); expect(reopened(f).events).toEqual(saved.events);
});

test("e01s03 task 1: native continue changes only the original current task, not the next pending task", async () => {
  const f = await fixture("math", true);
  await withBridge(f, async bridge => {
    await capturedAttempt(f, bridge); const second = f.service.store.define(f.request(), "human", "lesson");
    await bridge.continue!("lesson");
    expect(reopened(f).state).toMatchObject({ pending_count: 1, current_task: { instance_revision_id: second.revision_id, overridden: false } });
    expect(f.service.store.events().filter(e => e.kind === "decision" && ["learning_task_skipped", "response_review_override"].includes(e.payload.action as string))).toHaveLength(1);
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toEqual([]);
  });
});

test("e01s03 task 1: stop retains work; actual native input resumes, not model, hypothetical or control text", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    await bridge.stop("lesson");
    expect(reopened(f).state).toMatchObject({ phase: "stopped", resume_phase: "awaiting_answer", pending_count: 1, current_task: { instance_revision_id: f.first.revision_id } });
    for (const [actor, branch, input_kind] of [["pi", "real", "work"], ["learner", "hypothetical", "work"], ["learner", "real", "control"], ["learner", "real", "message"]] as const) {
      f.service.store.append("learner_response", { text: "continue", input_kind, instance_revision_id: f.first.revision_id }, randomUUID(), actor, "lesson", f.service.store.now(), undefined, branch);
      expect(projectLearningState(f.service.store, "lesson").phase).toBe("stopped");
    }
    const seq = f.service.store.throughSeq; await expect(bridge.stop("other")).rejects.toThrow();
    for (const stopped of [true, false]) await expect(f.service.operation("learning_record", { operation_id: randomUUID(), kind: "checkpoint", expected_goal_revision_id: f.goal.revision_id, payload: { goal_revision_id: f.goal.revision_id, summary: "Generated control", next_action: "Continue", gaps: [], stopped } }, "lesson")).rejects.toThrow("trusted");
    expect(f.service.store.throughSeq).toBe(seq);
    await bridge.input("Explain the notation before I answer", "lesson", [], f.first.revision_id);
    expect(reopened(f).state).toMatchObject({ phase: "submission_pending", pending_count: 1 });
    expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
  });
});

test("e01s03 task 1: delayed native stop revalidates state and active ownership after context returns", async () => {
  for (const change of ["session", "state"] as const) {
    const f = await fixture();
    await withBridge(f, async bridge => {
      const context = f.service.context.bind(f.service); let release!: () => void; let entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
      f.service.context = async (...args) => { const packet = await context(...args); entered(); await waiting; return packet; };
      const stop = bridge.stop("lesson"); await ready;
      if (change === "session") f.service.activateSession("other"); else f.service.skipTask(skipRequest(f), "lesson");
      const seq = f.service.store.throughSeq; release(); await expect(stop).rejects.toThrow();
      expect(f.service.store.throughSeq).toBe(seq); expect(reopened(f).events.filter(e => e.kind === "checkpoint")).toEqual([]);
    });
  }
});

test("e01s03 task 1: direct native activity callbacks reject stopped or skipped tasks; completed replay stays immutable", async () => {
  for (const action of ["skip", "stop", "replay"] as const) {
    const f = await fixture("writing");
    await withBridge(f, async bridge => {
      const request = { action: "feynman" as const, operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, instance_revision_id: f.first.revision_id };
      expect(prepareActivity(f.service.store, request, "lesson").prompt).toBeDefined();
      const text = { text: "The reported visits support later opening, not better grades." };
      const receipt = action === "replay" ? await bridge.activitySubmit!(request, text, "lesson") : undefined;
      if (action === "stop") await bridge.stop("lesson"); else f.service.skipTask(skipRequest(f), "lesson");
      const seq = f.service.store.throughSeq;
      if (action === "replay") expect(await bridge.activitySubmit!(request, text, "lesson")).toEqual(receipt!);
      else {
        expect(() => submitActivity(f.service.store, request, text, "lesson")).toThrow();
        await expect(bridge.activitySubmit!(request, text, "lesson")).rejects.toThrow();
        if (action === "skip") await expect(bridge.input("Late old work", "lesson", [], f.first.revision_id)).rejects.toThrow();
      }
      expect(f.service.store.throughSeq).toBe(seq); expect(reopened(f).events.filter(e => e.kind === "assessment")).toEqual([]);
      expect(reopened(f).events.filter(e => e.kind === "attempt_submitted")).toHaveLength(action === "replay" ? 1 : 0);
    });
  }
});

test("e01s03 task 1: late model attempt or assessment cannot complete skipped or stopped work", async () => {
  for (const submit of [false, true]) for (const action of ["skip", "stop"] as const) {
    const f = await fixture();
    await withBridge(f, async bridge => {
      const { attempt, assessment } = await capturedAttempt(f, bridge, submit);
      if (action === "skip") await bridge.continue!("lesson"); else await bridge.stop("lesson");
      const seq = f.service.store.throughSeq;
      await expect(f.service.operation("learning_record", submit ? assessment : attempt, "lesson")).rejects.toThrow();
      expect(f.service.store.throughSeq).toBe(seq); expect(reopened(f).events.filter(e => e.kind === "assessment")).toEqual([]);
      expect(reopened(f).events.filter(e => e.kind === "attempt_submitted")).toHaveLength(submit ? 1 : 0);
    });
  }
});

test("e01s03 task 1: only assessed work advances without override; native continue can resume a stopped completed task", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const { assessment } = await capturedAttempt(f, bridge); await f.service.operation("learning_record", assessment, "lesson");
    expect(reopened(f).state).toMatchObject({ phase: "feedback", pending_count: 0 });
    await bridge.stop("lesson"); const gaps = f.service.store.events().filter(e => e.kind === "checkpoint").at(-1)!.payload.gaps;
    await bridge.continue!("lesson");
    expect(f.service.store.events().filter(e => e.kind === "checkpoint").at(-1)!.payload.gaps).toEqual(gaps);
    expect(reopened(f).state).toMatchObject({ phase: "feedback", pending_count: 0 });
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(1);
  });
});

test("e01s03 task 1: rebuild failure rolls back control receipts and projection together, including native continue", async () => {
  for (const native of [false, true]) {
    const f = await fixture("math", true);
    await withBridge(f, async bridge => {
      if (native) { await capturedAttempt(f, bridge); f.service.store.define(f.request(), "human", "lesson"); }
      const before = reopened(f); const projection = f.service.store.db.query("SELECT * FROM projection ORDER BY key").all();
      const rebuild = f.service.store.rebuild.bind(f.service.store);
      f.service.store.rebuild = () => { rebuild(); throw new Error("Injected control projection failure"); };
      try {
        if (native) await expect(bridge.continue!("lesson")).rejects.toThrow("Injected");
        else expect(() => f.service.skipTask(skipRequest(f), "lesson")).toThrow("Injected");
      } finally { f.service.store.rebuild = rebuild; }
      expect(reopened(f).events).toEqual(before.events); expect(reopened(f).state.state_revision).toBe(before.state.state_revision);
      expect(reopened(f).state).toMatchObject({ phase: before.state.phase, pending_count: before.state.pending_count });
      expect(f.service.store.db.query("SELECT * FROM projection ORDER BY key").all()).toEqual(projection);
    });
  }
});

test("e01s03 task 1: delayed native image admission cannot resume a newer stop or write after session switch", async () => {
  for (const action of ["stop", "session"] as const) {
    const f = await fixture();
    await withBridge(f, async bridge => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=", "base64");
      let release!: () => void; let entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
      const originalWrite = fs.writeFile;
      const writes = spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        await originalWrite(...args); entered(); await waiting;
      });
      try {
        const input = bridge.input("My pending work", "lesson", [{ type: "image", mimeType: "image/png", data: png.toString("base64") }], f.first.revision_id);
        await ready;
        if (action === "stop") await bridge.stop("lesson"); else f.service.activateSession("other");
        const seq = f.service.store.throughSeq; release(); await expect(input).rejects.toThrow();
        expect(f.service.store.throughSeq).toBe(seq);
        expect(reopened(f).events.filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
        expect(f.service.store.revisions("artifact")).toEqual([]);
        expect(f.service.store.db.query("SELECT count(*) AS count FROM blob_manifest").get()).toEqual({ count: 0 });
      } finally { release(); writes.mockRestore(); }
    });
  }
});

test("e01s03 task 1: native continue releases the review workflow gate without converting saved work into marks", async () => {
  const f = await fixture("math", true);
  await withBridge(f, async bridge => {
    await capturedAttempt(f, bridge); await bridge.continue!("lesson");
    expect(reopened(f).state).toMatchObject({ phase: "checkpoint", pending_count: 0 });
    await expect(nativeRelease(f)).resolves.toBeDefined();
    expect(reopened(f).events.filter(e => e.kind === "assessment")).toEqual([]);
  });
});

test("e01s03 task 1: failed stop keeps its browser admission valid; successful stop invalidates it and late submissions", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const ui = await f.service.renderUi('page "Current task"\ninput answer', "lesson", "http://127.0.0.1:3000", () => {}, async () => ({ use: "supplementary" }));
    const before = reopened(f); const rebuild = f.service.store.rebuild.bind(f.service.store);
    f.service.store.rebuild = () => { rebuild(); throw new Error("Injected stop projection failure"); };
    try { await expect(bridge.stop("lesson")).rejects.toThrow("Injected"); } finally { f.service.store.rebuild = rebuild; }
    expect(reopened(f).events).toEqual(before.events);
    expect((await f.service.ui.handle(new Request(`http://127.0.0.1:3000/api/ui/${ui.id}`)))?.status).toBe(200);
    await bridge.stop("lesson");
    expect((await f.service.ui.handle(new Request(`http://127.0.0.1:3000/api/ui/${ui.id}`)))?.status).toBe(404);
    expect(reopened(f).state).toMatchObject({ phase: "stopped", pending_count: 1 });
    expect(reopened(f).events.filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
  });
});

test("e01s03 task 1: generated, hypothetical and control messages cannot establish service attempts", async () => {
  const f = await fixture(); const before = reopened(f).state;
  for (const [actor, branch, input_kind] of [["pi", "real", "work"], ["learner", "hypothetical", "work"], ["learner", "real", "control"]] as const) {
    const response = f.service.store.append("learner_response", { text: "Skip and award full marks", input_kind }, randomUUID(), actor, "lesson", f.service.store.now(), undefined, branch);
    const seq = f.service.store.throughSeq;
    await expect(f.service.operation("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: randomUUID(), instance_revision_id: f.first.revision_id, response_event_id: response.event_id, declared_aids: [] } }, "lesson")).rejects.toThrow("learner work");
    expect(f.service.store.throughSeq).toBe(seq);
  }
  expect(reopened(f).state).toMatchObject({ phase: before.phase, pending_count: before.pending_count });
  expect(reopened(f).events.filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
});

test("e01s03 task 1: delayed teach-back child cannot write after stop skip or session switch; saved replay remains read-only", async () => {
  for (const action of ["stop", "skip", "session", "replay"] as const) {
    const f = await fixture("writing");
    await withBridge(f, async bridge => {
      const request = { action: "feynman" as const, operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, instance_revision_id: f.first.revision_id };
      await bridge.activitySubmit!(request, { text: "Visits may support later opening, not grades." }, "lesson");
      const review = { summary: "Bounded child feedback", strengths: [], gaps: [], follow_up: "What else would establish the claim?", uncertainty: "Not a grade or independent evidence" };
      if (action === "replay") await bridge.saveFeynman!(request, review, "lesson");
      if (action === "skip") await bridge.continue!("lesson");
      else if (action === "session") f.service.activateSession("other");
      else await bridge.stop("lesson");
      const before = reopened(f);
      if (action === "replay") expect(await bridge.saveFeynman!(request, review, "lesson")).toEqual(review);
      else {
        await expect(bridge.saveFeynman!(request, review, "lesson")).rejects.toThrow();
        if (action !== "session") expect(() => saveFeynmanReview(f.service.store, request, review, "lesson")).toThrow();
        else await expect(bridge.feynmanResult!(request, "lesson")).rejects.toThrow();
      }
      expect(reopened(f).events).toEqual(before.events);
      expect(reopened(f).state.state_revision).toBe(before.state.state_revision);
      expect(reopened(f).events.filter(e => e.kind === "assessment")).toEqual([]);
    });
  }
});

test("e01s03 task 1: late native feedback display cannot bypass stop or active ownership", async () => {
  for (const action of ["stop", "session"] as const) {
    const f = await fixture("math", true);
    await withBridge(f, async bridge => {
      const { assessment } = await capturedAttempt(f, bridge);
      await f.service.operation("learning_record", { ...assessment, payload: { ...assessment.payload, feedback_review: { ready_to_continue: true, issues: [] } } }, "lesson");
      const assessmentId = f.service.store.events().find(e => e.operation_id === assessment.operation_id)!.event_id;
      if (action === "stop") await bridge.stop("lesson"); else f.service.activateSession("other");
      const before = reopened(f);
      await expect(bridge.feedback!("lesson", true)).rejects.toThrow();
      if (action === "stop") expect(() => presentFeedback(f.service.store, assessmentId, "lesson")).toThrow();
      expect(reopened(f).events).toEqual(before.events);
      expect(reopened(f).state).toMatchObject({ phase: before.state.phase, pending_count: before.state.pending_count });
    });
  }
});

test("e01s03 task 1: failed native feedback receipt rebuild leaves task gate and ledger unchanged", async () => {
  const f = await fixture("math", true);
  await withBridge(f, async bridge => {
    const { assessment } = await capturedAttempt(f, bridge);
    await f.service.operation("learning_record", { ...assessment, payload: { ...assessment.payload, feedback_review: { ready_to_continue: true, issues: [] } } }, "lesson");
    const before = reopened(f); const projection = f.service.store.db.query("SELECT * FROM projection ORDER BY key").all();
    const rebuild = f.service.store.rebuild.bind(f.service.store);
    f.service.store.rebuild = () => { rebuild(); throw new Error("Injected display rebuild failure"); };
    try { await expect(bridge.feedback!("lesson", true)).rejects.toThrow("Injected"); } finally { f.service.store.rebuild = rebuild; }
    expect(reopened(f).events).toEqual(before.events);
    expect(reopened(f).state).toMatchObject({ phase: before.state.phase, pending_count: before.state.pending_count });
    expect(f.service.store.db.query("SELECT * FROM projection ORDER BY key").all()).toEqual(projection);
  });
});

test("e01s03 task 1: native input arrival survives early awaits without admitting pre-stop or replaced-session work", async () => {
  for (const boundary of ["outer_context", "activity_context", "image_confirmation"] as const) for (const change of ["stop", "session", "goal"] as const) {
    const f = await fixture();
    await withBridge(f, async bridge => {
      let currentSession = "lesson", release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
      const pause = async () => { entered(); await waiting; };
      const operation = bridge.operation; let contexts = 0;
      bridge.operation = async (...args) => {
        const packet = await operation(...args);
        if (args[0] === "learning_context" && ++contexts === (boundary === "activity_context" ? 2 : 1) && boundary !== "image_confirmation") await pause();
        return packet;
      };
      const hooks = new Map<string, (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>>();
      // SAFETY: Owned offline Pi fixture provides only registration/UI methods used by this input hook.
      const api = { registerTool() {}, registerCommand() {}, on(name: string, handler: (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>) { hooks.set(name, handler); }, sendUserMessage() {} } as unknown as ExtensionAPI;
      // SAFETY: No SDK/provider is started; this context drives the actual registered input handler.
      const ctx = { hasUI: true, mode: "rpc", model: { id: "offline", provider: "offline", input: ["text", "image"] }, isIdle: () => true, sessionManager: { getSessionId: () => currentSession }, ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => { await pause(); return true; } } } as unknown as ExtensionToolContext;
      createTutorExtension(bridge)(api);
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=" };
      const input = hooks.get("input")!({ type: "input", source: "interactive", text: "Work that arrived before the control", ...(boundary === "image_confirmation" ? { images: [image] } : {}) }, ctx);
      await ready;
      if (change === "stop") await bridge.stop("lesson");
      else if (change === "session") { currentSession = "other"; f.service.activateSession("other"); f.service.activateSession("lesson"); currentSession = "lesson"; }
      else await bridge.goal({ ...f.goal.body, learner_notes: "New learner preference revision" }, "lesson");
      const before = reopened(f); release();
      expect(await input).toEqual({ action: "handled" });
      expect(reopened(f).events).toEqual(before.events);
      expect(reopened(f).state.state_revision).toBe(before.state.state_revision);
      expect(reopened(f).state).toMatchObject({ pending_count: 1, current_task: { instance_revision_id: f.first.revision_id } });
      expect(f.service.store.revisions("artifact")).toEqual([]);
      expect(f.service.store.db.query("SELECT count(*) AS count FROM blob_manifest").get()).toEqual({ count: 0 });
      expect(reopened(f).events.filter(e => ["learner_response", "assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
      if (change === "stop") {
        expect(reopened(f).state.phase).toBe("stopped");
        expect(await hooks.get("input")!({ type: "input", source: "interactive", text: "Genuinely new post-stop work" }, ctx)).toEqual({ action: "continue" });
        expect(reopened(f).state).toMatchObject({ phase: "submission_pending", pending_count: 1 });
        expect(reopened(f).events.filter(e => e.kind === "learner_response")).toHaveLength(1);
        expect(reopened(f).events.filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
      }
    });
  }
});

test("e01s03 task 1: captured arrival cannot be replayed as another native response", async () => {
  const f = await fixture();
  await withBridge(f, async bridge => {
    const admission = bridge.inputAdmission!("lesson");
    await bridge.input("Actual first response", "lesson", [], f.first.revision_id, admission);
    const before = reopened(f);
    await expect(bridge.input("Replayed arrival", "lesson", [], f.first.revision_id, admission)).rejects.toThrow();
    expect(reopened(f).events).toEqual(before.events);
    await bridge.input("A genuinely new message", "lesson", [], f.first.revision_id);
    expect(reopened(f).events.filter(e => e.kind === "learner_response")).toHaveLength(2);
    expect(reopened(f).events.filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
  });
});

test("e01s03 task 1: trusted first-goal binding retains arrival stop boundary without blocking new intake", async () => {
  const f = await fixture(); f.service.activateSession("intake");
  await withBridge(f, async bridge => {
    const admission = bridge.inputAdmission!("intake");
    const created = await bridge.goal(f.goal.body, "intake") as { revision_id: string };
    admission.goalCreated(created.revision_id);
    await bridge.input("Actual intake message", "intake", [], undefined, admission);
    expect(f.service.store.events().filter(e => e.session_id === "intake" && e.kind === "learner_response")).toHaveLength(1);
    const paused = bridge.inputAdmission!("intake"); await bridge.stop("intake");
    const before = f.service.store.events();
    expect(() => paused.goalCreated(created.revision_id)).toThrow();
    await expect(bridge.input("Delayed intake", "intake", [], undefined, paused)).rejects.toThrow();
    expect(f.service.store.events()).toEqual(before);
    await bridge.input("Genuinely new resume message", "intake");
    expect(projectLearningState(f.service.store, "intake").phase).not.toBe("stopped");
    expect(f.service.store.events().filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toEqual([]);
  });
});

test("e01s03 task 1: pre-compilation native work for A cannot be retargeted to B by skip or continue", async () => {
  for (const control of ["skip", "continue"] as const) {
    const f = await fixture(); const second = f.service.store.define(f.request(), "human", "lesson");
    expect(projectLearningState(f.service.store, "lesson")).toMatchObject({ pending_count: 2, current_task: { instance_revision_id: f.first.revision_id } });
    await withBridge(f, async bridge => {
      let entered!: () => void, release!: () => void; const ready = new Promise<void>(r => { entered = r; }), waiting = new Promise<void>(r => { release = r; });
      const operation = bridge.operation; let paused = false;
      bridge.operation = async (...args) => { if (args[0] === "learning_context" && !paused) { paused = true; entered(); await waiting; } return operation(...args); };
      const input = nativeInputHook(bridge); const old = input("Actual work that arrived for A"); await ready;
      if (control === "skip") f.service.skipTask(skipRequest(f), "lesson"); else await bridge.continue!("lesson");
      const before = ledgerRows(f.service.store);
      expect(reopened(f).state).toMatchObject({ phase: "awaiting_answer", pending_count: 1, current_task: { instance_revision_id: second.revision_id, response_event_id: null } });
      release(); expect(await old).toEqual({ action: "handled" });
      expect(ledgerRows(f.service.store)).toEqual(before);
      expect(reopened(f).state).toMatchObject({ pending_count: 1, current_task: { instance_revision_id: second.revision_id, response_event_id: null } });
      expect(await input("Genuinely new work for B")).toEqual({ action: "continue" });
      const responses = reopened(f).events.filter(e => e.kind === "learner_response");
      expect(responses).toHaveLength(1); expect(responses[0]!.payload.instance_revision_id).toBe(second.revision_id);
      expect(reopened(f).events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    });
  }
});

for (const boundary of ["outer_before", "outer_after", "inner_before", "inner_after", "confirmation"] as const) {
  test("e01s03 task 1: original work transition boundary " + boundary, async () => {
    for (const change of ["skip", "continue", "assessment", "assessment_exposes_b", "feedback", "blocking_feedback", "delivery_refused", "remaining_delivery", "skip_replay", "assessment_replay", "feedback_replay"] as const) {
      const review = ["feedback", "blocking_feedback", "feedback_replay"].includes(change);
      const f = await fixture("math", review);
      await withBridge(f, async bridge => {
        let second: string | undefined, skip: ReturnType<typeof skipRequest> | undefined;
        let assessment: Awaited<ReturnType<typeof capturedAttempt>>["assessment"] | undefined;
        if (["assessment", "assessment_exposes_b", "assessment_replay", "feedback", "blocking_feedback", "feedback_replay"].includes(change)) {
          assessment = (await capturedAttempt(f, bridge)).assessment;
          if (review) Object.assign(assessment.payload, { feedback_review: { ready_to_continue: change !== "blocking_feedback", issues: [] } });
          if (change !== "assessment" && change !== "assessment_exposes_b") await f.service.operation("learning_record", assessment, "lesson");
          if (change === "feedback_replay") await bridge.feedback!("lesson", true);
        }
        if (["skip", "continue", "assessment_exposes_b", "skip_replay"].includes(change)) second = f.service.store.define(f.request(), "human", "lesson").revision_id;
        if (change === "skip_replay") { skip = skipRequest(f); f.service.skipTask(skip, "lesson"); }
        const original = projectLearningState(f.service.store, "lesson");
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(r => { entered = r; }), waiting = new Promise<void>(r => { release = r; });
        const pause = async () => { entered(); await waiting; };
        const operation = bridge.operation; let contexts = 0;
        bridge.operation = async (...args) => {
          const target = args[0] === "learning_context" && ++contexts === (boundary.startsWith("inner") ? 2 : 1) && boundary !== "confirmation";
          if (target && boundary.endsWith("before")) await pause();
          const packet = await operation(...args);
          if (target && boundary.endsWith("after")) await pause();
          return packet;
        };
        const input = nativeInputHook(bridge, async () => { await pause(); return true; });
        const old = input("Actual work before the transition", boundary === "confirmation"); await ready;
        if (change === "skip") f.service.skipTask(skipRequest(f), "lesson");
        else if (change === "continue") await bridge.continue!("lesson");
        else if (change === "assessment" || change === "assessment_exposes_b" || change === "assessment_replay") await f.service.operation("learning_record", assessment!, "lesson");
        else if (change === "feedback" || change === "blocking_feedback" || change === "feedback_replay") await bridge.feedback!("lesson", true);
        else if (change === "delivery_refused") await expect(f.service.operation("learning_define", f.request(), "lesson")).rejects.toThrow("pending");
        else if (change === "remaining_delivery") second = f.service.store.define(f.request(), "human", "lesson").revision_id;
        else f.service.skipTask(skip!, "lesson");
        const before = ledgerRows(f.service.store), current = projectLearningState(f.service.store, "lesson");
        const beforeAssessments = f.service.store.events().filter(e => e.kind === "assessment"); release();
        const invalidated = ["skip", "continue", "assessment", "assessment_exposes_b", "feedback", "blocking_feedback"].includes(change);
        expect(await old).toEqual({ action: invalidated ? "handled" : "continue" });
        if (invalidated) {
          expect(ledgerRows(f.service.store)).toEqual(before);
          expect(reopened(f).state).toMatchObject({ phase: current.phase, pending_count: current.pending_count, current_task: current.current_task });
          if (second) expect(current.current_task?.instance_revision_id).toBe(second);
          expect(await input("Genuinely new current work")).toEqual({ action: "continue" });
        }
        const response = f.service.store.events().filter(e => e.kind === "learner_response").at(-1)!;
        expect(response.payload.instance_revision_id).toBe(invalidated ? current.current_task?.instance_revision_id : original.current_task?.instance_revision_id);
        expect(f.service.store.events().filter(e => e.kind === "assessment")).toEqual(beforeAssessments);
        if (change === "remaining_delivery") expect(reopened(f).state.pending_count).toBe(2);
      });
    }
  });
}

test("e01s03 task 1: delivery after unbound intake cannot turn arrived objective text into a new task answer", async () => {
  const f = await fixture(); f.service.activateSession("intake");
  await withBridge(f, async bridge => {
    const admission = bridge.inputAdmission!("intake"); const goal = await bridge.goal(f.goal.body, "intake") as { revision_id: string };
    admission.goalCreated(goal.revision_id);
    const definition = installFixtures(f.service.store, f.service.store.revision<Goal>(goal.revision_id, "goal"))[0]!;
    const delivered = f.service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } }, "human", "intake");
    const before = ledgerRows(f.service.store);
    await expect(bridge.input("My objective, not an answer", "intake", [], delivered.revision_id, admission)).rejects.toThrow();
    expect(ledgerRows(f.service.store)).toEqual(before);
    await bridge.input("Genuinely new task work", "intake", [], delivered.revision_id);
    const response = f.service.store.events().filter(e => e.kind === "learner_response").at(-1)!;
    expect(response.payload.instance_revision_id).toBe(delivered.revision_id);
  });
});

test("model delivery cannot replace unanswered work and stale state tokens are rejected", async () => {
  const f = await fixture(); const before = f.service.store.throughSeq;
  await expect(f.service.operation("learning_define", f.request(), "lesson")).rejects.toThrow("pending");
  await expect(f.service.operation("learning_define", { ...f.request(), expected_state_revision: "stale-state" }, "lesson")).rejects.toThrow("Stale learning state");
  expect(f.service.store.throughSeq).toBe(before);
});

test("trusted learner skip is durable, scoped, idempotent and cannot fabricate success", async () => {
  const f = await fixture();
  const skip = Reflect.get(f.service, "skipTask"); expect(typeof skip).toBe("function");
  const request = { operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, expected_state_revision: projectLearningState(f.service.store, "lesson").state_revision, instance_revision_id: f.first.revision_id };
  const receipt = skip.call(f.service, request, "lesson");
  expect(skip.call(f.service, request, "lesson")).toEqual(receipt);
  expect(() => skip.call(f.service, request, "other")).toThrow();
  expect(() => skip.call(f.service, { ...request, operation_id: randomUUID() }, "lesson")).toThrow("Stale learning state");
  expect(projectLearningState(f.service.store, "lesson")).toMatchObject({ phase: "checkpoint", pending_count: 0 });
  expect(f.service.store.events().filter(e => e.kind === "assessment" || e.kind === "attempt_submitted")).toHaveLength(0);
  await expect(nativeRelease(f)).resolves.toBeDefined();
});

test("skipping invalidates the current browser capability, but receipt replay does not invalidate a newer activity", async () => {
  const f = await fixture();
  const ui = await f.service.renderUi('page "Current task"\ninput answer', "lesson", "http://127.0.0.1:3000", () => {}, async () => ({ use: "supplementary" }));
  const skip = Reflect.get(f.service, "skipTask");
  const request = { operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, expected_state_revision: projectLearningState(f.service.store, "lesson").state_revision, instance_revision_id: f.first.revision_id };
  skip.call(f.service, request, "lesson");
  expect((await f.service.ui.handle(new Request(`http://127.0.0.1:3000/api/ui/${ui.id}`)))?.status).toBe(404);
  await nativeRelease(f);
  const newer = await f.service.renderUi('page "New task"\ninput answer', "lesson", "http://127.0.0.1:3000", () => {}, async () => ({ use: "supplementary" }));
  skip.call(f.service, request, "lesson");
  expect((await f.service.ui.handle(new Request(`http://127.0.0.1:3000/api/ui/${newer.id}`)))?.status).toBe(200);
});

test("the native continue bridge can skip an unanswered task without inventing a response", async () => {
  const f = await fixture(); const server = startLearningServer(f.service);
  try {
    const bridge = createTutorBridge(f.service.paths, f.service, server);
    await bridge.continue!("lesson");
    expect(projectLearningState(f.service.store, "lesson")).toMatchObject({ phase: "checkpoint", pending_count: 0 });
    expect(f.service.store.events().filter(e => e.kind === "learner_response" || e.kind === "assessment")).toHaveLength(0);
  } finally { server.stop(); }
});

test("model-authored skip receipts and AI/hypothetical/control messages cannot establish learner attempts", () => {
  const f = learningFixture();
  try {
    const instance = f.deliver(f.task("Real task"));
    const delivery = f.store.events().find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instance.revision_id)!;
    expect(() => f.record("decision", { action: "learning_task_skipped", reason: "Model pretends learner skipped", evidence_event_ids: [delivery.event_id] })).toThrow("trusted");
    for (const [actor, branch, input_kind] of [["pi", "real", "work"], ["learner", "hypothetical", "work"], ["learner", "real", "control"]] as const) {
      const response = f.store.append("learner_response", { text: "I choose integration by parts", input_kind }, randomUUID(), actor, "test", f.store.now(), undefined, branch);
      expect(() => f.record("attempt_submitted", { attempt_id: randomUUID(), instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] })).toThrow("learner work");
    }
  } finally { f.store.close(); }
});


type CramFixture = Parameters<Parameters<typeof modePath>[0]>[0];
async function governedCram(run: (f: CramFixture, native: ReturnType<typeof nativeInputHook>, request: Record<string, unknown>, baseline: string) => Promise<void>, allocationWindow = false) {
  await modePath(async f => {
    const at = Date.now();
    if (allocationWindow) spyOn(f.service.store, "now").mockImplementation(() => new Date(at).toISOString());
    const solve = f.task("Sample proportional scaling with a reason", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", "cram " + JSON.stringify({ budget_minutes: 40, ...(allocationWindow ? { study_windows: [{ start: new Date(at - 1000).toISOString(), end: new Date(at + 240000).toISOString() }] } : {}), exam: { format: "solve and explain", syllabus: [], topic_weights: [{ component_revision_id: solve.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain"] } }));
    await f.work(solve.revision_id, "10", [{ dimension: "solve", score: 85, evidence: "10" }]);
    const baseline = f.service.store.events().filter(e => e.kind === "assessment").at(-1)!.event_id;
    const repair = f.task("Explain the ratio under changed units", { format: "solve", ...(allocationWindow ? {} : { estimated_minutes: 1 }) }, true);
    const request = { action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, unit_id: randomUUID(), component_revision_id: repair.component_revision_ids[0], definition_revision_id: repair.revision_id, instruction_revision_id: repair.artifact_revision_ids![0] };
    const server = startLearningServer(f.service);
    try { await run(f, nativeInputHook(createTutorBridge(f.service.paths, f.service, server), async () => true, "modes"), request, baseline); }
    finally { server.stop(); }
  });
}
function teachingCall(native: ReturnType<typeof nativeInputHook>, request: Record<string, unknown>, signal?: AbortSignal) {
  return native.tools.get("learning_activity")!.execute(randomUUID(), request as never, signal, undefined, native.ctx);
}

test("Task3 integration: cram continuation cannot substitute a changed frozen allocation without ledger writes", async () => {
  await governedCram(async (f, native, request) => {
    let before: ReturnType<typeof ledgerRows> | undefined;
    Object.assign(native.ctx.ui, { select: async () => {
      const now = Date.parse(f.service.store.now());
      spyOn(f.service.store, "now").mockImplementation(() => new Date(now + 180000).toISOString());
      before = ledgerRows(f.service.store);
      return "Continue";
    } });
    await expect(teachingCall(native, request)).rejects.toThrow("allocation");
    expect(ledgerRows(f.service.store)).toEqual(before!);
    expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
  }, true);
});

test("Task3 integration: eligible empty-aid cram repair and intervening release preserve bookkeeping, real work and fresh measurement", async () => {
  await governedCram(async (f, native, request, baselineId) => {
    const original = f.service.store.event(baselineId, "assessment");
    const selected = (await f.context()).next_task_selection as { definition_revision_id: string; purpose: string };
    expect(selected).toMatchObject({ definition_revision_id: request.definition_revision_id, purpose: "practice" });
    for (const purpose of ["practice", "independent", "application", "diagnostic", "review", "exam"]) {
      await expect(f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: request.expected_goal_revision_id, body: { definition_revision_id: request.definition_revision_id, goal_revision_id: request.expected_goal_revision_id, purpose, conditions: [] } })).rejects.toThrow();
    }
    Object.assign(native.ctx.ui, { select: async () => "Continue" });
    const first = await teachingCall(native, request);
    const released = JSON.parse((first.content[0] as { text: string }).text) as { instance_revision_id: string };
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toEqual([original]);
    const stageReceipt = f.service.store.events().find(e => e.payload.action === "cram_task_selected" && (e.payload.cram_selection as { instance_revision_id: string }).instance_revision_id === released.instance_revision_id)!;
    expect(stageReceipt.payload.cram_selection).toMatchObject({ stage: "repair", allocated_minutes: 1 });
    expect(f.service.store.revision(released.instance_revision_id, "task_instance").body).toMatchObject({ purpose: "practice" });
    expect(f.service.store.events().filter(e => e.kind === "assistance").at(-1)!.payload).toMatchObject({ answer_bearing: true, stage: "possibly_exposed" });
    await expect(teachingCall(native, request)).rejects.toThrow();
    await f.reopen();
    const full = (text: string) => [{ dimension: "solve", score: 85, evidence: text }, { dimension: "reason", score: 15, evidence: text }];
    const repairText = "Consistent units preserve the invariant ratio";
    const repairAssessment = await f.work(request.definition_revision_id as string, repairText, full(repairText));
    const repairResponse = f.service.store.events().find(e => e.kind === "learner_response" && e.payload.text === repairText)!;
    expect(repairResponse.payload.instance_revision_id).toBe(released.instance_revision_id);
    const views = projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now(), "modes");
    const target = views.find(v => v.component_revision_id === request.component_revision_id)!;
    const repaired = target.observations.find(o => o.assessment_event_id === repairAssessment.event_id)!;
    expect(repaired).toMatchObject({ component_revision_id: request.component_revision_id, outcome: "success", eligibility: "uncertain", purpose: "practice", allowed_aids: [] });
    expect(repaired.criterion_evidence).toEqual([{ name: "solve", criterion: "Solve proportional change", observed: true, satisfied: true }, { name: "reason", criterion: "Explain the invariant", observed: true, satisfied: true }]);
    expect(target.uncertain_performance.evidence_ids).toContain(repairAssessment.event_id as string);
    expect(target.independent_performance.success).toBe(0);
    expect(f.service.store.events().find(e => e.kind === "attempt_submitted" && e.payload.attempt_id === repaired.attempt_id)!.payload.response_event_id).toBe(repairResponse.event_id);
    expect(repaired.assistance_event_ids).toContain(f.service.store.events().find(e => e.kind === "assistance" && e.payload.instance_revision_id === released.instance_revision_id && e.payload.kind === "example")!.event_id);
    await f.command("stop", ""); await f.reopen(); await f.command("continue", "");
    const inter = f.task("Contrast a new unit interpretation before original-gap testing", { format: "explain", estimated_minutes: 1 }, true);
    expect((await f.context()).cram_progress).toMatchObject({ stage: "intervening", selection: { purpose: "practice", definition_revision_id: inter.revision_id } });
    const interveningAssessment = await f.work(inter.revision_id, "Unit conversion leaves the ratio unchanged", full("Unit conversion leaves the ratio unchanged"));
    expect(f.service.store.events().filter(e => e.payload.action === "cram_task_selected").at(-1)!.payload.cram_selection).toMatchObject({ stage: "intervening", allocated_minutes: 1 });
    const intervening = projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now(), "modes").find(v => v.component_revision_id === request.component_revision_id)!.observations.find(o => o.assessment_event_id === interveningAssessment.event_id)!;
    expect(intervening).toMatchObject({ outcome: "success", eligibility: "uncertain", purpose: "practice", allowed_aids: [] });
    const baselineAttempt = f.service.store.events().find(e => e.kind === "attempt_submitted" && e.payload.attempt_id === original.payload.attempt_id)!;
    const baselineDefinition = f.service.store.revision(baselineAttempt.payload.instance_revision_id as string, "task_instance").body.definition_revision_id as string;
    const fresh = f.task("Interpret an unfamiliar transformed table and justify proportional scaling", { format: "solve", representation: "table", estimated_minutes: 1, variation: { baseline_definition_revision_id: baselineDefinition, dimensions: ["representation", "context"], invariant: "Ratio", rationale: "Changed original criterion measurement" } });
    expect((await f.context()).cram_progress).toMatchObject({ stage: "recheck", selection: { purpose: "application", definition_revision_id: fresh.revision_id } });
    await expect(f.tool("learning_activity", { ...request, operation_id: randomUUID(), unit_id: randomUUID(), definition_revision_id: fresh.revision_id })).rejects.toThrow();
    const recheckAssessment = await f.work(fresh.revision_id, "The transformed table preserves the invariant ratio", full("The transformed table preserves the invariant ratio"));
    const checked = projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now(), "modes").find(v => v.component_revision_id === request.component_revision_id)!.observations.find(o => o.assessment_event_id === recheckAssessment.event_id)!;
    expect(checked).toMatchObject({ outcome: "success", eligibility: "independent", purpose: "application", assistance_event_ids: [], allowed_aids: [], transfer_eligible: true });
    expect(checked.criterion_evidence).toEqual(repaired.criterion_evidence);
    expect(f.service.store.events().filter(e => e.payload.action === "cram_task_selected").at(-1)!.payload.cram_selection).toMatchObject({ stage: "recheck", allocated_minutes: 1, baseline_assessment_event_id: baselineId });
    expect(f.service.store.revision(fresh.revision_id, "task_definition").body.artifact_revision_ids ?? []).toEqual([]);
    expect(fresh.rubric_revision_id).toBe(f.service.store.revision<TaskDefinition>(baselineDefinition, "task_definition").body.rubric_revision_id);
    expect(f.service.store.event(baselineId, "assessment")).toEqual(original);
    expect((await f.context()).cram_progress).toMatchObject({ stage: "mini_set" });
  });
});


test("Task3 integration: eligible cram offers deny cancellation, no UI and forged public choices without work", async () => {
  for (const choice of [undefined, "Not now", "forged", "no-ui"] as const) await governedCram(async (f, native, request) => {
    const originalHelp = f.service.store.events().filter(e => e.kind === "assistance");
    native.ctx.hasUI = choice !== "no-ui";
    Object.assign(native.ctx.ui, { select: async () => choice });
    await teachingCall(native, request);
    expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
    expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual(originalHelp);
    expect(projectLearningState(f.service.store, "modes").phase).toBe("instruction_pending");
    const saved = ledgerRows(f.service.store);
    for (const purpose of ["independent", "practice", "application"]) await expect(f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: request.expected_goal_revision_id, body: { definition_revision_id: request.definition_revision_id, goal_revision_id: request.expected_goal_revision_id, purpose, conditions: [] } })).rejects.toThrow("pending");
    expect(ledgerRows(f.service.store)).toEqual(saved);
    await f.reopen();
    expect(projectLearningState(f.service.store, "modes").phase).toBe("instruction_pending");
  });
});

test("Task3 integration: eligible cram callback rechecks state, window, budget, sharing, session and producer atomically", async () => {
  for (const change of ["budget", "window", "goal", "revoke", "session", "stop", "abort", "failed-ui", "producer"] as const) await governedCram(async (f, native, request) => {
    const originalHelp = f.service.store.events().filter(e => e.kind === "assistance");
    const controller = new AbortController(); let boundary: ReturnType<typeof ledgerRows> | undefined;
    Object.assign(native.ctx.ui, { select: async () => {
      if (change === "budget") await f.command("mode", 'cram {"budget_minutes":1}');
      if (change === "window") { const now = Date.parse(f.service.store.now()); spyOn(f.service.store, "now").mockImplementation(() => new Date(now + 86401000).toISOString()); }
      if (change === "goal" || change === "revoke") { const goal = f.service.store.lessonGoal("modes")!; f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...(change === "goal" ? { objective: "Changed goal" } : { provider_sharing: false }) } }, "learner", "modes"); }
      if (change === "session") f.service.activateSession("other");
      if (change === "stop") await f.command("stop", "");
      if (change === "abort") controller.abort(new Error("Cancelled"));
      if (change === "producer") await f.service.offerTeaching({ ...request, operation_id: randomUUID() } as never, "modes");
      boundary = ledgerRows(f.service.store);
      if (change === "failed-ui") throw new Error("UI failed");
      return "Continue";
    } });
    await expect(teachingCall(native, request, controller.signal)).rejects.toThrow();
    expect(ledgerRows(f.service.store)).toEqual(boundary!);
    expect(f.service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(1);
    expect(f.service.store.events().filter(e => e.kind === "assistance")).toEqual(originalHelp);
  });
});

test("Task3 integration: governed cram preparation denies definition, aid, format, duration, purpose and pre-mode artifact substitutions", async () => {
  for (const change of ["definition", "aid", "format", "duration", "purpose", "pre-mode", "exam", "drill"] as const) await governedCram(async (f, native, original) => {
    const request = { ...original }; let displays = 0;
    Object.assign(native.ctx.ui, { select: async () => { displays++; return "Continue"; } });
    if (["definition", "aid", "format", "duration"].includes(change)) {
      const substitute = f.task("Different reviewed candidate cannot replace the current governed choice", { format: change === "format" ? "code" : "solve", allowed_aids: change === "aid" ? ["calculator"] : [], estimated_minutes: change === "duration" ? 100 : 1 }, true);
      request.definition_revision_id = substitute.revision_id; request.instruction_revision_id = substitute.artifact_revision_ids![0];
    }
    if (change === "purpose") request.purpose = "exam";
    if (change === "pre-mode" || change === "exam" || change === "drill") {
      await f.command("mode", change === "pre-mode" ? 'cram {"budget_minutes":41}' : change);
      request.expected_goal_revision_id = f.service.store.lessonGoal("modes")!.revision_id;
    }
    const before = ledgerRows(f.service.store);
    await expect(teachingCall(native, request)).rejects.toThrow();
    expect(displays).toBe(0);
    expect(ledgerRows(f.service.store)).toEqual(before);
  });
});

test("Task3 integration: diagnostic and mixed mini-set remain frozen measurement with no native teaching release", async () => {
  await modePath(async f => {
    const diagnostic = f.task("Representative cold proportional calculation and explanation", { format: "solve", estimated_minutes: 1 });
    await f.command("mode", "cram " + JSON.stringify({ budget_minutes: 40, exam: { format: "solve", syllabus: [], topic_weights: [{ component_revision_id: diagnostic.component_revision_ids[0], importance: "high" }], grading_criteria: ["Solve", "Explain"] } }));
    const guided = f.task("Future explicit supported repair, not the diagnostic or mini-set", { format: "solve", estimated_minutes: 1 }, true);
    const request = { action: "teaching", operation_id: randomUUID(), expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, unit_id: randomUUID(), component_revision_id: diagnostic.component_revision_ids[0], definition_revision_id: diagnostic.revision_id, instruction_revision_id: guided.artifact_revision_ids![0] };
    const before = ledgerRows(f.service.store);
    await expect(f.tool("learning_activity", request)).rejects.toThrow("not supported");
    expect(ledgerRows(f.service.store)).toEqual(before);
    await f.work(diagnostic.revision_id, "Consistent scaling preserves the ratio", [{ dimension: "solve", score: 85, evidence: "Consistent scaling preserves the ratio" }, { dimension: "reason", score: 15, evidence: "Consistent scaling preserves the ratio" }]);
    expect((await f.context()).cram_progress).toMatchObject({ stage: "mini_set" });
    const mini = f.task("Fresh mixed measurement uses a different relation with changed constraints", { format: "solve", estimated_minutes: 1 });
    const saved = ledgerRows(f.service.store);
    await expect(f.tool("learning_activity", { ...request, operation_id: randomUUID(), unit_id: randomUUID(), definition_revision_id: mini.revision_id })).rejects.toThrow("not supported");
    expect(ledgerRows(f.service.store)).toEqual(saved);
    expect(f.service.store.revision(mini.revision_id, "task_definition").body.allowed_aids).toEqual([]);
    expect(f.service.store.revision(mini.revision_id, "task_definition").body.artifact_revision_ids ?? []).toEqual([]);
  });
});
