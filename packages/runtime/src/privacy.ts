import { Database } from "bun:sqlite";
import { readdir, stat, unlink, readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SagePaths } from "./paths.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { Type } from "typebox";
import { validate } from "../../core/src/contracts.ts";
import { acquireTutorLock } from "./tutor-lock.ts";

const PurgeOptionsSchema = Type.Object({ scope: Type.Enum(["all_learning_data", "lesson", "source"]), target_id: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })), dryRun: Type.Boolean(), confirm: Type.Boolean() }, { additionalProperties: false });

export interface PrivacyInventory {
  database: {
    path: string;
    bytes: number;
    events_count: number;
    revisions_count: number;
    sources_count: number;
    model_calls_count: number;
  };
  blobs: {
    path: string;
    count: number;
    bytes: number;
  };
  sessions: {
    path: string;
    count: number;
    bytes: number;
  };
  brain: {
    path: string;
    exists: boolean;
    bytes: number;
  };
  credentials: {
    path: string;
    detected: boolean;
    excluded_from_backup: boolean;
  };
  usage_tracking: {
    totals_path: string;
    settings_path: string;
    metrics: ["total_sessions", "total_hours"];
    default_enabled: true;
    network_reporting: false;
    excluded_from_learning_backup: true;
    disabling_deletes_totals: false;
  };
  limitations: {
    plaintext_at_rest: true;
    provider_copies_recalled: false;
    secure_erasure_hardware_guarantee: false;
  };
}

export interface PurgeOptions {
  scope: "all_learning_data" | "lesson" | "source";
  target_id?: string;
  dryRun: boolean;
  confirm: boolean;
}

export interface PurgeResult {
  dryRun: boolean;
  success: boolean;
  scope: PurgeOptions["scope"];
  records_removed: number;
  other_rows_removed: number;
  blobs_removed: number;
  sessions_removed: number;
  message: string;
  external_limitations: string[];
}

async function ownedFiles(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error("Privacy maintenance refuses a symbolic link or junction in an owned directory");
  if (!info.isDirectory()) throw new Error("Privacy maintenance requires an owned directory");
  const files: Array<{ path: string; bytes: number }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), child = await lstat(path);
    if (child.isSymbolicLink()) throw new Error("Privacy maintenance refuses a symbolic link or junction in an owned directory");
    if (child.isDirectory()) files.push(...await ownedFiles(path));
    else if (child.isFile()) files.push({ path, bytes: child.size });
    else throw new Error("Privacy maintenance refuses an unsupported owned file type");
  }
  return files;
}

export async function privacyInventory(paths: SagePaths, existingStore?: LearningStore): Promise<PrivacyInventory> {
  const dbPath = join(paths.data, "learning.sqlite");
  const dbStat = await stat(dbPath).catch(() => ({ size: 0 }));
  const store = existingStore ?? new LearningStore(dbPath);
  let eventsCount = 0, revisionsCount = 0, sourcesCount = 0, callsCount = 0;
  try {
    eventsCount = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM event").get()?.count) ?? 0;
    revisionsCount = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM object_revision").get()?.count) ?? 0;
    sourcesCount = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM source_span").get()?.count) ?? 0;
    callsCount = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM model_call_log").get()?.count) ?? 0;
  } finally {
    if (!existingStore) store.close();
  }

  const blobsDir = join(paths.data, "blobs");
  const blobEntries = await ownedFiles(blobsDir), blobBytes = blobEntries.reduce((sum, file) => sum + file.bytes, 0);
  const sessionEntries = await ownedFiles(paths.sessions), sessionBytes = sessionEntries.reduce((sum, file) => sum + file.bytes, 0);

  const brainStat = await stat(paths.brain).catch(() => undefined);
  const authPath = join(paths.agent, "auth.json");
  const authExists = await readFile(authPath, "utf8").then(c => c.trim().length > 2, () => false);

  return {
    database: {
      path: dbPath,
      bytes: dbStat.size,
      events_count: eventsCount,
      revisions_count: revisionsCount,
      sources_count: sourcesCount,
      model_calls_count: callsCount,
    },
    blobs: {
      path: blobsDir,
      count: blobEntries.length,
      bytes: blobBytes,
    },
    sessions: {
      path: paths.sessions,
      count: sessionEntries.length,
      bytes: sessionBytes,
    },
    brain: {
      path: paths.brain,
      exists: !!brainStat,
      bytes: brainStat?.size ?? 0,
    },
    credentials: {
      path: authPath,
      detected: authExists,
      excluded_from_backup: true,
    },
    usage_tracking: {
      totals_path: join(paths.data, "usage.json"),
      settings_path: join(paths.config, "usage.json"),
      metrics: ["total_sessions", "total_hours"],
      default_enabled: true,
      network_reporting: false,
      excluded_from_learning_backup: true,
      disabling_deletes_totals: false,
    },
    limitations: {
      plaintext_at_rest: true,
      provider_copies_recalled: false,
      secure_erasure_hardware_guarantee: false,
    },
  };
}

