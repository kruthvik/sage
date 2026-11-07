import { mkdir, open, realpath, lstat, link, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, win32, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "../../storage/src/store.ts";
import { Type } from "typebox";
import { validate } from "../../core/src/contracts.ts";
import type { SagePaths } from "./paths.ts";

export type VaultOrigin = "learner" | "tutor" | "source" | "unknown";
export interface VaultWriteOptions {
  vaultRoot: string;
  relativePath: string;
  content: string;
  /** Compatibility only: immutable managed notes never permit replacement. */
  overwrite?: boolean;
  origin?: VaultOrigin;
  artifactRevisionId?: string;
  sourceSpanIds?: string[];
}
export interface VaultWriteResult { fullPath: string; relativePath: string; contentHash: string; bytesWritten: number; created: boolean }
const limit = 262144;
const prefix = "<!-- Sage managed artifact ";
const idPattern = /^[A-Za-z0-9_.:-]{1,180}$/;
function inside(root: string, target: string) {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function notePath(path: string): string[] {
  if (!path || path.length > 500 || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path)) throw new Error("Path traversal denied: choose a relative managed Markdown path");
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length > 9 || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".obsidian" || p.trim() !== p || p.endsWith(".") || /[<>:"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || !/\.md$/i.test(parts.at(-1)!)) throw new Error("Path traversal denied: invalid or reserved managed Markdown path");
  return parts;
}
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const collision = (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST";
async function childDirectory(root: string, parent: string, name: string, create: boolean): Promise<string> {
  const path = join(parent, name);
  let info;
  try { info = await lstat(path); } catch (error) {
    if (!create || !missing(error)) throw error;
    try { await mkdir(path); } catch (race) { if (!collision(race)) throw race; }
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Vault path must use regular managed directories, not junctions/symlinks");
  const actual = await realpath(path);
  if (!inside(root, actual)) throw new Error("Vault path escapes its selected root");
  return actual;
}
async function targetPath(vaultRoot: string, path: string, create: boolean, namespace: "Sage" | "content" = "Sage"): Promise<string> {
  const parts = notePath(path);
  const root = await realpath(resolve(vaultRoot));
  if (!(await lstat(root)).isDirectory()) throw new Error("Vault root must be an existing selected directory");
  let parent = await childDirectory(root, root, namespace, create);
  for (const part of parts.slice(0, -1)) parent = await childDirectory(root, parent, part, create);
  return join(parent, parts.at(-1)!);
}
interface ManagedNote { content: string; contentHash: string; storedText: string; origin: VaultOrigin }
function decodeNote(bytes: Uint8Array): ManagedNote {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (cause) { throw new Error("Vault conflict: invalid note encoding", { cause }); }
  const newline = text.indexOf("\n"); const header = text.slice(0, newline);
  if (newline < 0 || (!header.startsWith(prefix) && !header.startsWith("<!-- Sato managed artifact ")) || !header.endsWith(" -->")) throw new Error("Vault conflict: existing note is not a Sage-managed artifact");
  let value: unknown;
  try { value = JSON.parse(header.slice(prefix.length, -4)); } catch (cause) { throw new Error("Vault conflict: invalid managed ownership header", { cause }); }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("contentHash" in value) || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash) || !("origin" in value) || !["learner", "tutor", "source", "unknown"].includes(String(value.origin))) throw new Error("Vault conflict: invalid managed ownership header");
  const origin = value.origin;
  if (origin !== "learner" && origin !== "tutor" && origin !== "source" && origin !== "unknown") throw new Error("Vault conflict: invalid origin");
  const content = text.slice(newline + 1);
  if (hash(Buffer.from(content, "utf8")) !== value.contentHash) throw new Error("Vault conflict: managed note was modified; preserve annotations and use a new versioned path");
  return { content, contentHash: value.contentHash, storedText: text, origin };
}
async function readBoundedFile(target: string, bound: number): Promise<Uint8Array> {
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > bound) throw new Error("Vault path must be a bounded regular, unlinked file");
  const file = await open(target, "r");
  try {
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size > bound || info.nlink !== 1) throw new Error("Vault path changed during read");
    const bytes = Buffer.alloc(bound + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > bound) throw new Error("Vault file exceeds its bounded size");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function readNote(target: string): Promise<ManagedNote> { return decodeNote(await readBoundedFile(target, limit)); }

/** Immutable/versioned projections. Atomic create-only publication never replaces a user file. */
async function writeOwnedArtifact(options: VaultWriteOptions, namespace: "Sage" | "content"): Promise<VaultWriteResult> {
  if (options.content.includes("\0") || Buffer.byteLength(options.content, "utf8") > limit - 10000) throw new Error("Vault note content exceeds the text bound");
  const origin = options.origin ?? "tutor";
  if (!["learner", "tutor", "source", "unknown"].includes(origin) || (options.artifactRevisionId && !idPattern.test(options.artifactRevisionId)) || (options.sourceSpanIds && (options.sourceSpanIds.length > 40 || options.sourceSpanIds.some(id => !idPattern.test(id))))) throw new Error("Invalid vault provenance");
  const contentHash = hash(Buffer.from(options.content, "utf8"));
  const storedText = `${prefix}${JSON.stringify({ version: 1, contentHash, origin, artifactRevisionId: options.artifactRevisionId, sourceSpanIds: options.sourceSpanIds ?? [] })} -->\n${options.content}`;
  const bytes = Buffer.from(storedText, "utf8");
  const target = await targetPath(options.vaultRoot, options.relativePath, true, namespace);
  const receipt = (created: boolean): VaultWriteResult => ({ fullPath: target, relativePath: options.relativePath.replace(/\\/g, "/"), contentHash, bytesWritten: created ? bytes.length : 0, created });
  try {
    const existing = await readNote(target);
    if (existing.storedText === storedText) return receipt(false);
    throw new Error("Vault conflict: immutable note exists; use a new versioned path");
  } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(dirname(target), `.sage-note-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    try { await link(temporary, target); } catch (error) {
      if (!collision(error)) throw error;
      const existing = await readNote(target);
      if (existing.storedText === storedText) return receipt(false);
      throw new Error("Vault conflict: another writer published this path");
    }
  } finally { await file.close(); await unlink(temporary); }
  const verified = await readNote(target);
  if (verified.storedText !== storedText) throw new Error("Vault artifact verification failed");
  return receipt(true);
}
export function writeVaultArtifact(options: VaultWriteOptions): Promise<VaultWriteResult> {
  return writeOwnedArtifact(options, "Sage");
}
/** Same immutable publication guards; only the explicitly selected Sage home owns content/. */
export function writeContentArtifact(paths: SagePaths, options: Omit<VaultWriteOptions, "vaultRoot">): Promise<VaultWriteResult> {
  return writeOwnedArtifact({ ...options, vaultRoot: paths.home }, "content");
}
export async function readVaultArtifact(vaultRoot: string, path: string): Promise<string> {
  return (await readNote(await targetPath(vaultRoot, path, false))).content;
}
export async function vaultOpenUri(vaultRoot: string, path: string): Promise<string> {
  const target = await targetPath(vaultRoot, path, false); await readNote(target);
  return `obsidian://open?path=${encodeURIComponent(target)}`;
}

export interface VaultConfiguration { version: 1; vaultRoot: string; device: number; inode: number }
const VaultConfigurationSchema = Type.Object({ version: Type.Literal(1), vaultRoot: Type.String({ minLength: 1, maxLength: 2000 }), device: Type.Number({ minimum: 0 }), inode: Type.Number({ minimum: 0 }) }, { additionalProperties: false });
async function settingsFile(paths: SagePaths, create = false): Promise<string> {
  if (resolve(paths.config) !== resolve(paths.home, "config")) throw new Error("Vault configuration path must be Sage's own configuration directory");
  const root = await realpath(paths.home);
  let info;
  try { info = await lstat(paths.config); } catch (error) {
    if (!create || !missing(error)) throw error;
    try { await mkdir(paths.config); } catch (race) { if (!collision(race)) throw race; }
    info = await lstat(paths.config);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Vault configuration path cannot be a junction/symlink");
  const directory = await realpath(paths.config);
  if (!inside(root, directory)) throw new Error("Vault configuration path escapes Sage home");
  return join(directory, "vault.json");
}
export async function readVaultConfig(paths: SagePaths): Promise<VaultConfiguration | undefined> {
  let filename: string;
  try { filename = await settingsFile(paths); } catch (error) { if (missing(error)) return undefined; throw error; }
  let bytes: Uint8Array;
  try { bytes = await readBoundedFile(filename, 4096); } catch (error) { if (missing(error)) return undefined; throw error; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error("Vault configuration is corrupt; preserved unchanged for local resolution", { cause }); }
  validate<VaultConfiguration>(VaultConfigurationSchema, value);
  let info;
  try { info = await lstat(value.vaultRoot); } catch (cause) { throw new Error("Configured vault changed or disappeared; resolve it locally before exporting", { cause }); }
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== value.device || info.ino !== value.inode || await realpath(value.vaultRoot) !== value.vaultRoot) throw new Error("Configured vault changed; no automatic redirection or note migration is permitted");
  return value;
}
/** Explicit local settings, not learning memory/evidence and never inferred from a global app. */
export async function configureVault(paths: SagePaths, selectedPath: string): Promise<VaultConfiguration> {
  const filename = await settingsFile(paths, true);
  const selected = await realpath(resolve(selectedPath)); const info = await lstat(selected);
  if (!info.isDirectory()) throw new Error("Select an existing vault directory");
  const existing = await readVaultConfig(paths);
  if (existing) {
    if (existing.vaultRoot === selected) return existing;
    throw new Error("One vault is already configured; explicit local resolution is required before switching. No notes were moved.");
  }
  const config: VaultConfiguration = { version: 1, vaultRoot: selected, device: info.dev, inode: info.ino };
  const temporary = join(dirname(filename), `.vault-config-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(config)); await file.sync(); await file.close();
    try { await link(temporary, filename); } catch (error) { if (!collision(error)) throw error; }
  } finally { await file.close(); await unlink(temporary); }
  const verified = await readVaultConfig(paths);
  if (!verified || verified.vaultRoot !== selected) throw new Error("Another vault is already configured; no settings were overwritten");
  return verified;
}
