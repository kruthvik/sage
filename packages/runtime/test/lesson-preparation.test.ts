import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DefineSchema, validate } from "../../core/src/contracts.ts";
import { createTutorExtension } from "../../pi/src/tutor.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createSagePaths } from "../src/paths.ts";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createTutorBridge } from "../src/tutor-host.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(mode = "learn", sharing = true) {
  const root = await mkdtemp(join(tmpdir(), "sage-lesson-preparation-"));
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths), owner = "owned-lesson"; service.activateSession(owner);
  const server = startLearningServer(service), bridge = createTutorBridge(paths, service, server);
  cleanup.push(async () => { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); });
  const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode, objective: "Explain variables and values", subject: "computing", horizon_days: 7, target_format: "free response", criteria: ["Distinguish the name from its value"], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: sharing, source_ids: [] } }, "learner", owner);
  const tools: ToolDefinition[] = [];
  createTutorExtension(bridge)({ registerTool: (t: ToolDefinition) => tools.push(t), on() {}, registerCommand() {} } as unknown as ExtensionAPI);
  const request = async () => ({ operation_id: randomUUID(), kind: "lesson_preparation", expected_goal_revision_id: goal.revision_id,
    expected_state_revision: ((await service.context({}, owner)).learning_state as { state_revision: string } | undefined)?.state_revision ?? "disclosure-denied",
    body: { component: { title: "Variable and value", behavior: "Explain their distinction" }, title: "A changed assignment", instruction: "A variable keeps its name while assignment changes its current value. For x=2 then x=5, x is still the name but the value becomes 5.", prompt: "After score=3 and then score=8, what stays the same and what changes?", criteria: [{ name: "distinction", criterion: "Distinguish the variable name from the assigned value", max_score: 2 }], construct: "Variable/value distinction", variation: "Use different assignments", allowed_aids: [], source_span_ids: [], uncertainty: "Uncalibrated model-authored instruction and question" } });
  const call = async (input: unknown) => {
    const tool = tools.find(t => t.name === "learning_define")!; validate(tool.parameters, input);
    const result = await tool.execute(randomUUID(), input as never, undefined, undefined, { sessionManager: { getSessionId: () => owner } } as ExtensionToolContext);
    return JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")) as { kind: string; component_revision_id: string; rubric_revision_id: string; family_revision_id: string; instruction_revision_id: string; definition_revision_id: string; review_required: boolean };
  };
  return { root, paths, service, server, bridge, owner, goal, tools, request, call };
}

for (const mode of ["learn", "accelerate"]) test(`lesson preparation: one registered ${mode} request saves a linked unreviewed draft, not work or delivery`, async () => {
  const f = await fixture(mode), input = await f.request(), before = f.service.store.throughSeq;
  expect(f.tools).toHaveLength(7);
  expect(() => validate(DefineSchema, input)).toThrow();
  const result = await f.call(input), store = f.service.store;
  expect(result.kind).toBe("lesson_preparation"); expect(result.review_required).toBe(true);
  const task = store.revision(result.definition_revision_id, "task_definition");
  expect(task.body).toMatchObject({ component_revision_ids: [result.component_revision_id], family_revision_id: result.family_revision_id, rubric_revision_id: result.rubric_revision_id, artifact_revision_ids: [result.instruction_revision_id], status: "candidate", scoring: "rubric", review: { method: "unreviewed" }, partition: "practice", stakes: "low" });
  expect(store.revision(result.rubric_revision_id, "rubric").body).toMatchObject({ provisional: true, dimensions: input.body.criteria });
  expect(store.revision(result.instruction_revision_id, "artifact").body).toMatchObject({ goal_revision_id: f.goal.revision_id, author: "tutor", evidence_kind: "artifact_only", content: input.body.instruction });
  expect(store.revision(result.component_revision_id, "component").body.subject).toBe("computing");
  expect(store.events().filter(e => e.seq > before && e.payload.action === "revision_defined").map(e => e.actor)).toEqual(["pi", "pi", "pi", "pi", "pi"]);
  expect(store.events().filter(e => ["task_delivered", "assessment", "learner_response", "attempt_submitted"].includes(e.kind))).toHaveLength(0);
  expect(store.events().some(e => e.payload.action === "teaching_stage")).toBe(false);
  expect(store.integrity()).toEqual(["ok"]);
});

test("lesson preparation: identical retry and reopen reuse receipts, but changed content or conversation cannot", async () => {
  const f = await fixture(), input = await f.request(), first = await f.call(input), seq = f.service.store.throughSeq;
  expect(await f.call(input)).toEqual(first); expect(f.service.store.throughSeq).toBe(seq);
  await expect(f.call({ ...input, body: { ...input.body, instruction: "Different instruction" } })).rejects.toThrow("different content");
  expect(f.service.store.throughSeq).toBe(seq);
  const reopened = new LearningService(f.paths); reopened.activateSession(f.owner);
  try { expect(await reopened.operation("learning_define", input, f.owner)).toEqual(first); expect(reopened.store.throughSeq).toBe(seq); }
  finally { reopened.close(); }
  const other = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "another-conversation");
  f.service.activateSession("another-conversation");
  await expect(f.service.operation("learning_define", { ...input, expected_goal_revision_id: other.revision_id }, "another-conversation")).rejects.toThrow("another conversation");
});

