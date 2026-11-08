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

test("chapter layout: a heading line between segments starts a chapter", () => {
  const s = parseYoutubeTranscript("Intro\n0:00\nhi\n0:03\nplan for today\nLimits\n0:09\na limit is\n0:15\nwhat f approaches\nDerivatives\n1:10\nslope of the tangent")!;
  expect(s.map(x => [x.seconds, x.chapter, x.text])).toEqual([[0, "Intro", "hi"], [3, "Intro", "plan for today"], [9, "Limits", "a limit is"], [15, "Limits", "what f approaches"], [70, "Derivatives", "slope of the tangent"]]);
  expect(transcriptParts(s).map(p => p.locator)).toEqual(["0:00–0:09 · Intro", "0:09–1:10 · Limits", "1:10–1:10 · Derivatives"]);
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
