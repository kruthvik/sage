import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, Goal, Revision } from "../../core/src/contracts.ts";
import type { SubmittedImage } from "../../core/src/interactions.ts";
import { LearningStore, hash } from "../../storage/src/store.ts";
import { captureInput, validateImages } from "../src/submissions.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { LearningService, startLearningServer, requestLearning } from "../src/service.ts";
import { backup, restore } from "../src/backup.ts";
import { learningFixture } from "./learning-fixture.ts";

const roots: string[] = []; const stores: LearningStore[] = []; const services: LearningService[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// A real 1x1 PNG; signatures are envelope validation, not visual interpretation.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=", "base64");
const image: SubmittedImage = { type: "image", mimeType: "image/png", data: png.toString("base64") };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-submission-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const f = learningFixture(); stores.push(f.store);
  const task = f.task("Show the work used to choose integration by parts.");
  const instance = f.deliver(task);
  return { ...f, root, paths, definition: task, instance };
}

test("image envelopes reject malformed base64, MIME mismatch, empty, count and byte limits", () => {
  expect(validateImages([image])[0]).toMatchObject({ mime: "image/png", size: png.length, hash: hash(png) });
  expect(validateImages([])).toEqual([]);
  expect(() => validateImages([{ ...image, data: "data:image/png;base64,abc" }])).toThrow("encoding");
  expect(() => validateImages([{ ...image, data: "" }])).toThrow("limited");
  expect(() => validateImages([{ ...image, mimeType: "image/jpeg" }])).toThrow("matching file signature");
  expect(() => validateImages([{ ...image, mimeType: "image/svg+xml" }])).toThrow("matching file signature");
  expect(() => validateImages(Array(5).fill(image))).toThrow("four");
  expect(() => validateImages([{ ...image, data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }])).toThrow("limited");
  const large = Buffer.alloc(3 * 1024 * 1024); png.copy(large);
  expect(() => validateImages(Array(3).fill({ ...image, data: large.toString("base64") }))).toThrow("8 MiB");
});

test("image-only native input saves local blobs and linked learner artifacts, not assessments or prompts", async () => {
  const f = await fixture();
  const result = await captureInput(f.store, f.paths, "", "test", [image], f.instance.revision_id, randomUUID());
  const response = f.store.event(result.response_event_id, "learner_response");
  expect(response.actor).toBe("learner");
  expect(response.payload.text).toContain("handwriting interpretation requires confirmation");
  expect(response.payload.images).toEqual([{ hash: hash(png), mime: "image/png", size: png.length }]);
  expect(response.payload.instance_revision_id).toBe(f.instance.revision_id);
  expect(JSON.stringify(response)).not.toContain(image.data);
  const artifact = f.store.revision<Artifact>(result.artifact_revision_ids[0]!, "artifact");
  expect(artifact.body).toMatchObject({ author: "learner", capability: "scrap_work_image", goal_revision_id: f.goal.revision_id, instance_revision_id: f.instance.revision_id, media_type: "image/png", blob_hash: hash(png), evidence_kind: "artifact_only", response_event_id: response.event_id });
  expect(artifact.body.interpretation_uncertainty).toContain("confirm handwriting");
  expect(await readFile(join(f.paths.data, "blobs", hash(png)))).toEqual(png);
  expect(f.store.db.query("SELECT role,mime,size FROM blob_manifest WHERE hash=?").get(hash(png))).toEqual({ role: "learner_work", mime: "image/png", size: png.length });
  expect(f.store.events().filter(e => e.kind === "assessment" || e.kind === "attempt_submitted")).toEqual([]);
  expect(f.state().independent_performance.success).toBe(0);
});

