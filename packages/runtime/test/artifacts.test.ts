import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, link, symlink } from "node:fs/promises";
import { marked } from "marked";
import { contentInventory, publishArtifactContent, rebuildContent } from "../src/artifacts.ts";
import * as vault from "../src/vault.ts";
import * as submissions from "../src/submissions.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { startLearningServer } from "../src/service.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LearningService } from "../src/service.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { learningFixture } from "./learning-fixture.ts";
import { createTutorArtifact } from "../src/artifacts.ts";

const fixtures: ReturnType<typeof learningFixture>[] = [];
const services: LearningService[] = [], roots: string[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) f.store.close(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function contentFixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-content-")); roots.push(root);
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service);
  const session = randomUUID(); service.activateSession(session);
  const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Owned notes", subject: "math", horizon_days: 7, target_format: "solve", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", session);
  const request = { operation_id: randomUUID(), kind: "artifact", expected_goal_revision_id: goal.revision_id, body: { capability: "lesson_summary", goal_revision_id: goal.revision_id, author: "tutor", provenance: "Owned fixture", media_type: "text/markdown", content: '# Literal source\n~~~\n<script>steal()</script> [link](https://example.invalid)\n~~~', evidence_kind: "artifact_only", interpretation_uncertainty: "Generated, not learner performance", assistance_event_ids: [] } };
  return { root, paths, service, session, goal, request };
}

test("Task72 service artifacts automatically publish an inert attributed session/type copy", async () => {
  const f = await contentFixture();
  const created = await f.service.operation("learning_define", f.request, f.session) as { revision_id: string };
  const path = join(f.paths.home, "content", f.session, "lesson_summary", `${created.revision_id}.md`);
  expect(await Bun.file(path).exists()).toBe(true);
  const text = await readFile(path, "utf8");
  expect(text).toContain(created.revision_id); expect(text).toContain(f.session);
  expect(text).toContain("not learner performance evidence");
  expect(text).toContain("~~~~");
  expect(f.service.store.revision(created.revision_id).body.content).toBe(f.request.body.content);
  expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toHaveLength(0);
});

test("Task72 capability artifacts use their creation session and preserve ordinary assistance receipts", async () => {
  const f = await contentFixture();
  const result = await f.service.operation("learning_source", { action: "calculate", operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, input: "2+3" }, f.session) as { artifact_revision_id: string };
  expect(await Bun.file(join(f.paths.home, "content", f.session, "calculator", `${result.artifact_revision_id}.md`)).exists()).toBe(true);
  expect(f.service.store.revision(result.artifact_revision_id).body.author).toBe("tutor");
  expect(f.service.store.events().filter(e => e.payload.action === "capability_artifact")).toHaveLength(1);
  expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
});

