import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStore } from "../../storage/src/store.ts";
import { draft } from "../../core/test/planning-fixture.ts";
import { commitPlannedGoal, commitDelegatedOutline, delegatedPlanResult } from "../src/planning.ts";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { SourceService } from "../../sources/src/service.ts";
import { currentDisclosure } from "../src/disclosure.ts";
test("topic scope: duplicate entries within one draft reuse its newly created owned component", () => {
  const { store, body } = setup(), repeated = { ...draft, components: [draft.components[0]!, draft.components[0]!] };
  const result = commitPlannedGoal(store, body, "same-draft", { draft: repeated });
  const ids = result.outline.body.component_revision_ids as string[];
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  expect(store.revisions("component")).toHaveLength(1);
});

test("topic scope: native science, math and writing goals start without unrelated demo exercises", async () => {
  const { body } = setup(), root = await mkdtemp(join(tmpdir(), "sage-topic-native-"));
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths), server = startLearningServer(service), bridge = createTutorBridge(paths, service, server);
  try {
    for (const topic of [{ subject: "science", objective: "Explain the photoelectric effect", format: "Qualitative predictions" }, { subject: "math", objective: "Understand eigenvectors", format: "Matrix reasoning" }, { subject: "writing", objective: "Write screenplay dialogue", format: "Dialogue writing" }]) {
      const owner = `topic-${topic.subject}`;
      service.activateSession(owner);
      await bridge.goal({ ...body, subject: topic.subject, objective: topic.objective, target_format: topic.format }, owner);
      expect(service.store.revisions("task_definition")).toEqual([]);
      expect(service.store.revisions("component")).toEqual([]);
      expect(service.store.revisions("rubric")).toEqual([]);
      expect((await service.context({}, owner)).goal).toMatchObject({ body: { objective: topic.objective } });
      expect((await service.context({}, owner)).learning_state).toMatchObject({ phase: "prepare" });
    }
    const math = service.store.lessonGoal("topic-math")!;
    expect(installFixtures(service.store, math)).toHaveLength(3); // Explicit demos/tests still opt in.
    expect(service.store.events().filter(event => ["task_delivered", "attempt_submitted", "assessment"].includes(event.kind))).toEqual([]);
    expect(service.store.integrity()).toEqual(["ok"]);
  } finally { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); }
});

test("topic scope: a planned physics goal saves its requested outline, not subject demo content", () => {
  const { store, body } = setup();
  const topicDraft = { ...draft, goal: { ...draft.goal, subject: "science" }, summary: "Start with photon thresholds", components: [{ title: "Photon threshold", behavior: "Explain threshold energy", uncertainty: "Not yet observed" }], outline: { next_activities: ["Explain photons before predicting emission"], known_gaps: ["Formalism remains untested"], uncertain_assumptions: ["Prior quantum knowledge is unknown"] } };
  const result = commitPlannedGoal(store, { ...body, subject: "science", objective: "Explain photoelectric emission" }, "physics", { draft: topicDraft });
  expect(store.revisions("component").map(revision => revision.body.title)).toEqual(["Photon threshold"]);
  expect(store.revisions("task_definition")).toEqual([]); expect(store.revisions("rubric")).toEqual([]);
  expect(result.outline.body.known_gaps).toEqual(["Formalism remains untested"]);
});

test("topic scope: identical planned components stay owned by their current conversation and resume without duplication", () => {
  const { store, body } = setup();
  const first = commitPlannedGoal(store, body, "lesson-a", { draft }), second = commitPlannedGoal(store, body, "lesson-b", { draft });
  const a = (first.outline.body.component_revision_ids as string[])[0]!, b = (second.outline.body.component_revision_ids as string[])[0]!;
  expect(b).not.toBe(a);
  expect(store.events().find(event => event.seq === store.revision(b).created_seq)?.session_id).toBe("lesson-b");
  const before = store.throughSeq;
  expect(commitDelegatedOutline(store, draft, "lesson-a", first.goal.revision_id).body.component_revision_ids).toEqual([a]);
  expect(store.throughSeq).toBe(before); expect(store.revisions("component")).toHaveLength(2);
});

