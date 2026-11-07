import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { createTutorExtension } from "../src/tutor.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-approve-"));
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths), server = startLearningServer(service);
  cleanup.push(async () => { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); });
  const owner = "approval-owner"; service.activateSession(owner);
  const defined = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Understand quantization", subject: "science", horizon_days: 7, target_format: "qualitative prediction", criteria: ["Distinguish intensity and frequency"], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", owner);
  const goal = service.store.revision<Goal>(defined.revision_id, "goal");
  const bridge = createTutorBridge(paths, service, server);
  const commands = new Map<string, RegisteredCommand>(), notices: string[] = [], messages: string[] = [], reviews: string[] = [];
  createTutorExtension(bridge)({ registerTool() {}, on() {}, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, sendUserMessage(message: string) { messages.push(message); } } as unknown as ExtensionAPI);
  let sid = owner, idle = true;
  const ui = { notify: (text: string) => notices.push(text), select: async (_title: string, options: string[]): Promise<string | undefined> => options[0], confirm: async (title: string, text: string) => { reviews.push(title + text); return true; } };
  const ctx = { hasUI: true, isIdle: () => idle, sessionManager: { getSessionId: () => sid }, ui } as unknown as ExtensionCommandContext;
  const prepare = async (title = "Photoelectric effect") => {
    const current = service.store.lessonGoal(owner)!;
    const state = (await service.context({}, owner)).learning_state as { state_revision: string };
    const result = await service.operation("learning_define", { operation_id: randomUUID(), kind: "lesson_preparation", expected_goal_revision_id: current.revision_id, expected_state_revision: state.state_revision, body: { component: { title, behavior: "Predict electron emission" }, title, instruction: "Photon energy depends on frequency, not beam intensity.", prompt: `${title}: Does brighter subthreshold light eject electrons? Explain.`, criteria: [{ name: "threshold", criterion: "Compare photon energy with the work function", max_score: 2 }], construct: "Energy quantization", variation: "Change frequency or intensity", allowed_aids: [], source_span_ids: [], uncertainty: "Synthetic uncalibrated proposal" } }, owner) as { definition_revision_id: string };
    return service.store.revision<TaskDefinition>(result.definition_revision_id, "task_definition");
  };
  const choices = async () => {
    const method = Reflect.get(bridge, "approvalChoices") as undefined | ((session: string) => Promise<Array<{ revision_id: string; title: string }>>);
    expect(typeof method).toBe("function");
    return method!(owner);
  };
  return { service, bridge, owner, goal, prepare, choices, notices, messages, reviews, ui, ctx, approve: (args = "") => commands.get("approve")!.handler(args, ctx), switchSession: (id: string) => { sid = id; service.activateSession(id); }, busy: () => { idle = false; } };
}

test("lesson approval: bare command reviews one current draft, confirms and resumes without learner work", async () => {
  const f = await fixture(), task = await f.prepare();
  await f.approve();
  const latest = f.service.store.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1)!;
  expect(latest.body.status).toBe("practice_ready");
  expect(latest.body.review).toMatchObject({ method: "human", reviewer_role: "learner" });
  expect(f.notices.join("\n") + f.reviews.join("\n")).toContain("work function");
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toContain("not learner work");
  expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "task_delivered", "assessment"].includes(e.kind))).toHaveLength(0);
  expect(f.service.store.lessonGoal(f.owner)?.revision_id).toBe(f.goal.revision_id);
});

test("lesson approval: multiple drafts use named selection, never an implicit latest choice", async () => {
  const f = await fixture(), first = await f.prepare("Photoelectric effect"), second = await f.prepare("State vectors");
  let offered: string[] = [];
  f.ui.select = async (_title, options) => { offered = options; return options[1]; };
  await f.approve();
  expect(offered).toHaveLength(2); expect(offered.join(" ")).toContain("State vectors");
  expect(f.service.store.revisions("task_definition").filter(r => r.entity_id === first.entity_id).at(-1)?.body.status).toBe("candidate");
  expect(f.service.store.revisions("task_definition").filter(r => r.entity_id === second.entity_id).at(-1)?.body.status).toBe("practice_ready");
});

test("lesson approval: cancellation and no drafts do not accept or resume", async () => {
  const empty = await fixture(), before = empty.service.store.throughSeq;
  await empty.approve(); expect(empty.service.store.throughSeq).toBe(before); expect(empty.messages).toEqual([]);
  const f = await fixture(), task = await f.prepare(), seq = f.service.store.throughSeq;
  f.ui.confirm = async () => false;
  await f.approve(); expect(f.service.store.throughSeq).toBe(seq); expect(f.messages).toEqual([]);
  expect(f.service.store.revision<TaskDefinition>(task.revision_id).body.status).toBe("candidate");
  await f.prepare("Another unit"); const chooserSeq = f.service.store.throughSeq;
  f.ui.select = async () => undefined;
  await f.approve(); expect(f.service.store.throughSeq).toBe(chooserSeq); expect(f.messages).toEqual([]);
});

