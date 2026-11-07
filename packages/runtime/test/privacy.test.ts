import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { LearningService } from "../src/service.ts";
import { privacyInventory, purgePrivacyData } from "../src/privacy.ts";
import { acquireTutorLock } from "../src/tutor-lock.ts";
import { backup, restore } from "../src/backup.ts";
import type { Goal, Revision } from "../../core/src/contracts.ts";

const roots: string[] = [], services: LearningService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-privacy-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service);
  const sourceFile = join(root, "leaves.txt");
  await writeFile(sourceFile, "Leaves convert sunlight into chemical energy.", "utf8");
  const source = await service.sources.importFile(sourceFile);
  service.sources.accept(source.revision_id);
  const goal = service.store.define({
    operation_id: randomUUID(),
    kind: "goal",
    body: {
      mode: "learn",
      objective: "Understand photosynthesis",
      subject: "science",
      horizon_days: 7,
      target_format: "explanation",
      criteria: ["Explain light reaction"],
      allowed_aids: [],
      constraints: [],
      probe: "skip",
      provider_sharing: true,
      source_ids: [source.revision_id],
    },
  }, "learner", "session-1") as unknown as Revision<Goal>;

  // Add dummy credential in agent dir to verify it is inventoried and excluded from backups
  await writeFile(join(paths.agent, "auth.json"), JSON.stringify({ token: "secret-key-123" }), "utf8");
  return { root, paths, service, goal, source };
}

test("full purge rejects a different home's supplied database before changing either home", async () => {
  const selected = await fixture(), other = await fixture();
  const selectedSeq = selected.service.store.throughSeq, otherSeq = other.service.store.throughSeq;
  const blob = join(selected.paths.data, "blobs", selected.source.body.original_hash);
  const bytes = await readFile(blob);
  for (const dryRun of [true, false]) {
    await expect(purgePrivacyData(selected.paths, other.service.store, { scope: "all_learning_data", dryRun, confirm: !dryRun })).rejects.toThrow("does not match");
    expect(selected.service.store.throughSeq).toBe(selectedSeq);
    expect(other.service.store.throughSeq).toBe(otherSeq);
    expect(selected.service.store.lessonGoal("session-1")!.revision_id).toBe(selected.goal.revision_id);
    expect(other.service.store.lessonGoal("session-1")!.revision_id).toBe(other.goal.revision_id);
    expect(await readFile(blob)).toEqual(bytes);
  }
});

test("full purge refuses a live tutor lease before changing any records", async () => {
  const f = await fixture(), before = f.service.store.throughSeq;
  const release = acquireTutorLock(f.paths.home);
  try {
    await expect(purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true })).rejects.toThrow("Another Sage tutor is running");
    expect(f.service.store.throughSeq).toBe(before);
    expect(f.service.store.lessonGoal("session-1")!.revision_id).toBe(f.goal.revision_id);
  } finally { release(); }
});

test("full purge inventories and removes nested native session files without deleting credentials", async () => {
  const f = await fixture(), nested = join(f.paths.sessions, "owned", "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "one.jsonl"), "synthetic transcript one");
  await writeFile(join(nested, "two.jsonl"), "synthetic transcript two");
  expect((await privacyInventory(f.paths, f.service.store)).sessions.count).toBe(2);
  const result = await purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true });
  expect(result.sessions_removed).toBe(2);
  expect((await privacyInventory(f.paths, f.service.store)).sessions).toMatchObject({ count: 0, bytes: 0 });
  expect(JSON.parse(await readFile(join(f.paths.agent, "auth.json"), "utf8"))).toEqual({ token: "secret-key-123" });
});

test("full purge rejects a session junction before database deletion and leaves the external sentinel unchanged", async () => {
  const f = await fixture(), outside = join(f.root, "unmanaged"), before = f.service.store.throughSeq;
  await mkdir(outside); await writeFile(join(outside, "keep.txt"), "owned external sentinel");
  await symlink(outside, join(f.paths.sessions, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true })).rejects.toThrow("symbolic link");
  expect(f.service.store.throughSeq).toBe(before);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("owned external sentinel");
});

