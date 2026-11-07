import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { exportMarkdownPdf, type MarkdownPdfOptions } from "../src/markdown-pdf.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ root: string; options: MarkdownPdfOptions }> {
  const root = await mkdtemp(join(tmpdir(), "sage-pdf-bounds-")); roots.push(root);
  return { root, options: { content: "# Checked artifact\n\nBounded text.", outputPath: join(root, "checked.pdf"), artifactRevisionId: "owned-fixture", origin: "tutor", provenance: "Owned test; not performance evidence" } };
}
async function clean(root: string, output: string) { await expect(access(output)).rejects.toThrow(); expect((await readdir(root)).filter(name => name.startsWith(".sage-pdf-"))).toEqual([]); }

test("renderer deadline kills its owned process and removes every unpublished job file", async () => {
  const f = await fixture(); const start = Date.now();
  await expect(exportMarkdownPdf({ ...f.options, timeoutMs: 1 })).rejects.toThrow("timed out"); expect(Date.now() - start).toBeLessThan(10000); await clean(f.root, f.options.outputPath);
}, 15000);

test("preflight and in-flight cancellation never publish a partial PDF", async () => {
  const f = await fixture(); const preflight = new AbortController(); preflight.abort();
  await expect(exportMarkdownPdf({ ...f.options, signal: preflight.signal })).rejects.toThrow("cancelled"); await clean(f.root, f.options.outputPath);
  const active = new AbortController(); const timer = setTimeout(() => active.abort(), 25);
  try { await expect(exportMarkdownPdf({ ...f.options, signal: active.signal })).rejects.toThrow("cancelled"); } finally { clearTimeout(timer); }
  await clean(f.root, f.options.outputPath);
}, 15000);

test("page limits, malformed Unicode, controls, oversized content and reserved paths fail without publication", async () => {
  const f = await fixture();
  await expect(exportMarkdownPdf({ ...f.options, mediaType: "text/plain", content: "Bounded line\n".repeat(400), maxPages: 1 })).rejects.toThrow("page bound"); await clean(f.root, f.options.outputPath);
  for (const content of ["\ud800", "\x1b[31m", "x".repeat(240001)]) await expect(exportMarkdownPdf({ ...f.options, content })).rejects.toThrow();
  for (const outputPath of [join(f.root, "NUL.pdf"), join(f.root, "escape", "..", "..", "bad.pdf").replace("bad.pdf", "../bad.pdf"), join(f.root, "not-pdf.md")]) await expect(exportMarkdownPdf({ ...f.options, outputPath })).rejects.toThrow();
  await clean(f.root, f.options.outputPath);
}, 15000);

test("invalid explicit fonts cannot be embedded or leave a partially published document", async () => {
  const f = await fixture(); const font = join(f.root, "fake.ttf"); await writeFile(font, "not a font; never execute this");
  await expect(exportMarkdownPdf({ ...f.options, fontPath: font })).rejects.toThrow("font signature"); await clean(f.root, f.options.outputPath);
  await expect(exportMarkdownPdf({ ...f.options, fontPath: "https://example.invalid/font.ttf" })).rejects.toThrow(); await clean(f.root, f.options.outputPath);
});

test("concurrent publication creates exactly one verified PDF and never overwrites the winner", async () => {
  const f = await fixture(); const results = await Promise.allSettled([exportMarkdownPdf(f.options), exportMarkdownPdf({ ...f.options, content: "A distinct competing document" })]);
  const successful = results.filter(result => result.status === "fulfilled"); expect(successful).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const winner = successful[0]; if (!winner || winner.status !== "fulfilled") throw new Error("Missing winning export receipt");
  const bytes = await readFile(f.options.outputPath); expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(winner.value.fileHash);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(winner.value.pages); expect((await readdir(f.root)).filter(name => name.startsWith(".sage-pdf-"))).toEqual([]);
}, 15000);
