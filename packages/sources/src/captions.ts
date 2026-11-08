// Ported from v3 packages/sources/src/captions.ts (V3_PORT: keep; owner M6 2026-11-08).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface CaptionCue {
  ordinal: number;
  start: string;
  end: string;
  locator: string;
  text: string;
}

export interface CaptionExtractionResult {
  format: "vtt" | "srt";
  cues: CaptionCue[];
  fullText: string;
}

export function parseCaptions(text: string, format: "vtt" | "srt"): CaptionExtractionResult {
  if (format === "vtt" && !text.trim().startsWith("WEBVTT")) {
    throw new Error("Invalid WebVTT format: missing WEBVTT header");
  }

  // Regex matching standard timestamp intervals 00:01:23.456 --> 00:01:26.789
  const cueRegex = /(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\r?\n([\s\S]*?)(?=(?:\r?\n\r?\n|\s*$))/g;
  const cues: CaptionCue[] = [];
  let match: RegExpExecArray | null;
  let ordinal = 1;

  while ((match = cueRegex.exec(text)) !== null) {
    const start = match[1]!;
    const end = match[2]!;
    const cueText = match[3]!.replace(/<[^>]+>/g, "").trim(); // strip HTML/formatting tags
    if (cueText) {
      cues.push({
        ordinal: ordinal++,
        start,
        end,
        locator: `${start.slice(0, 8)}–${end.slice(0, 8)}`,
        text: cueText,
      });
    }
  }

  if (cues.length === 0) {
    throw new Error(`No extractable caption cues found in ${format.toUpperCase()} file`);
  }

  const fullText = cues.map(c => c.text).join("\n");
  return { format, cues, fullText };
}

const MAX_CAPTION_BYTES = 5 * 1024 * 1024;
const privateAddress = () => new Error("Access to local or private network addresses is prohibited");
const sizeError = () => new Error("Caption file exceeds maximum size limit (5 MB)");

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const [a, b] = address.toLowerCase().split(":").map(s => parseInt(s || "0", 16));
    // shortcut: only ordinary global unicast, extend special IPv6 ranges only with transport tests.
    return a! >= 0x2000 && a! <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b! < 0x200 || b === 0xdb8));
  }
  return false;
}

function captionUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error("Invalid caption URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Caption acquisition is limited to http and https URLs");
  if (url.username || url.password) throw new Error("Caption URLs must not contain credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIP(hostname) && !publicAddress(hostname)) throw privateAddress();
  return url;
}

export interface CaptionFetchOptions { signal?: AbortSignal; timeoutMs?: number }

function captionHop(url: URL, signal: AbortSignal): Promise<{ location: string } | { text: string; original: Buffer }> {
  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage | undefined, settled = false;
    const finish = (error?: Error, result?: { location: string } | { text: string; original: Buffer }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      response?.destroy(); request.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal.reason);
    const lookup: LookupFunction = (hostname, _options, callback) => {
      // This is the socket's only lookup: validate all answers, then pin the chosen IP.
      dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (settled || signal.aborted) return;
        if (error) { callback(error, "", 4); return; }
        if (!addresses.length || addresses.some(a => !publicAddress(a.address))) { callback(privateAddress(), "", 4); return; }
        const selected = addresses[0]!;
        callback(null, selected.address, selected.family);
      });
    };
    const requestOptions: http.RequestOptions & { autoSelectFamily: false } = {
      agent: false, autoSelectFamily: false, lookup,
      headers: { "User-Agent": "Sage-Learning-Engine/1.0", "Accept-Encoding": "identity" },
    };
    const request = (url.protocol === "https:" ? https : http).request(url, requestOptions, res => {
      response = res;
      res.on("error", error => finish(error));
      if (settled) { res.destroy(); return; }
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        if (!res.headers.location) { finish(new Error("Caption redirect is missing Location")); return; }
        finish(undefined, { location: res.headers.location }); return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { finish(new Error(`Failed to fetch captions: HTTP ${res.statusCode}`)); return; }
      const encoding = res.headers["content-encoding"];
      if (encoding && encoding !== "identity") { finish(new Error("Unsupported caption Content-Encoding; identity required")); return; }
      const declared = res.headers["content-length"];
      if (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) { finish(new Error("Invalid caption Content-Length")); return; }
      if (declared !== undefined && Number(declared) > MAX_CAPTION_BYTES) { finish(sizeError()); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_CAPTION_BYTES) { finish(sizeError()); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (declared !== undefined && Number(declared) !== bytes) { finish(new Error("Caption Content-Length mismatch")); return; }
        try {
          const original = Buffer.concat(chunks, bytes);
          finish(undefined, { text: new TextDecoder("utf-8", { fatal: true }).decode(original), original });
        }
        catch { finish(new Error("Unsupported caption text encoding; UTF-8 required")); }
      });
      res.on("close", () => { if (!settled) finish(new Error("Incomplete caption stream")); });
    });
    request.on("error", error => finish(error));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else request.end();
  });
}

