import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, PDFName, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { marked } from "marked";
import { Type } from "typebox";
import { validate } from "../../core/src/contracts.ts";
import { hash } from "../../storage/src/store.ts";

const JobSchema = Type.Object({ content: Type.String({ maxLength: 250000 }), mediaType: Type.Enum(["text/markdown", "text/plain"]), artifactRevisionId: Type.String({ minLength: 1, maxLength: 180 }), origin: Type.Enum(["learner", "tutor", "source", "unknown"]), provenance: Type.String({ maxLength: 2000 }), contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), font: Type.Boolean(), maxPages: Type.Integer({ minimum: 1, maximum: 128 }) }, { additionalProperties: false });
interface Job { content: string; mediaType: "text/markdown" | "text/plain"; artifactRevisionId: string; origin: string; provenance: string; contentHash: string; font: boolean; maxPages: number }
interface Block { text: string; size: number; mono?: boolean }
const text = (value: unknown): string => typeof value === "string" ? value : "";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Markdown token");
  return value as Record<string, unknown>;
}
/** Read-only token conversion. Never render HTML, attach actions, dereference URLs or load images. */
function blocks(content: string, plain: boolean): Block[] {
  if (plain) return [{ text: content, size: 11 }];
  let count = 0;
  function bound(depth: number) { if (++count > 10000 || depth > 24) throw new Error("Markdown token/depth bound exceeded"); }
  function inline(nodes: unknown, depth: number): string {
    if (!Array.isArray(nodes)) return "";
    return nodes.map(value => {
      bound(depth); const node = object(value); const kind = text(node.type);
      if (kind === "image") return `[Image omitted: ${text(node.text)}]`;
      if (kind === "br") return "\n";
      if (Array.isArray(node.tokens)) return inline(node.tokens, depth + 1);
      return text(node.text); // Includes raw HTML as literal PDF text, never markup.
    }).join("");
  }
  const output: Block[] = [];
  function walk(nodes: unknown, depth: number, prefix = "") {
    if (!Array.isArray(nodes)) throw new Error("Invalid Markdown blocks");
    for (const value of nodes) {
      bound(depth); const node = object(value); const kind = text(node.type);
      if (kind === "space" || kind === "def") continue;
      if (kind === "list") {
        if (!Array.isArray(node.items)) throw new Error("Invalid Markdown list");
        let index = typeof node.start === "number" ? node.start : 1;
        for (const item of node.items) walk(object(item).tokens, depth + 1, `${prefix}${node.ordered ? `${index++}. ` : "- "}`);
      } else if (kind === "blockquote") walk(node.tokens, depth + 1, `${prefix}> `);
      else if (kind === "table") {
        const cell = (value: unknown) => { const c = object(value); return Array.isArray(c.tokens) ? inline(c.tokens, depth + 1) : text(c.text); };
        if (Array.isArray(node.header)) output.push({ text: prefix + node.header.map(cell).join(" | "), size: 11 });
        if (Array.isArray(node.rows)) for (const row of node.rows) { bound(depth + 1); if (!Array.isArray(row)) throw new Error("Invalid Markdown table row"); output.push({ text: prefix + row.map(cell).join(" | "), size: 10 }); }
      } else if (kind === "hr") output.push({ text: "------------------------------", size: 10 });
      else if (["heading", "paragraph", "text", "html", "code"].includes(kind)) {
        const value = Array.isArray(node.tokens) ? inline(node.tokens, depth + 1) : text(node.text);
        output.push({ text: prefix + value, size: kind === "heading" ? Math.max(12, 21 - (typeof node.depth === "number" ? node.depth : 1) * 2) : kind === "code" ? 9 : 11, mono: kind === "code" });
      } else throw new Error(`Unsupported Markdown block: ${kind}`);
    }
  }
  walk(marked.lexer(content, { gfm: true }), 0);
  return output;
}