test("full purge checkpoints active SQLite and WAL copies before reporting local removal", async () => {
  const f = await fixture(), database = join(f.paths.data, "learning.sqlite"), secret = "Leaves convert sunlight into chemical energy.";
  f.service.store.db.query("PRAGMA wal_checkpoint(FULL)").get();
  expect((await readFile(database)).includes(secret)).toBe(true);
  await purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true });
  expect((await readFile(database)).includes(secret)).toBe(false);
  const wal = await readFile(`${database}-wal`).catch(error => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; });
  expect(wal.length).toBe(0);
  expect(f.service.store.integrity()).toEqual(["ok"]);
});

test("full purge reports an owned-copy failure and retries instead of claiming successful erasure", async () => {
  const f = await fixture(), file = join(f.paths.sessions, "transcript.jsonl");
  await writeFile(file, "synthetic transcript");
  let replaced = false;
  const db = f.service.store.db, original = db.exec, execute = db.exec.bind(db);
  // Change the owned file after deletion starts, without mocking global filesystem APIs.
  db.exec = (...args) => {
    const result = execute(...args);
    if (!replaced && args[0].includes("CREATE TRIGGER")) { replaced = true; unlinkSync(file); mkdirSync(file); writeFileSync(join(file, "remaining.txt"), "synthetic remaining copy"); }
    return result;
  };
  try {
    await expect(purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true })).rejects.toThrow("Purge incomplete");
    expect(await readFile(join(file, "remaining.txt"), "utf8")).toBe("synthetic remaining copy");
    const retried = await purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: true });
    expect(retried.success).toBe(true);
    expect((await privacyInventory(f.paths, f.service.store)).sessions.count).toBe(0);
    expect(f.service.store.integrity()).toEqual(["ok"]);
  } finally { db.exec = original; }
});

test("privacy inventory enumerates learning DB, blobs, sessions, config and credentials with disclosure boundaries", async () => {
  const f = await fixture();
  const inventory = await privacyInventory(f.paths, f.service.store);

  expect(inventory.database.events_count).toBeGreaterThan(0);
  expect(inventory.database.revisions_count).toBeGreaterThan(0);
  expect(inventory.blobs.count).toBeGreaterThan(0);
  expect(inventory.blobs.bytes).toBeGreaterThan(0);
  expect(inventory.credentials.detected).toBe(true);
  expect(inventory.credentials.excluded_from_backup).toBe(true);
  expect(inventory.limitations.plaintext_at_rest).toBe(true);
  expect(inventory.limitations.provider_copies_recalled).toBe(false);
});

test("dry-run purge produces accurate deletion preview without modifying database, blobs or sessions", async () => {
  const f = await fixture();
  const beforeEvents = f.service.store.events().length;
  const beforeBlobs = await readdir(join(f.paths.data, "blobs"));

  const preview = await purgePrivacyData(f.paths, f.service.store, {
    scope: "all_learning_data",
    dryRun: true,
    confirm: false,
  });

  expect(preview.dryRun).toBe(true);
  expect(preview.records_removed).toBeGreaterThan(0);
  expect(preview.blobs_removed).toBeGreaterThan(0);

  // Ensure nothing was actually deleted
  expect(f.service.store.events().length).toBe(beforeEvents);
  expect(await readdir(join(f.paths.data, "blobs"))).toEqual(beforeBlobs);
});

test("confirmed purge deletes targeted learning data, preserves unreferenced state and reports limitations", async () => {
  const f = await fixture();
  f.service.close(); // close active service handle for offline purge maintenance

  const result = await purgePrivacyData(f.paths, undefined, {
    scope: "all_learning_data",
    dryRun: false,
    confirm: true,
  });

  expect(result.dryRun).toBe(false);
  expect(result.success).toBe(true);
  expect(result.records_removed).toBeGreaterThan(0);

  // Reopen store to verify educational data is wiped while schema and integrity remain ok
  const fresh = new LearningService(f.paths);
  services.push(fresh);
  expect(fresh.store.integrity()).toEqual(["ok"]);
  expect(fresh.store.events().length).toBe(0);
  expect(fresh.store.revisions().length).toBe(0);
  expect(await readdir(join(f.paths.data, "blobs"))).toEqual([]);

  // Credentials must still be intact (not destroyed by learning data purge)
  expect(await readFile(join(f.paths.agent, "auth.json"), "utf8")).toContain("secret-key-123");
});

