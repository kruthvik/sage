import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

export interface SharedPi { source: string; version: string; fingerprint: string }
const failure = () => new Error("Shared Pi is unavailable, changed or not a versioned installation; use sage pi rollback or sage pi reset. No changed runtime was selected.");
const contained = (root: string, file: string) => { const child = relative(root, file); return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child); };

async function boundedJson(file: string, limit: number): Promise<unknown> {
  const info = await lstat(file); if (!info.isFile() || info.size > limit) throw failure();
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit || bytesRead !== info.size) throw failure();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

/** Fingerprint installed executable code and dependencies, never user settings or credentials. */
export async function inspectSharedPi(input: string): Promise<SharedPi> {
  try {
    if (!isAbsolute(input)) throw failure();
    const source = await realpath(input), modules = join(source, "node_modules");
    const manifestPath = await realpath(join(modules, "@earendil-works", "pi-coding-agent", "package.json"));
    if (!contained(source, manifestPath)) throw failure();
    const manifest = await boundedJson(manifestPath, 65536) as { name?: unknown; version?: unknown };
    if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof manifest.version !== "string" || !/^1\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) || basename(source) !== manifest.version) throw failure();
    const hash = createHash("sha256"), visited = new Set<string>(); let files = 0, size = 0;
    type Entry = { file: string; actual: string; info?: Stats };
    async function* walk(file: string): AsyncGenerator<Entry> {
      const actual = await realpath(file);
      if (!contained(source, actual)) throw failure();
      if (visited.has(actual)) { yield { file, actual }; return; }
      visited.add(actual);
      const info = await lstat(actual);
      if (info.isDirectory()) {
        yield { file, actual };
        for (const entry of (await readdir(actual)).sort()) yield* walk(join(actual, entry));
        return;
      }
      if (!info.isFile() || ++files > 50000 || (size += info.size) > 1024 ** 3) throw failure();
      yield { file, actual, info };
    }
    const iterator = walk(modules), buffer = Buffer.alloc(65536);
    const pending: Array<{ entry: Entry; opened?: Promise<FileHandle | undefined> }> = [];
    let done = false;
    try {
      while (!done || pending.length) {
        // Two speculative opens avoid serial cold I/O without an eight-open warm slowdown.
        while (!done && pending.length < 2) {
          const next = await iterator.next();
          if (next.done) { done = true; break; }
          pending.push({ entry: next.value, ...(next.value.info ? { opened: open(next.value.actual, "r").catch(() => undefined) } : {}) });
        }
        const current = pending.shift(); if (!current) break;
        const { entry, opened } = current;
        hash.update(relative(source, entry.file)).update("\0").update(relative(source, entry.actual)).update("\0");
        if (!entry.info || !opened) continue;
        const info = entry.info, handle = await opened; if (!handle) throw failure();
        try {
          const before = await handle.stat();
          if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size || before.mtimeMs !== info.mtimeMs || before.ctimeMs !== info.ctimeMs) throw failure();
          let offset = 0;
          while (offset < before.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) throw failure(); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
          }
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw failure();
          hash.update("\0");
        } finally { await handle.close(); }
      }
    } finally {
      await Promise.allSettled([iterator.return(undefined), ...pending.map(async entry => { const handle = await entry.opened; return handle?.close(); })]);
    }
    return { source, version: manifest.version, fingerprint: hash.digest("hex") };
  } catch { throw failure(); }
}

export async function resolveSharedPi(directory: string): Promise<string | undefined> {
  const file = join(directory, "shared.json");
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw failure(); }
  try {
    const value = await boundedJson(file, 4096) as SharedPi;
    if (!value || Object.keys(value).sort().join() !== "fingerprint,source,version" || typeof value.source !== "string" || typeof value.version !== "string" || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw failure();
    const current = await inspectSharedPi(value.source);
    if (current.version !== value.version || current.fingerprint !== value.fingerprint) throw failure();
    return current.source;
  } catch { throw failure(); }
}
