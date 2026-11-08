// One entry point from a learner's file / URL / pasted text to extracted parts (owner M6: PDF, OCR, YouTube captions, Office via
// our own unzip; no Office/COM). Everything runs locally except fetching the caption URL the learner pasted.
import { hash } from "../../storage/src/ledger.ts";
import { extractPdfTextBounded } from "./pdf.ts";
import { SourceSizeError } from "./limits.ts";
import { extractRasterText } from "./raster.ts";
import { extractOfficeText } from "./office.ts";
import { fetchCaptionsFromUrl, fetchYoutubeCaptions, parseCaptions, youtubeId } from "./captions.ts";
import { sniffImage } from "../../storage/src/blobs.ts";
import type { Part, SourceKind } from "./store.ts";

export interface Intake { title: string; kind: SourceKind; method: string; parts: Part[]; contentHash: string; url?: string; warnings: string[] }

/** Plain text in ~40-line parts with line locators, so citations point at lines. */
export function textParts(text: string): Part[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), out: Part[] = [];
  for (let i = 0; i < lines.length; i += 40) { const chunk = lines.slice(i, i + 40).join("\n"); if (chunk.trim()) out.push({ locator: `L${i + 1}–${Math.min(lines.length, i + 40)}`, text: chunk }); }
  return out;
}

export async function intakeFile(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Intake> {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase(), contentHash = hash(bytes), title = name.replace(/\.[^.]+$/, ""), warnings: string[] = [];
  if (ext === "pdf") {
    let why = "This PDF had no text layer";
    try {
      const r = await extractPdfTextBounded(bytes, { ...(signal ? { signal } : {}) });
      const parts = r.pages.filter(p => p.text.trim()).map(p => ({ locator: `p${p.pageNumber}`, text: p.text }));
      if (parts.length) return { title, kind: "pdf", method: "pdf-text-v1", parts, contentHash, warnings };
    } catch (e) {
      if (e instanceof SourceSizeError || signal?.aborted) throw e; // size decisions never fall back to OCR (v3)
      // shortcut: v3's text parser refuses xref/object streams (most PDFs since 1.5); those go to OCR (≤ 12 pages). Upgrade: resolve objects via pdf-lib's parser.
      why = "Sage's PDF text reader can't parse this PDF's structure";
    }
    const o = await extractRasterText(bytes, "application/pdf", signal);
    return { title, kind: "pdf", method: o.method, parts: o.parts, contentHash, warnings: [`${why}, so the pages were read by local OCR (Tesseract; PDFs of up to 12 pages). Check the text for misreads.`] };
  }
  if (ext === "docx" || ext === "pptx") { const o = extractOfficeText(bytes, name); return { title, kind: o.kind, method: "office-xml-v1", parts: o.parts, contentHash, warnings }; }
  if (["png", "jpg", "jpeg"].includes(ext)) {
    const mime = sniffImage(bytes);
    if (mime !== "image/png" && mime !== "image/jpeg") throw new Error("only PNG or JPEG scans can be read");
    const o = await extractRasterText(bytes, mime, signal);
    return { title, kind: "image", method: o.method, parts: o.parts, contentHash, warnings: ["Text read by local OCR; check it for misreads."] };
  }
  if (ext === "vtt" || ext === "srt") {
    const c = parseCaptions(new TextDecoder("utf-8", { fatal: true }).decode(bytes), ext);
    return { title, kind: "captions", method: "captions-v1", parts: c.cues.map(q => ({ locator: q.locator, text: q.text })), contentHash, warnings };
  }
  if (["txt", "md", "markdown"].includes(ext)) return { title, kind: "text", method: "text-v1", parts: textParts(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), contentHash, warnings };
  throw new Error("supported: .pdf, .docx, .pptx, .png/.jpg scans, .vtt/.srt captions, .txt/.md");
}

/** A YouTube video URL, or a direct .vtt/.srt caption URL. Only that URL (and the caption file it names) is fetched. */
export async function intakeUrl(url: string, signal?: AbortSignal): Promise<Intake> {
  if (youtubeId(url)) {
    const c = await fetchYoutubeCaptions(url, { ...(signal ? { signal } : {}) });
    const p = parseCaptions(c.text, "vtt");
    return { title: `YouTube ${c.videoId} (${c.trackName})`, kind: "captions", method: "youtube-captions-v1", url, parts: p.cues.map(q => ({ locator: q.locator, text: q.text })), contentHash: hash(c.original), warnings: [] };
  }
  const c = await fetchCaptionsFromUrl(url, { ...(signal ? { signal } : {}) });
  const p = parseCaptions(c.text, c.format);
  return { title: new URL(url).pathname.split("/").pop() || url, kind: "captions", method: "captions-url-v1", url, parts: p.cues.map(q => ({ locator: q.locator, text: q.text })), contentHash: hash(c.original), warnings: [] };
}

export function intakeText(title: string, text: string): Intake {
  return { title, kind: "text", method: "pasted-v1", parts: textParts(text), contentHash: hash(text), warnings: [] };
}
