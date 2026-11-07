// Ported from v3 packages/storage/src/store.ts: same 7 tables, WAL, immutable-write triggers, content hashes and idempotent op IDs.
// v3's domain validation (define/record) is replaced by the v4 engine reducer; engine events are stored as `v4.<type>` event rows.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, EngineEvent } from "../../engine/src/index.ts";

export const SCHEMA_VERSION = 2; // unchanged from v3: v4 adds no tables
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function parseStoredJson(encoded: string) {
  try { return JSON.parse(encoded); }
  catch (cause) { throw new Error("Stored record JSON is corrupt; stop writes and inspect the local backup", { cause }); }
}

export interface LedgerEvent { seq: number; event_id: string; operation_id: string; kind: string; session_id: string; actor: string; occurred_at: string; recorded_at: string; payload: Record<string, unknown> }
export interface CallEntry { call_id: string; phase: "started" | "response" | "completed" | "failed" | "cancelled" | "unknown"; role?: string; model?: string; input_tokens?: number; output_tokens?: number; input_chars?: number; cost_usd?: number; [k: string]: unknown }

export class Ledger {
  readonly db: Database;
  constructor(readonly filename: string, readonly now: () => string = () => new Date().toISOString()) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) { this.db.close(); throw new Error("Database is newer than this Sage version; upgrade Sage before opening it"); }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS object_revision (
          revision_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, kind TEXT NOT NULL,
          parent_revision_id TEXT REFERENCES object_revision(revision_id), schema_version INTEGER NOT NULL DEFAULT 1,
          body TEXT NOT NULL CHECK(json_valid(body)), content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          created_seq INTEGER NOT NULL, operation_id TEXT UNIQUE NOT NULL, command_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS revision_entity ON object_revision(entity_id, created_seq);
        CREATE TABLE IF NOT EXISTS event (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, operation_id TEXT UNIQUE NOT NULL,
          command_hash TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL, branch TEXT NOT NULL CHECK(branch IN ('real','hypothetical')),
          actor TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE TABLE IF NOT EXISTS model_call_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('started','response','completed','failed','cancelled','unknown')),
          recorded_at TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(call_id, phase)
        );
        CREATE TABLE IF NOT EXISTS projection (
          key TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, as_of_time TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))
        );
        CREATE TABLE IF NOT EXISTS blob_manifest (
          hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_span (
          span_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL REFERENCES object_revision(revision_id),
          ordinal INTEGER NOT NULL, locator TEXT NOT NULL, text TEXT NOT NULL, method TEXT NOT NULL, confidence REAL NOT NULL,
          UNIQUE(source_revision_id, ordinal)
        );
        CREATE TABLE IF NOT EXISTS job (
          job_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, error TEXT, body TEXT NOT NULL CHECK(json_valid(body))
        );
        CREATE INDEX IF NOT EXISTS event_kind_time ON event(kind,occurred_at,seq);
        CREATE INDEX IF NOT EXISTS event_session ON event(session_id,seq);
        CREATE INDEX IF NOT EXISTS revision_kind ON object_revision(kind,created_seq);
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      for (const table of ["object_revision", "event", "model_call_log", "blob_manifest", "source_span"]) this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
      `);
    })();
  }

  get throughSeq(): number { return (this.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM event").get() as { seq: number }).seq; }

  /** Idempotent append: the same operation ID with the same content returns the original row; different content is an error (v3). */
  append(kind: string, payload: Record<string, unknown>, operationId: string, actor: string, sessionId: string, occurredAt = this.now()): LedgerEvent {
    const commandHash = hash(canonical({ kind, payload }));
    const row = this.db.query<{ event_id: string; command_hash: string; session_id: string }, [string]>("SELECT event_id,command_hash,session_id FROM event WHERE operation_id=?").get(operationId);
    if (row) {
      if (row.command_hash !== commandHash) throw new Error("Idempotency key was already used with different content");
      if (row.session_id !== sessionId) throw new Error("Idempotency receipt belongs to a different session");
      return this.event(row.event_id);
    }
    const recordedAt = this.now();
    if (Date.parse(occurredAt) > Date.parse(recordedAt) + 60_000) throw new Error("Future events cannot establish learning evidence");
    const eventId = randomUUID();
    this.db.query("INSERT INTO event(event_id,operation_id,command_hash,kind,session_id,branch,actor,occurred_at,recorded_at,payload) VALUES(?,?,?,?,?,'real',?,?,?,?)")
      .run(eventId, operationId, commandHash, kind, sessionId, actor, occurredAt, recordedAt, canonical(payload));
    return this.event(eventId);
  }
  event(id: string): LedgerEvent {
    const row = this.db.query<LedgerEvent & { payload: string }, [string]>("SELECT * FROM event WHERE event_id=?").get(id);
    if (!row) throw new Error(`Missing event: ${id}`);
    return { ...row, payload: parseStoredJson(row.payload) };
  }
  events(sessionId?: string, throughSeq = this.throughSeq): LedgerEvent[] {
    return this.db.query<LedgerEvent & { payload: string }, [number, string | null, string | null]>("SELECT * FROM event WHERE seq<=? AND (? IS NULL OR session_id=?) ORDER BY seq")
      .all(throughSeq, sessionId ?? null, sessionId ?? null).map(row => ({ ...row, payload: parseStoredJson(row.payload) }));
  }

  /** Engine events only, in order, ready for `replay` (packages/engine). */
  appendEngine(sessionId: string, event: EngineEvent, actor: Actor, now: string, operationId: string = randomUUID()): LedgerEvent {
    return this.append(`v4.${event.type}`, event as unknown as Record<string, unknown>, operationId, actor, sessionId, now);
  }
  engineLog(sessionId: string, throughSeq?: number): { event: EngineEvent; now: string; actor: Actor }[] {
    return this.events(sessionId, throughSeq).filter(e => e.kind.startsWith("v4.")).map(e => ({ event: e.payload as unknown as EngineEvent, now: e.occurred_at, actor: e.actor as Actor }));
  }
  sessions(): string[] {
    return this.db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM event WHERE kind='v4.session_created' ORDER BY seq").all().map(r => r.session_id);
  }

  logCall(entry: CallEntry): void {
    if (entry.phase !== "started" && !this.db.query("SELECT 1 FROM model_call_log WHERE call_id=? AND phase='started'").get(entry.call_id)) throw new Error("Call has no observed request start");
    this.db.query("INSERT OR IGNORE INTO model_call_log(call_id,phase,recorded_at,body) VALUES(?,?,?,?)").run(entry.call_id, entry.phase, this.now(), canonical(entry));
  }
  calls(): CallEntry[] { return this.db.query<{ body: string }, []>("SELECT body FROM model_call_log ORDER BY seq").all().map(r => parseStoredJson(r.body)); }

  integrity(): string[] { return this.db.query("PRAGMA integrity_check").all().map(row => String((row as Record<string, unknown>).integrity_check)); }
  close(): void { this.db.close(); }
}