test("lesson approval: trusted choices exclude superseded, protected, high-stakes and foreign drafts", async () => {
  const f = await fixture(), original = await f.prepare();
  const revised = f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", entity_id: original.entity_id, parent_revision_id: original.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...original.body, title: "Revised unit" } }, "pi", f.owner);
  for (const body of [{ ...original.body, partition: "protected" }, { ...original.body, stakes: "high" }]) f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: f.goal.revision_id, body }, "human", f.owner);
  f.service.activateSession("other");
  const foreignGoal = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "other");
  f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: foreignGoal.revision_id, body: { ...original.body, title: "Foreign unit" } }, "human", "other");
  f.service.activateSession(f.owner);
  expect(await f.choices()).toEqual([{ revision_id: revised.revision_id, title: "Revised unit" }]);
  await f.bridge.goal({ ...f.goal.body, objective: "A different focus" }, f.owner);
  expect(await f.choices()).toEqual([]);
});

test("lesson approval: changing the draft set while selecting rejects a stale choice", async () => {
  const f = await fixture(); await f.prepare(); await f.prepare("Second unit");
  f.ui.select = async (_title, options) => { await f.prepare("Late unit"); return options[0]; };
  await expect(f.approve()).rejects.toThrow("scope changed");
  expect(f.messages).toEqual([]);
  expect(f.service.store.revisions("task_definition").some(r => r.body.status === "practice_ready")).toBe(false);
});

test("lesson approval: goal, session, state, work and idle changes during confirmation cannot approve", async () => {
  for (const change of ["goal", "session", "state", "work", "busy"] as const) {
    const f = await fixture(), task = await f.prepare();
    f.ui.confirm = async () => {
      if (change === "goal") await f.bridge.goal({ ...f.goal.body, objective: "Changed focus" }, f.owner);
      if (change === "session") f.switchSession("another");
      if (change === "state") await f.prepare("New draft");
      if (change === "work") f.service.store.learnerResponse("New learner work arrived", f.owner);
      if (change === "busy") f.busy();
      return true;
    };
    await expect(f.approve()).rejects.toThrow();
    expect(f.service.store.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1)?.body.status).toBe("candidate");
    expect(f.messages).toEqual([]);
  }
});

test("lesson approval: pending work blocks inferred approval of a new draft", async () => {
  const f = await fixture(), task = await f.prepare();
  const approved = f.service.approveTask(task.revision_id, "Synthetic learner review", f.owner);
  f.service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: approved.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: [] } }, "pi", f.owner);
  const before = f.service.store.throughSeq;
  await expect(f.approve()).rejects.toThrow("saved work");
  expect(f.service.store.throughSeq).toBe(before); expect(f.messages).toEqual([]);
});

test("lesson approval: stopped lessons and noninteractive contexts never implicitly accept", async () => {
  const f = await fixture(); await f.prepare(); await f.bridge.stop(f.owner);
  await expect(f.approve()).rejects.toThrow("saved work"); expect(f.messages).toEqual([]);
  const g = await fixture(); await g.prepare(); Object.assign(g.ctx, { hasUI: false });
  const before = g.service.store.throughSeq;
  await g.approve(); expect(g.service.store.throughSeq).toBe(before); expect(g.messages).toEqual([]);
});

test("lesson approval: an exposed key remains supported evidence even if review is cancelled", async () => {
  const f = await fixture(), base = await f.prepare();
  const keyed = f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", entity_id: base.entity_id, parent_revision_id: base.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...base.body, answer: "Photon threshold condition" } }, "pi", f.owner);
  f.ui.confirm = async () => false;
  await f.approve();
  expect(f.service.store.events().filter(e => e.payload.action === "task_solution_reviewed")).toHaveLength(1);
  expect(f.service.store.revisions("task_definition").filter(r => r.entity_id === keyed.entity_id).at(-1)?.body.status).toBe("candidate");
  expect(f.messages).toEqual([]);
});

test("lesson approval: explicit-ID review and confirmation remain available", async () => {
  const f = await fixture(), task = await f.prepare();
  await f.approve(task.revision_id); expect(f.reviews).toEqual([]);
  await f.approve(`${task.revision_id} confirm`);
  expect(f.service.store.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1)?.body.status).toBe("practice_ready");
});

test("lesson approval: teaching guidance retains direction choices and makes scope deferrals explicit", async () => {
  const skill = await readFile(join(import.meta.dir, "../../../resources/skills/learning/SKILL.md"), "utf8");
  expect(skill).toContain("/approve without an ID");
  expect(skill).toContain("Do not silently omit");
  expect(skill).toContain("across sessions");
  expect(skill).toContain("Ask which direction");
});
