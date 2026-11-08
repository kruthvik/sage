// PDF text via pdf.js (unpdf), reusing the copy pi-web-access installs in Sage's own agent dir (owner 2026-11-08), so Sage adds no
// dependency of its own. Runs in a worker with a deadline; fonts are never eval'd. Untrusted file, bounded output.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export const UNPDF_LIMITS = { maxPages: 500, maxChars: 2_000_000, timeoutMs: 20_000 } as const;

/** The unpdf entry inside `<agent>/npm/node_modules/unpdf`, if present and a 1.x release (the API this code was written against). */
export function findUnpdf(agentDir: string): string | undefined {
  const dir = join(agentDir, "npm", "node_modules", "unpdf"), entry = join(dir, "dist", "index.mjs");
  try {
    const v = String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "");
    return /^1\./.test(v) && existsSync(entry) ? entry : undefined;
  } catch { return undefined; }
}

export interface UnpdfResult { pages: { pageNumber: number; text: string }[]; totalPages: number }

export function extractPdfWithUnpdf(bytes: Uint8Array, entry: string, signal?: AbortSignal): Promise<UnpdfResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./unpdf-worker.ts", import.meta.url), { workerData: { entry: pathToFileURL(entry).href, bytes, limits: UNPDF_LIMITS } });
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); void worker.terminate(); fn(); };
    const abort = () => finish(() => reject(new Error("PDF import cancelled; no source admitted")));
    const timer = setTimeout(() => finish(() => reject(new Error("PDF text extraction timed out"))), UNPDF_LIMITS.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (m: { result?: UnpdfResult; error?: string }) => finish(() => m.result ? resolve(m.result) : reject(new Error(m.error ?? "PDF text extraction failed"))));
    worker.once("error", e => finish(() => reject(e)));
    worker.once("exit", code => finish(() => reject(new Error(`PDF text worker exited (${code})`))));
  });
}
