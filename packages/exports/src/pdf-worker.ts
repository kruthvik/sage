// Ported from v3 runtime/src/markdown-pdf-worker.ts (V3_PORT: keep). Runs in an isolated subprocess; never renders HTML,
// loads URLs/images or adds PDF actions. Changes from v3: plain validation instead of typebox;
// characters the font lacks (built-in or owner-supplied) are transliterated where common, else "?" with a notice (v3 refused the file).
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, PDFName, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { marked } from "marked";
import { bareToUnicode, mathToUnicode, splitMath, type MathSpan } from "./latex.ts";
import { MATH_LIMITS, typeset, type MathBox } from "./mathsvg.ts";
import { createHash } from "node:crypto";
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");

interface Job { content: string; mediaType: "text/markdown" | "text/plain"; artifactRevisionId: string; origin: string; provenance: string; contentHash: string; fonts: "none" | "one" | "two"; maxPages: number }
interface Block { text: string; size: number; mono?: boolean }
const text = (value: unknown): string => typeof value === "string" ? value : "";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Markdown token");
  return value as Record<string, unknown>;
}
function validJob(v: unknown): asserts v is Job {
  const j = object(v);
  const ok = typeof j.content === "string" && j.content.length <= 250000 && (j.mediaType === "text/markdown" || j.mediaType === "text/plain")
    && typeof j.artifactRevisionId === "string" && j.artifactRevisionId.length >= 1 && j.artifactRevisionId.length <= 180
    && ["learner", "tutor", "source", "unknown"].includes(String(j.origin)) && typeof j.provenance === "string" && j.provenance.length <= 2000
    && typeof j.contentHash === "string" && /^[a-f0-9]{64}$/.test(j.contentHash) && ["none", "one", "two"].includes(String(j.fonts))
    && Number.isInteger(j.maxPages) && (j.maxPages as number) >= 1 && (j.maxPages as number) <= 128 && Object.keys(j).length === 8;
  if (!ok) throw new Error("Invalid PDF worker job");
}

/** Plain-text spellings for symbols the built-in (WinAnsi) font lacks. */
const TRANSLIT: Record<string, string> = {
  "∫": "integral ", "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~=", "√": "sqrt", "∞": "inf", "−": "-", "∑": "sum ", "∏": "prod ",
  "∂": "d", "∆": "Delta", "Δ": "Delta", "π": "pi", "θ": "theta", "α": "alpha", "β": "beta", "γ": "gamma", "λ": "lambda", "μ": "mu", "σ": "sigma", "ω": "omega",
  "′": "'", "″": "''", "♯": "#", "♭": "b", "✓": "[ok]", "✗": "[x]", "⁰": "^0", "⁴": "^4", "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9", "ⁿ": "^n",
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "∈": " in ", "∉": " not in ", "∀": "for all ", "∃": "exists ", "⋅": "·",
};

/** Read-only token conversion. Never render HTML, attach actions, dereference URLs or load images. */
/** Delimited maths becomes a placeholder (U+E000 n U+E001) before Markdown parsing, which would otherwise eat "\," and read
 * x_n…y_n as emphasis; it is typeset later. Undelimited commands become linear Unicode. Code spans/blocks stay exactly as written. */