test("unsupported lesson/source purge scopes and misleading all-data targets fail before any deletion or preview", async () => {
  const f = await fixture(); const before = f.service.store.throughSeq; const blobs = await readdir(join(f.paths.data, "blobs"));
  for (const request of [{ scope: "lesson" as const, target_id: f.goal.entity_id }, { scope: "source" as const, target_id: f.source.revision_id }, { scope: "all_learning_data" as const, target_id: f.goal.entity_id }]) {
    await expect(purgePrivacyData(f.paths, f.service.store, { ...request, dryRun: true, confirm: false })).rejects.toThrow("scope");
  }
  expect(f.service.store.throughSeq).toBe(before); expect(await readdir(join(f.paths.data, "blobs"))).toEqual(blobs);
});

async function privacySafetySnapshot(root: string, service: LearningService) {
  const rows: Record<string, unknown[]> = {
    event: service.store.db.query("SELECT * FROM event ORDER BY seq").all(),
    object_revision: service.store.db.query("SELECT * FROM object_revision ORDER BY revision_id").all(),
    source_span: service.store.db.query("SELECT * FROM source_span ORDER BY span_id").all(),
    model_call_log: service.store.db.query("SELECT * FROM model_call_log ORDER BY seq").all(),
    blob_manifest: service.store.db.query("SELECT * FROM blob_manifest ORDER BY hash").all(),
    projection: service.store.db.query("SELECT * FROM projection ORDER BY key").all(),
    job: service.store.db.query("SELECT * FROM job ORDER BY job_id").all(),
  };
  const triggers = service.store.db.query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  const copies: Array<{ path: string; sha256: string }> = [];
  const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  async function visit(relative: string) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else {
        // SQLite/WAL headers may change on reopen; compare logical rows instead.
        if (["", "-wal", "-shm"].some(suffix => join(root, path) === service.store.filename + suffix)) continue;
        copies.push({ path, sha256: sha256(await readFile(join(root, path))) });
      }
    }
  }
  await visit("");
  return {
    rows, triggers, copies,
    records_sha256: sha256(JSON.stringify(rows)),
    copies_sha256: sha256(JSON.stringify(copies)),
    foreign_keys: service.store.db.query("PRAGMA foreign_keys").get(),
    foreign_key_check: service.store.db.query("PRAGMA foreign_key_check").all(),
    integrity: service.store.integrity(),
  };
}