test("lesson preparation: state, goal, sharing, mode, stop and pending work retain their guards", async () => {
  const f = await fixture(), input = await f.request(), seq = f.service.store.throughSeq;
  for (const changes of [{ expected_state_revision: "stale" }, { expected_goal_revision_id: "other-goal" }, { body: { ...input.body, status: "practice_ready" } }, { body: { ...input.body, instruction: "x".repeat(4001) } }]) {
    await expect(f.call({ ...input, ...changes })).rejects.toThrow(); expect(f.service.store.throughSeq).toBe(seq);
  }
  await f.bridge.stop(f.owner);
  const stopped = f.service.store.throughSeq; await expect(f.call(await f.request())).rejects.toThrow(); expect(f.service.store.throughSeq).toBe(stopped);
  const denied = await fixture("learn", false), deniedSeq = denied.service.store.throughSeq;
  await expect(denied.call(await denied.request())).rejects.toThrow(); expect(denied.service.store.throughSeq).toBe(deniedSeq);
  for (const mode of ["exam", "cram", "drill"]) { const other = await fixture(mode), at = other.service.store.throughSeq; await expect(other.call(await other.request())).rejects.toThrow(); expect(other.service.store.throughSeq).toBe(at); }
});

test("lesson preparation: reuse only an owned same-subject component; late failure rolls back every draft object", async () => {
  const f = await fixture(), first = await f.call(await f.request());
  const next = await f.request(); const reused = await f.call({ ...next, body: { ...next.body, prompt: "After score=4 and then score=9, what changes?", component: { revision_id: first.component_revision_id } } });
  expect(reused.component_revision_id).toBe(first.component_revision_id); expect(f.service.store.revisions("component")).toHaveLength(1);
  const foreign = f.service.store.define({ operation_id: randomUUID(), kind: "component", body: { title: "Foreign", behavior: "Foreign behavior", subject: "computing", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Synthetic foreign component" } }, "human", "foreign-owner");
  const wrongSubject = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: f.goal.revision_id, body: { title: "Other subject", behavior: "Other behavior", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Wrong subject" } }, "pi", f.owner);
  for (const id of [foreign.revision_id, wrongSubject.revision_id]) { const current = await f.request(), seq = f.service.store.throughSeq; await expect(f.call({ ...current, body: { ...current.body, component: { revision_id: id } } })).rejects.toThrow(); expect(f.service.store.throughSeq).toBe(seq); }
  const input = await f.request(), before = f.service.store.throughSeq, revisions = f.service.store.revisions().length;
  input.body.prompt = "After count=1 and then count=6, what changes?";
  await expect(f.call({ ...input, body: { ...input.body, source_span_ids: ["missing-span"] } })).rejects.toThrow();
  expect(f.service.store.throughSeq).toBe(before); expect(f.service.store.revisions()).toHaveLength(revisions);
  f.service.store.db.exec("CREATE TEMP TRIGGER fail_preparation BEFORE INSERT ON object_revision WHEN NEW.kind='task_definition' BEGIN SELECT RAISE(ABORT, 'injected final save failure'); END;");
  await expect(f.call(input)).rejects.toThrow("injected final save failure");
  expect(f.service.store.throughSeq).toBe(before); expect(f.service.store.revisions()).toHaveLength(revisions); expect(f.service.store.integrity()).toEqual(["ok"]);
});

test("lesson preparation: globally accepted sources do not become implicit goal source consent", async () => {
  const f = await fixture(), filename = join(f.root, "synthetic-source.txt");
  await writeFile(filename, "Synthetic source about variables and values.");
  const source = await f.service.sources.importFile(filename, "reference", "owned"); f.service.sources.accept(source.revision_id);
  const span = f.service.store.db.query<{ span_id: string }, [string]>("SELECT span_id FROM source_span WHERE source_revision_id=?").get(source.revision_id)!;
  const input = await f.request(), before = f.service.store.throughSeq;
  await expect(f.call({ ...input, body: { ...input.body, source_span_ids: [span.span_id] } })).rejects.toThrow("selected goal sources");
  expect(f.service.store.throughSeq).toBe(before); expect(f.service.store.revisions("task_definition")).toHaveLength(0);
});

test("lesson preparation: native approval and one-use teaching continuation remain separate from preparation", async () => {
  const f = await fixture(), result = await f.call(await f.request());
  const request = { action: "teaching" as const, operation_id: randomUUID(), unit_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, component_revision_id: result.component_revision_id, instruction_revision_id: result.instruction_revision_id, definition_revision_id: result.definition_revision_id };
  await expect(f.bridge.teachingOffer!(request, f.owner)).rejects.toThrow();
  const approved = f.service.approveTask(result.definition_revision_id, "Synthetic learner explicitly reviewed the question", f.owner);
  const offer = await f.bridge.teachingOffer!({ ...request, definition_revision_id: approved.revision_id as string }, f.owner);
  expect(f.service.store.revisions("task_instance")).toHaveLength(0);
  expect(offer.instruction).toContain("variable");
  const released = await offer.continue(); expect(released.prompt).toContain("score=3");
  expect(f.service.store.revisions("task_instance")).toHaveLength(1);
  await expect(offer.continue()).rejects.toThrow();
  const pending = await f.request(), seq = f.service.store.throughSeq;
  await expect(f.call(pending)).rejects.toThrow(); expect(f.service.store.throughSeq).toBe(seq);
  expect(f.service.store.events().filter(e => ["assessment", "attempt_submitted", "learner_response"].includes(e.kind))).toHaveLength(0);
});