test("topic scope: a fresh source-free plan never inherits another lesson's private-source dependency", async () => {
  const { store, body } = setup(), root = await mkdtemp(join(tmpdir(), "sage-topic-source-"));
  try {
    const sources = new SourceService(store, join(root, "blobs")), path = join(root, "synthetic-private.txt");
    await writeFile(path, "ONLY-OLD-LESSON");
    const source = await sources.importFile(path, "reference", "owned"); sources.accept(source.revision_id);
    const first = commitPlannedGoal(store, { ...body, source_ids: [source.revision_id] }, "source-lesson", { draft });
    const oldComponent = store.revision((first.outline.body.component_revision_ids as string[])[0]!);
    expect(currentDisclosure(store, "source-lesson")).toMatchObject({ allowed: true });
    const fresh = commitPlannedGoal(store, body, "fresh-lesson", { draft });
    expect(currentDisclosure(store, "fresh-lesson")).toMatchObject({ allowed: true });
    expect(fresh.outline.body.component_revision_ids).not.toContain(oldComponent.revision_id);
    expect(store.revision(oldComponent.revision_id)).toEqual(oldComponent);
    expect(sources.list()[0]).toMatchObject({ source_id: source.revision_id, status: "indexed" });
    expect(store.integrity()).toEqual(["ok"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new LearningStore(":memory:"); stores.push(store);
  const body = { ...draft.goal, mode: "learn" as const, objective: "Learn Python", probe: draft.probe, provider_sharing: true, source_ids: [] };
  return { store, body };
}

test("delegated intake atomically saves the existing goal, component and outline contracts", () => {
  const { store, body } = setup();
  const { goal, outline } = commitPlannedGoal(store, body, "conversation", { draft });
  expect(goal.body.objective).toBe("Learn Python");
  expect(outline.body.goal_revision_id).toBe(goal.revision_id);
  expect((outline.body.component_revision_ids as string[]).map(id => store.revision(id).body.behavior)).toEqual([draft.components[0]!.behavior]);
  expect(store.integrity()).toEqual(["ok"]);
  const seq = store.throughSeq;
  expect(() => commitPlannedGoal(store, body, "conversation", { draft })).toThrow("changed");
  expect(store.throughSeq).toBe(seq);
  const invalid = { ...draft, outline: { ...draft.outline, next_activities: [] } };
  expect(() => commitPlannedGoal(store, body, "conversation", { draft: invalid, expected_goal_revision_id: goal.revision_id })).toThrow();
  expect(store.currentGoal()!.revision_id).toBe(goal.revision_id);
});

test("replans reject stale goals and retry stable operation IDs without new evidence or revisions", () => {
  const { store, body } = setup();
  const { goal, outline } = commitPlannedGoal(store, body, "conversation", { draft });
  const request = { operation_id: "replan-1", kind: "plan", expected_goal_revision_id: goal.revision_id, body: { goal_revision_id: goal.revision_id, component_revision_ids: [], ...draft.outline } };
  expect(delegatedPlanResult(store, request)).toBeUndefined();
  const first = commitDelegatedOutline(store, draft, "conversation", goal.revision_id, request);
  expect(first.revision_id).toBe(outline.revision_id);
  const seq = store.throughSeq;
  expect(delegatedPlanResult(store, request)?.revision_id).toBe(first.revision_id);
  expect(commitDelegatedOutline(store, draft, "conversation", goal.revision_id, request).revision_id).toBe(first.revision_id);
  expect(store.throughSeq).toBe(seq);
  expect(() => delegatedPlanResult(store, { ...request, body: { ...request.body, next_activities: ["Different request"] } })).toThrow("reused");
  const changed = { ...draft, outline: { ...draft.outline, next_activities: ["Try one conditional"] } };
  const second = commitDelegatedOutline(store, changed, "conversation", goal.revision_id);
  expect(second.parent_revision_id).toBe(first.revision_id);
  expect(() => commitDelegatedOutline(store, draft, "conversation", "old-goal")).toThrow("changed");
  expect(store.revisions("component")).toHaveLength(1);
  expect(second.body.component_revision_ids).toEqual(first.body.component_revision_ids);
  expect(store.events().filter(e => e.kind === "assessment" || e.kind === "attempt_submitted")).toEqual([]);
});

test("an outline persistence failure rolls back goal and components together", () => {
  const { store, body } = setup();
  const define = store.define.bind(store);
  store.define = (input, actor, sessionId) => {
    if ((input as { kind: string }).kind === "plan") throw new Error("Simulated outline save failure");
    return define(input, actor, sessionId);
  };
  expect(() => commitPlannedGoal(store, body, "conversation", { draft })).toThrow("save failure");
  expect(store.currentGoal()).toBeUndefined();
  expect(store.revisions()).toEqual([]);
  expect(store.events()).toEqual([]);
  expect(store.integrity()).toEqual(["ok"]);
});
