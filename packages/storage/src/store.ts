import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TeachingAnnotationSchema, type TeachingAnnotation, CallSchema, DefineSchema, RecordSchema, validate, validTime, type Revision, type RevisionKind, type LearningEvent, type Goal, type TaskDefinition, type TaskInstance, type Rubric, type Attempt, type Assessment, type Assistance, type CallEntry } from "../../core/src/contracts.ts";
import { familyKeys, projectComponents } from "./projection.ts";
import { componentOutcome, taskReviewRole, POLICY_VERSION, PROJECTOR_VERSION } from "../../core/src/learning.ts";
import type { Artifact, DrillRound, Hypothesis } from "../../core/src/contracts.ts";
import type { SubmissionMetadata } from "../../core/src/interactions.ts";
import { verifyLinearEquation } from "../../activities/src/validation.ts";
import { assertReviewAuthorization, assertReviewCompletion } from "./review-validation.ts";

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
interface RevisionRow { revision_id: string; entity_id: string; kind: RevisionKind; parent_revision_id: string | null; body: string; content_hash: string; created_at: string; created_seq: number }
interface EventRow extends Omit<LearningEvent, "payload"> { payload: string }
type DefineInput = { operation_id: string; kind: Exclude<RevisionKind, "source">; entity_id?: string; parent_revision_id?: string; expected_goal_revision_id?: string; body: Record<string, unknown> };
type RecordInput = { operation_id: string; kind: LearningEvent["kind"]; expected_goal_revision_id: string; occurred_at?: string; payload: Record<string, unknown> };