export async function fetchCaptionsFromUrl(urlStr: string, options: CaptionFetchOptions = {}): Promise<{ text: string; format: "vtt" | "srt"; original: Buffer }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error("Invalid caption deadline");
  let url = captionUrl(urlStr);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Caption acquisition cancelled"));
  const timer = setTimeout(() => controller.abort(new Error("Caption acquisition deadline exceeded")), timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    for (let redirects = 0; ; redirects++) {
      const result = await captionHop(url, controller.signal);
      if ("text" in result) {
        const format = result.text.trim().startsWith("WEBVTT") || url.pathname.endsWith(".vtt") ? "vtt" : "srt";
        return { text: result.text, format, original: result.original };
      }
      if (redirects >= 5) throw new Error("Caption redirect limit exceeded");
      url = captionUrl(result.location, url);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** v4 (owner M6): a YouTube watch/share URL → that video's caption track as WebVTT. Same pinned-DNS, public-address-only hops as
 * fetchCaptionsFromUrl; only youtube.com / youtu.be pages and the caption URL they name are fetched. Manual tracks beat auto ones. */
export function youtubeId(value: string): string | undefined {
  let u: URL; try { u = new URL(value); } catch { return undefined; }
  if (u.protocol !== "https:") return undefined;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const id = host === "youtu.be" ? u.pathname.slice(1) : host === "youtube.com" ? (u.pathname === "/watch" ? u.searchParams.get("v") ?? "" : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1] ?? "") : "";
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
}
export async function fetchYoutubeCaptions(value: string, options: CaptionFetchOptions & { lang?: string } = {}): Promise<{ text: string; format: "vtt"; original: Buffer; videoId: string; trackName: string }> {
  const videoId = youtubeId(value);
  if (!videoId) throw new Error("not a YouTube video URL (https://www.youtube.com/watch?v=… or https://youtu.be/…)");
  const page = await fetchCaptionsFromUrl(`https://www.youtube.com/watch?v=${videoId}&hl=en`, options);
  const m = /"captionTracks":(\[.*?\])/.exec(page.text);
  if (!m) throw new Error("this video has no captions YouTube will share without signing in; upload a .vtt/.srt file instead");
  let tracks: { baseUrl: string; languageCode?: string; kind?: string; name?: { simpleText?: string; runs?: { text: string }[] } }[];
  try { tracks = JSON.parse(m[1]!); } catch { throw new Error("couldn't read the caption list on the YouTube page"); }
  const lang = options.lang ?? "en", score = (t: typeof tracks[number]) => (t.languageCode?.startsWith(lang) ? 2 : 0) + (t.kind === "asr" ? 0 : 1);
  const best = [...tracks].sort((a, b) => score(b) - score(a))[0];
  if (!best?.baseUrl) throw new Error("this video has no caption tracks");
  const track = new URL(best.baseUrl);
  if (track.hostname !== "www.youtube.com" && track.hostname !== "youtube.com") throw new Error("unexpected caption host");
  track.searchParams.set("fmt", "vtt");
  const cap = await fetchCaptionsFromUrl(track.href, options);
  if (!cap.text.trim().startsWith("WEBVTT")) throw new Error("YouTube returned no captions for this video (it may require signing in); upload a .vtt/.srt file instead");
  return { ...cap, format: "vtt", videoId, trackName: best.name?.simpleText ?? best.name?.runs?.map(r => r.text).join("") ?? best.languageCode ?? "captions" };
}
