// Ported from v3 packages/sources/src/pdf.ts (V3_PORT: keep; owner M6 2026-11-08).
import { inflateSync } from "node:zlib";
import { PDFString, PDFHexString } from "pdf-lib";
import { Worker } from "node:worker_threads";
import { sourceInputLimit } from "./limits.ts";

/** Enforced deadline/cancellation for source admission; worker is not a sandbox. */
export async function extractPdfTextBounded(buffer: Uint8Array, options: { timeoutMs?: number; signal?: AbortSignal; maxInputBytes?: number } = {}): Promise<PdfExtractionResult> {
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error("Invalid PDF decoder deadline");
  const maxInputBytes = sourceInputLimit(options.maxInputBytes);
  if (buffer.byteLength > maxInputBytes) throw unsupported("input bound exceeded");
  if (options.signal?.aborted) throw new Error("PDF import cancelled; no revision admitted");
  const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { workerData: { buffer, maxInputBytes } });
  let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
  try {
    return await new Promise<PdfExtractionResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PDF decoder timed out; no revision admitted")), timeout);
      cancel = () => reject(new Error("PDF import cancelled; no revision admitted"));
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      worker.once("message", (message: { result?: PdfExtractionResult; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else if (message.result) resolve(message.result);
        else reject(new Error("Invalid PDF worker result"));
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("PDF decoder exited without a result")));
    });
  } finally {
    clearTimeout(timer); if (cancel) options.signal?.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}

export interface PdfPage { pageNumber: number; text: string }
export interface PdfExtractionResult { pages: PdfPage[]; totalLength: number }

// Decoded-content bounds stay independent of the authorized original-file size.
const MAX_BYTES = 10 * 1024 * 1024, MAX_PAGES = 128, MAX_OBJECTS = 4096;
type Ref = { id: number; generation: number };
type Value = null | boolean | number | string | Uint8Array | Ref | Value[] | Map<string, Value>;
const malformed = () => new Error("Malformed PDF; no partial extraction accepted");
const unsupported = (detail: string) => new Error(`Unsupported PDF ${detail}; use a supported text PDF or manual UTF-8 source`);
const isRef = (value: Value | undefined): value is Ref => !!value && typeof value === "object" && "id" in value;