export class LearningStore {
  readonly db: Database;
  constructor(readonly filename: string, readonly now: () => string = () => new Date().toISOString()) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 2) { this.db.close(); throw new Error("Database is newer than this Sage version; upgrade Sage before opening it"); }
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
        PRAGMA user_version=2;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS object_revision_immutable_update BEFORE UPDATE ON object_revision BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS object_revision_immutable_delete BEFORE DELETE ON object_revision BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER IF NOT EXISTS event_immutable_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS event_immutable_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER IF NOT EXISTS model_call_log_immutable_update BEFORE UPDATE ON model_call_log BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS model_call_log_immutable_delete BEFORE DELETE ON model_call_log BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER IF NOT EXISTS blob_manifest_immutable_update BEFORE UPDATE ON blob_manifest BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS blob_manifest_immutable_delete BEFORE DELETE ON blob_manifest BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
        CREATE TRIGGER IF NOT EXISTS source_span_immutable_update BEFORE UPDATE ON source_span BEGIN SELECT RAISE(ABORT, 'Immutable record'); END;
        CREATE TRIGGER IF NOT EXISTS source_span_immutable_delete BEFORE DELETE ON source_span BEGIN SELECT RAISE(ABORT, 'Immutable record; privacy purge requires an explicit maintenance operation'); END;
      `);
    })();
  }
  get throughSeq(): number { return (this.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM event").get() as { seq: number }).seq; }
  revisions(kind?: RevisionKind, throughSeq = this.throughSeq): Revision[] {
    const rows = this.db.query<RevisionRow, [number, string | null, string | null]>("SELECT * FROM object_revision WHERE created_seq<=? AND (? IS NULL OR kind=?) ORDER BY created_seq,revision_id").all(throughSeq, kind ?? null, kind ?? null);
    return rows.map(row => ({ ...row, body: parseStoredJson(row.body) }));
  }
  revision<T = Record<string, unknown>>(id: string, kind?: RevisionKind): Revision<T> {
    const row = this.db.query<RevisionRow, [string]>("SELECT * FROM object_revision WHERE revision_id=?").get(id);
    if (!row || (kind && row.kind !== kind)) throw new Error(`Missing ${kind ?? "object"} revision: ${id}`);
    return { ...row, body: parseStoredJson(row.body) };
  }
  /** Maintenance inventory only. Runtime authorization must use lessonGoal(). */
  currentGoal(throughSeq = this.throughSeq): Revision<Goal> | undefined { return this.revisions("goal", throughSeq).at(-1) as Revision<Goal> | undefined; }
  lessonGoals(sessionId: string, throughSeq = this.throughSeq): Revision<Goal>[] {
    const owned = new Set(this.events(throughSeq).filter(e => e.session_id === sessionId && e.kind === "decision" && e.payload.action === "revision_defined" && e.payload.kind === "goal").map(e => e.payload.revision_id));
    return [...new Map((this.revisions("goal", throughSeq) as Revision<Goal>[]).filter(r => owned.has(r.revision_id)).map(r => [r.entity_id, r])).values()];
  }
  lessonGoal(sessionId: string, throughSeq = this.throughSeq): Revision<Goal> | undefined {
    const goals = this.lessonGoals(sessionId, throughSeq);
    const binding = this.events(throughSeq).filter(e => e.session_id === sessionId && e.kind === "decision" && e.actor === "host" && e.payload.action === "lesson_bound").at(-1);
    if (binding) return goals.find(g => g.entity_id === binding.payload.goal_entity_id);
    if (goals.length > 1) throw new Error("Legacy conversation contains multiple lessons; choose a lesson locally before resuming");
    return goals[0];
  }
  bindLesson(sessionId: string, entityId: string): Revision<Goal> {
    const goal = this.lessonGoals(sessionId).find(g => g.entity_id === entityId);
    if (!goal) throw new Error("Lesson does not belong to this conversation");
    const binding = this.events().filter(e => e.actor === "host" && e.session_id === sessionId && e.payload.action === "lesson_bound").at(-1);
    if (binding?.payload.goal_entity_id !== entityId) this.append("decision", { action: "lesson_bound", goal_entity_id: entityId, reason: "Learner explicitly selected a lesson from a legacy mixed conversation", evidence_event_ids: [] }, randomUUID(), "host", sessionId);
    return goal;
  }
  events(throughSeq = this.throughSeq): LearningEvent[] {
    return this.db.query<EventRow, [number]>("SELECT * FROM event WHERE seq<=? ORDER BY seq").all(throughSeq).map(row => ({ ...row, payload: parseStoredJson(row.payload) }));
  }
  event<T = Record<string, unknown>>(id: string, kind?: LearningEvent["kind"]): LearningEvent<T> {
    const row = this.db.query<EventRow, [string]>("SELECT * FROM event WHERE event_id=?").get(id);
    if (!row || (kind && row.kind !== kind)) throw new Error(`Missing ${kind ?? "event"}: ${id}`);
    return { ...row, payload: parseStoredJson(row.payload) };
  }
  private checkGoal(expected: string | undefined, sessionId: string): void {
    const current = this.lessonGoal(sessionId);
    if (current && expected !== current.revision_id) throw new Error(`Stale goal: refresh learning_context; current revision is ${current.revision_id}`);
    if (!current && expected) throw new Error("No active goal");
  }
  private duplicate(table: "event" | "object_revision", operationId: string, input: unknown): string | undefined {
    const query = table === "event" ? "SELECT event_id AS id,command_hash FROM event WHERE operation_id=?" : "SELECT revision_id AS id,command_hash FROM object_revision WHERE operation_id=?";
    const row = this.db.query<{ id: string; command_hash: string }, [string]>(query).get(operationId);
    if (row && row.command_hash !== hash(canonical(input))) throw new Error("Idempotency key was already used with different content");
    return row?.id;
  }
  append(kind: LearningEvent["kind"], payload: Record<string, unknown>, operationId: string, actor: string, sessionId: string, occurredAt = this.now(), command: unknown = { kind, payload }, branch: "real" | "hypothetical" = "real"): LearningEvent {
    if (kind === "decision" && payload.action === "cram_task_selected" && actor !== "host") throw new Error("Cram selection annotations require trusted host delivery control");
    if (kind === "decision" && payload.action === "learning_task_skipped" && (actor !== "learner" || branch !== "real")) throw new Error("Task skipping requires trusted learner controls");
    if (kind === "decision" && (payload.action === "lesson_bound" || payload.action === "review_offer_authorized") && actor === "pi") throw new Error("Lesson binding and review authorization require trusted host controls");
    if (kind === "decision" && ["review_cancelled", "review_declined", "review_rescheduled"].includes(payload.action as string) && actor === "pi") throw new Error("Review queue controls require learner authority");
    if (payload.teaching !== undefined || payload.action === "teaching_stage") {
      if (kind !== "decision" || payload.action !== "teaching_stage" || actor !== "host" || branch !== "real") throw new Error("Teaching annotations require trusted host controls");
    }
    const existing = this.duplicate("event", operationId, command);
    if (existing) {
      const event = this.event(existing);
      if (event.session_id !== sessionId) throw new Error("Idempotency receipt belongs to a different conversation");
      return event;
    }
    const recordedAt = validTime(this.now());
    const occurred = validTime(occurredAt);
    if (Date.parse(occurred) > Date.parse(recordedAt) + 60000) throw new Error("Future events cannot establish learning evidence");
    if (payload.teaching !== undefined || payload.action === "teaching_stage") this.validateTeachingAnnotation(payload.teaching, sessionId, this.lessonGoal(sessionId)?.revision_id ?? "", this.throughSeq, occurred);
    const eventId = randomUUID();
    this.db.query("INSERT INTO event(event_id,operation_id,command_hash,kind,session_id,branch,actor,occurred_at,recorded_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)").run(eventId, operationId, hash(canonical(command)), kind, sessionId, branch, actor, occurred, recordedAt, canonical(payload));
    return this.event(eventId);
  }
  define(rawInput: unknown, actor = "pi", sessionId = "local"): Revision {
    validate<DefineInput>(DefineSchema, rawInput);
    return this.db.transaction(() => {
      let input = rawInput;
      const existing = this.duplicate("object_revision", input.operation_id, input);
      if (existing) {
        const revision = this.revision(existing);
        if (!this.events().some(e => e.seq === revision.created_seq && e.session_id === sessionId)) throw new Error("Definition receipt belongs to a different conversation");
        return revision;
      }
      this.checkGoal(input.expected_goal_revision_id, sessionId);
      const current = this.lessonGoal(sessionId);
      if (input.kind === "goal" && current && !input.parent_revision_id) throw new Error("Start a new session for a new lesson; refinements require the current lesson parent");
      if (input.kind === "goal" && input.parent_revision_id && this.revision(input.parent_revision_id, "goal").entity_id !== current?.entity_id) throw new Error("Parent belongs to another lesson");
      for (const ref of input.kind === "goal" ? [] : [input.body.goal_revision_id]) if (typeof ref === "string" && this.revision(ref, "goal").entity_id !== current?.entity_id) throw new Error("Definition belongs to another lesson");
      if (input.parent_revision_id) {
        const parent = this.revision(input.parent_revision_id, input.kind);
        if (!this.events().some(e => e.seq === parent.created_seq && e.session_id === sessionId)) throw new Error("Parent belongs to another lesson conversation");
        if (input.entity_id && parent.entity_id !== input.entity_id) throw new Error("Parent belongs to a different entity");
        input = { ...input, entity_id: parent.entity_id };
        const latest = this.revisions(input.kind).filter(r => r.entity_id === parent.entity_id).at(-1);
        if (latest?.revision_id !== parent.revision_id) throw new Error("Stale parent revision");
      } else if (input.entity_id && this.revisions().some(r => r.entity_id === input.entity_id)) throw new Error("Existing entities require a parent revision");
      if (input.kind === "task_definition" && input.body.partition !== "protected" && ["candidate", "needs_review"].includes(input.body.status as string)) {
        // SAFETY: DefineSchema validates this discriminated task body before verifier dispatch.
        const proposedTask = input.body as unknown as TaskDefinition;
        if (verifyLinearEquation(proposedTask)) input = { ...input, body: { ...input.body, status: "practice_ready", review: { method: "deterministic", reason: "Independent bounded linear-equation calculator verified the key; no semantic or psychometric equivalence claim" } } };
      }
      this.validateDefinition(input.kind, input.body, actor, current);
      const revisionId = randomUUID();
      const created = this.append("decision", { action: "revision_defined", kind: input.kind, revision_id: revisionId, reason: "Accepted immutable proposal", evidence_event_ids: [], disclosure_scope: { goal_revision_id: current?.revision_id, source_ids: current?.body.source_ids ?? [] } }, `define:${input.operation_id}`, actor, sessionId);
      this.insertRevision(revisionId, input.entity_id ?? randomUUID(), input.kind, input.parent_revision_id ?? null, input.body, created.seq, input.operation_id, rawInput);
      if (input.kind === "task_instance") {
        this.append("task_delivered", { instance_revision_id: revisionId, disclosure_scope: { goal_revision_id: current?.revision_id, source_ids: current?.body.source_ids ?? [] } }, `deliver:${input.operation_id}`, actor, sessionId);
        const task = this.revision<TaskDefinition>(input.body.definition_revision_id as string).body;
        for (const ref of task.artifact_revision_ids ?? []) {
          const artifact = this.revision<Artifact>(ref, "artifact").body;
          if (artifact.author !== "learner") this.append("assistance", { assistance_id: `task-artifact:${revisionId}:${ref}`, instance_revision_id: revisionId, component_revision_ids: task.component_revision_ids, stage: "possibly_exposed", kind: "example", content: `Supplied ${artifact.author} artifact ${ref}; support content not automatically independent evidence`, answer_bearing: true }, `task-artifact:${revisionId}:${ref}`, "host", sessionId);
        }
      }
      this.rebuild();
      return this.revision(revisionId);
    })();
  }
  insertRevision(revisionId: string, entityId: string, kind: RevisionKind, parent: string | null, body: Record<string, unknown>, seq: number, operationId: string, command: unknown): void {
    const encoded = canonical(body);
    this.db.query("INSERT INTO object_revision(revision_id,entity_id,kind,parent_revision_id,body,content_hash,created_at,created_seq,operation_id,command_hash,schema_version) VALUES(?,?,?,?,?,?,?,?,?,?,2)").run(revisionId, entityId, kind, parent, encoded, hash(encoded), this.now(), seq, operationId, hash(canonical(command)));
  }
  private validateDefinition(kind: RevisionKind, body: Record<string, unknown>, actor: string, current?: Revision<Goal>): void {
    const refs = (key: string, refKind: RevisionKind) => { for (const ref of (body[key] as string[] | undefined) ?? []) this.revision(ref, refKind); };
    if (kind === "goal") {
      if (actor === "pi" && (!current || body.provider_sharing !== current.body.provider_sharing || canonical(body.source_ids) !== canonical(current.body.source_ids))) throw new Error("Provider consent and source selection require learner controls");
      if (actor === "pi" && current && ["mode", "deadline", "study_windows", "exam", "budget_minutes", "target_format", "allowed_aids", "criteria"].some(field => canonical(body[field] ?? null) !== canonical(current.body[field as keyof Goal] ?? null))) throw new Error("Mode, urgency, allocation, format, aids and criteria require native learner controls; AI or source claims are not learner intent");
      if (body.deadline) validTime(body.deadline as string);
      // SAFETY: DefineSchema validates the goal body before temporal and reference checks.
      const goal = body as unknown as Goal;
      let previousEnd = -Infinity;
      for (const window of goal.study_windows ?? []) {
        const start = Date.parse(validTime(window.start)), end = Date.parse(validTime(window.end));
        if (end <= start || start < previousEnd) throw new Error("Study windows must be ordered, non-overlapping and end after they start");
        previousEnd = end;
      }
      for (const source of body.source_ids as string[]) this.revision(source, "source");
      const weights = goal.exam?.topic_weights ?? [];
      for (const weight of weights) this.revision(weight.component_revision_id, "component");
      if (new Set(weights.map(w => w.component_revision_id)).size !== weights.length) throw new Error("Exam topic weights must be unique");
    }
    if (kind === "component") { refs("concept_revision_ids", "concept"); refs("prerequisite_revision_ids", "component"); }
    if (kind === "task_family") {
      refs("lineage_revision_ids", "task_family"); refs("component_revision_ids", "component"); refs("concept_revision_ids", "concept"); refs("prerequisite_revision_ids", "component");
      for (const span of (body.source_span_ids as string[] | undefined) ?? []) this.acceptedSpan(span);
    }
    if (kind === "hypothesis") {
      // SAFETY: DefineSchema validates the hypothesis body before reference checks.
      const h = body as unknown as Hypothesis;
      refs("component_revision_ids", "component"); refs("competing_hypothesis_revision_ids", "hypothesis");
      if (h.prerequisite_component_revision_id) this.revision(h.prerequisite_component_revision_id, "component");
      const first = validTime(h.first_observed_at), last = validTime(h.last_observed_at);
      if (first > last || last > this.now()) throw new Error("Invalid hypothesis observation interval");
      if (h.supporting_evidence_ids.some(id => h.contradicting_evidence_ids.includes(id))) throw new Error("Evidence cannot both support and contradict the same hypothesis revision");
      for (const id of [...h.supporting_evidence_ids, ...h.contradicting_evidence_ids]) {
        const evidence = this.event<Assessment>(id, "assessment");
        const attempt = this.findAttempt(evidence.payload.attempt_id);
        const task = this.revision<TaskDefinition>(this.revision<TaskInstance>(attempt.payload.instance_revision_id).body.definition_revision_id).body;
        if (evidence.branch !== "real" || !task.component_revision_ids.some(c => (h.component_revision_ids.includes(c) || c === h.prerequisite_component_revision_id) && componentOutcome(task, evidence.payload, c) !== "not_observed")) throw new Error("Hypothesis evidence is not a relevant observed assessment");
      }
      if (h.status === "resolved" && !h.contradicting_evidence_ids.length) throw new Error("Resolution requires contradictory evidence, not an unsupported label");
    }
    if (kind === "artifact") {
      // SAFETY: DefineSchema validates the artifact body; authority checks follow below.
      const artifact = body as unknown as Artifact;
      if (artifact.blob_hash && !this.db.query("SELECT 1 FROM blob_manifest WHERE hash=?").get(artifact.blob_hash)) throw new Error("Artifact binary blob is not registered");
      if (artifact.goal_revision_id) this.revision(artifact.goal_revision_id, "goal");
      if (artifact.instance_revision_id) this.revision(artifact.instance_revision_id, "task_instance");
      for (const ref of artifact.assistance_event_ids) this.event(ref, "assistance");
      if (actor === "pi" && (artifact.author === "learner" || artifact.evidence_kind === "direct")) throw new Error("Pi cannot claim learner authorship or direct modality evidence");
      if (artifact.author === "learner") {
        if (actor !== "learner" || !artifact.response_event_id) throw new Error("Learner artifacts require a captured learner submission");
        this.event(artifact.response_event_id, "learner_response");
      }
      if (artifact.author !== "learner" && artifact.evidence_kind === "direct") throw new Error("Non-learner artifact is not direct learner evidence");
    }
    if (kind === "plan") { this.revision(body.goal_revision_id as string, "goal"); refs("component_revision_ids", "component"); }
    if (kind === "drill_round") {
      this.revision(body.goal_revision_id as string, "goal");
      for (const instId of (body.task_instance_ids as string[] | undefined) ?? []) this.revision(instId, "task_instance");
      for (const span of (body.source_anchor_span_ids as string[] | undefined) ?? []) this.acceptedSpan(span);
      if (body.prior_round_revision_id) this.revision(body.prior_round_revision_id as string, "drill_round");
    }
    if (kind === "rubric" || kind === "task_definition") {
      for (const span of body.source_span_ids as string[]) this.acceptedSpan(span);
    }
    if (kind === "rubric") {
      // SAFETY: DefineSchema validates the rubric dimensions before this uniqueness check.
      const dimensions = (body as unknown as Rubric).dimensions.map(d => d.name);
      if (new Set(dimensions).size !== dimensions.length) throw new Error("Rubric dimensions must be unique");
    }
    if (kind === "task_definition") {
      // SAFETY: DefineSchema validates the task_definition body before semantic/reference checks.
      const task = body as unknown as TaskDefinition;
      if (task.format === "mcq") {
        if (!task.choices || task.scoring !== "exact" || !task.choices.some(c => c.id === task.answer)) throw new Error("MCQs require choices, exact scoring and a keyed choice ID");
        if (new Set(task.choices.map(c => c.id.toLowerCase())).size !== task.choices.length || new Set(task.choices.map(c => c.text.trim().toLowerCase())).size !== task.choices.length) throw new Error("MCQ choice IDs and texts must be distinct");
      } else if (task.choices) throw new Error("Choices belong only to MCQ tasks");
      this.revision(task.family_revision_id, "task_family"); this.revision(task.rubric_revision_id, "rubric"); refs("component_revision_ids", "component");
      refs("artifact_revision_ids", "artifact");
      if (task.variation) {
        const baseline = this.revision<TaskDefinition>(task.variation.baseline_definition_revision_id, "task_definition");
        if (!baseline.body.component_revision_ids.some(c => task.component_revision_ids.includes(c))) throw new Error("Variation baseline must share a targeted component");
      }
      if (task.scoring !== "rubric" && !task.answer) throw new Error("Objective scoring requires an answer");
      if (task.scoring === "numeric" && (!Number.isFinite(Number(task.answer)) || task.answer?.trim() === "")) throw new Error("Numeric key must be a finite number");
      if (task.status === "practice_ready" && task.review.method === "unreviewed") throw new Error("Review is required before practice");
      if (actor === "pi" && task.status === "practice_ready" && !(task.review.method === "deterministic" && verifyLinearEquation(task))) throw new Error("Pi cannot self-certify review. Save a candidate for /approve");
      if (task.review.reviewer_role === "expert" && taskReviewRole(task, actor) !== "expert") throw new Error("Expert review requires an expert actor and reviewer provenance");
      if (task.stakes === "high" && task.status === "practice_ready" && taskReviewRole(task, actor) !== "expert") throw new Error("High-stakes tasks require attributable expert review, not learner approval");
      if (task.partition === "protected" && actor === "pi") throw new Error("Tutor cannot author the protected outcome bank");
      if (task.answer && task.answer.trim().length > 3 && task.prompt.toLowerCase().includes(task.answer.trim().toLowerCase())) throw new Error("Answer appears in prompt; revise before use");
      const duplicate = this.revisions("task_definition").find(r => r.body.prompt === task.prompt && r.body.family_revision_id !== task.family_revision_id);
      if (duplicate) throw new Error("Identical prompt is already assigned to another family");
    }
    if (kind === "task_instance") {
      // SAFETY: DefineSchema validates the task_instance body before frozen-goal checks.
      const instance = body as unknown as TaskInstance;
      this.revision(instance.goal_revision_id, "goal");
      if (instance.goal_revision_id !== current?.revision_id) throw new Error("Task instance is outside the current lesson revision");
      const task = this.revision<TaskDefinition>(instance.definition_revision_id, "task_definition");
      if (task.body.status !== "practice_ready") throw new Error("Task is not reviewed and ready");
      const latest = this.revisions("task_definition").filter(r => r.entity_id === task.entity_id).at(-1);
      if (latest?.revision_id !== task.revision_id) throw new Error("Task definition was superseded");
      for (const span of task.body.source_span_ids) this.acceptedSpan(span);
      if (task.body.partition === "protected" && actor === "pi") throw new Error("Protected task delivery requires the explicit assessment control");
      if (task.body.partition === "protected") {
        const familyEntities = (revisionId: string, seen = new Set<string>()): Set<string> => {
          if (seen.has(revisionId)) return new Set();
          seen.add(revisionId);
          const family = this.revision(revisionId, "task_family");
          const entities = new Set([family.entity_id]);
          for (const related of (family.body.lineage_revision_ids as string[]) ?? []) for (const entity of familyEntities(related, seen)) entities.add(entity);
          return entities;
        };
        const sourceEntities = (spans: string[]) => new Set(spans.map(span => {
          const row = this.db.query<{ source_revision_id: string }, [string]>("SELECT source_revision_id FROM source_span WHERE span_id=?").get(span);
          if (!row) throw new Error("Missing historical source span");
          return this.revision(row.source_revision_id, "source").entity_id;
        }));
        const protectedFamilies = familyEntities(task.body.family_revision_id);
        const familyGroups = familyKeys(this, this.throughSeq);
        const protectedSources = sourceEntities(task.body.source_span_ids);
        const knownSources = this.revisions("goal").flatMap(goal => goal.body.source_ids as string[]).map(id => this.revision(id, "source").entity_id);
        if (knownSources.some(id => protectedSources.has(id))) throw new Error("Learner already selected this assessment source; cannot claim an unseen source");
        const delivered = this.events().filter(e => e.kind === "task_delivered");
        for (const e of delivered) {
          const prior = this.revision<TaskInstance>(e.payload.instance_revision_id as string);
          const def = this.revision<TaskDefinition>(prior.body.definition_revision_id).body;
          const priorFamilies = familyEntities(def.family_revision_id);
          const priorSources = sourceEntities(def.source_span_ids);
          if (familyGroups.get(def.family_revision_id) === familyGroups.get(task.body.family_revision_id) || [...priorFamilies].some(id => protectedFamilies.has(id)) || [...priorSources].some(id => protectedSources.has(id))) throw new Error("Protected assessment overlaps a delivered family/source; cannot claim independent transfer");
        }
      }
    }
  }
  acceptedSpan(spanId: string): { span_id: string; source_revision_id: string; text: string; locator: string } {
    const span = this.db.query<{ span_id: string; source_revision_id: string; text: string; locator: string }, [string]>("SELECT * FROM source_span WHERE span_id=?").get(spanId);
    if (!span) throw new Error(`Missing source span: ${spanId}`);
    const source = this.revision(span.source_revision_id, "source");
    const latest = this.revisions("source").filter(r => r.entity_id === source.entity_id).at(-1);
    if (latest?.revision_id !== source.revision_id || this.sourceStatus(source.revision_id) !== "indexed") throw new Error("Source is removed, superseded or not accepted");
    return span;
  }
  /** Validate pinned teaching references against the owned, bounded ledger, not just JSON. */
  validateTeachingAnnotation(raw: unknown, sessionId: string, goalRevisionId: string, throughSeq: number, asOfTime: string): TeachingAnnotation {
    validate<TeachingAnnotation>(TeachingAnnotationSchema, raw);
    const sessionEvents = this.events(throughSeq).filter(e => e.session_id === sessionId && e.branch === "real");
    const events = sessionEvents.filter(e => e.occurred_at <= asOfTime);
    const owned = new Set(events.map(e => e.seq));
    const revision = (id: string, kind: RevisionKind) => {
      const r = this.revision(id, kind);
      if (r.created_seq > throughSeq || r.created_at > asOfTime || !owned.has(r.created_seq)) throw new Error("Teaching reference is not owned at this boundary");
      return r;
    };
    const goal = revision(raw.goal_revision_id, "goal");
    if (raw.goal_revision_id !== goalRevisionId) throw new Error("Teaching unit belongs to a stale goal");
    const component = revision(raw.component_revision_id, "component");
    const instruction = revision(raw.instruction_revision_id, "artifact");
    const definition = revision(raw.definition_revision_id, "task_definition");
    if (raw.stage === "prepared" && this.revisions("task_definition", throughSeq).filter(r => r.entity_id === definition.entity_id && r.created_at <= asOfTime).at(-1)?.revision_id !== definition.revision_id) throw new Error("Teaching question was superseded");
    const rubric = revision(definition.body.rubric_revision_id as string, "rubric");
    revision(definition.body.family_revision_id as string, "task_family");
    if (component.body.subject !== goal.body.subject || instruction.body.goal_revision_id !== raw.goal_revision_id || instruction.body.author !== "tutor" || instruction.body.evidence_kind !== "artifact_only" || !(definition.body.artifact_revision_ids as string[] | undefined)?.includes(raw.instruction_revision_id) || !(definition.body.component_revision_ids as string[]).includes(raw.component_revision_id) || definition.body.status !== "practice_ready") throw new Error("Teaching references do not describe this goal and component");
    for (const artifactId of (definition.body.artifact_revision_ids as string[] | undefined) ?? []) {
      const artifact = revision(artifactId, "artifact");
      if (artifact.body.goal_revision_id && artifact.body.goal_revision_id !== raw.goal_revision_id) throw new Error("Teaching task artifact belongs to another goal");
    }
    for (const spanId of [...definition.body.source_span_ids as string[], ...rubric.body.source_span_ids as string[]]) {
      const span = this.db.query<{ source_revision_id: string }, [string]>("SELECT source_revision_id FROM source_span WHERE span_id=?").get(spanId);
      if (!span) throw new Error("Teaching source span is missing");
      const source = revision(span.source_revision_id, "source");
      const status = this.events(throughSeq).filter(e => e.branch === "real" && e.occurred_at <= asOfTime && e.payload.source_revision_id === source.revision_id && ["source_status", "source_accepted", "source_removed"].includes(e.kind)).at(-1)?.payload.status;
      if (!(goal.body.source_ids as string[]).includes(source.revision_id) || status !== "indexed") throw new Error("Teaching source is outside the accepted goal sources");
    }
    // Replay identity follows ledger order; reference availability still follows event time.
    const sequenceReceipts = sessionEvents.filter(e => e.kind === "decision" && e.actor === "host" && e.payload.action === "teaching_stage");
    const receipts = sequenceReceipts.filter(e => e.occurred_at <= asOfTime);
    if (raw.stage === "prepared") {
      if (raw.prepared_event_id || raw.instance_revision_id || sequenceReceipts.some(e => (e.payload.teaching as TeachingAnnotation | undefined)?.unit_id === raw.unit_id)) throw new Error("Teaching preparation cannot replay a unit");
    } else {
      const prepared = receipts.find(e => e.event_id === raw.prepared_event_id);
      const pins = prepared?.payload.teaching as TeachingAnnotation | undefined;
      if (!prepared || pins?.stage !== "prepared" || ["unit_id", "goal_revision_id", "component_revision_id", "instruction_revision_id", "definition_revision_id"].some(key => pins[key as keyof TeachingAnnotation] !== raw[key as keyof TeachingAnnotation])) throw new Error("Teaching transition lacks its owned preparation");
      const sequencePrior = sequenceReceipts.filter(e => e.seq > prepared.seq && (e.payload.teaching as TeachingAnnotation | undefined)?.prepared_event_id === prepared.event_id);
      if (sequencePrior.some(e => (e.payload.teaching as TeachingAnnotation).stage === raw.stage)) throw new Error("Teaching transition was already recorded");
      const prior = sequencePrior.filter(e => e.occurred_at <= asOfTime);
      if (raw.stage === "presented") {
        if (raw.instance_revision_id || prior.length) throw new Error("Teaching instruction must precede its question");
      } else {
        if (!prior.some(e => (e.payload.teaching as TeachingAnnotation).stage === "presented") || !raw.instance_revision_id) throw new Error("Teaching question requires instruction presentation");
        const instance = revision(raw.instance_revision_id, "task_instance");
        if (instance.body.goal_revision_id !== raw.goal_revision_id || instance.body.definition_revision_id !== raw.definition_revision_id) throw new Error("Teaching question does not match the pinned unit");
        const delivery = events.find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === raw.instance_revision_id);
        const presented = prior.find(e => (e.payload.teaching as TeachingAnnotation).stage === "presented")!;
        if (!delivery || delivery.seq <= presented.seq) throw new Error("Teaching question must be delivered after instruction");
        if (raw.stage === "completed" && !prior.some(e => (e.payload.teaching as TeachingAnnotation).stage === "linked" && (e.payload.teaching as TeachingAnnotation).instance_revision_id === raw.instance_revision_id)) throw new Error("Teaching completion requires its linked question");
      }
    }
    return raw;
  }
  sourceStatus(revisionId: string, throughSeq = this.throughSeq): string {
    let status = "received";
    for (const e of this.events(throughSeq)) if (e.payload.source_revision_id === revisionId && ["source_status", "source_accepted", "source_removed"].includes(e.kind)) status = e.payload.status as string;
    return status;
  }
  record(input: unknown, sessionId: string): LearningEvent {
    validate<RecordInput>(RecordSchema, input);
    if (input.payload.teaching !== undefined || input.payload.action === "teaching_stage") throw new Error("Teaching annotations require trusted host controls");
    return this.db.transaction(() => {
      const existing = this.duplicate("event", input.operation_id, input);
      if (existing) {
        const event = this.event(existing);
        if (event.session_id !== sessionId) throw new Error("Event receipt belongs to a different conversation");
        return event;
      }
      this.checkGoal(input.expected_goal_revision_id, sessionId);
      const current = this.lessonGoal(sessionId);
      const payload = { ...input.payload };
      if (input.kind === "decision" && payload.action === "cram_task_selected") throw new Error("Cram selection annotations require trusted host delivery control");
      if (input.kind === "decision" && (payload.action === "lesson_bound" || payload.action === "review_offer_authorized")) throw new Error("Lesson binding and review authorization require trusted host controls");
      if (input.kind === "decision" && ["review_cancelled", "review_declined", "review_rescheduled"].includes(payload.action as string)) throw new Error("Review queue controls require learner authority");
      const attemptScope = typeof payload.attempt_id === "string" && input.kind !== "attempt_submitted" ? this.findAttempt(payload.attempt_id) : undefined;
      const instanceId = payload.instance_revision_id ?? attemptScope?.payload.instance_revision_id;
      if (typeof instanceId === "string") {
        const instance = this.revision<TaskInstance>(instanceId, "task_instance");
        if (!current || this.revision(instance.body.goal_revision_id, "goal").entity_id !== current.entity_id || (attemptScope && attemptScope.session_id !== sessionId)) throw new Error("Evidence belongs to another lesson");
      }
      if (instanceId && ["attempt_submitted", "step_attempt", "assessment"].includes(input.kind)) {
        const events = this.events().filter(e => e.branch === "real" && e.session_id === sessionId);
        const delivery = events.find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instanceId);
        if (!delivery) throw new Error("Performance requires an owned delivered task");
        if (events.some(e => e.actor === "learner" && e.kind === "decision" && e.seq > delivery.seq && (e.payload.action === "learning_task_skipped" && e.payload.instance_revision_id === instanceId || e.payload.action === "response_review_override" && attemptScope && (e.payload.evidence_event_ids as string[]).includes(attemptScope.event_id)))) throw new Error("Task was explicitly overridden; late performance cannot complete it");
        const responseId = input.kind === "assessment" ? attemptScope?.payload.response_event_id : payload.response_event_id;
        const response = typeof responseId === "string" ? this.event(responseId, "learner_response") : undefined;
        const stop = events.filter(e => e.kind === "checkpoint" && e.payload.stopped === true && e.seq > delivery.seq && (!response || e.seq > response.seq) && this.revision(e.payload.goal_revision_id as string, "goal").entity_id === current?.entity_id).at(-1);
        if (stop) {
          const resume = events.filter(e => e.kind === "checkpoint" && this.revision(e.payload.goal_revision_id as string, "goal").entity_id === current?.entity_id).at(-1);
          const instance = this.revision<TaskInstance>(instanceId as string, "task_instance");
          const round = typeof stop.payload.round_revision_id === "string" ? this.revision<DrillRound>(stop.payload.round_revision_id, "drill_round") : undefined;
          // Only native resume of the same unassessed drill attempt can retain pre-stop work.
          const savedPending = input.kind === "assessment" && !payload.step_attempt_id && current?.body.mode === "drill" && attemptScope && response
            && stop.actor === "learner" && stop.payload.goal_revision_id === current.revision_id && instance.body.goal_revision_id === current.revision_id
            && resume?.actor === "learner" && resume.payload.stopped === false && resume.seq > stop.seq && resume.payload.goal_revision_id === current.revision_id && resume.payload.round_revision_id === round?.revision_id
            && round?.body.goal_revision_id === current.revision_id && round.body.task_instance_ids.includes(instance.revision_id) && events.some(e => e.seq === round.created_seq) && round.created_seq < stop.seq
            && attemptScope.seq < stop.seq && response.seq < attemptScope.seq && response.actor === "learner" && response.branch === "real" && response.session_id === sessionId
            && events.filter(e => e.kind === "task_delivered").at(-1)?.payload.instance_revision_id === instance.revision_id
            && !events.some(e => e.kind === "assessment" && !e.payload.step_attempt_id && e.payload.attempt_id === attemptScope.payload.attempt_id)
            && !events.some(e => e.kind === "learner_response" && e.seq > attemptScope.seq && !["control", "message"].includes(e.payload.input_kind as string));
          if (!savedPending) throw new Error("Work predates the learner's stop; capture current work before assessment");
        }
      }
      let occurred = validTime(input.occurred_at ?? this.now());
      if (input.kind === "attempt_submitted") {
        // SAFETY: RecordSchema validates attempt_submitted fields before host evidence lookup.
        const attempt = payload as unknown as Attempt;
        const instance = this.revision<TaskInstance>(attempt.instance_revision_id, "task_instance");
        if (this.revision(instance.body.goal_revision_id, "goal").entity_id !== this.revision(input.expected_goal_revision_id, "goal").entity_id) throw new Error("Attempt belongs to a different goal");
        const response = this.event<{ text: string }>(attempt.response_event_id, "learner_response");
        const responseScope = response.payload as { text: string; instance_revision_id?: string; input_kind?: string };
        if (response.actor !== "learner" || response.branch !== "real" || ["control", "message"].includes(responseScope.input_kind ?? "")) throw new Error("Attempts require actual real-branch learner work, not AI, hypothetical or control text");
        if (responseScope.instance_revision_id && responseScope.instance_revision_id !== instance.revision_id) throw new Error("Captured response belongs to another task");
        const delivered = this.events().find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === attempt.instance_revision_id);
        if (!delivered || response.seq <= delivered.seq) throw new Error("Response must follow task delivery");
        if (response.session_id !== sessionId) throw new Error("Response belongs to a different conversation");
        if (this.events().some(e => e.kind === "attempt_submitted" && (e.payload.attempt_id === attempt.attempt_id || e.payload.response_event_id === attempt.response_event_id))) throw new Error("Attempt/response was already recorded; do not duplicate evidence");
        payload.response = response.payload.text;
        occurred = response.occurred_at;
      }
      if (input.kind === "step_attempt") {
        const attempt = this.findAttempt(payload.attempt_id as string);
        const response = this.event<{ text: string; input_kind?: string }>(payload.response_event_id as string, "learner_response");
        if (response.actor !== "learner" || response.branch !== "real" || ["control", "message"].includes(response.payload.input_kind ?? "")) throw new Error("Steps require actual real-branch learner work");
        if (response.session_id !== sessionId || attempt.session_id !== sessionId || response.seq < this.event(attempt.payload.response_event_id).seq) throw new Error("Step response must follow its attempt in the same conversation");
        const instance = this.revision<TaskInstance>(attempt.payload.instance_revision_id, "task_instance");
        const task = this.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition").body;
        const scope = response.payload as { instance_revision_id?: string };
        const owner = this.events().find(e => e.kind === "attempt_submitted" && e.payload.response_event_id === response.event_id);
        if ((scope.instance_revision_id && scope.instance_revision_id !== instance.revision_id) || (owner && owner.payload.attempt_id !== attempt.payload.attempt_id)) throw new Error("Step response belongs to another task or attempt");
        if (task.steps.length && !task.steps.includes(payload.step as string) && !payload.spontaneous) throw new Error("Step must match a declared task step or be explicitly spontaneous");
        if (this.events().some(e => e.kind === "step_attempt" && e.payload.response_event_id === response.event_id)) throw new Error("Step response already recorded");
        payload.response = response.payload.text;
        occurred = response.occurred_at;
        for (const id of payload.prior_step_ids as string[]) if (!this.events().some(e => e.kind === "step_attempt" && e.payload.step_attempt_id === id && e.payload.attempt_id === attempt.payload.attempt_id)) throw new Error("Invalid dependent step");
        if (this.events().some(e => e.kind === "step_attempt" && e.payload.step_attempt_id === payload.step_attempt_id)) throw new Error("Step already exists");
      }
      if (input.kind === "assistance") {
        // SAFETY: RecordSchema validates assistance fields before lifecycle/ownership checks.
        const help = payload as unknown as Assistance;
        const instance = this.revision<TaskInstance>(help.instance_revision_id, "task_instance");
        if (this.revision(instance.body.goal_revision_id, "goal").entity_id !== this.revision(input.expected_goal_revision_id, "goal").entity_id) throw new Error("Assistance belongs to another goal");
        if (help.attempt_id && this.findAttempt(help.attempt_id).payload.instance_revision_id !== help.instance_revision_id) throw new Error("Assistance attempt mismatch");
        for (const ref of help.component_revision_ids) this.revision(ref, "component");
        if (help.kind === "reveal" && !help.answer_bearing) throw new Error("A revealed solution is answer-bearing assistance");
        if (help.step_attempt_id && !this.events().some(e => e.kind === "step_attempt" && e.payload.step_attempt_id === help.step_attempt_id && e.payload.attempt_id === help.attempt_id)) throw new Error("Assistance step scope mismatch");
        const stages = this.events().filter(e => e.kind === "assistance" && e.payload.assistance_id === help.assistance_id);
        if (stages.some(e => e.payload.stage === help.stage)) throw new Error("Assistance stage already recorded");
        if (stages.some(e => e.payload.instance_revision_id !== help.instance_revision_id || e.payload.content !== help.content || e.payload.answer_bearing !== help.answer_bearing || e.payload.kind !== help.kind || e.payload.attempt_id !== help.attempt_id || e.payload.step_attempt_id !== help.step_attempt_id || canonical(e.payload.component_revision_ids) !== canonical(help.component_revision_ids))) throw new Error("Assistance lifecycle content/scope cannot change");
      }
      if (input.kind === "assessment") {
        // SAFETY: RecordSchema validates assessment fields; marks and evidence are checked below.
        const assessment = payload as unknown as Assessment;
        const attempt = this.findAttempt(assessment.attempt_id);
        const instance = this.revision<TaskInstance>(attempt.payload.instance_revision_id, "task_instance");
        const task = this.revision<TaskDefinition>(instance.body.definition_revision_id, "task_definition").body;
        if (task.rubric_revision_id !== assessment.rubric_revision_id) throw new Error("Assessment must pin the delivered rubric");
        if (assessment.step_attempt_id && !this.events().some(e => e.kind === "step_attempt" && e.payload.step_attempt_id === assessment.step_attempt_id && e.payload.attempt_id === assessment.attempt_id)) throw new Error("Invalid step assessment");
        const rubric = this.revision<Rubric>(assessment.rubric_revision_id, "rubric").body;
        const step = assessment.step_attempt_id ? this.events().find(e => e.kind === "step_attempt" && e.payload.step_attempt_id === assessment.step_attempt_id) : undefined;
        const scoredText = step ? this.event<{ text: string }>(step.payload.response_event_id as string, "learner_response").payload.text : attempt.payload.response;
        const scoredResponse = this.event(step ? step.payload.response_event_id as string : attempt.payload.response_event_id, "learner_response");
        if (assessment.feedback_review) {
          if (assessment.feedback_review.issues.some(issue => !scoredText.includes(issue.quote))) throw new Error("Feedback issues must quote actual learner response text");
          if (assessment.feedback_review.ready_to_continue && assessment.feedback_review.issues.some(issue => issue.severity === "blocking")) throw new Error("A blocking issue cannot be marked ready to continue");
          if (scoredResponse.payload.image_only && assessment.feedback_review.issues.length) throw new Error("Image-only work needs learner-confirmed text before quoted feedback");
        }
        if (scoredResponse.payload.image_only && (assessment.outcome !== "not_observed" || assessment.scores.length || assessment.claims?.length || assessment.component_outcomes?.some(c => c.outcome !== "not_observed"))) throw new Error("Image-only work needs learner-confirmed text before scoring; visual receipt metadata is not performance evidence");
        const componentOutcomes = assessment.component_outcomes ?? [];
        if (new Set(componentOutcomes.map(c => c.component_revision_id)).size !== componentOutcomes.length || componentOutcomes.some(c => !task.component_revision_ids.includes(c.component_revision_id))) throw new Error("Component outcomes must be unique and targeted by the task");
        const claims = assessment.claims ?? [];
        if (new Set(claims.map(c => `${c.component_revision_id}:${c.dimension}`)).size !== claims.length) throw new Error("Duplicate component dimension claim");
        for (const claim of claims) {
          if (!task.component_revision_ids.includes(claim.component_revision_id) || !scoredText.includes(claim.evidence)) throw new Error("Dimension claim requires a targeted component and actual response quote");
          if (task.scoring !== "rubric" && claim.dimension !== "execution") throw new Error("Objective answer matching cannot establish explanation, discrimination or fluency");
        }
        for (const score of assessment.scores) {
          const dim = rubric.dimensions.find(d => d.name === score.dimension);
          if (!dim || score.score > dim.max_score) throw new Error("Score does not match rubric bounds");
          if (task.scoring === "rubric" && !scoredText.includes(score.evidence)) throw new Error("Rubric evidence must quote an actual span of the learner response");
        }
        if (new Set(assessment.scores.map(s => s.dimension)).size !== assessment.scores.length) throw new Error("Duplicate scoring dimension");
        if (task.scoring === "rubric" && assessment.outcome === "success" && assessment.scores.length !== rubric.dimensions.length) throw new Error("A successful holistic assessment requires evidence for every rubric dimension");
        const previous = this.events().filter(e => e.kind === "assessment" && e.payload.attempt_id === assessment.attempt_id && e.payload.step_attempt_id === assessment.step_attempt_id).at(-1);
        if (previous && assessment.correction_of_event_id !== previous.event_id) throw new Error("Re-scoring requires a correction of the latest assessment");
        if (assessment.correction_of_event_id && previous?.event_id !== assessment.correction_of_event_id) throw new Error("Correction must target the latest assessment for the same whole response or step");
        if (assessment.correction_of_event_id && this.event(assessment.correction_of_event_id, "assessment").payload.attempt_id !== assessment.attempt_id) throw new Error("Correction must refer to the same attempt");
        if (!assessment.step_attempt_id && task.scoring !== "rubric" && !scoredResponse.payload.image_only) {
          const captured = this.event<{ text: string; selected_choice_id?: string }>(attempt.payload.response_event_id, "learner_response");
          const response = task.format === "mcq" ? captured.payload.selected_choice_id ?? captured.payload.text.trim() : attempt.payload.response.trim();
          const success = task.scoring === "numeric" ? response !== "" && Number.isFinite(Number(response)) && Math.abs(Number(response) - Number(task.answer)) <= (task.tolerance ?? 0) : response.toLocaleLowerCase() === task.answer?.trim().toLocaleLowerCase();
          // Only named answer/execution criteria are observable from a bare answer match.
          // Other criteria remain unobserved, even if a proposed grade requests full marks.
          const observable = new Set(["answer", "result", "correctness", "execution", "target"]);
          const unobserved = rubric.dimensions.filter(d => !observable.has(d.name.toLocaleLowerCase()));
          payload.outcome = success ? (unobserved.length ? "partial" : "success") : "failure";
          payload.assessor = "deterministic";
          payload.scores = rubric.dimensions.map(d => ({ dimension: d.name, score: success && observable.has(d.name.toLocaleLowerCase()) ? d.max_score : 0, evidence: response }));
          payload.uncertainty = "Objective response match only; reasoning is not established by this score.";
          if (assessment.component_outcomes) payload.component_outcomes = componentOutcomes.map(c => ({ ...c, outcome: c.outcome === "not_observed" || task.component_revision_ids.length !== 1 ? "not_observed" : payload.outcome }));
          if (assessment.claims) payload.claims = claims.map(c => ({ ...c, outcome: c.outcome === "not_observed" || task.component_revision_ids.length !== 1 ? "not_observed" : payload.outcome }));
        } else payload.assessor = scoredResponse.payload.image_only ? "image_receipt_only" : "pi_rubric_proposal";
        // SAFETY: RecordSchema validates proposed scores; deterministic replacements use the same shape.
        const finalScores = payload.scores as Assessment["scores"];
        const objectiveNames = new Set(["answer", "result", "correctness", "execution", "target"]);
        const earned = finalScores.reduce((total, mark) => total + mark.score, 0);
        const maximum = rubric.dimensions.reduce((total, dimension) => total + dimension.max_score, 0);
        payload.marking_summary = {
          earned, maximum, percentage: maximum > 0 ? Math.round(earned / maximum * 10000) / 100 : null,
          unobserved_dimensions: rubric.dimensions.filter(d => !finalScores.some(s => s.dimension === d.name) || (payload.assessor === "deterministic" && !objectiveNames.has(d.name.toLocaleLowerCase()))).map(d => d.name),
          authority: payload.assessor,
        };
      }
      if (input.kind === "review_scheduled") {
        if (!current) throw new Error("Select a lesson before authorizing reviews");
        payload.due_at = validTime(payload.due_at as string);
        if (Date.parse(payload.due_at as string) <= Date.parse(this.now())) throw new Error("Offer a future review date; do not backdate consent");
        assertReviewAuthorization(this, payload, sessionId, current, occurred);
        if (this.events().some(e => e.kind === "review_scheduled" && e.payload.authorization_event_id === payload.authorization_event_id)) throw new Error("Review authorization receipt was already used");
        payload.policy_version = POLICY_VERSION;
      }
      if (input.kind === "checkpoint") {
        if (payload.goal_revision_id !== input.expected_goal_revision_id) throw new Error("Checkpoint goal mismatch");
      }
      if (input.kind === "decision") {
        payload.policy_version ??= POLICY_VERSION;
        payload.reason_codes ??= ["explicit_tutor_reason"];
        payload.uncertainty ??= "unknown";
        for (const ref of payload.evidence_event_ids as string[]) this.event(ref);
        for (const ref of (payload.target_component_revision_ids as string[] | undefined) ?? []) this.revision(ref, "component");
        if (payload.selected_candidate_id && !(payload.candidate_ids as string[] | undefined)?.includes(payload.selected_candidate_id as string)) throw new Error("Selected candidate must appear among considered candidates");
        if (payload.model_call_id && !this.db.query("SELECT 1 FROM model_call_log WHERE call_id=? AND phase='started'").get(payload.model_call_id as string)) throw new Error("Decision model call association was not observed");
      }
      if (input.kind === "review_completed") {
        if (!current) throw new Error("Select a lesson before completing reviews");
        assertReviewCompletion(this, payload.schedule_event_id as string, payload.assessment_event_id as string, sessionId, current, occurred);
      }
      const event = this.append(input.kind, { ...payload, disclosure_scope: { goal_revision_id: current?.revision_id, source_ids: current?.body.source_ids ?? [] } }, input.operation_id, "pi", sessionId, occurred, input);
      if (input.kind === "assessment") {
        const attempt = this.findAttempt(payload.attempt_id as string);
        const instance = this.revision<TaskInstance>(attempt.payload.instance_revision_id).body;
        const task = this.revision<TaskDefinition>(instance.definition_revision_id).body;
        this.append("assistance", { assistance_id: `feedback:${event.event_id}`, instance_revision_id: attempt.payload.instance_revision_id, attempt_id: attempt.payload.attempt_id, component_revision_ids: task.component_revision_ids, stage: "possibly_exposed", kind: "feedback", content: payload.feedback, answer_bearing: true }, `feedback:${input.operation_id}`, "host", sessionId);
      }
      this.rebuild();
      return event;
    })();
  }
  findAttempt(attemptId: string): LearningEvent<Attempt & { response: string }> {
    const e = this.events().find(e => e.kind === "attempt_submitted" && e.payload.attempt_id === attemptId);
    if (!e) throw new Error(`Missing attempt: ${attemptId}`);
    // SAFETY: record() validates AttemptSchema and copies response from the captured learner event.
    return e as unknown as LearningEvent<Attempt & { response: string }>;
  }
  learnerResponse(text: string, sessionId: string, operationId: string = randomUUID(), metadata: SubmissionMetadata = {}): LearningEvent {
    if (!text.trim() || text.length > 24000) throw new Error("Response must contain 1–24000 characters");
    const existing = this.events().find(e => e.operation_id === operationId);
    if (existing && (existing.session_id !== sessionId || existing.actor !== "learner" || existing.kind !== "learner_response")) throw new Error("Response operation ID belongs to a different conversation");
    return this.append("learner_response", { text, ...metadata }, operationId, "learner", sessionId);
  }
  logCall(input: unknown): void {
    validate<CallEntry>(CallSchema, input);
    if (input.phase !== "started" && !this.db.query("SELECT 1 FROM model_call_log WHERE call_id=? AND phase='started'").get(input.call_id)) throw new Error("Call has no observed request start");
    this.db.query("INSERT OR IGNORE INTO model_call_log(call_id,phase,recorded_at,body) VALUES(?,?,?,?)").run(input.call_id, input.phase, this.now(), canonical(input));
  }
  rebuild(asOfTime = this.events().at(-1)?.recorded_at ?? "1970-01-01T00:00:00.000Z"): void {
    const projection = projectComponents(this, this.throughSeq, validTime(asOfTime));
    this.db.query("INSERT INTO projection(key,through_seq,as_of_time,version,body) VALUES('components',?,?,?,?) ON CONFLICT(key) DO UPDATE SET through_seq=excluded.through_seq,as_of_time=excluded.as_of_time,version=excluded.version,body=excluded.body").run(this.throughSeq, asOfTime, PROJECTOR_VERSION, canonical(projection));
  }
  integrity(): string[] { return this.db.query("PRAGMA integrity_check").all().map(row => String((row as Record<string, unknown>).integrity_check)); }
  close(): void { this.db.close(); }
}