async function render(input: string, output: string, fontPath: string) {
  const bytes = await readFile(input); if (bytes.length > 262144) throw new Error("PDF job input exceeds bound");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error("Invalid PDF worker job encoding/JSON", { cause }); }
  validate<Job>(JobSchema, parsed); const raw = parsed;
  if (hash(Buffer.from(raw.content, "utf8")) !== raw.contentHash) throw new Error("PDF source hash mismatch");
  const doc = await PDFDocument.create(); doc.setTitle(`Sage artifact ${raw.artifactRevisionId}`); doc.setAuthor(raw.origin); doc.setSubject(raw.provenance); doc.setCreator("Sage local pdf-lib/1.17.1"); doc.setKeywords(["artifact_only", raw.artifactRevisionId, raw.contentHash]);
  let body: PDFFont; let mono: PDFFont;
  if (raw.font) { const fontBytes = await readFile(fontPath); if (fontBytes.length > 8388608) throw new Error("PDF font exceeds bound"); doc.registerFontkit(fontkit); body = await doc.embedFont(fontBytes, { subset: true }); mono = body; }
  else { body = await doc.embedFont(StandardFonts.Helvetica); mono = await doc.embedFont(StandardFonts.Courier); }
  const all: Block[] = [{ text: "Sage attributed artifact - not learner performance evidence", size: 12 }, { text: `Artifact: ${raw.artifactRevisionId}\nOrigin: ${raw.origin}\nProvenance: ${raw.provenance}\nContent SHA-256: ${raw.contentHash}`, size: 8 }, ...blocks(raw.content, raw.mediaType === "text/plain")];
  const charset = new Map<PDFFont, Set<number>>([[body, new Set(body.getCharacterSet())], [mono, new Set(mono.getCharacterSet())]]);
  const width = 595.28, height = 841.89, margin = 48, available = width - margin * 2;
  let page = doc.addPage([width, height]), y = height - margin;
  function newPage() { if (doc.getPageCount() >= raw.maxPages) throw new Error("PDF page bound exceeded"); page = doc.addPage([width, height]); y = height - margin; }
  function line(value: string, size: number, font: PDFFont) { if (y - size * 1.4 < margin) newPage(); if (value) page.drawText(value, { x: margin, y: y - size, size, font, color: rgb(0.08, 0.08, 0.08) }); y -= size * 1.4; }
  for (const block of all) {
    const font = block.mono ? mono : body;
    const normalized = block.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    for (const ch of normalized) if (ch !== "\n" && !charset.get(font)!.has(ch.codePointAt(0)!)) throw new Error(`PDF font cannot represent U+${ch.codePointAt(0)!.toString(16)}; select a local font containing every required glyph`);
    for (const paragraph of normalized.split("\n")) {
      let current = "";
      // Character-based wrap guarantees even long source IDs/code/URLs cannot overrun the page.
      for (const ch of paragraph) { if (current && font.widthOfTextAtSize(current + ch, block.size) > available) { line(current, block.size, font); current = ch; } else current += ch; }
      line(current, block.size, font);
    }
    y -= 5;
  }
  const result = await doc.save(); if (result.length > 16777216) throw new Error("PDF output exceeds bound");
  const checked = await PDFDocument.load(result); if (checked.isEncrypted || checked.getPageCount() < 1 || checked.getPageCount() > raw.maxPages) throw new Error("PDF structure verification failed");
  for (const key of ["OpenAction", "AA", "Names", "AcroForm"]) if (checked.catalog.has(PDFName.of(key))) throw new Error("Active PDF content rejected");
  // pdf-lib normalizes new pages with an empty Annots array; only actual annotations are active.
  for (const p of checked.getPages()) if (p.node.has(PDFName.of("AA")) || (p.node.Annots()?.size() ?? 0) > 0) throw new Error("PDF actions/annotations rejected");
  await writeFile(output, result, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ pages: checked.getPageCount(), bytes: result.length, fileHash: hash(result) }));
}
if (import.meta.main) {
  try { if (process.argv.length !== 5) throw new Error("Invalid owned PDF worker invocation"); await render(process.argv[2]!, process.argv[3]!, process.argv[4]!); }
  catch (error) { console.error(error instanceof Error ? error.message : "PDF renderer failed"); process.exitCode = 1; }
}
