// Ported from v3 runtime/src/markdown-pdf.ts (V3_PORT: keep): isolated subprocess, bounded, verified, never overwrites.
import { lstat, realpath, open, mkdtemp, writeFile, link, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, basename, resolve, parse, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
export interface MarkdownPdfOptions {
  content: string; mediaType?: "text/markdown" | "text/plain"; outputPath: string;
  artifactRevisionId: string; origin: "learner" | "tutor" | "source" | "unknown"; provenance: string;
  /** Explicit local font; never inferred from global/user directories. Caller must have embedding rights. Without it, the bundled
   * DejaVu Sans / Sans Mono are used (free to embed; broad maths coverage). */
  fontPath?: string; timeoutMs?: number; maxPages?: number; signal?: AbortSignal;
}
export interface MarkdownPdfReceipt { fullPath: string; fileHash: string; contentHash: string; artifactRevisionId: string; origin: MarkdownPdfOptions["origin"]; pages: number; bytesWritten: number; replacedChars: number; renderer: "pdf-lib/1.17.1" }
interface Summary { pages: number; bytes: number; fileHash: string; replaced: number }
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
function unicode(value: string) { if (new TextDecoder().decode(Buffer.from(value, "utf8")) !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/u.test(value)) throw new Error("PDF requires valid Unicode text without terminal/directional control characters"); }
function validSummary(v: unknown): asserts v is Summary {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || !Number.isInteger(s.pages) || (s.pages as number) < 1 || (s.pages as number) > 128 || !Number.isInteger(s.bytes) || (s.bytes as number) < 1 || (s.bytes as number) > 16777216
    || typeof s.fileHash !== "string" || !/^[a-f0-9]{64}$/.test(s.fileHash) || !Number.isInteger(s.replaced) || Object.keys(s).length !== 4) throw new Error("Invalid PDF worker receipt");
}
async function regularDirectory(directory: string) {
  let part = resolve(directory);
  for (;;) { const info = await lstat(part); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("PDF output/font path must use regular directories, not a junction/symlink"); const parent = dirname(part); if (parent === part) break; part = parent; }
  const actual = await realpath(directory), info = await lstat(actual);
  return { path: actual, device: info.dev, inode: info.ino };
}
async function boundedFile(path: string, limit: number) {
  const before = await lstat(path); if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("PDF input/output must be a bounded regular unlinked file");
  const file = await open(path, "r");
  try {
    const info = await file.stat(); if (info.ino !== before.ino || info.dev !== before.dev || info.nlink !== 1 || info.size > limit) throw new Error("PDF file changed during read");
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > limit) throw new Error("PDF file size bound exceeded"); return buffer.subarray(0, length);
  } finally { await file.close(); }
}
async function boundedStream(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > limit) throw new Error("PDF worker diagnostic bound exceeded"); chunks.push(item.value); } return Buffer.concat(chunks, length).toString("utf8"); }
  finally { reader.releaseLock(); }
}
function outputName(path: string) {
  if (!path || path.length > 2000 || path.includes("\0") || path.split(/[\\/]/).some(p => p === "..")) throw new Error("Invalid PDF output path");
  const target = resolve(path), name = basename(target);
  if (extname(name).toLowerCase() !== ".pdf" || name.trim() !== name || /[<>:"|?*\u0000-\u001f]/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || parse(target).root.startsWith("\\\\")) throw new Error("Choose a regular local .pdf output filename, not a reserved/device path");
  return target;
}

const FONT_MAX = 8388608;
const sfnt = (b: Uint8Array) => Buffer.from(b.subarray(0, 4)).toString("hex") === "00010000" || Buffer.from(b.subarray(0, 4)).toString("ascii") === "OTTO";
/** Sage's own dependency (dejavu-fonts-ttf), resolved from this package, never from user/system dirs. Package managers hard-link
 * these files, so they're read by size + signature instead of the unlinked-file check used for owner fonts. Missing ⇒ Helvetica. */
async function bundledFonts(): Promise<[Uint8Array, Uint8Array] | undefined> {
  let dir: string;
  try { dir = join(dirname(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/package.json")), "ttf"); } catch { return undefined; }
  const read = async (name: string) => { const b = await readFile(join(dir, name)); if (b.length > FONT_MAX || !sfnt(b)) throw new Error("bundled font is invalid"); return b; };
  try { return [await read("DejaVuSans.ttf"), await read("DejaVuSansMono.ttf")]; } catch (e) { if (missing(e)) return undefined; throw e; }
}

/** Local export. No browser, provider, active PDF actions, URL/file resource loading or outcome writes. */
export async function exportMarkdownPdf(options: MarkdownPdfOptions): Promise<MarkdownPdfReceipt> {
  if (options.signal?.aborted) throw new Error("PDF export cancelled before rendering");
  unicode(options.content); unicode(options.provenance);
  if (Buffer.byteLength(options.content, "utf8") > 240000 || !/^[A-Za-z0-9_.:-]{1,180}$/.test(options.artifactRevisionId) || !["learner", "tutor", "source", "unknown"].includes(options.origin) || (options.mediaType && !["text/markdown", "text/plain"].includes(options.mediaType))) throw new Error("Invalid/oversized PDF content or attribution");
  const timeout = options.timeoutMs ?? 10000, maxPages = options.maxPages ?? 64;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 128) throw new Error("Invalid PDF worker time/page bound");
  const requested = outputName(options.outputPath); const parent = await regularDirectory(dirname(requested)); const target = join(parent.path, basename(requested));
  try { await lstat(target); throw new Error("PDF conflict: existing files are never overwritten"); } catch (error) { if (!missing(error)) throw error; }
  let font: Uint8Array | undefined, mono: Uint8Array | undefined;
  if (options.fontPath) {
    const selected = resolve(options.fontPath); if (![".ttf", ".otf"].includes(extname(selected).toLowerCase())) throw new Error("Choose an explicit local TTF/OTF font");
    await regularDirectory(dirname(selected)); font = await boundedFile(selected, FONT_MAX);
    if (!sfnt(font)) throw new Error("Invalid TTF/OTF font signature");
  } else [font, mono] = (await bundledFonts()) ?? [];
  const contentHash = hash(Buffer.from(options.content, "utf8"));
  const job = JSON.stringify({ content: options.content, mediaType: options.mediaType ?? "text/markdown", artifactRevisionId: options.artifactRevisionId, origin: options.origin, provenance: Array.from(options.provenance).slice(0, 1900).join("") + (Array.from(options.provenance).length > 1900 ? " [truncated]" : ""), contentHash, fonts: mono ? "two" : font ? "one" : "none", maxPages });
  if (Buffer.byteLength(job, "utf8") > 262144) throw new Error("PDF serialized job exceeds bound");
  const directory = await mkdtemp(join(parent.path, ".sage-pdf-")); const output = join(directory, "output.pdf"); let summary: Summary | undefined;
  try {
    const input = join(directory, "input.json"), fontPath = join(directory, "font.bin"), monoPath = join(directory, "mono.bin"); await writeFile(input, job, { flag: "wx", mode: 0o600 });
    if (font) await writeFile(fontPath, font, { flag: "wx", mode: 0o600 }); if (mono) await writeFile(monoPath, mono, { flag: "wx", mode: 0o600 });
    const env: Record<string, string> = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory, XDG_CACHE_HOME: directory, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(directory, "cache"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    for (const key of ["PATH", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key]!;
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)), input, output, fontPath, monoPath], { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false, cancelled = false;
    const cancel = () => { cancelled = true; if (child.exitCode === null) child.kill("SIGKILL"); };
    const timer = setTimeout(() => { if (child.exitCode === null) { timedOut = true; child.kill("SIGKILL"); } }, timeout);
    options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
    let stdout: string;
    try {
      const [code, out, error] = await Promise.all([child.exited, boundedStream(child.stdout, 32768), boundedStream(child.stderr, 32768)]);
      if (cancelled) throw new Error("PDF export cancelled; no document published");
      if (timedOut) throw new Error("PDF renderer timed out; no document published");
      if (code !== 0) throw new Error(`PDF renderer failed: ${error.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1000)}`);
      stdout = out;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    let value: unknown; try { value = JSON.parse(stdout); } catch (cause) { throw new Error("Invalid PDF worker receipt", { cause }); }
    validSummary(value); summary = value;
    const bytes = await boundedFile(output, 16777216);
    if (bytes.length !== summary.bytes || hash(bytes) !== summary.fileHash || bytes.subarray(0, 5).toString() !== "%PDF-" || !bytes.subarray(-32).toString().includes("%%EOF") || summary.pages > maxPages) throw new Error("PDF disk/structure verification failed");
    if (options.signal?.aborted) throw new Error("PDF export cancelled before publication");
    const current = await regularDirectory(dirname(requested)); if (current.path !== parent.path || current.device !== parent.device || current.inode !== parent.inode) throw new Error("PDF output directory changed during rendering");
    try { await link(output, target); } catch (cause) { throw new Error("PDF conflict: publication failed; no existing file was overwritten", { cause }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
  if (!summary) throw new Error("Missing PDF verification receipt");
  const final = await boundedFile(target, 16777216); if (hash(final) !== summary.fileHash) throw new Error("Published PDF changed; preserve the file and resolve locally");
  return { fullPath: target, fileHash: summary.fileHash, contentHash, artifactRevisionId: options.artifactRevisionId, origin: options.origin, pages: summary.pages, bytesWritten: final.length, replacedChars: summary.replaced, renderer: "pdf-lib/1.17.1" };
}