/** Strict bounded syntax reader; never repairs broken objects or guesses stream boundaries. */
class Reader {
  constructor(readonly data: string, public pos = 0) {}
  skip() { for (;;) { while (/[\x00\t\n\f\r ]/.test(this.data[this.pos] ?? "x")) this.pos++; if (this.data[this.pos] !== "%") break; while (this.pos < this.data.length && !/[\r\n]/.test(this.data[this.pos]!)) this.pos++; } }
  word() { this.skip(); const start = this.pos; while (this.pos < this.data.length && !/[\x00\t\n\f\r ()<>\[\]{}\/%]/.test(this.data[this.pos]!)) this.pos++; if (start === this.pos) throw malformed(); return this.data.slice(start, this.pos); }
  expect(word: string) { if (this.word() !== word) throw malformed(); }
  integer() { const word = this.word(); if (!/^\d+$/.test(word) || !Number.isSafeInteger(Number(word))) throw malformed(); return Number(word); }
  value(depth = 0): Value {
    if (depth > 32) throw unsupported("nesting bound exceeded");
    this.skip(); const c = this.data[this.pos];
    if (c === "(") {
      const start = ++this.pos; let nesting = 1;
      while (this.pos < this.data.length && nesting) {
        const char = this.data[this.pos++]!;
        if (char === "\\") { if (this.pos >= this.data.length) throw malformed(); this.pos++; }
        else if (char === "(") { if (++nesting > 32) throw unsupported("string nesting bound exceeded"); }
        else if (char === ")") nesting--;
      }
      if (nesting) throw malformed();
      return PDFString.of(this.data.slice(start, this.pos - 1).replace(/\r\n?/g, "\n")).asBytes();
    }
    if (c === "<" && this.data[this.pos + 1] !== "<") {
      const start = ++this.pos, end = this.data.indexOf(">", start);
      if (end < 0) throw malformed();
      const hex = this.data.slice(start, end).replace(/[\x00\t\n\f\r ]/g, "");
      if (!/^[a-fA-F0-9]*$/.test(hex)) throw malformed();
      this.pos = end + 1; return PDFHexString.of(hex.length % 2 ? hex + "0" : hex).asBytes();
    }
    if (c === "<") {
      this.pos += 2; const dict = new Map<string, Value>();
      for (;;) {
        this.skip(); if (this.data.slice(this.pos, this.pos + 2) === ">>") { this.pos += 2; return dict; }
        const key = this.value(depth + 1);
        if (typeof key !== "string" || !key.startsWith("/") || dict.has(key)) throw malformed();
        dict.set(key, this.value(depth + 1));
      }
    }
    if (c === "[") {
      this.pos++; const values: Value[] = [];
      for (;;) { this.skip(); if (this.data[this.pos] === "]") { this.pos++; return values; } values.push(this.value(depth + 1)); if (values.length > MAX_OBJECTS) throw unsupported("array bound exceeded"); }
    }
    if (c === "/") {
      const start = this.pos++; while (this.pos < this.data.length && !/[\x00\t\n\f\r ()<>\[\]{}\/%]/.test(this.data[this.pos]!)) this.pos++;
      const name = this.data.slice(start, this.pos);
      if (/#(?![a-fA-F0-9]{2})/.test(name)) throw malformed();
      return name.replace(/#([a-fA-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    const word = this.word();
    if (word === "null") return null;
    if (word === "true" || word === "false") return word === "true";
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) throw malformed();
    const number = Number(word); if (!Number.isFinite(number)) throw malformed();
    const after = this.pos;
    if (/^\d+$/.test(word)) {
      this.skip(); const ref = /^(\d+)\s+R(?=[\x00\t\n\f\r ()<>\[\]{}\/%]|$)/.exec(this.data.slice(this.pos));
      if (ref) { this.pos += ref[0].length; return { id: number, generation: Number(ref[1]) }; }
    }
    this.pos = after; return number;
  }
}

interface ObjectEntry { value: Value; stream?: Uint8Array }
function dictionary(value: Value | undefined): Map<string, Value> { if (!(value instanceof Map)) throw malformed(); return value; }

/** Supported subset: single classic xref, ordinary page tree, direct stream lengths,
 * unfiltered/Flate Contents and ASCII WinAnsi Type1 text. No OCR or recovery. */
export function extractPdfText(buffer: Uint8Array, maxInputBytes?: number): PdfExtractionResult {
  if (buffer.byteLength > sourceInputLimit(maxInputBytes)) throw unsupported("input bound exceeded");
  const data = Buffer.from(buffer).toString("latin1");
  if (!data.startsWith("%PDF-")) throw new Error("Invalid PDF signature: expected %PDF- header");
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(data);
  if (!tail) throw malformed();
  const xrefOffset = Number(tail[1]);
  const xref = new Reader(data, xrefOffset);
  if (data.slice(xrefOffset, xrefOffset + 4) !== "xref") {
    if (/^\d+\s+\d+\s+obj/.test(data.slice(xrefOffset))) throw unsupported("xref/object streams");
    throw malformed();
  }
  xref.expect("xref");
  const offsets = new Map<number, { offset: number; generation: number }>();
  let entries = 0;
  for (;;) {
    xref.skip(); if (data.slice(xref.pos, xref.pos + 7) === "trailer") break;
    const first = xref.integer(), count = xref.integer();
    if (!count || (entries += count) > MAX_OBJECTS) throw unsupported("object bound exceeded");
    for (let i = 0; i < count; i++) {
      const offset = xref.integer(), generation = xref.integer(), state = xref.word();
      if (state !== "n" && state !== "f") throw malformed();
      if (state === "n") {
        if (offsets.has(first + i) || offset < 1 || offset >= xrefOffset || generation > 65535) throw malformed();
        offsets.set(first + i, { offset, generation });
      }
    }
  }
  xref.expect("trailer"); const trailer = dictionary(xref.value());
  if (trailer.has("/Encrypt")) throw new Error("Encrypted/password-protected PDFs are not supported");
  if (trailer.has("/Prev") || trailer.has("/XRefStm")) throw unsupported("incremental/hybrid xref");
  xref.expect("startxref"); if (xref.integer() !== xrefOffset) throw malformed();
  if (data.slice(xref.pos).trim() !== "%%EOF") throw malformed();
  const size = trailer.get("/Size");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || [...offsets.keys()].some(id => id >= size)) throw malformed();
  const objects = new Map<number, ObjectEntry>();
  const sorted = [...offsets.entries()].sort((a, b) => a[1].offset - b[1].offset);
  const header = new Reader(data); header.skip();
  if (header.pos !== sorted[0]?.[1].offset) throw malformed();
  for (let i = 0; i < sorted.length; i++) {
    const [id, info] = sorted[i]!, end = sorted[i + 1]?.[1].offset ?? xrefOffset;
    if (info.offset >= end) throw malformed();
    const reader = new Reader(data.slice(0, end), info.offset);
    if (reader.integer() !== id || reader.integer() !== info.generation) throw malformed();
    reader.expect("obj"); const value = reader.value(); const entry: ObjectEntry = { value };
    reader.skip();
    if (data.slice(reader.pos, reader.pos + 6) === "stream") {
      reader.pos += 6;
      const eol = /^(?:\r\n|\n|\r)/.exec(data.slice(reader.pos)); if (!eol) throw malformed(); reader.pos += eol[0].length;
      const dict = dictionary(value), length = dict.get("/Length");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || reader.pos + length >= end) throw unsupported("indirect/invalid stream length");
      entry.stream = buffer.subarray(reader.pos, reader.pos + length); reader.pos += length;
      reader.expect("endstream");
      if (dict.get("/Type") === "/ObjStm" || dict.get("/Type") === "/XRef") throw unsupported("object/xref streams");
      if (dict.has("/DecodeParms") || dict.has("/F") || dict.has("/FFilter")) throw unsupported("stream parameters/external streams");
      const filter = dict.get("/Filter"); if (filter !== undefined && filter !== "/FlateDecode") throw unsupported("stream filter");
    }
    reader.expect("endobj"); reader.skip(); if (reader.pos !== end) throw malformed();
    objects.set(id, entry);
  }
  const resolve = (value: Value | undefined): Value | undefined => {
    if (!isRef(value)) return value;
    const entry = objects.get(value.id), info = offsets.get(value.id);
    if (!entry || info?.generation !== value.generation) throw malformed();
    return entry.value;
  };
  const root = dictionary(resolve(trailer.get("/Root")));
  if (root.get("/Type") !== "/Catalog") throw malformed();
  let decodedBytes = 0;
  const content = (ref: Value): string => {
    if (!isRef(ref)) throw unsupported("inline Contents");
    resolve(ref); const entry = objects.get(ref.id)!;
    if (!entry.stream) throw malformed();
    let bytes = entry.stream;
    const remaining = MAX_BYTES - decodedBytes;
    if (remaining <= 0) throw unsupported("decoded byte bound exceeded");
    if (dictionary(entry.value).get("/Filter") === "/FlateDecode") {
      try {
        // Bun's info:true reports consumed input; plain inflate ignores trailing corruption.
        const inflated: unknown = inflateSync(bytes, { maxOutputLength: remaining, info: true });
        if (!inflated || typeof inflated !== "object" || !("buffer" in inflated) || !(inflated.buffer instanceof Uint8Array) || !("engine" in inflated)) throw malformed();
        const engine = inflated.engine;
        if (!engine || typeof engine !== "object" || !("bytesWritten" in engine) || engine.bytesWritten !== bytes.length) throw malformed();
        bytes = inflated.buffer;
      }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") throw unsupported("decoded byte bound exceeded");
        throw malformed();
      }
    }
    decodedBytes += bytes.length; if (decodedBytes > MAX_BYTES) throw unsupported("decoded byte bound exceeded");
    return Buffer.from(bytes).toString("latin1");
  };
  const pages: PdfPage[] = [], visited = new Set<number>();
  function walk(ref: Value | undefined, resources?: Value, parent?: Ref, depth = 0): number {
    if (!isRef(ref) || visited.has(ref.id) || depth > 32) throw malformed();
    visited.add(ref.id); const node = dictionary(resolve(ref));
    if (parent) { const actual = node.get("/Parent"); if (!isRef(actual) || actual.id !== parent.id || actual.generation !== parent.generation) throw malformed(); }
    resources = node.get("/Resources") ?? resources;
    if (node.get("/Type") === "/Pages") {
      const kids = resolve(node.get("/Kids")); if (!Array.isArray(kids) || !kids.length) throw malformed();
      const count = kids.reduce<number>((n, kid) => n + walk(kid, resources, ref, depth + 1), 0);
      if (node.get("/Count") !== count) throw malformed(); return count;
    }
    if (node.get("/Type") !== "/Page") throw malformed();
    if (pages.length >= MAX_PAGES) throw unsupported("page bound exceeded");
    const contents = node.get("/Contents");
    const resolved = resolve(contents);
    const streams = Array.isArray(resolved) ? resolved : contents ? [contents] : [];
    if (!streams.length) throw new Error("PDF page contains no extractable text; scanned documents and OCR are not supported; use a manual text source");
    const text = textFromContents(streams.map(content).join("\n"), dictionary(resolve(resources)), resolve);
    if (!text) throw new Error("PDF page contains no extractable text; scanned documents and OCR are not supported; use a manual text source");
    pages.push({ pageNumber: pages.length + 1, text }); return 1;
  }
  walk(root.get("/Pages"));
  return { pages, totalLength: pages.reduce((n, page) => n + page.text.length, 0) };
}

