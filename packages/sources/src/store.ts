// Learner sources (SPEC §16, v3 pipeline semantics): content-addressed, immutable revisions in object_revision, line/page/time
// spans in source_span, needs_review → accepted, removal blocks future use, and nothing reaches a model without the learner's
// sharing consent. Excerpts are untrusted data wherever they are shown to a model. Lexical search only (owner M6: FTS5, no embeddings).
import { randomUUID } from "node:crypto";
import type { Ledger } from "../../storage/src/ledger.ts";
import { canonical, hash } from "../../storage/src/ledger.ts";
import { transcriptLink } from "./transcript.ts";

export type SourceKind = "pdf" | "docx" | "pptx" | "image" | "captions" | "text" | "note";
export type SourceStatus = "needs_review" | "accepted" | "removed";
export interface SourceRecord {
  sourceId: string; revisionId: string; title: string; kind: SourceKind; status: SourceStatus; method: string; contentHash: string;
  /** Consent to send excerpts of this source to model providers (planner/generator). Required to use it in a session. */
  shareWithModels: boolean; url?: string; examSample?: boolean; warnings: string[]; spans: number; createdAt: string;
}
export interface Excerpt { spanId: string; sourceId: string; title: string; locator: string; text: string; link?: string }
export interface Part { locator: string; text: string }

const SPAN_CHARS = 900;
/** Parts → spans of ≤ ~900 chars, split at line breaks; each keeps its part's locator. */
export function toSpans(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    let cur = "";
    for (const line of p.text.replace(/\r\n?/g, "\n").split("\n")) {
      if (cur && cur.length + line.length + 1 > SPAN_CHARS) { out.push({ locator: p.locator, text: cur.trim() }); cur = ""; }
      cur += (cur ? "\n" : "") + line.slice(0, SPAN_CHARS * 2);
    }
    if (cur.trim()) out.push({ locator: p.locator, text: cur.trim() });
  }
  return out;
}

export class SourceStore {
  constructor(private ledger: Ledger, private now: () => string = () => new Date().toISOString()) {
    // Derived, rebuildable lexical index (not part of the immutable record; SCHEMA_VERSION unchanged).
    ledger.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(span_id UNINDEXED, source_id UNINDEXED, text, tokenize='porter unicode61')");
  }

  private revise(sourceId: string, body: Omit<SourceRecord, "revisionId" | "sourceId">, parent?: string): SourceRecord {
    const revisionId = randomUUID(), b = { sourceId, ...body };
    this.ledger.db.query("INSERT INTO object_revision(revision_id,entity_id,kind,parent_revision_id,body,content_hash,created_at,created_seq,operation_id,command_hash) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(revisionId, sourceId, "v4.source", parent ?? null, canonical(b), body.contentHash, this.now(), this.ledger.throughSeq, randomUUID(), hash(canonical(b)));
    return { ...b, revisionId };
  }

  /** Admits extracted parts as a new source awaiting review. The same content twice returns the existing source (unless it was removed). */
  add(input: { title: string; kind: SourceKind; method: string; parts: Part[]; contentHash: string; url?: string; examSample?: boolean; warnings?: string[] }): SourceRecord {
    const sourceId = `src_${input.contentHash.slice(0, 16)}`, prev = this.get(sourceId);
    if (prev && prev.status !== "removed") return prev;
    const spans = toSpans(input.parts);
    if (!spans.length) throw new Error("no text could be extracted from this source");
    const rec = this.revise(sourceId, { title: input.title.slice(0, 200) || "Untitled source", kind: input.kind, status: "needs_review", method: input.method, contentHash: input.contentHash,
      shareWithModels: false, ...(input.url ? { url: input.url } : {}), ...(input.examSample ? { examSample: true } : {}), warnings: input.warnings ?? [], spans: spans.length, createdAt: this.now() }, prev?.revisionId);
    const ins = this.ledger.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)");
    const fts = this.ledger.db.query("INSERT INTO source_fts(span_id,source_id,text) VALUES(?,?,?)");
    this.ledger.db.transaction(() => spans.forEach((s, i) => { const id = `${sourceId}:${rec.revisionId.slice(0, 8)}:${i + 1}`; ins.run(id, rec.revisionId, i + 1, s.locator, s.text, input.method, 1); fts.run(id, sourceId, s.text); }))();
    return rec;
  }