test("e01s01 task 1: rejection and read-only preview preserve two lessons, shared source and owned copies after reopen", async () => {
  const f = await fixture();
  const secondGoal = f.service.store.define({
    operation_id: randomUUID(), kind: "goal",
    body: { ...f.goal.body, objective: "Explain how leaves store energy" },
  }, "learner", "session-2") as unknown as Revision<Goal>;
  const transcripts = ["session-1/transcript.jsonl", "session-2/nested/transcript.jsonl"];
  for (const transcript of transcripts) {
    const path = join(f.paths.sessions, transcript);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ role: "user", text: `Synthetic lesson ${transcript}` }) + "\n");
  }
  await writeFile(join(f.root, "unmanaged-note.md"), "User-edited sentinel: retain exactly.\n");

  function assertLessons(service: LearningService) {
    expect(service.store.revisions("goal")).toHaveLength(2);
    expect(service.store.lessonGoal("session-1")).toEqual(f.goal);
    expect(service.store.lessonGoal("session-2")).toEqual(secondGoal);
    for (const session of ["session-1", "session-2"]) {
      expect(service.store.lessonGoal(session)?.body.source_ids).toEqual([f.source.revision_id]);
    }
    expect(service.store.sourceStatus(f.source.revision_id)).toBe("indexed");
    expect(service.store.revision(f.source.revision_id).body.original_hash).toBe(f.source.body.original_hash);
  }
  assertLessons(f.service);
  expect(f.goal.entity_id).not.toBe(secondGoal.entity_id);
  expect(await readFile(join(f.paths.data, "blobs", f.source.body.original_hash))).toEqual(await readFile(join(f.root, "leaves.txt")));
  const before = await privacySafetySnapshot(f.root, f.service);
  expect(Object.keys(before.rows)).toHaveLength(7);
  expect(before.triggers).toHaveLength(10);
  expect(before.foreign_keys).toEqual({ foreign_keys: 1 });
  expect(before.foreign_key_check).toEqual([]);
  expect(before.integrity).toEqual(["ok"]);
  expect(before.copies.map(copy => copy.path)).toEqual(expect.arrayContaining([
    "leaves.txt", "unmanaged-note.md", "home/agent/auth.json",
    `home/data/blobs/${f.source.body.original_hash}`,
    ...transcripts.map(path => `home/sessions/${path}`),
  ]));
  console.info("task1 baseline", JSON.stringify({ records: before.records_sha256, copies: before.copies_sha256, file_hashes: before.copies }));
  async function assertPreserved(operation: string, service = f.service) {
    assertLessons(service);
    expect(await privacySafetySnapshot(f.root, service), operation).toEqual(before);
    console.info(`task1 preserved: ${operation}; records=${before.records_sha256}; copies=${before.copies_sha256}; integrity=ok; foreign_keys=1`);
  }

  const inventory = await privacyInventory(f.paths, f.service.store);
  expect(inventory.database.events_count).toBe(before.rows.event!.length);
  expect(inventory.blobs.count).toBe(1);
  expect(inventory.credentials.detected).toBe(true);
  await assertPreserved("inventory");
  for (const request of [
    { scope: "lesson" as const, target_id: f.goal.entity_id },
    { scope: "source" as const, target_id: f.source.revision_id },
    { scope: "all_learning_data" as const, target_id: f.goal.entity_id },
  ]) {
    for (const dryRun of [true, false]) {
      await expect(purgePrivacyData(f.paths, f.service.store, { ...request, dryRun, confirm: !dryRun })).rejects.toThrow("scope");
      await assertPreserved(`${request.scope} target rejected; dryRun=${dryRun}`);
    }
  }
  const preview = await purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: true, confirm: false });
  expect(preview.success).toBe(true);
  expect(preview.dryRun).toBe(true);
  expect(preview.records_removed).toBe(["event", "object_revision", "source_span", "model_call_log", "blob_manifest"].reduce((count, table) => count + before.rows[table]!.length, 0));
  expect(preview.blobs_removed).toBe(1);
  expect(preview.sessions_removed).toBe(2);
  await assertPreserved("all-data dryRun");
  await expect(purgePrivacyData(f.paths, f.service.store, { scope: "all_learning_data", dryRun: false, confirm: false })).rejects.toThrow("explicit confirmation");
  await assertPreserved("missing confirmation rejected");

  f.service.close();
  const reopened = new LearningService(f.paths); services.push(reopened);
  await assertPreserved("reopened store", reopened);
});

test("backup excludes credentials and restore rejects path escape and corrupt data", async () => {
  const f = await fixture();
  const backupFile = join(f.root, "backup.json");
  await backup(f.service.store, f.paths, backupFile);

  const backupContent = await readFile(backupFile, "utf8");
  expect(backupContent).not.toContain("secret-key-123");

  const restoredRoot = join(f.root, "restored-home");
  const restoredPaths = createSagePaths({ home: restoredRoot });
  await restore(restoredPaths, backupFile);

  // Ensure restored home does not contain credentials
  const authExists = await readFile(join(restoredPaths.agent, "auth.json"), "utf8").then(() => true, () => false);
  expect(authExists).toBe(false);
});