function textFromContents(data: string, resources: Map<string, Value>, resolve: (v: Value | undefined) => Value | undefined): string {
  const reader = new Reader(data), chunks: string[] = [], savedFonts: boolean[] = []; let operands: Value[] = [], inText = false, font = false;
  const fonts = () => dictionary(resolve(resources.get("/Font")));
  const show = (value: Value | undefined) => {
    if (!inText || !font || !(value instanceof Uint8Array)) throw malformed();
    if (value.some(byte => byte > 126 || (byte < 32 && ![9, 10, 13].includes(byte)))) throw unsupported("non-ASCII text encoding");
    chunks.push(Buffer.from(value).toString("ascii"));
  };
  const numeric: Record<string, number> = { cm: 6, w: 1, J: 1, j: 1, M: 1, i: 1, m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4, Tc: 1, Tw: 1, Tz: 1, TL: 1, Tr: 1, Ts: 1, Td: 2, TD: 2, Tm: 6 };
  const empty = new Set("h S s f F f* B B* b b* n W W* T*".split(" "));
  for (;;) {
    reader.skip(); if (reader.pos >= data.length) break;
    if (/[\/<\[(+\-.\d]/.test(data[reader.pos]!)) { operands.push(reader.value()); if (operands.length > MAX_OBJECTS) throw unsupported("operand bound exceeded"); continue; }
    const op = reader.word();
    if (op === "BT") { if (inText || operands.length) throw malformed(); inText = true; chunks.push(" "); }
    else if (op === "ET") { if (!inText || operands.length) throw malformed(); inText = false; }
    else if (op === "Tf") {
      if (!inText || operands.length !== 2 || typeof operands[0] !== "string" || typeof operands[1] !== "number") throw malformed();
      const dict = dictionary(resolve(fonts().get(operands[0])));
      if (dict.get("/Type") !== "/Font" || dict.get("/Subtype") !== "/Type1" || dict.get("/Encoding") !== "/WinAnsiEncoding" || dict.has("/ToUnicode") || dict.has("/FontDescriptor") || !/^\/(Helvetica|Times|Courier)(?:-(Bold|Oblique|BoldOblique|Roman|Italic|BoldItalic))?$/.test(String(dict.get("/BaseFont")))) throw unsupported("font/encoding");
      font = true;
    } else if (op === "Tj" || op === "'" || op === '"') {
      if (operands.length !== (op === '"' ? 3 : 1) || (op === '"' && operands.slice(0, 2).some(value => typeof value !== "number"))) throw malformed();
      if (op !== "Tj") chunks.push(" "); show(operands.at(-1));
    } else if (op === "TJ") {
      if (operands.length !== 1 || !Array.isArray(operands[0])) throw malformed();
      const parts: Uint8Array[] = [];
      for (const value of operands[0]) {
        if (value instanceof Uint8Array) parts.push(value);
        else if (typeof value !== "number") throw malformed();
      }
      show(Buffer.concat(parts));
    } else if (op === "q" || op === "Q") {
      if (operands.length) throw malformed();
      if (op === "q") { if (savedFonts.length >= 32) throw unsupported("graphics nesting bound exceeded"); savedFonts.push(font); }
      else { if (!savedFonts.length) throw malformed(); font = savedFonts.pop()!; }
    } else if (op in numeric) {
      if (operands.length !== numeric[op] || operands.some(value => typeof value !== "number")) throw malformed();
      if (["Td", "TD", "Tm"].includes(op)) { if (!inText) throw malformed(); chunks.push(" "); }
    } else if (empty.has(op)) {
      if (operands.length) throw malformed();
      if (op === "T*") { if (!inText) throw malformed(); chunks.push(" "); }
    } else if (["ri", "CS", "cs"].includes(op)) {
      if (operands.length !== 1 || typeof operands[0] !== "string") throw malformed();
    } else if (["SC", "SCN", "sc", "scn"].includes(op)) {
      if (!operands.length || operands.some(value => typeof value !== "number")) throw unsupported("pattern/color operands");
    } else if (op === "d") {
      if (operands.length !== 2 || !Array.isArray(operands[0]) || operands[0].some(value => typeof value !== "number") || typeof operands[1] !== "number") throw malformed();
    } else throw unsupported(`content operator ${op}`);
    operands = [];
  }
  if (inText || operands.length || savedFonts.length) throw malformed();
  return chunks.join("").replace(/\s+/g, " ").trim();
}