  get(sourceId: string): SourceRecord | undefined {
    const row = this.ledger.db.query<{ revision_id: string; body: string }, [string]>("SELECT revision_id, body FROM object_revision WHERE entity_id=? AND kind='v4.source' ORDER BY created_seq DESC, rowid DESC LIMIT 1").get(sourceId);
    return row ? { ...JSON.parse(row.body), revisionId: row.revision_id } : undefined;
  }
  list(): SourceRecord[] {
    const ids = this.ledger.db.query<{ entity_id: string }, []>("SELECT DISTINCT entity_id FROM object_revision WHERE kind='v4.source' ORDER BY rowid").all();
    return ids.map(r => this.get(r.entity_id)!).filter(Boolean);
  }
  /** The spans of a source's current content (the revision that admitted them). */
  spans(sourceId: string): Excerpt[] {
    const rec = this.get(sourceId);
    if (!rec) throw new Error(`unknown source ${sourceId}`);
    return this.ledger.db.query<{ span_id: string; locator: string; text: string }, [string, string]>(
      "SELECT s.span_id, s.locator, s.text FROM source_span s JOIN object_revision r ON r.revision_id = s.source_revision_id WHERE r.entity_id=? AND r.revision_id = (SELECT s2.source_revision_id FROM source_span s2 JOIN object_revision r2 ON r2.revision_id = s2.source_revision_id WHERE r2.entity_id=? ORDER BY r2.created_seq DESC, r2.rowid DESC LIMIT 1) ORDER BY s.ordinal")
      .all(sourceId, sourceId).map(r => { const link = transcriptLink(rec.url, r.locator); return { spanId: r.span_id, sourceId, title: rec.title, locator: r.locator, text: r.text, ...(link ? { link } : {}) }; });
  }

  /** Citations for span ids an item cited (title, locator, link to the moment for videos). Unknown or removed sources are skipped. */
  cite(spanIds: string[]): { spanId: string; title: string; locator: string; link?: string }[] {
    const ids = new Set(spanIds), bySource = new Set(spanIds.map(id => id.split(":")[0]!));
    return [...bySource].flatMap(sid => { const r = this.get(sid); return r && r.status !== "removed" ? this.spans(sid) : []; })
      .filter(e => ids.has(e.spanId)).map(({ spanId, title, locator, link }) => ({ spanId, title, locator, ...(link ? { link } : {}) }));
  }

  /** The learner accepts the source; `shareWithModels` is their consent for excerpts to be sent to the model providers. */
  accept(sourceId: string, shareWithModels: boolean): SourceRecord {
    const rec = this.get(sourceId) ?? (() => { throw new Error(`unknown source ${sourceId}`); })();
    if (rec.status === "removed") throw new Error("this source was removed; add it again to review it");
    const { revisionId, sourceId: _, ...body } = rec;
    return this.revise(sourceId, { ...body, status: "accepted", shareWithModels }, revisionId);
  }
  remove(sourceId: string): SourceRecord {
    const rec = this.get(sourceId) ?? (() => { throw new Error(`unknown source ${sourceId}`); })();
    const { revisionId, sourceId: _, ...body } = rec;
    return this.revise(sourceId, { ...body, status: "removed", shareWithModels: false }, revisionId);
  }

  /** Sources a model may see: accepted, consented, not removed. */
  usable(ids: string[]): SourceRecord[] { return [...new Set(ids)].map(id => this.get(id)).filter((r): r is SourceRecord => !!r && r.status === "accepted" && r.shareWithModels); }

  /** Best-matching spans from usable sources for a query (FTS5 BM25), falling back to each source's opening spans. */
  excerpts(ids: string[], query: string, k = 8): Excerpt[] {
    const ok = this.usable(ids);
    if (!ok.length) return [];
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
    const allowed = new Set(ok.map(r => r.sourceId)), spans = new Map(ok.flatMap(r => this.spans(r.sourceId)).map(e => [e.spanId, e]));
    let hits: string[] = [];
    if (terms.length) hits = this.ledger.db.query<{ span_id: string; source_id: string }, [string]>("SELECT span_id, source_id FROM source_fts WHERE source_fts MATCH ? ORDER BY bm25(source_fts) LIMIT 200")
      .all(terms.map(t => `"${t}"`).join(" OR ")).filter(r => allowed.has(r.source_id) && spans.has(r.span_id)).map(r => r.span_id);
    const pick = [...new Set([...hits, ...ok.flatMap(r => this.spans(r.sourceId).slice(0, 2).map(e => e.spanId))])].slice(0, k);
    return pick.map(id => spans.get(id)!);
  }

  /** Short outline for the planner: titles and the opening of each usable source. */
  outline(ids: string[], chars = 2400): string {
    return this.usable(ids).map(r => `${r.title} (${r.kind}${r.examSample ? ", past exam" : ""}):\n${this.spans(r.sourceId).slice(0, 3).map(e => `[${e.locator}] ${e.text}`).join("\n").slice(0, Math.floor(chars / Math.max(1, ids.length)))}`).join("\n\n");
  }
}