function mathSource(md: string, markdown: boolean): { source: string; spans: MathSpan[] } {
  const spans: MathSpan[] = [];
  const conv = (part: string) => splitMath(part).map(p => typeof p === "string" ? bareToUnicode(p)
    : spans.length < MATH_LIMITS.perDocument ? `\uE000${spans.push(p) - 1}\uE001` : mathToUnicode(p.tex, true)).join("");
  const clean = md.replace(/[\uE000\uE001]/g, "");
  const code = /(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$|`[^`\n]+`)/m;
  return { spans, source: markdown ? clean.split(code).map((part, i) => i % 2 ? part : conv(part)).join("") : conv(clean) };
}

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

async function render(input: string, output: string, fontPath: string, monoPath: string) {
  const bytes = await readFile(input); if (bytes.length > 262144) throw new Error("PDF job input exceeds bound");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error("Invalid PDF worker job encoding/JSON", { cause }); }
  validJob(parsed); const raw = parsed;
  if (hash(Buffer.from(raw.content, "utf8")) !== raw.contentHash) throw new Error("PDF source hash mismatch");
  const doc = await PDFDocument.create(); doc.setTitle(`Sage ${raw.artifactRevisionId}`); doc.setAuthor(raw.origin); doc.setSubject(raw.provenance); doc.setCreator("Sage local pdf-lib/1.17.1"); doc.setKeywords(["artifact_only", raw.artifactRevisionId, raw.contentHash]);
  let body: PDFFont; let mono: PDFFont;
  const embed = async (p: string) => { const b = await readFile(p); if (b.length > 8388608) throw new Error("PDF font exceeds bound"); return doc.embedFont(b, { subset: true }); };
  if (raw.fonts !== "none") { doc.registerFontkit(fontkit); body = await embed(fontPath); mono = raw.fonts === "two" ? await embed(monoPath) : body; }
  else { body = await doc.embedFont(StandardFonts.Helvetica); mono = await doc.embedFont(StandardFonts.Courier); }
  const { source, spans } = mathSource(raw.content, raw.mediaType !== "text/plain");
  const content = blocks(source, raw.mediaType === "text/plain");
  const charset = new Map<PDFFont, Set<number>>([[body, new Set(body.getCharacterSet())], [mono, new Set(mono.getCharacterSet())]]);
  let replaced = 0;
  const fit = (value: string, font: PDFFont) => Array.from(value).map(ch => {
    if (ch === "\n" || charset.get(font)!.has(ch.codePointAt(0)!)) return ch;
    const t = TRANSLIT[ch]; if (t !== undefined && Array.from(t).every(c => charset.get(font)!.has(c.codePointAt(0)!))) return t;
    replaced++; return "?";
  }).join("");
  // Runs: text (fitted to the font) and typeset maths; maths MathJax can't typeset falls back to linear Unicode text.
  type Run = { kind: "text"; s: string } | { kind: "math"; box: MathBox; display: boolean };
  const runs: { block: Block; runs: Run[] }[] = [];
  for (const b of content) {
    const font = b.mono ? mono : body, parts = b.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split(/(\d+)/), out: Run[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { if (parts[i]) out.push({ kind: "text", s: fit(parts[i]!, font) }); continue; }
      const sp = spans[Number(parts[i])]!, box = await typeset(sp.tex, sp.display, b.size);
      // Not typeset (unsupported command, error, bound): linear Unicode, or the TeX as written if commands would be left mangled.
      const linear = mathToUnicode(sp.tex, true), fallback = /\\[a-zA-Z]/.test(linear) ? `$${sp.tex}$` : linear;
      out.push(box ? { kind: "math", box, display: sp.display } : { kind: "text", s: fit(fallback, font) });
    }
    runs.push({ block: b, runs: out });
  }
  const head: Block[] = [{ text: `Sage export: ${raw.artifactRevisionId}`, size: 8 },
    ...(replaced ? [{ text: `${replaced} character(s) this font can't show are printed as "?". The Markdown file has the exact text.`, size: 8 }] : [])];
  const all = head.map(b => ({ block: b, runs: [{ kind: "text", s: b.text }] as Run[] })).concat(runs);
  const width = 595.28, height = 841.89, margin = 48, available = width - margin * 2, ink = rgb(0.08, 0.08, 0.08);
  let page = doc.addPage([width, height]), y = height - margin;
  function newPage() { if (doc.getPageCount() >= raw.maxPages) throw new Error("PDF page bound exceeded"); page = doc.addPage([width, height]); y = height - margin; }
  type Item = { kind: "text"; s: string; w: number } | { kind: "math"; box: MathBox; w: number; k: number };
  /** One line: the baseline sits below the tallest item; inline maths shares the text baseline. */
  function draw(items: Item[], size: number, font: PDFFont, center: boolean) {
    const asc = Math.max(size, ...items.map(i => i.kind === "math" ? i.box.ascent * i.k + 2 : 0));
    const desc = Math.max(size * 0.4, ...items.map(i => i.kind === "math" ? i.box.descent * i.k + 2 : 0));
    if (y - asc - desc < margin) newPage();
    const base = y - asc; let x = margin + (center ? (available - items.reduce((n, i) => n + i.w, 0)) / 2 : 0);
    for (const it of items) {
      if (it.kind === "text") { if (it.s) page.drawText(it.s, { x, y: base, size, font, color: ink }); }
      else for (const p of it.box.paths) page.drawSvgPath(p, { x, y: base + it.box.ascent * it.k, scale: it.k, color: ink });
      x += it.w;
    }
    y -= asc + desc;
  }
  for (const { block, runs: rs } of all) {
    const font = block.mono ? mono : body, size = block.size, tw = (s: string) => font.widthOfTextAtSize(s, size);
    let items: Item[] = [], lw = 0;
    const flush = (center = false) => { draw(items, size, font, center); items = []; lw = 0; };
    const addText = (s: string) => { const last = items.at(-1), w = tw(s); if (last?.kind === "text") { last.s += s; last.w += w; } else items.push({ kind: "text", s, w }); lw += w; };
    for (const r of rs) {
      if (r.kind === "math") {
        const k = Math.min(1, available / r.box.width), w = r.box.width * k; // wider than the page: scaled down to fit
        if (r.display) { if (items.length) flush(); items = [{ kind: "math", box: r.box, w, k }]; flush(true); continue; }
        if (items.length && lw + w > available) flush();
        items.push({ kind: "math", box: r.box, w, k }); lw += w; continue;
      }
      r.s.split("\n").forEach((piece, n) => {
        if (n) flush();
        for (const tok of piece.match(/\S+\s*|\s+/g) ?? []) {
          if (!items.length && !tok.trim()) continue; // no leading space on a wrapped line
          if (items.length && lw + tw(tok.trimEnd()) > available) { flush(); if (!tok.trim()) continue; }
          // Character-based wrap guarantees even long source IDs/code/URLs cannot overrun the page.
          if (tw(tok.trimEnd()) > available) { for (const ch of tok) { if (items.length && lw + tw(ch) > available) flush(); addText(ch); } }
          else addText(tok);
        }
      });
    }
    flush();
    y -= 5;
  }
  const result = await doc.save(); if (result.length > 16777216) throw new Error("PDF output exceeds bound");
  const checked = await PDFDocument.load(result); if (checked.isEncrypted || checked.getPageCount() < 1 || checked.getPageCount() > raw.maxPages) throw new Error("PDF structure verification failed");
  for (const key of ["OpenAction", "AA", "Names", "AcroForm"]) if (checked.catalog.has(PDFName.of(key))) throw new Error("Active PDF content rejected");
  // pdf-lib normalizes new pages with an empty Annots array; only actual annotations are active.
  for (const p of checked.getPages()) if (p.node.has(PDFName.of("AA")) || (p.node.Annots()?.size() ?? 0) > 0) throw new Error("PDF actions/annotations rejected");
  await writeFile(output, result, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ pages: checked.getPageCount(), bytes: result.length, fileHash: hash(result), replaced }));
}
if (import.meta.main) {
  try { if (process.argv.length !== 6) throw new Error("Invalid owned PDF worker invocation"); await render(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!); }
  catch (error) { console.error(error instanceof Error ? error.message : "PDF renderer failed"); process.exitCode = 1; }
}
