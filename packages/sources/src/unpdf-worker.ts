// Worker for unpdf.ts. Loads pdf.js from the given entry; no eval of embedded fonts/scripts; page and character bounds.
import { parentPort, workerData } from "node:worker_threads";

const { entry, bytes, limits } = workerData as { entry: string; bytes: Uint8Array; limits: { maxPages: number; maxChars: number } };
try {
  const u = await import(entry) as { getDocumentProxy(d: Uint8Array, o?: Record<string, unknown>): Promise<{ numPages: number }>; extractText(p: unknown, o: { mergePages: false }): Promise<{ totalPages: number; text: string[] }> };
  if (typeof u.getDocumentProxy !== "function" || typeof u.extractText !== "function") throw new Error("installed unpdf has an unexpected API");
  const doc = await u.getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  if (doc.numPages < 1 || doc.numPages > limits.maxPages) throw new Error(`PDF has ${doc.numPages} pages; the limit is ${limits.maxPages}`);
  const r = await u.extractText(doc, { mergePages: false });
  let total = 0;
  const pages = r.text.map((t, i) => { const text = String(t ?? "").replace(/\u0000/g, "").trim(); total += text.length; return { pageNumber: i + 1, text }; });
  if (total > limits.maxChars) throw new Error("PDF text exceeds the size bound");
  parentPort!.postMessage({ result: { pages, totalPages: r.totalPages } });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  parentPort!.postMessage({ error: /password/i.test(msg) ? "Encrypted/password-protected PDFs are not supported" : `PDF text extraction failed: ${msg.slice(0, 300)}` });
}
