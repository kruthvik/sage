// Ported from v3 packages/sources/src/pdf-worker.ts (V3_PORT: keep; owner M6 2026-11-08).
import { parentPort, workerData } from "node:worker_threads";
import { extractPdfText } from "./pdf.ts";

// Owned decoder worker, not an OS sandbox. It never opens files or resources.
try {
  const { buffer, maxInputBytes } = workerData as { buffer: Uint8Array; maxInputBytes: number };
  parentPort!.postMessage({ result: extractPdfText(buffer, maxInputBytes) });
}
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : "Malformed PDF" }); }
