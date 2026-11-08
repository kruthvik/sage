import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clock, parseYoutubeTranscript, transcriptLink, transcriptParts } from "../src/transcript.ts";
import { intakeText, intakeTranscript, intakeUrl } from "../src/intake.ts";
import { SourceStore } from "../src/store.ts";
import { Ledger } from "../../storage/src/ledger.ts";

const URL_ = "https://youtu.be/arj7oStGLkU";

test("plain layout: timestamp lines then text, hours, screen-reader labels dropped", () => {
  const s = parseYoutubeTranscript("Transcript\n0:00\nwelcome back\n0:04\n4 seconds\ntoday: derivatives\n12:34\nthe chain rule\n1:02:03\nwrap up")!;
  expect(s.map(x => [x.seconds, x.text])).toEqual([[0, "welcome back"], [4, "today: derivatives"], [754, "the chain rule"], [3723, "wrap up"]]);
  expect(s.every(x => !x.chapter)).toBe(true);
  expect(clock(3723)).toBe("1:02:03");
});

// 20 one-line segments, 5 s apart; `extra` maps a segment index to a line pasted before it (a heading, or wrapped text).
const paste = (extra: Record<number, string>, lead = "") => (lead ? lead + "\n" : "") +
  Array.from({ length: 20 }, (_, i) => `${clock(i * 5)}\nsegment ${i}${extra[i + 1] ? `\n${extra[i + 1]}` : ""}`).join("\n");

test("chapter layout: a heading line between segments starts a chapter", () => {
  const s = parseYoutubeTranscript(paste({ 8: "Limits", 15: "Derivatives" }, "Intro"))!;
  expect(s).toHaveLength(20);
  expect([s[0]!.chapter, s[7]!.chapter, s[8]!.chapter, s[14]!.chapter, s[15]!.chapter, s[19]!.chapter]).toEqual(["Intro", "Intro", "Limits", "Limits", "Derivatives", "Derivatives"]);
  expect(s.every(x => /^segment \d+$/.test(x.text))).toBe(true);
  expect(transcriptParts(s).map(p => p.locator)).toEqual(["0:00–0:40 · Intro", "0:40–1:15 · Limits", "1:15–1:35 · Derivatives"]);
});

test("more than ~15% 'headings' means wrapped segment text: joined, no chapters", () => {
  const wrapped = { 2: "and more", 5: "continued here", 9: "still going", 13: "the rest", 17: "end of thought" }; // 5 of 20 = 25%
  const s = parseYoutubeTranscript(paste(wrapped))!;
  expect(s).toHaveLength(20);
  expect(s.every(x => !x.chapter)).toBe(true);
  expect(s[1]!.text).toBe("segment 1 and more");
  expect(s[16]!.text).toBe("segment 16 end of thought");
});

test("inline layout and non-transcripts", () => {
  expect(parseYoutubeTranscript("0:00 one\n0:05 two\n0:09 three")!.map(x => x.seconds)).toEqual([0, 5, 9]);
  expect(parseYoutubeTranscript("Meeting at 10:30\nnotes\nmore notes")).toBeUndefined();
  expect(parseYoutubeTranscript("0:10\na\n0:05\nb\n0:20\nc")).toBeUndefined(); // times go backwards: not one video
});

test("pasted transcript → timestamped spans that cite URL&t=<seconds>s; nothing fetched", () => {
  const it = intakeTranscript(URL_, "0:00\nintro\n12:34\nthe chain rule says\n13:00\nmultiply the derivatives");
  expect(it.url).toBe("https://www.youtube.com/watch?v=arj7oStGLkU");
  expect(it.method).toBe("youtube-paste-v1");
  const store = new SourceStore(new Ledger(":memory:"));
  const rec = store.add(it), spans = store.spans(rec.sourceId);
  expect(spans[0]!.link).toBe("https://www.youtube.com/watch?v=arj7oStGLkU&t=0s");
  expect(transcriptLink(it.url, "12:34–13:00")).toBe("https://www.youtube.com/watch?v=arj7oStGLkU&t=754s");
  expect(store.cite([spans[0]!.spanId])).toEqual([{ spanId: spans[0]!.spanId, title: rec.title, locator: spans[0]!.locator, link: spans[0]!.link }]);
  expect(() => intakeTranscript(URL_, "just some notes")).toThrow(/Show transcript/);
  expect(() => intakeTranscript("https://example.org/v", "0:00\na\n0:01\nb\n0:02\nc")).toThrow(/YouTube video URL/);
  expect(intakeText("Pasted", "0:00\na\n0:05\nb\n0:09\nc").kind).toBe("captions"); // auto-detected without a URL
});

