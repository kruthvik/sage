import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DefineSchema, validate, type Artifact, type Revision, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import type { SagePaths } from "./paths.ts";
import { writeContentArtifact } from "./vault.ts";

export interface CreateArtifactOptions {
  capability: "lesson_summary" | "question_set" | "feedback_note" | "visual_diagram" | "drawing" | "code";
  content: string;
  media_type?: string;
  goal_revision_id?: string;
  instance_revision_id?: string;
  provenance: string;
}

export function createTutorArtifact(
  store: LearningStore,
  options: CreateArtifactOptions,
  sessionId: string,
): Revision<Artifact> {
  const goal = store.lessonGoal(sessionId);
  const goalId = options.goal_revision_id ?? goal?.revision_id;

  const revision = store.define({
    operation_id: randomUUID(),
    kind: "artifact",
    expected_goal_revision_id: goalId,
    body: {
      capability: options.capability,
      goal_revision_id: goalId,
      instance_revision_id: options.instance_revision_id,
      author: "tutor",
      provenance: options.provenance,
      media_type: options.media_type ?? "text/markdown",
      content: options.content,
      evidence_kind: "artifact_only",
      interpretation_uncertainty: "Tutor-generated instructional artifact; not learner performance evidence",
      assistance_event_ids: [],
    },
  }, "pi", sessionId);
  return store.revision<Artifact>(revision.revision_id, "artifact");
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function receipts(store: LearningStore) {
  const events = store.events().filter(e => e.branch === "real");
  return { bySeq: new Map(events.map(e => [e.seq, e])), byId: new Map(events.map(e => [e.event_id, e])) };
}
function projection(store: LearningStore, artifact: Revision<Artifact>, events: ReturnType<typeof receipts>) {
  validate(DefineSchema, { operation_id: "managed-copy-validation", kind: "artifact", body: artifact.body });
  const creator = events.bySeq.get(artifact.created_seq);
  if (!creator || creator.kind !== "decision" || creator.payload.action !== "revision_defined" || creator.payload.kind !== "artifact" || creator.payload.revision_id !== artifact.revision_id || !creator.session_id || !["pi", "host", "human", "learner"].includes(creator.actor)) throw new Error("Artifact lacks verified native creation lineage; original preserved");
  const { content, ...details } = artifact.body;
  if (!["learner", "tutor"].includes(details.author)) throw new Error("Unknown/external ownership is preserved, not automatically rebuilt");
  if (details.author === "learner") {
    const response = details.response_event_id ? events.byId.get(details.response_event_id) : undefined;
    if (!response || response.kind !== "learner_response" || response.session_id !== creator.session_id || (details.goal_revision_id && response.payload.goal_revision_id !== details.goal_revision_id)) throw new Error("Learner artifact has no attributable real response in its creation session");
  }
  const sourceSpanIds = details.instance_revision_id ? store.revision<TaskDefinition>(store.revision<TaskInstance>(details.instance_revision_id, "task_instance").body.definition_revision_id, "task_definition").body.source_span_ids : [];
  const sessionFolder = uuid.test(creator.session_id) ? creator.session_id.toLowerCase() : `session-${hash(creator.session_id)}`;
  const typeFolder = /^[a-z][a-z0-9_-]{0,63}$/.test(details.capability) && !reserved.test(details.capability) ? details.capability : `type-${hash(details.capability)}`;
  const name = uuid.test(artifact.revision_id) ? artifact.revision_id.toLowerCase() : `revision-${hash(artifact.revision_id)}`;
  const relativePath = `${sessionFolder}/${typeFolder}/${name}.md`;
  const originalBodyHash = hash(canonical(artifact.body));
  const metadata = JSON.stringify({ artifact_revision_id: artifact.revision_id, session_id: creator.session_id, creation_event_id: creator.event_id, original_body_hash: originalBodyHash, source_span_ids: sourceSpanIds, ...details }, null, 2);
  const longest = ((metadata + content).match(/~+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "~".repeat(Math.max(3, longest + 1));
  const text = `# Sage artifact copy\n\nAn attributed projection, not learner performance evidence. Original revision/blobs remain authoritative.\n\n${fence}json\n${metadata}\n${fence}\n\n${fence}text\n${content}\n${fence}\n`;
  return { artifact, creator, sourceSpanIds, relativePath, originalBodyHash, text };
}

/** Read-only native receipt inventory, never a filesystem scan or ownership guess. */
export function contentInventory(paths: SagePaths, store: LearningStore) {
  const events = receipts(store), items: Array<{ artifact_revision_id: string; session_id: string; creation_event_id: string; original_body_hash: string; copy_hash: string; relativePath: string; author: string; provenance: string; goal_revision_id?: string; instance_revision_id?: string; response_event_id?: string; blob_hash?: string; source_span_ids: string[] }> = [];
  const preserved: Array<{ artifact_revision_id: string; reason: string }> = [];
  for (const revision of store.revisions("artifact")) {
    try {
      const copy = projection(store, store.revision<Artifact>(revision.revision_id, "artifact"), events), body = copy.artifact.body;
      items.push({ artifact_revision_id: revision.revision_id, session_id: copy.creator.session_id, creation_event_id: copy.creator.event_id, original_body_hash: copy.originalBodyHash, copy_hash: hash(copy.text), relativePath: copy.relativePath, author: body.author, provenance: body.provenance, goal_revision_id: body.goal_revision_id, instance_revision_id: body.instance_revision_id, response_event_id: body.response_event_id, blob_hash: body.blob_hash, source_span_ids: copy.sourceSpanIds });
    } catch (error) { preserved.push({ artifact_revision_id: revision.revision_id, reason: error instanceof Error ? error.message : "Unverified artifact preserved" }); }
  }
  items.sort((a, b) => a.artifact_revision_id.localeCompare(b.artifact_revision_id));
  preserved.sort((a, b) => a.artifact_revision_id.localeCompare(b.artifact_revision_id));
  const plan = { version: 1, root: join(paths.home, "content"), items, preserved };
  return { ...plan, plan_hash: hash(canonical(plan)), warning: "Copy-only rebuild; historical/user-edited/shared/external files are not scanned, moved or deleted. Non-text payloads are literal snapshots/references, not rendered original media. Privacy-erasure coverage is unverified." };
}

/** Shared selected-export boundary: real native lineage and inert, attributed text. */
export function artifactExportProjection(store: LearningStore, revisionId: string) {
  return projection(store, store.revision<Artifact>(revisionId, "artifact"), receipts(store));
}

export async function publishArtifactContent(paths: SagePaths, store: LearningStore, revisionId: string) {
  const copy = artifactExportProjection(store, revisionId);
  return writeContentArtifact(paths, { relativePath: copy.relativePath, content: copy.text, origin: copy.artifact.body.author === "learner" ? "learner" : "tutor", artifactRevisionId: revisionId, sourceSpanIds: copy.sourceSpanIds });
}

/** A failed projection cannot undo an already captured response or accepted revision. */
export async function publishAutomaticContent(paths: SagePaths, store: LearningStore, revisionId: string): Promise<void> {
  try { await publishArtifactContent(paths, store, revisionId); }
  catch { console.warn("Managed artifact copy blocked; original revision/response preserved. Retry explicit artifact export after reviewing the conflict.", revisionId); }
}

export async function rebuildContent(paths: SagePaths, store: LearningStore, expectedHash: string) {
  const plan = contentInventory(paths, store);
  if (expectedHash !== plan.plan_hash) throw new Error("Rebuild plan changed or confirmation hash is invalid; run artifact rebuild again before publishing");
  const copies: Array<Awaited<ReturnType<typeof publishArtifactContent>>> = [];
  for (const item of plan.items) copies.push(await publishArtifactContent(paths, store, item.artifact_revision_id));
  return { ...plan, receipts: copies, originals_preserved: true, recovery: "Retry the same unchanged plan; exact immutable copies are reused. No destructive rollback or erasure is implied." };
}