test("input retries preserve IDs, reject changed content/session and require text or images before writes", async () => {
  const f = await fixture();
  const operation = randomUUID();
  const result = await captureInput(f.store, f.paths, "My working", "test", [image], f.instance.revision_id, operation);
  const seq = f.store.throughSeq;
  expect(await captureInput(f.store, f.paths, "My working", "test", [image], f.instance.revision_id, operation)).toEqual(result);
  expect(f.store.throughSeq).toBe(seq);
  await expect(captureInput(f.store, f.paths, "Different working", "test", [image], f.instance.revision_id, operation)).rejects.toThrow();
  await expect(captureInput(f.store, f.paths, "My working", "other-session", [image], f.instance.revision_id, operation)).rejects.toThrow();
  await expect(captureInput(f.store, f.paths, "   ", "test", [], f.instance.revision_id)).rejects.toThrow("text or an image");
  await expect(captureInput(f.store, f.paths, "x".repeat(24001), "test")).rejects.toThrow("24000");
  await expect(captureInput(f.store, f.paths, "Bad image", "test", [{ ...image, data: "%%%" }])).rejects.toThrow("encoding");
  expect(f.store.throughSeq).toBe(seq);
  expect(f.store.revisions("artifact")).toHaveLength(1);
  expect(f.store.db.query("SELECT count(*) AS count FROM blob_manifest").get()).toEqual({ count: 1 });
});

test("image submissions are goal/source scoped and cannot be forged through model IPC", async () => {
  const f = await fixture();
  const source = randomUUID();
  const registered = f.store.append("source_status", { source_revision_id: source, status: "received" }, randomUUID(), "learner", "test");
  f.store.insertRevision(source, randomUUID(), "source", null, { title: "Private source" }, registered.seq, randomUUID(), {});
  f.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${source}:0`, source, 0, "line 1", "Private problem text", "utf8-lines-v1", 1);
  f.store.append("source_accepted", { source_revision_id: source, status: "indexed" }, randomUUID(), "learner", "test");
  const task = f.task("Source-bound work", { source_span_ids: [`${source}:0`] });
  const sourced = f.deliver(task);
  await expect(captureInput(f.store, f.paths, "Source work", "test", [image], sourced.revision_id)).rejects.toThrow("source-sharing");
  const newer = f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Refined scope within this lesson" } }, "learner", "test");
  await expect(captureInput(f.store, f.paths, "", "test", [image], f.instance.revision_id)).rejects.toThrow("another goal");
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: newer.revision_id, expected_goal_revision_id: newer.revision_id, body: { ...newer.body, provider_sharing: false } }, "learner", "test");
  await expect(captureInput(f.store, f.paths, "private work", "test", [image])).rejects.toThrow("sharing-authorized");
  expect(f.store.revisions("artifact")).toEqual([]);
  const service = new LearningService(f.paths); services.push(service);
  const server = startLearningServer(service);
  try {
    await expect(requestLearning(server, "learner_response", { text: "Forged", images: [image] }, "test")).rejects.toThrow();
    await expect(requestLearning(server, "capture_input", { text: "Forged", images: [image] }, "test")).rejects.toThrow();
    await expect(requestLearning(server, "learning_record", { operation_id: "forged", kind: "learner_response", payload: { text: "Forged" } }, "test")).rejects.toThrow("Invalid operation");
    expect(service.store.events().filter(e => e.kind === "learner_response")).toEqual([]);
  } finally { server.stop(); }
});

test("scrap-work image bytes and event/artifact linkage survive verified backup and restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-image-backup-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service);
  const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Explain a physics derivation", subject: "science", horizon_days: 30, target_format: "worked derivation", criteria: ["Explain each relation"], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "test") as unknown as Revision<Goal>;
  const receipt = await captureInput(service.store, paths, "My derivation", "test", [image], undefined, randomUUID());
  const filename = join(root, "images.backup.json"); await backup(service.store, paths, filename);
  const target = createSagePaths({ home: join(root, "restored") }); await restore(target, filename);
  const restored = new LearningService(target); services.push(restored);
  expect(restored.store.integrity()).toEqual(["ok"]);
  expect(restored.store.currentGoal()?.revision_id).toBe(goal.revision_id);
  expect(restored.store.event(receipt.response_event_id).payload).toEqual(service.store.event(receipt.response_event_id).payload);
  expect(restored.store.revision(receipt.artifact_revision_ids[0]!).body).toEqual(service.store.revision(receipt.artifact_revision_ids[0]!).body);
  expect(await readFile(join(target.data, "blobs", hash(png)))).toEqual(png);
});
