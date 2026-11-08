// Owner 2026-11-08: YouTube transcripts come in by paste only (no YouTube internal API, no yt-dlp). The learner opens
// "Show transcript" under the video, selects all, copies and pastes it. We recognise that copy's layout: a timestamp line
// ("0:00", "12:34", "1:02:03") followed by its text, optionally with chapter headings between segments.
import { youtubeId } from "./captions.ts";
import type { Part } from "./store.ts";

export const YOUTUBE_PASTE_HINT = "On YouTube, click Show transcript under the description, select all, copy, paste here";

export interface TranscriptSegment { seconds: number; text: string; chapter?: string }

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
const TS_INLINE = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(\S.*)$/;
// Screen-reader duration labels ("2 minutes, 5 seconds") that some copies include under each timestamp.
const LABEL = /^\d+\s+(?:hours?|minutes?|seconds?)(?:,\s*\d+\s+(?:hours?|minutes?|seconds?))*$/i;

const seconds = (ts: string): number | undefined => {
  const m = TS.exec(ts);
  if (!m) return undefined;
  const h = Number(m[1] ?? 0), min = Number(m[2]), s = Number(m[3]);
  if (s > 59 || (m[1] !== undefined && min > 59)) return undefined;
  return h * 3600 + min * 60 + s;
};
export const clock = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/** The pasted text as timestamped segments, or undefined when it isn't YouTube's transcript layout. */
export function parseYoutubeTranscript(text: string): TranscriptSegment[] | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(l => l.trim()).filter(l => l && !LABEL.test(l));
  const blocks: { seconds: number; lines: string[] }[] = [], pre: string[] = [];
  for (const l of lines) {
    const sec = seconds(l), inline = sec === undefined ? TS_INLINE.exec(l) : null, isec = inline ? seconds(inline[1]!) : undefined;
    if (sec !== undefined) blocks.push({ seconds: sec, lines: [] });
    else if (isec !== undefined) blocks.push({ seconds: isec, lines: [inline![2]!] });
    else (blocks.at(-1)?.lines ?? pre).push(l);
  }
  if (blocks.length < 3) return undefined;
  const withText = blocks.filter(b => b.lines.length);
  if (withText.length < blocks.length * 0.8) return undefined;
  for (let i = 1; i < blocks.length; i++) if (blocks[i]!.seconds < blocks[i - 1]!.seconds) return undefined; // not one video's transcript
  // Chapter layout: segments are one line each, so an extra trailing line is the heading of the chapter that starts next.
  const multi = blocks.filter(b => b.lines.length > 1);
  const chapters = multi.length > 0 && multi.length <= blocks.length / 2 && multi.every(b => b.lines.length === 2 && b.lines[1]!.length <= 100);
  const out: TranscriptSegment[] = [];
  let chapter = chapters ? pre.at(-1) : undefined;
  for (const b of blocks) {
    const heading = chapters && b.lines.length > 1 ? b.lines.pop() : undefined;
    if (b.lines.length) out.push({ seconds: b.seconds, text: b.lines.join(" "), ...(chapter ? { chapter } : {}) });
    if (heading) chapter = heading;
  }
  return out;
}

/** Segments → parts of ≤ ~800 chars that break at chapters. Locator "12:34–14:02" or "12:34–14:02 · Chapter"; it starts with the cue time. */
export function transcriptParts(segs: TranscriptSegment[]): Part[] {
  const out: Part[] = [];
  let cur: TranscriptSegment[] = [];
  const flush = (endSec?: number) => {
    if (!cur.length) return;
    const c = cur[0]!.chapter, end = endSec ?? cur.at(-1)!.seconds;
    out.push({ locator: `${clock(cur[0]!.seconds)}–${clock(end)}${c ? ` · ${c}` : ""}`, text: cur.map(s => s.text).join("\n") });
    cur = [];
  };
  for (const s of segs) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0);
    if (cur.length && (s.chapter !== cur[0]!.chapter || len + s.text.length > 800)) flush(s.seconds);
    cur.push(s);
  }
  flush();
  return out;
}

/** Canonical watch URL for a YouTube video, so a time can be appended as &t=. */
export const youtubeWatchUrl = (url: string) => { const id = youtubeId(url); return id ? `https://www.youtube.com/watch?v=${id}` : undefined; };

/** A citation link for a span: the video at the span's start time (URL&t=<seconds>s). Undefined for non-YouTube sources. */
export function transcriptLink(url: string | undefined, locator: string): string | undefined {
  const watch = url ? youtubeWatchUrl(url) : undefined, start = seconds(/^[\d:]+/.exec(locator)?.[0] ?? "");
  return watch && start !== undefined ? `${watch}&t=${start}s` : undefined;
}