export async function purgePrivacyData(
  paths: SagePaths,
  existingStore: LearningStore | undefined,
  options: PurgeOptions,
): Promise<PurgeResult> {
  validate<PurgeOptions>(PurgeOptionsSchema, options);
  if (options.scope !== "all_learning_data" || options.target_id !== undefined) throw new Error("Requested purge scope is unsupported; lesson/source deletion cannot fall back to deleting all learning data");
  if (existingStore && resolve(existingStore.db.filename) !== resolve(join(paths.data, "learning.sqlite"))) throw new Error("Existing privacy store does not match the selected Sage home");
  if (!options.dryRun && !options.confirm) {
    throw new Error("Purge requires explicit confirmation: confirm: true");
  }
  if (options.dryRun) return purgeAllLearningData(paths, existingStore, options);
  const release = acquireTutorLock(paths.home);
  try { return await purgeAllLearningData(paths, existingStore, options); }
  finally { release(); }
}

async function purgeAllLearningData(paths: SagePaths, existingStore: LearningStore | undefined, options: PurgeOptions): Promise<PurgeResult> {
  const dbPath = join(paths.data, "learning.sqlite");
  for (const path of [paths.data, dbPath]) {
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error("Privacy maintenance refuses a symbolic link or junction in the learning database path");
  }
  const blobsDir = join(paths.data, "blobs");
  const blobEntries = await ownedFiles(blobsDir), sessionEntries = await ownedFiles(paths.sessions);

  const store = existingStore ?? new LearningStore(dbPath);
  let recordsCount = 0, otherRowsCount = 0;
  try {
    const events = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM event").get()?.count) ?? 0;
    const revs = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM object_revision").get()?.count) ?? 0;
    const spans = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM source_span").get()?.count) ?? 0;
    const calls = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM model_call_log").get()?.count) ?? 0;
    const blobs = (store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM blob_manifest").get()?.count) ?? 0;
    const projections = store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM projection").get()?.count ?? 0;
    const jobs = store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM job").get()?.count ?? 0;
    recordsCount = events + revs + spans + calls + blobs;
    otherRowsCount = projections + jobs;

    if (options.dryRun) {
      return {
        dryRun: true,
        success: true,
        scope: options.scope,
        records_removed: recordsCount,
        other_rows_removed: otherRowsCount,
        blobs_removed: blobEntries.length,
        sessions_removed: sessionEntries.length,
        message: "Dry run preview: no data was modified",
        external_limitations: [
          "Brain, caches, artifacts, backups, exports and original source files are retained; older backups can restore removed data",
          "Provider-side request logs cannot be purged locally",
          "Plaintext SQLite rows cannot guarantee hardware-level SSD non-recoverability",
        ],
      };
    }

    store.db.transaction(() => {
      store.db.exec(`
        DROP TRIGGER IF EXISTS object_revision_immutable_delete;
        DROP TRIGGER IF EXISTS event_immutable_delete;
        DROP TRIGGER IF EXISTS model_call_log_immutable_delete;
        DROP TRIGGER IF EXISTS blob_manifest_immutable_delete;
        DROP TRIGGER IF EXISTS source_span_immutable_delete;
        DELETE FROM source_span;
        DELETE FROM object_revision;
        DELETE FROM event;
        DELETE FROM blob_manifest;
        DELETE FROM model_call_log;
        DELETE FROM projection;
        DELETE FROM job;
        CREATE TRIGGER object_revision_immutable_delete BEFORE DELETE ON object_revision BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER event_immutable_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER model_call_log_immutable_delete BEFORE DELETE ON model_call_log BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER blob_manifest_immutable_delete BEFORE DELETE ON blob_manifest BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER source_span_immutable_delete BEFORE DELETE ON source_span BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
      `);
    })();
  } finally {
    if (!existingStore) store.close();
  }

  try {
    for (const file of [...blobEntries, ...sessionEntries]) await unlink(file.path);
  } catch (cause) {
    throw new Error("Purge incomplete: local rows were cleared but owned copies may remain. Retry the same confirmed purge; complete erasure is not claimed.", { cause });
  }

  // Run VACUUM to reclaim space and clear freed SQLite pages
  const db = new Database(dbPath);
  try {
    db.query("VACUUM").run();
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (!checkpoint || checkpoint.busy !== 0) throw new Error("Purge incomplete: SQLite checkpoint is blocked. Close other database readers and retry; complete local removal is not claimed.");
  } finally {
    db.close();
  }

  return {
    dryRun: false,
    success: true,
    scope: options.scope,
    records_removed: recordsCount,
    other_rows_removed: otherRowsCount,
    blobs_removed: blobEntries.length,
    sessions_removed: sessionEntries.length,
    message: "Local ledger, blob files and native session files removed; this is not complete erasure of all copies",
    external_limitations: [
      "Brain, caches, artifacts, backups, exports and original source files are retained; older backups can restore removed data",
      "Provider-side request logs cannot be purged locally",
      "Plaintext SQLite rows cannot guarantee hardware-level SSD non-recoverability",
    ],
  };
}
