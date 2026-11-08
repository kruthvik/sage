// Ported from v3 packages/sources/src/limits.ts (V3_PORT: keep; owner M6 2026-11-08).
export const SOURCE_FILE_BYTES = 50 * 1024 * 1024;
export const SOURCE_FILE_CEILING = 200 * 1024 * 1024;
export type ConfirmLargeSource = (file: { path: string; size: number }) => Promise<boolean>;

/** Size decisions are not PDF extraction failures and must never trigger OCR fallback. */
export class SourceSizeError extends Error {}

export function sourceInputLimit(bytes = SOURCE_FILE_BYTES): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > SOURCE_FILE_CEILING) throw new SourceSizeError("Invalid source input bound; maximum 200 MiB");
  return bytes;
}
