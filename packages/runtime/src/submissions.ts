import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SubmittedImage } from "../../core/src/interactions.ts";
import type { TaskDefinition, TaskInstance } from "../../core/src/contracts.ts";
import { hash, type LearningStore } from "../../storage/src/store.ts";
import type { SagePaths } from "./paths.ts";
import { assertCurrentLearningTask } from "./learning-controller.ts";

/** Host-created native input capability; never read from model/tool data. */
export interface NativeInputAdmission {
  assertCurrent(): void;
  /** Original goal/session/control seal remains valid after this input is persisted. */
  assertScopeCurrent(): void;
  goalCreated(revisionId: string): void;
}

/** Validate envelope/signature without claiming to decode handwriting or executing image contents. */
export function validateImages(images: SubmittedImage[]) {
  if (images.length > 4) throw new Error("Paste at most four scrap-work images per message");
  let total = 0;
  return images.map(image => {
    if (typeof image.data !== "string" || image.data.length > 5592408 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new Error("Invalid or oversized image encoding");
    const bytes = Buffer.from(image.data, "base64");
    total += bytes.length;
    if (!bytes.length || bytes.length > 4 * 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error("Images are limited to 4 MiB each and 8 MiB per message");
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString() === "IHDR";
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.length >= 20 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.subarray(12, 16).toString());
    if (!(image.mimeType === "image/png" && png || image.mimeType === "image/jpeg" && jpeg || image.mimeType === "image/webp" && webp)) throw new Error("Expected a PNG, JPEG or WebP image with a matching file signature");
    return { bytes, hash: hash(bytes), mime: image.mimeType, size: bytes.length };
  });
}

/** Trusted actual-input path, not available to a model tool. Binary bytes stay outside prompts/SQLite. */
export async function captureInput(store: LearningStore, paths: SagePaths, text: string, sessionId: string, images: SubmittedImage[] = [], instanceId?: string, operationId: string = randomUUID(), authorize?: () => void) {
  const goal = store.lessonGoal(sessionId);
  if (!goal?.body.provider_sharing) throw new Error("Set a sharing-authorized goal before submitting work");
  if (text.length > 24000) throw new Error("Keep typed work below 24000 characters");
  const throughSeq = store.throughSeq;
  const existing = store.events().find(e => e.operation_id === operationId);
  if (existing && existing.session_id !== sessionId) throw new Error("Response operation ID belongs to a different conversation");
  const scope = () => {
    authorize?.();
    if (store.events().some(e => e.seq > throughSeq && e.session_id === sessionId && e.branch === "real" && e.kind === "checkpoint" && e.payload.stopped === true)) throw new Error("Learner stopped while saving work; resubmit to resume");
    if (store.lessonGoal(sessionId)?.revision_id !== goal.revision_id || !store.lessonGoal(sessionId)?.body.provider_sharing) throw new Error("Goal changed while saving work; resubmit for the new goal");
    if (instanceId) {
      const instance = store.revision<TaskInstance>(instanceId, "task_instance");
      const frozenGoal = store.revision(instance.body.goal_revision_id, "goal");
      if (frozenGoal.entity_id !== goal.entity_id || frozenGoal.body.objective !== goal.body.objective || frozenGoal.body.subject !== goal.body.subject) throw new Error("Work belongs to another goal");
      const task = store.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition").body;
      for (const span of task.source_span_ids) if (!goal.body.source_ids.includes(store.acceptedSpan(span).source_revision_id)) throw new Error("Work exceeds source-sharing permissions");
      // Actual native input can resume a stop; delayed submissions cannot revive skipped work.
      if (!store.events().some(e => e.operation_id === operationId)) assertCurrentLearningTask(store, sessionId, instanceId, true);
    }
  };
  scope();
  const validated = validateImages(images);
  const caption = text.trim() || (images.length ? "Learner submitted scrap-work images; handwriting interpretation requires confirmation." : "");
  if (!caption) throw new Error("Submit text or an image");
  for (const image of validated) {
    await mkdir(join(paths.data, "blobs"), { recursive: true });
    const filename = join(paths.data, "blobs", image.hash);
    try { await writeFile(filename, image.bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hash(await readFile(filename)) !== image.hash) throw new Error("Saved image failed integrity verification");
    }
  }
  return store.db.transaction(() => {
    scope();
    for (const image of validated) store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(image.hash, image.mime, image.size, "learner_work", store.now());
    const response = store.learnerResponse(caption, sessionId, operationId, { goal_revision_id: goal.revision_id, ...(instanceId ? { instance_revision_id: instanceId } : {}), ...(validated.length ? { image_only: !text.trim(), images: validated.map(({ hash, mime, size }) => ({ hash, mime, size })) } : {}) });
    const artifacts = validated.map((image, index) => store.define({ operation_id: `${operationId}:image:${index}`, kind: "artifact", expected_goal_revision_id: goal.revision_id, body: {
      capability: "scrap_work_image", goal_revision_id: goal.revision_id, ...(instanceId ? { instance_revision_id: instanceId } : {}), author: "learner",
      provenance: "Actual native-editor image submission; authorship self-declared and external assistance unobserved", media_type: image.mime, content: `Scrap-work image sha256:${image.hash}`, blob_hash: image.hash,
      evidence_kind: "artifact_only", interpretation_uncertainty: "Model visual interpretation is inferred; confirm handwriting in learner text before rubric scoring", response_event_id: response.event_id, assistance_event_ids: [],
    } }, "learner", sessionId));
    store.rebuild();
    return { response_event_id: response.event_id, artifact_revision_ids: artifacts.map(a => a.revision_id), ...(instanceId ? { instance_revision_id: instanceId } : {}) };
  })();
}
