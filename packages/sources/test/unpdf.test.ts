// PDF text through pdf.js (unpdf reused from pi-web-access's install in Sage's agent dir). Skips where it isn't installed.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { sagePaths } from "../../core/src/paths.ts";
import { findUnpdf } from "../src/unpdf.ts";
import { intakeFile } from "../src/intake.ts";

const entry = findUnpdf(sagePaths().agent);
const font = "C:/Windows/Fonts/arial.ttf";

test.if(!!entry && process.platform === "win32")("embedded TrueType fonts, object streams, Unicode maths and >12 pages all keep their text", async () => {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const f = await doc.embedFont(await Bun.file(font).bytes(), { subset: true });
  for (let i = 1; i <= 15; i++) doc.addPage().drawText(`Page ${i}: ∫ x² dx = x³/3`, { x: 50, y: 700, font: f, size: 14 });
  doc.addPage(); // an image-only / blank page
  const r = await intakeFile("lecture.pdf", await doc.save(), undefined, { unpdfEntry: entry! }); // pdf-lib's default save uses object streams
  expect(r.method).toBe("unpdf-pdfjs-v1");
  expect(r.parts).toHaveLength(15); expect(r.parts[14]).toEqual({ locator: "p15", text: "Page 15: ∫ x² dx = x³/3" });
  expect(r.warnings[0]).toContain("1 of 16 pages had no text");
}, 30000);

test.if(!!entry)("a corrupt PDF is refused, not half-read", async () => {
  await expect(intakeFile("bad.pdf", Buffer.from("%PDF-1.7\nthis is not really a pdf"), undefined, { unpdfEntry: entry! })).rejects.toThrow(/PDF/);
}, 30000);

test("only a 1.x unpdf in <agent>/npm/node_modules is used", () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-")), dir = join(agent, "npm", "node_modules", "unpdf");
  expect(findUnpdf(agent)).toBeUndefined();
  mkdirSync(join(dir, "dist"), { recursive: true }); writeFileSync(join(dir, "dist", "index.mjs"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" })); expect(findUnpdf(agent)).toBeUndefined();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.9.1" })); expect(findUnpdf(agent)).toBe(join(dir, "dist", "index.mjs"));
});
