// One entry point from a learner's file / URL / pasted text to extracted parts (owner M6: PDF, OCR, captions, Office via our own
// unzip; no Office/COM). Everything runs locally except fetching a direct caption-file URL the learner pasted. YouTube transcripts
// come in by paste only (owner 2026-11-08: no YouTube internal API, no yt-dlp).
import { hash } from "../../storage/src/ledger.ts";
import { extractPdfTextBounded } from "./pdf.ts";
import { SourceSizeError, sourceInputLimit } from "./limits.ts";
import { extractPdfWithUnpdf } from "./unpdf.ts";
import { extractRasterText } from "./raster.ts";
import { extractOfficeText } from "./office.ts";
import { fetchCaptionsFromUrl, parseCaptions, youtubeId } from "./captions.ts";
import { YOUTUBE_PASTE_HINT, parseYoutubeTranscript, transcriptParts, youtubeWatchUrl } from "./transcript.ts";
import { sniffImage } from "../../storage/src/blobs.ts";
import type { Part, SourceKind } from "./store.ts";

export interface Intake { title: string; kind: SourceKind; method: string; parts: Part[]; contentHash: string; url?: string; warnings: string[] }

/** Plain text in ~40-line parts with line locators, so citations point at lines. */
export function textParts(text: string): Part[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), out: Part[] = [];
  for (let i = 0; i < lines.length; i += 40) { const chunk = lines.slice(i, i + 40).join("\n"); if (chunk.trim()) out.push({ locator: `L${i + 1}–${Math.min(lines.length, i + 40)}`, text: chunk }); }
  return out;
}

export async function intakeFile(name: string, bytes: Uint8Array, signal?: AbortSignal, opts: { unpdfEntry?: string } = {}): Promise<Intake> {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase(), contentHash = hash(bytes), title = name.replace(/\.[^.]+$/, ""), warnings: string[] = [];
  if (ext === "pdf") {
    let why = "This PDF had no text layer";
    if (bytes.length > sourceInputLimit()) throw new SourceSizeError("PDF exceeds the source size bound");
    if (opts.unpdfEntry) {
      // pdf.js (unpdf from pi-web-access): real fonts, object streams, Unicode. A page with no text is an image page.
      const r = await extractPdfWithUnpdf(bytes, opts.unpdfEntry, signal);
      const parts = r.pages.filter(p => p.text).map(p => ({ locator: `p${p.pageNumber}`, text: p.text }));
      if (parts.length) {
        const blank = r.totalPages - parts.length;
        return { title, kind: "pdf", method: "unpdf-pdfjs-v1", parts, contentHash, warnings: blank ? [`${blank} of ${r.totalPages} pages had no text (scanned or image-only pages); upload those as images to read them by OCR.`] : [] };
      }
    } else try {
      const r = await extractPdfTextBounded(bytes, { ...(signal ? { signal } : {}) });
      const parts = r.pages.filter(p => p.text.trim()).map(p => ({ locator: `p${p.pageNumber}`, text: p.text }));
      if (parts.length) return { title, kind: "pdf", method: "pdf-text-v1", parts, contentHash, warnings };
    } catch (e) {
      if (e instanceof SourceSizeError || signal?.aborted) throw e; // size decisions never fall back to OCR (v3)
      // Fallback only when unpdf isn't installed: v3's parser reads standard-font ASCII PDFs without object streams; the rest go to OCR (≤ 12 pages).
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

/** A direct .vtt/.srt caption URL; only that URL is fetched. A YouTube URL needs the pasted transcript (intakeTranscript). */
export async function intakeUrl(url: string, signal?: AbortSignal): Promise<Intake> {
  if (youtubeId(url)) throw new Error(`YouTube videos are added with their transcript: ${YOUTUBE_PASTE_HINT}.`);
  // No YouTube endpoint is ever fetched, including caption URLs copied from it (owner 2026-11-08).
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i.test(URL.canParse(url) ? new URL(url).hostname : "")) throw new Error(`Sage doesn't fetch from YouTube. ${YOUTUBE_PASTE_HINT}, with the video URL.`);
  const c = await fetchCaptionsFromUrl(url, { ...(signal ? { signal } : {}) });
  const p = parseCaptions(c.text, c.format);
  return { title: new URL(url).pathname.split("/").pop() || url, kind: "captions", method: "captions-url-v1", url, parts: p.cues.map(q => ({ locator: q.locator, text: q.text })), contentHash: hash(c.original), warnings: [] };
}

/** A YouTube URL plus the transcript the learner copied from "Show transcript". Nothing is fetched. */
export function intakeTranscript(url: string, text: string, title?: string): Intake {
  const watch = youtubeWatchUrl(url);
  if (!watch) throw new Error("not a YouTube video URL (https://www.youtube.com/watch?v=… or https://youtu.be/…)");
  const segs = parseYoutubeTranscript(text);
  if (!segs) throw new Error(`That doesn't look like a YouTube transcript (timestamp lines followed by text). ${YOUTUBE_PASTE_HINT}.`);
  return { title: title?.trim() || `YouTube ${youtubeId(url)}`, kind: "captions", method: "youtube-paste-v1", url: watch, parts: transcriptParts(segs),
    contentHash: hash(`${watch}\n${text}`), warnings: [] };
}

export function intakeText(title: string, text: string): Intake {
  const segs = parseYoutubeTranscript(text); // a transcript pasted without its URL still gets timestamped spans (no links)
  if (segs) return { title, kind: "captions", method: "transcript-paste-v1", parts: transcriptParts(segs), contentHash: hash(text), warnings: ["Timestamps kept; add the video URL to get links to each moment."] };
  return { title, kind: "text", method: "pasted-v1", parts: textParts(text), contentHash: hash(text), warnings: [] };
}
