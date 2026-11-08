// .docx / .pptx text without Office (owner M6 2026-11-08: "unzip it yourself ... pull text from the xml"). Replaces v3's
// PowerShell/COM extractor. A minimal bounded ZIP reader (stored + deflate; no ZIP64, no encryption) and a tag-level XML text pass.
import { inflateRawSync } from "node:zlib";

export interface OfficeText { kind: "docx" | "pptx"; parts: { locator: string; text: string }[] }
export const OFFICE_LIMITS = { maxEntries: 5000, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024, maxRatio: 200 } as const;

interface Entry { name: string; method: number; flags: number; compSize: number; size: number; offset: number }

function entries(buf: Buffer): Entry[] {
  // End of central directory: last 22 bytes + up to 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP file (no central directory)");
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 files are not supported");
  if (count > OFFICE_LIMITS.maxEntries) throw new Error("too many files inside the document");
  const out: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    out.push({ flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), compSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42), name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(buf: Buffer, e: Entry, budget: { left: number }): string {
  if (e.flags & 1) throw new Error("encrypted documents are not supported");
  if (e.size > OFFICE_LIMITS.maxEntryBytes || e.size > budget.left || (e.compSize > 0 && e.size / e.compSize > OFFICE_LIMITS.maxRatio)) throw new Error("document part exceeds the size bound (possible ZIP bomb)");
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("corrupt ZIP entry");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28), data = buf.subarray(start, start + e.compSize);
  if (data.length !== e.compSize) throw new Error("truncated ZIP entry");
  const raw = e.method === 0 ? data : e.method === 8 ? inflateRawSync(data, { maxOutputLength: e.size }) : (() => { throw new Error(`unsupported ZIP compression ${e.method}`); })();
  if (raw.length !== e.size) throw new Error("ZIP entry size mismatch");
  budget.left -= raw.length;
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]!);

/** Paragraph texts from WordprocessingML (w:) or DrawingML (a:) XML: <x:t> runs joined, tabs and breaks kept. */
function paragraphs(xml: string, ns: "w" | "a"): string[] {
  const out: string[] = [];
  for (const p of xml.split(new RegExp(`</${ns}:p>`))) {
    let t = "";
    for (const m of p.matchAll(new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:(tab|br)\\b[^>]*/>`, "g"))) t += m[2] === "tab" ? "\t" : m[2] === "br" ? "\n" : decode(m[1]!);
    if (t.trim()) out.push(t.trim());
  }
  return out;
}

export function extractOfficeText(bytes: Uint8Array, name: string): OfficeText {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), list = entries(buf), budget = { left: OFFICE_LIMITS.maxTotalBytes };
  const kind = /\.pptx$/i.test(name) ? "pptx" : /\.docx$/i.test(name) ? "docx" : list.some(e => e.name === "word/document.xml") ? "docx" : list.some(e => e.name.startsWith("ppt/slides/")) ? "pptx" : undefined;
  if (kind === "docx") {
    const doc = list.find(e => e.name === "word/document.xml") ?? (() => { throw new Error("no word/document.xml in this .docx"); })();
    return { kind, parts: paragraphs(read(buf, doc, budget), "w").map((text, i) => ({ locator: `¶${i + 1}`, text })) };
  }
  if (kind === "pptx") {
    const slides = list.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => Number(/\d+/.exec(a.name.slice(11))![0]) - Number(/\d+/.exec(b.name.slice(11))![0]));
    if (!slides.length) throw new Error("no slides in this .pptx");
    return { kind, parts: slides.map(e => ({ locator: `slide ${/\d+/.exec(e.name.slice(11))![0]}`, text: paragraphs(read(buf, e, budget), "a").join("\n") })).filter(p => p.text) };
  }
  throw new Error("only .docx and .pptx Office files are supported");
}