test("YouTube URLs are never fetched: watch pages and caption endpoints both refused", async () => {
  await expect(intakeUrl("https://www.youtube.com/watch?v=arj7oStGLkU")).rejects.toThrow(/Show transcript/);
  await expect(intakeUrl("https://www.youtube.com/api/timedtext?v=arj7oStGLkU&lang=en")).rejects.toThrow(/doesn't fetch from YouTube/);
});

// A real "Show transcript" copy of a video of 30+ minutes. Not committed (it's the publisher's text): put the video URL on the
// first line and the paste below it in test/fixtures/local/youtube-transcript.txt.
const REAL = join(import.meta.dir, "fixtures", "local", "youtube-transcript.txt");
test.skipIf(!existsSync(REAL))("real pasted transcript of at least 30 minutes", () => {
  const [url, ...rest] = readFileSync(REAL, "utf8").replace(/\r\n?/g, "\n").split("\n");
  const paste = rest.join("\n"), segs = parseYoutubeTranscript(paste)!;
  expect(segs).toBeDefined();
  expect(segs.at(-1)!.seconds).toBeGreaterThanOrEqual(30 * 60);
  // Every timestamp line in the paste became a segment (or a chapter heading's segment), in order.
  const stamps = paste.split("\n").filter(l => /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(l.trim())).length;
  expect(segs.length).toBeGreaterThanOrEqual(stamps * 0.98);
  expect(segs.every(s => s.text.trim())).toBe(true);
  const it = intakeTranscript(url!.trim(), paste), store = new SourceStore(new Ledger(":memory:")), spans = store.spans(store.add(it).sourceId);
  expect(spans.every(s => s.link && /&t=\d+s$/.test(s.link))).toBe(true);
  console.log(`real transcript: ${segs.length} segments, ${clock(segs.at(-1)!.seconds)}, ${new Set(segs.map(s => s.chapter)).size} chapter(s), ${spans.length} spans`);
});

// The owner's real paste (2026-11-08): a ~95-minute accounting course copied with timestamps hidden. Wrapped lines, no times,
// HTML entities. Not committed; it lives in test/fixtures/local/youtube-transcript-untimed.txt.
const UNTIMED = join(import.meta.dir, "fixtures", "local", "youtube-transcript-untimed.txt");
test.skipIf(!existsSync(UNTIMED))("real paste without timestamps: kept as an untimed transcript, linked to the video with no invented time", () => {
  const paste = readFileSync(UNTIMED, "utf8");
  expect(paste.split(/\s+/).length).toBeGreaterThan(30 * 150); // over 30 minutes of speech at ~150 words/min
  expect(parseYoutubeTranscript(paste)).toBeUndefined();
  const it = intakeTranscript(URL_, paste);
  expect(it.method).toBe("youtube-paste-untimed-v1");
  expect(it.warnings[0]).toMatch(/no timestamps/);
  const store = new SourceStore(new Ledger(":memory:")), spans = store.spans(store.add(it).sourceId);
  expect(spans.every(s => s.link === "https://www.youtube.com/watch?v=arj7oStGLkU")).toBe(true); // no &t: we don't know the time
  const all = spans.map(s => s.text).join("\n");
  expect(all).not.toContain("&quot;");
  expect(all).toContain('"Oh no, this must be');
  expect(all).toContain("debit cash 5,000, credit owner's");
  const id = store.list()[0]!.sourceId;
  expect(store.excerpts([id], "depreciation")).toEqual([]); // not accepted yet: nothing reaches a model
  store.accept(id, true);
  expect(store.excerpts([id], "straight-line depreciation salvage value")[0]!.text).toMatch(/straight-line/i);
  console.log(`untimed real paste: ${spans.length} spans, ${it.parts.length} parts, ${all.split(/\s+/).length} words`);
});
