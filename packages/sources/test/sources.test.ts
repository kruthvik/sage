// Learner sources (owner M6): extraction, review → accept with sharing consent, removal blocks use, lexical excerpts.
import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Ledger } from "../../storage/src/ledger.ts";
import { SourceStore } from "../src/store.ts";
import { intakeFile, intakeText } from "../src/intake.ts";
import { extractOfficeText } from "../src/office.ts";
import { youtubeId } from "../src/captions.ts";

/** Minimal ZIP writer for fixtures (deflate). */
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content), comp = deflateRawSync(raw), n = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, n, comp); central.push(c, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const docx = (paras: string[]) => zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": `<w:document><w:body>${paras.map(p => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` });

test("docx and pptx text come out of the XML with paragraph/slide locators; bombs and junk are refused", () => {
  const d = extractOfficeText(docx(["Mitosis has four phases.", "Prophase &amp; metaphase come first."]), "bio.docx");
  expect(d.parts).toEqual([{ locator: "¶1", text: "Mitosis has four phases." }, { locator: "¶2", text: "Prophase & metaphase come first." }]);
  const p = extractOfficeText(zip({ "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>", "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>" }), "deck.pptx");
  expect(p.parts.map(x => x.locator + ":" + x.text)).toEqual(["slide 1:First", "slide 2:Second"]);
  expect(() => extractOfficeText(zip({ "word/document.xml": Buffer.alloc(8 * 1024 * 1024, 0x20) }), "bomb.docx")).toThrow(/size bound/);
  expect(() => extractOfficeText(Buffer.from("not a zip at all, sorry"), "x.docx")).toThrow();
});

test("PDF text is extracted per page", async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("The chain rule multiplies derivatives.", { x: 50, y: 700, font, size: 12 });
  doc.addPage().drawText("Integration by parts reverses the product rule.", { x: 50, y: 700, font, size: 12 });
  const r = await intakeFile("calc.pdf", await doc.save({ useObjectStreams: false }));
  expect(r.kind).toBe("pdf"); expect(r.parts.map(p => p.locator)).toEqual(["p1", "p2"]); expect(r.parts[1]!.text).toContain("product rule");
});

test("review lifecycle: nothing reaches a model before accept + sharing consent; removal blocks use", () => {
  const s = new SourceStore(new Ledger(":memory:"));
  const a = s.add(intakeText("Notes", "Photosynthesis makes glucose from light.\n".repeat(3) + "\nThe Krebs cycle runs in the mitochondria."));
  expect(a.status).toBe("needs_review"); expect(s.excerpts([a.sourceId], "krebs")).toEqual([]);
  s.accept(a.sourceId, false); expect(s.excerpts([a.sourceId], "krebs")).toEqual([]); // accepted but not consented to share
  s.accept(a.sourceId, true);
  const ex = s.excerpts([a.sourceId], "Where does the Krebs cycle happen?");
  expect(ex[0]!.text).toContain("Krebs"); expect(ex[0]!.locator).toMatch(/^L\d/);
  expect(s.add(intakeText("Notes", "Photosynthesis makes glucose from light.\n".repeat(3) + "\nThe Krebs cycle runs in the mitochondria.")).revisionId).toBe(s.get(a.sourceId)!.revisionId); // same content: same source
  s.remove(a.sourceId);
  expect(s.excerpts([a.sourceId], "krebs")).toEqual([]);
  expect(() => s.accept(a.sourceId, true)).toThrow(/removed/);
  expect(s.list()[0]!.status).toBe("removed");
});

test("only YouTube video URLs are treated as YouTube", () => {
  expect(youtubeId("https://www.youtube.com/watch?v=arj7oStGLkU")).toBe("arj7oStGLkU");
  expect(youtubeId("https://youtu.be/arj7oStGLkU")).toBe("arj7oStGLkU");
  expect(youtubeId("http://youtube.com/watch?v=arj7oStGLkU")).toBeUndefined();
  expect(youtubeId("https://evil.example/watch?v=arj7oStGLkU")).toBeUndefined();
});

test.if(process.platform === "win32")("scans are read by local OCR (Tesseract)", async () => {
  const png = await Bun.file(`${import.meta.dir}/fixtures/working.png`).bytes();
  const r = await intakeFile("scan.png", png);
  expect(r.parts.map(p => p.text).join(" ")).toMatch(/x\s*=\s*5/);
}, 30000);

test.if(process.platform === "win32")("a PDF with object streams falls back to local OCR, with a warning", async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("Osmosis moves water across a membrane.", { x: 50, y: 700, font, size: 24 });
  const r = await intakeFile("bio.pdf", await doc.save()); // pdf-lib's default uses object streams
  expect(r.method).toBe("local-ocr-v1"); expect(r.warnings[0]).toContain("OCR"); expect(r.parts.map(p => p.text).join(" ")).toMatch(/Osmosis/i);
}, 30000);
