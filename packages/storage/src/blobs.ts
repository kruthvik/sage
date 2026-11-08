// Content-addressed blob store (SPEC §13: data/blobs/). Photos of learner working only; never uploaded except by a role call the learner consented to.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./ledger.ts";

export const IMAGE_LIMITS = { maxBytes: 5 * 1024 * 1024, maxImages: 4 } as const;
const MAGIC: [string, (b: Uint8Array) => boolean][] = [
  ["image/png", b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", b => Buffer.from(b.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("ascii") === "WEBP"],
];
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The media type from the bytes themselves (the declared type is not trusted), or undefined if not PNG/JPEG/WebP. */
export const sniffImage = (b: Uint8Array) => MAGIC.find(([, ok]) => ok(b))?.[0];

/** Stores bytes under their sha256; returns the hash. Idempotent. */
export function putImage(dir: string, bytes: Uint8Array): { hash: string; mimeType: string } {
  if (bytes.length < 16 || bytes.length > IMAGE_LIMITS.maxBytes) throw new Error(`each image must be under ${IMAGE_LIMITS.maxBytes / 1048576} MB`);
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new Error("only PNG, JPEG or WebP photos are accepted");
  const h = hash(bytes), p = join(dir, `${h}.${EXT[mimeType]}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(p)) { const tmp = `${p}.tmp`; writeFileSync(tmp, bytes); renameSync(tmp, p); }
  return { hash: h, mimeType };
}

/** Reads a stored image back and re-checks its hash. */
export function readImage(dir: string, h: string): { data: string; mimeType: string } {
  if (!/^[a-f0-9]{64}$/.test(h)) throw new Error("invalid blob hash");
  for (const [mimeType, ext] of Object.entries(EXT)) {
    const p = join(dir, `${h}.${ext}`);
    if (!existsSync(p)) continue;
    const b = readFileSync(p);
    if (hash(b) !== h) throw new Error("stored image changed on disk");
    return { data: b.toString("base64"), mimeType };
  }
  throw new Error("image not found");
}