test("Task72 explicit learner import publishes a copy without replacing its captured source", async () => {
  const f = await contentFixture(), filename = join(f.root, "input.txt");
  await writeFile(filename, "print('hello')");
  const created = await f.service.importArtifact("code", filename, undefined, f.session);
  expect(await Bun.file(join(f.paths.home, "content", f.session, "code", `${created.revision_id}.md`)).exists()).toBe(true);
  expect(await readFile(filename, "utf8")).toBe("print('hello')");
  expect(f.service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(1);
  expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
});

test("Task72 blocked automatic projection preserves the accepted artifact and user-owned conflict", async () => {
  const f = await contentFixture(); await writeFile(join(f.paths.home, "content"), "User-owned conflict");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const created = await f.service.operation("learning_define", f.request, f.session) as { revision_id: string };
    expect(f.service.store.revision(created.revision_id).body.content).toBe(f.request.body.content);
    expect(await readFile(join(f.paths.home, "content"), "utf8")).toBe("User-owned conflict");
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});

test("Task72 actual native image capture publishes only an attributed reference, retaining original blob", async () => {
  const f = await contentFixture(), server = startLearningServer(f.service);
  try {
    const bridge = createTutorBridge(f.paths, f.service, server);
    const result = await bridge.input("Learner diagram", f.session, [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=" }]) as { response_event_id: string; artifact_revision_ids: string[] };
    const id = result.artifact_revision_ids[0]!;
    expect(await Bun.file(join(f.paths.home, "content", f.session, "scrap_work_image", `${id}.md`)).exists()).toBe(true);
    const artifact = f.service.store.revision(id);
    expect(await Bun.file(join(f.paths.data, "blobs", artifact.body.blob_hash as string)).exists()).toBe(true);
    expect(artifact.body.response_event_id).toBe(result.response_event_id);
    expect(f.service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(1);
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
  } finally { server.stop(); }
});

test("Task72 the post-capture handoff cannot adopt a replacement goal or session epoch", async () => {
  for (const change of ["goal", "session"] as const) {
    const f = await contentFixture(), server = startLearningServer(f.service), original = submissions.captureInput;
    const capture = spyOn(submissions, "captureInput").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (change === "session") { f.service.activateSession("foreign"); f.service.activateSession(f.session); }
      else f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Replacement goal" } }, "learner", f.session);
      return result;
    });
    try {
      await expect(createTutorBridge(f.paths, f.service, server).input("Original learner text", f.session)).rejects.toThrow("Input is saved in its original lesson");
      expect(f.service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(1);
      expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
    } finally { capture.mockRestore(); server.stop(); }
  }
});

test("Task72 publication await cannot forward saved image work after stop, goal or session changes", async () => {
  for (const change of ["stop", "goal", "session"] as const) {
    const f = await contentFixture(), server = startLearningServer(f.service);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const original = vault.writeContentArtifact;
    const publishing = spyOn(vault, "writeContentArtifact").mockImplementation(async (...args) => { enter(); await waiting; return original(...args); });
    try {
      const bridge = createTutorBridge(f.paths, f.service, server);
      const input = bridge.input("Saved diagram", f.session, [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=" }]);
      // Bun promise matchers wait synchronously; observe rejection before releasing the barrier.
      const outcome = input.then(() => undefined, (error: unknown) => error);
      await entered;
      if (change === "stop") f.service.store.append("checkpoint", { stopped: true, reason: "Learner stop" }, randomUUID(), "host", f.session);
      else if (change === "session") { f.service.activateSession("foreign"); f.service.activateSession(f.session); }
      else f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Another target" } }, "learner", f.session);
      release();
      expect(await outcome).toMatchObject({ message: expect.stringContaining("Input is saved in its original lesson") });
      expect(f.service.store.events().filter(e => e.kind === "learner_response")).toHaveLength(1);
      expect(f.service.store.revisions("artifact")).toHaveLength(1);
      expect(f.service.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toHaveLength(0);
    } finally { release(); publishing.mockRestore(); server.stop(); }
  }
});

test("Task72 unsafe identifiers are contained and malicious Markdown stays literal", async () => {
  const f = await contentFixture();
  const created = createTutorArtifact(f.service.store, { capability: "code", content: '<script>alert(1)</script>\n~~~~\n[secret](file:///private)\n~~~~', provenance: "Owned metadata ~~~~~" }, "../CON");
  const result = await publishArtifactContent(f.paths, f.service.store, created.revision_id);
  expect(result.relativePath).toMatch(/^session-[a-f0-9]{64}\/code\/[a-f0-9-]+\.md$/);
  const html = await marked.parse(await readFile(result.fullPath, "utf8"));
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<a ");
  expect(f.service.store.revision(created.revision_id).body.content).toBe(created.body.content);
});

test("Task72 hypothetical, imported and unknown ownership are excluded without file or state mutation", async () => {
  const f = await contentFixture();
  const unknown = f.service.store.define({ ...f.request, body: { ...f.request.body, author: "unknown" } }, "pi", f.session);
  const imported = f.service.store.define({ ...f.request, operation_id: randomUUID() }, "import", f.session);
  const fakeId = randomUUID();
  const hypothetical = f.service.store.append("decision", { action: "revision_defined", kind: "artifact", revision_id: fakeId, reason: "Counterfactual", evidence_event_ids: [] }, randomUUID(), "pi", f.session, undefined, undefined, "hypothetical");
  f.service.store.insertRevision(fakeId, randomUUID(), "artifact", null, f.request.body, hypothetical.seq, randomUUID(), {});
  const before = f.service.store.throughSeq, plan = contentInventory(f.paths, f.service.store);
  expect(plan.items).toEqual([]);
  expect(plan.preserved.map(item => item.artifact_revision_id).sort()).toEqual([unknown.revision_id, imported.revision_id, fakeId].sort());
  expect(await Bun.file(join(f.paths.home, "content")).exists()).toBe(false);
  await expect(rebuildContent(f.paths, f.service.store, "unreviewed")).rejects.toThrow("confirmation hash");
  expect(f.service.store.throughSeq).toBe(before);
});

test("Task72 changed plans, edited notes and shared hardlinks cannot be replaced by rebuild", async () => {
  const f = await contentFixture(), created = createTutorArtifact(f.service.store, { capability: "lesson_summary", content: "Source", provenance: "Owned" }, f.session);
  const old = contentInventory(f.paths, f.service.store);
  createTutorArtifact(f.service.store, { capability: "lesson_summary", content: "Second", provenance: "Owned" }, f.session);
  await expect(rebuildContent(f.paths, f.service.store, old.plan_hash)).rejects.toThrow("plan changed");
  const written = await publishArtifactContent(f.paths, f.service.store, created.revision_id);
  await link(written.fullPath, join(f.root, "shared.md"));
  await expect(publishArtifactContent(f.paths, f.service.store, created.revision_id)).rejects.toThrow("unlinked");
  expect(await readFile(join(f.root, "shared.md"), "utf8")).toContain("Source");
  expect(f.service.store.revision(created.revision_id).body.content).toBe("Source");
});

test("Task72 managed content rejects symlink escape without touching the external target", async () => {
  const f = await contentFixture(), outside = await mkdtemp(join(tmpdir(), "sage-content-external-")); roots.push(outside);
  await mkdir(join(f.paths.home, "content"));
  await symlink(outside, join(f.paths.home, "content", f.session), "junction");
  const created = createTutorArtifact(f.service.store, { capability: "lesson_summary", content: "Source", provenance: "Owned" }, f.session);
  await expect(publishArtifactContent(f.paths, f.service.store, created.revision_id)).rejects.toThrow("junctions/symlinks");
  expect(await Bun.file(join(outside, "lesson_summary", `${created.revision_id}.md`)).exists()).toBe(false);
});

test("tutor artifact creates valid revision with explicit non-performance evidence metadata", () => {
  const f = learningFixture();
  fixtures.push(f);

  const artifact = createTutorArtifact(f.store, {
    capability: "lesson_summary",
    content: "# Summary of Integration by Parts\nu * v - int(v * du)",
    provenance: "Generated instructional summary",
  }, "test");

  expect(artifact.kind).toBe("artifact");
  expect(artifact.body.author).toBe("tutor");
  expect(artifact.body.evidence_kind).toBe("artifact_only");
  expect(artifact.body.interpretation_uncertainty).toContain("not learner performance evidence");
  expect(artifact.body.content).toContain("u * v");
});
