import { randomUUID } from "node:crypto";
import fs, { mkdir, open, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { Revision } from "../../core/src/contracts.ts";
import { hash, type LearningStore } from "../../storage/src/store.ts";
import { extractPdfTextBounded } from "./pdf.ts";
import { extractOfficeTextBounded } from "./office.ts";
import { extractRasterText } from "./raster.ts";
import type { SubmittedImage } from "../../core/src/interactions.ts";
import { parseCaptions, fetchCaptionsFromUrl, type CaptionFetchOptions } from "./captions.ts";
import { SOURCE_FILE_BYTES, SOURCE_FILE_CEILING, SourceSizeError, type ConfirmLargeSource } from "./limits.ts";

export interface SourceBody { title: string; original_hash: string; mime: string; rights: "unknown" | "owned" | "licensed"; purpose: string; local_private_only: true; extraction: string }
export const sourceFileExtensions = [".txt", ".md", ".csv", ".tsv", ".json", ".pdf", ".vtt", ".srt", ".docx", ".pptx", ".png", ".jpg", ".jpeg"];
export interface SourceFolder { directory: string; files: Array<{ name: string; path: string; size: number }>; skipped: number }

function sourceImportError(error: unknown, kind: "pdf" | "captions"): Error {
  const next = kind === "pdf"
    ? "Retry a supported text PDF or use source add PATH with an authorized manual UTF-8 .txt/.md source. OCR is not performed; separately verify and review any OCR text before import."
    : "Retry an authorized direct UTF-8 .vtt/.srt URL or use source add PATH with an authorized local .vtt/.srt or manual .txt/.md source. Automatic caption discovery and OCR are not performed.";
  return new Error(`${error instanceof Error ? error.message : String(error)}. ${next} Access restrictions are not bypassed.`, { cause: error });
}

function parseSourceCaptions(text: string, format: "vtt" | "srt") {
  try { return parseCaptions(text, format); }
  catch (error) { throw sourceImportError(error, "captions"); }
}

export class SourceService {
  constructor(readonly store: LearningStore, readonly blobRoot: string) {}
  private admittedOriginal(contentHash: string) {
    const source = this.store.revisions("source").find(r => r.body.original_hash === contentHash && this.store.sourceStatus(r.revision_id) !== "removed");
    if (source) return { ...this.store.revision<SourceBody>(source.revision_id), status: this.store.sourceStatus(source.revision_id), duplicate: true };
  }
  /** Explicit native directory selection: metadata only, no recursion or admission. */
  async listFolder(directory: string): Promise<SourceFolder> {
    const root = await fs.realpath(resolve(directory));
    const files: SourceFolder["files"] = [];
    let visited = 0;
    const folder = await fs.opendir(root);
    for await (const entry of folder) {
      if (++visited > 500) throw new Error("Source folder contains more than 500 entries; choose a smaller folder");
      if (!entry.isFile() || entry.name.startsWith(".") || !sourceFileExtensions.includes(extname(entry.name).toLowerCase())) continue;
      const path = join(root, entry.name), info = await fs.lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1) continue;
      files.push({ name: entry.name, path, size: info.size });
    }
    return { directory: root, files: files.sort((a, b) => a.name.localeCompare(b.name)), skipped: visited - files.length };
  }
  async importFile(filename: string, purpose = "reference", rights: SourceBody["rights"] = "unknown", signal?: AbortSignal, extraction: "default" | "local_ocr" = "default", confirmLarge?: ConfirmLargeSource): Promise<Revision<SourceBody> & { status: string; duplicate: boolean }> {
    if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
    const path = resolve(filename);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error("Source must be a nonempty regular file");
    if (info.size > SOURCE_FILE_CEILING) throw new SourceSizeError("Source exceeds the 200 MiB safety ceiling; split it or choose a smaller copy");
    const extension = extname(path).toLowerCase();
    if (!sourceFileExtensions.includes(extension)) throw new Error("Supported sources: UTF-8 .txt, .md, .csv, .tsv, .json, text .pdf, .vtt, .srt, local text extraction from .docx/.pptx, and local OCR of .png/.jpg/.jpeg (4 MiB). Use source ocr PATH for scanned PDFs. Audio and legacy .doc/.ppt need a verified adapter or conversion; no partial import was saved.");
    if (extraction === "local_ocr" && ![".pdf", ".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("Local OCR supports PDF, PNG and JPEG sources only");
    if (!["unknown", "owned", "licensed"].includes(rights)) throw new Error("Rights must be unknown, owned or licensed");
    if ([".png", ".jpg", ".jpeg"].includes(extension) && info.size > 4 * 1024 * 1024) throw new SourceSizeError("Image originals retain a separate 4 MiB limit; resize or export a smaller copy");
    if (info.size > SOURCE_FILE_BYTES) {
      if (!confirmLarge) throw new SourceSizeError("Source exceeds 50 MiB; decide whether to import this file in the native source dialog, or retry this CLI source add/ocr with --allow-large (maximum 200 MiB)");
      const approved = await confirmLarge({ path, size: info.size });
      if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
      if (approved !== true) throw new SourceSizeError("Large source import declined; no source admitted");
    }
    const unchanged = (current: typeof info) => current.dev === info.dev && current.ino === info.ino && current.size === info.size && current.mtimeMs === info.mtimeMs && current.ctimeMs === info.ctimeMs;
    const file = await open(path, "r");
    let original: Buffer;
    try {
      if (!unchanged(await file.stat())) throw new SourceSizeError("Source file changed while deciding; select it again");
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) {
        if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      if (length !== info.size || !unchanged(await file.stat())) throw new SourceSizeError("Source file changed during import; select it again");
      original = bytes.subarray(0, length);
    } finally { await file.close(); }
    if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
    const contentHash = hash(original);
    const duplicate = this.admittedOriginal(contentHash);
    if (duplicate) return duplicate;
    await mkdir(this.blobRoot, { recursive: true });
    await fs.writeFile(join(this.blobRoot, contentHash), original, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
    // Recheck after the last await: file and URL retries share original identity.
    const afterBlob = this.admittedOriginal(contentHash);
    if (afterBlob) return afterBlob;
    const revisionId = randomUUID();

    if (extension === ".pdf" && extraction === "default") {
      const pdf = await extractPdfTextBounded(original, { signal, maxInputBytes: info.size }).catch(error => { throw sourceImportError(error, "pdf"); });
      if (signal?.aborted) throw new Error("PDF import cancelled; no revision admitted");
      // Decoding yields: another import may have admitted this same original.
      const admitted = this.admittedOriginal(contentHash);
      if (admitted) return admitted;
      const body: SourceBody = { title: basename(path), original_hash: contentHash, mime: "application/pdf", rights, purpose, local_private_only: true, extraction: "pdf-pages-v1" };
      this.store.db.transaction(() => {
        this.store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(contentHash, body.mime, original.length, "source_original", this.store.now());
        const receipt = this.store.append("source_status", { source_revision_id: revisionId, status: "received" }, `source:${revisionId}:received`, "learner", "sources");
        this.store.insertRevision(revisionId, randomUUID(), "source", null, { ...body }, receipt.seq, `source:${revisionId}`, body);
        this.store.append("source_status", { source_revision_id: revisionId, status: "extracting" }, `source:${revisionId}:extracting`, "host", "sources");
        let ordinal = 0;
        for (const page of pdf.pages) {
          this.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${revisionId}:${ordinal++}`, revisionId, ordinal - 1, `page ${page.pageNumber}`, page.text, "pdf-pages-v1", 0.95);
        }
        this.store.append("source_status", { source_revision_id: revisionId, status: "needs_review", reason: "Review extracted text before using it to author or score tasks" }, `source:${revisionId}:review`, "host", "sources");
        this.store.rebuild();
      })();
      return { ...this.store.revision<SourceBody>(revisionId), status: "needs_review", duplicate: false };
    }

    if (extension === ".docx" || extension === ".pptx" || [".png", ".jpg", ".jpeg"].includes(extension) || extraction === "local_ocr") {
      const decoded = extension === ".docx" || extension === ".pptx"
        ? await extractOfficeTextBounded(original, extension === ".docx" ? "docx" : "pptx", { signal, maxInputBytes: info.size })
        : await extractRasterText(original, extension === ".pdf" ? "application/pdf" : extension === ".png" ? "image/png" : "image/jpeg", signal, info.size);
      if (signal?.aborted) throw new Error("Source import cancelled; no revision admitted");
      const admitted = this.admittedOriginal(contentHash);
      if (admitted) return admitted;
      const body: SourceBody = { title: basename(path), original_hash: contentHash, mime: decoded.mime, rights, purpose, local_private_only: true, extraction: decoded.method };
      this.store.db.transaction(() => {
        this.store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(contentHash, body.mime, original.length, "source_original", this.store.now());
        const receipt = this.store.append("source_status", { source_revision_id: revisionId, status: "received" }, `source:${revisionId}:received`, "learner", "sources");
        this.store.insertRevision(revisionId, randomUUID(), "source", null, { ...body }, receipt.seq, `source:${revisionId}`, body);
        this.store.append("source_status", { source_revision_id: revisionId, status: "extracting" }, `source:${revisionId}:extracting`, "host", "sources");
        let ordinal = 0;
        for (const part of decoded.parts) {
          for (let offset = 0; offset < part.text.length; offset += 3500) {
            const locator = part.text.length <= 3500 ? part.locator : `${part.locator}, text chunk ${Math.floor(offset / 3500) + 1}`;
            this.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${revisionId}:${ordinal}`, revisionId, ordinal++, locator, part.text.slice(offset, offset + 3500), decoded.method, decoded.method === "local-ocr-v1" ? 0 : 0.95);
          }
        }
        this.store.append("source_status", { source_revision_id: revisionId, status: "needs_review", reason: decoded.method === "local-ocr-v1" ? "OCR is an unverified transcription, not factual validation; compare the original. Image originals require separate lesson/provider-sharing consent." : "Review extracted body/slide text before use; pictures, charts, notes and layout were not interpreted" }, `source:${revisionId}:review`, "host", "sources");
        this.store.rebuild();
      })();
      return { ...this.store.revision<SourceBody>(revisionId), status: "needs_review", duplicate: false };
    }

    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(original); } catch { throw new Error("Source must be valid UTF-8 text"); }
    if (text.includes("\0")) throw new Error("Binary content is not a text source");

    if (extension === ".vtt" || extension === ".srt") {
      const caps = parseSourceCaptions(text, extension === ".vtt" ? "vtt" : "srt");
      const mime = extension === ".vtt" ? "text/vtt" : "application/x-subrip";
      const body: SourceBody = { title: basename(path), original_hash: contentHash, mime, rights, purpose, local_private_only: true, extraction: "captions-cues-v1" };
      this.store.db.transaction(() => {
        this.store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(contentHash, body.mime, original.length, "source_original", this.store.now());
        const receipt = this.store.append("source_status", { source_revision_id: revisionId, status: "received" }, `source:${revisionId}:received`, "learner", "sources");
        this.store.insertRevision(revisionId, randomUUID(), "source", null, { ...body }, receipt.seq, `source:${revisionId}`, body);
        this.store.append("source_status", { source_revision_id: revisionId, status: "extracting" }, `source:${revisionId}:extracting`, "host", "sources");
        let ordinal = 0;
        for (const cue of caps.cues) {
          this.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${revisionId}:${ordinal++}`, revisionId, ordinal - 1, cue.locator, cue.text, "captions-cues-v1", 0.98);
        }
        this.store.append("source_status", { source_revision_id: revisionId, status: "needs_review", reason: "Review extracted text before using it to author or score tasks" }, `source:${revisionId}:review`, "host", "sources");
        this.store.rebuild();
      })();
      return { ...this.store.revision<SourceBody>(revisionId), status: "needs_review", duplicate: false };
    }

    const body: SourceBody = { title: basename(path), original_hash: contentHash, mime: "text/plain; charset=utf-8", rights, purpose, local_private_only: true, extraction: "utf8-lines-v1" };
    this.store.db.transaction(() => {
      this.store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(contentHash, body.mime, original.length, "source_original", this.store.now());
      const receipt = this.store.append("source_status", { source_revision_id: revisionId, status: "received" }, `source:${revisionId}:received`, "learner", "sources");
      this.store.insertRevision(revisionId, randomUUID(), "source", null, { ...body }, receipt.seq, `source:${revisionId}`, body);
      this.store.append("source_status", { source_revision_id: revisionId, status: "extracting" }, `source:${revisionId}:extracting`, "host", "sources");
      const lines = text.split(/\r?\n/);
      let chunk = "", firstLine = 1, ordinal = 0;
      const save = (lastLine: number) => {
        if (!chunk.trim()) return;
        this.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${revisionId}:${ordinal++}`, revisionId, ordinal - 1, `lines ${firstLine}–${lastLine}`, chunk, "utf8-lines-v1", 1);
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (chunk.length + line.length > 3500 && chunk) { save(i); chunk = ""; firstLine = i + 1; }
        // Very long lines are bounded too; no source span bypasses the context budget.
        for (let offset = 0; offset < line.length || offset === 0; offset += 3500) {
          const part = line.slice(offset, offset + 3500);
          if (part.length + chunk.length > 3500 && chunk) { save(i + 1); chunk = ""; firstLine = i + 1; }
          chunk += part + "\n";
        }
      }
      save(lines.length);
      this.store.append("source_status", { source_revision_id: revisionId, status: "needs_review", reason: "Review extracted text before using it to author or score tasks" }, `source:${revisionId}:review`, "host", "sources");
      this.store.rebuild();
    })();
    return { ...this.store.revision<SourceBody>(revisionId), status: "needs_review", duplicate: false };
  }
  async importCaptionsUrl(url: string, purpose = "reference", rights: SourceBody["rights"] = "unknown", options: CaptionFetchOptions = {}) {
    if (!["unknown", "owned", "licensed"].includes(rights)) throw new Error("Rights must be unknown, owned or licensed");
    const fetched = await fetchCaptionsFromUrl(url, options).catch(error => { throw sourceImportError(error, "captions"); });
    if (options.signal?.aborted) throw new Error("Caption import cancelled; no revision admitted");
    const content = fetched.original;
    const contentHash = hash(content);
    const duplicate = this.admittedOriginal(contentHash);
    if (duplicate) return duplicate;
    await mkdir(this.blobRoot, { recursive: true });
    await fs.writeFile(join(this.blobRoot, contentHash), content, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (options.signal?.aborted) throw new Error("Caption import cancelled; no revision admitted");
    const afterBlob = this.admittedOriginal(contentHash);
    if (afterBlob) return afterBlob;
    const revisionId = randomUUID();
    const caps = parseSourceCaptions(fetched.text, fetched.format);
    const mime = fetched.format === "vtt" ? "text/vtt" : "application/x-subrip";
    let title: string;
    try { title = basename(new URL(url).pathname) || "captions"; }
    catch (error) { throw sourceImportError(error, "captions"); }
    const body: SourceBody = { title, original_hash: contentHash, mime, rights, purpose, local_private_only: true, extraction: "captions-cues-v1" };
    this.store.db.transaction(() => {
      this.store.db.query("INSERT OR IGNORE INTO blob_manifest(hash,mime,size,role,created_at) VALUES(?,?,?,?,?)").run(contentHash, body.mime, content.length, "source_original", this.store.now());
      const receipt = this.store.append("source_status", { source_revision_id: revisionId, status: "received" }, `source:${revisionId}:received`, "learner", "sources");
      this.store.insertRevision(revisionId, randomUUID(), "source", null, { ...body }, receipt.seq, `source:${revisionId}`, body);
      let ordinal = 0;
      for (const cue of caps.cues) {
        this.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${revisionId}:${ordinal++}`, revisionId, ordinal - 1, cue.locator, cue.text, "captions-cues-v1", 0.98);
      }
      this.store.append("source_status", { source_revision_id: revisionId, status: "needs_review", reason: "Review extracted caption text before use" }, `source:${revisionId}:review`, "host", "sources");
      this.store.rebuild();
    })();
    return { ...this.store.revision<SourceBody>(revisionId), status: "needs_review", duplicate: false };
  }
  /** Trusted transport reads only explicitly selected, accepted, integrity-checked originals. */
  async originalImages(selected: string[]): Promise<SubmittedImage[]> {
    const images: SubmittedImage[] = []; let total = 0;
    for (const id of new Set(selected)) {
      const source = this.store.revision<SourceBody>(id, "source");
      if (source.body.mime !== "image/png" && source.body.mime !== "image/jpeg") continue;
      if (this.store.sourceStatus(id) !== "indexed") throw new Error("Source image must still be accepted before sharing");
      if (images.length >= 4) throw new Error("Select at most four original source images per lesson");
      if (!/^[a-f0-9]{64}$/.test(source.body.original_hash)) throw new Error("Source image integrity check failed");
      const path = join(this.blobRoot, source.body.original_hash), info = await fs.lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 4 * 1024 * 1024) throw new Error("Source image integrity or 4 MiB bound failed");
      const file = await open(path, "r"), bytes = Buffer.alloc(4 * 1024 * 1024 + 1); let length = 0;
      try { while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; } }
      finally { await file.close(); }
      const original = bytes.subarray(0, length); total += length;
      if (!length || length > 4 * 1024 * 1024 || hash(original) !== source.body.original_hash) throw new Error("Source image integrity check failed");
      if (total > 8 * 1024 * 1024) throw new Error("Selected source image originals exceed the 8 MiB lesson bound");
      images.push({ type: "image", data: original.toString("base64"), mimeType: source.body.mime });
    }
    return images;
  }
  list(): Array<Record<string, unknown>> {
    return this.store.revisions("source").map(r => ({ source_id: r.revision_id, ...r.body, original_size_bytes: this.store.db.query<{ size: number }, [string]>("SELECT size FROM blob_manifest WHERE hash=?").get(String(r.body.original_hash))?.size ?? 0, status: this.store.sourceStatus(r.revision_id), spans: (this.store.db.query("SELECT count(*) AS count FROM source_span WHERE source_revision_id=?").get(r.revision_id) as { count: number }).count }));
  }
  preview(sourceId: string): Array<{ span_id: string; locator: string; text: string }> {
    this.store.revision(sourceId, "source");
    return this.store.db.query<{ span_id: string; locator: string; text: string }, [string]>("SELECT span_id,locator,text FROM source_span WHERE source_revision_id=? ORDER BY ordinal LIMIT 12").all(sourceId);
  }
  accept(sourceId: string): void {
    this.store.revision(sourceId, "source");
    if (this.store.sourceStatus(sourceId) === "removed") throw new Error("Removed source cannot be accepted");
    if (!this.preview(sourceId).length) throw new Error("No extracted text to accept");
    this.store.append("source_accepted", { source_revision_id: sourceId, status: "indexed", reason: "Learner accepted the extraction; factual accuracy and answer keys remain task-specific" }, `accept:${sourceId}`, "learner", "sources");
  }
  remove(sourceId: string): void {
    this.store.revision(sourceId, "source");
    this.store.append("source_removed", { source_revision_id: sourceId, status: "removed", reason: "Stop future use; historical attempts and original retained for provenance. Use a separate privacy purge to erase payloads." }, `remove:${sourceId}`, "learner", "sources");
  }
  search(query: string, allowedSources: string[]): Array<Record<string, unknown>> {
    if (!query.trim()) return [];
    const words = query.toLocaleLowerCase().split(/\s+/).slice(0, 10);
    return this.store.db.query<{ span_id: string; source_revision_id: string; locator: string; text: string }, []>("SELECT span_id,source_revision_id,locator,text FROM source_span ORDER BY source_revision_id,ordinal").all()
      .filter(s => allowedSources.includes(s.source_revision_id) && this.store.sourceStatus(s.source_revision_id) === "indexed")
      .map(s => ({ ...s, rank: words.reduce((n, word) => n + (s.text.toLocaleLowerCase().includes(word) ? 1 : 0), 0) }))
      .filter(s => s.rank > 0).sort((a, b) => b.rank - a.rank || a.span_id.localeCompare(b.span_id)).slice(0, 6)
      .map(s => ({ ...s, text: s.text.slice(0, 2400), trust: "untrusted quoted source data" }));
  }
}
