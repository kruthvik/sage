import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { SagePaths } from "./paths.ts";

export interface UsageTotals { total_sessions: number; total_hours: number }
export interface UsageSnapshot extends UsageTotals { enabled: boolean; available: boolean; error?: string }
export interface UsageTracker {
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  snapshot(): UsageSnapshot;
  subscribe(listener: () => void): () => void;
}
const unavailable = "Local usage tracking is unavailable; existing files were not changed. You can still turn tracking off.";
const bound = 4096;

async function directory(paths: SagePaths, kind: "config" | "data") {
  if (resolve(paths[kind]) !== resolve(paths.home, kind)) throw new Error("Invalid local usage directory");
  await mkdir(paths.home, { recursive: true });
  const root = await realpath(paths.home), child = join(root, kind);
  try { await mkdir(child); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(child), actual = await realpath(child), rel = relative(root, actual);
  if (info.isSymbolicLink() || !info.isDirectory() || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Unsafe local usage directory");
  return child;
}
async function readLocal(file: string): Promise<string | undefined> {
  let before;
  try { before = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > bound) throw new Error("Unsafe local usage file");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || info.size !== before.size) throw new Error("Local usage file changed");
    const buffer = Buffer.alloc(bound + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
    if (bytesRead > bound || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Local usage file changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
function decode(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid local usage data"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local usage data");
  return value as Record<string, unknown>;
}

export async function createUsageTracker(paths: SagePaths, options: { now?: () => number } = {}): Promise<UsageTracker> {
  const now = options.now ?? (() => performance.now());
  let enabled = true, problem: string | undefined, active = false, counted = false, last = 0, dirty = false;
  let totals: UsageTotals = { total_sessions: 0, total_hours: 0 };
  let configRaw: string | undefined, countersRaw: string | undefined, pending = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) { try { listener(); } catch { listeners.delete(listener); } } };
  const fail = () => { problem = unavailable; if (timer) clearInterval(timer); timer = undefined; emit(); };
  const exclusive = (work: () => Promise<void>) => { const next = pending.then(work); pending = next.catch(() => {}); return next; };
  const delta = () => { const value = now(); return Number.isFinite(value) ? Math.max(0, value - last) / 3_600_000 : 0; };
  const account = () => {
    if (!active || !enabled || problem) return;
    const value = now();
    if (!Number.isFinite(value)) { fail(); return; }
    totals.total_hours += Math.max(0, value - last) / 3_600_000; last = Math.max(last, value); dirty = true;
  };
  const write = async (kind: "config" | "data", value: UsageTotals | { enabled: boolean }) => {
    const dir = await directory(paths, kind), file = join(dir, "usage.json"), expected = kind === "config" ? configRaw : countersRaw;
    if (await readLocal(file) !== expected) throw new Error("Local usage data changed outside Sage");
    const text = JSON.stringify(value) + "\n", temp = join(dir, `.usage-${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close();
      await directory(paths, kind);
      if (await readLocal(file) !== expected) throw new Error("Local usage data changed outside Sage");
      await rename(temp, file);
      if (kind === "config") configRaw = text; else countersRaw = text;
    } finally {
      await handle.close();
      await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  };
  const save = async () => {
    if (!dirty || problem) return;
    try {
      if (!Number.isSafeInteger(totals.total_sessions) || !Number.isFinite(totals.total_hours) || totals.total_hours > Number.MAX_SAFE_INTEGER) throw new Error("Local usage totals exceed their numeric bound");
      await write("data", totals); dirty = false;
    } catch { fail(); }
  };
  try {
    configRaw = await readLocal(join(await directory(paths, "config"), "usage.json"));
    if (configRaw !== undefined) {
      const config = decode(configRaw);
      if (Object.keys(config).length !== 1 || typeof config.enabled !== "boolean") throw new Error("Invalid local usage setting");
      enabled = config.enabled;
    }
    countersRaw = await readLocal(join(await directory(paths, "data"), "usage.json"));
    if (countersRaw !== undefined) {
      const saved = decode(countersRaw);
      if (Object.keys(saved).sort().join(",") !== "total_hours,total_sessions" || !Number.isSafeInteger(saved.total_sessions) || Number(saved.total_sessions) < 0 || typeof saved.total_hours !== "number" || !Number.isFinite(saved.total_hours) || saved.total_hours < 0 || saved.total_hours > Number.MAX_SAFE_INTEGER) throw new Error("Invalid local usage totals");
      totals = { total_sessions: Number(saved.total_sessions), total_hours: saved.total_hours };
    }
  } catch { problem = unavailable; }
  const tracker: UsageTracker = {
    snapshot: () => ({ ...totals, total_hours: totals.total_hours + (active && enabled && !problem ? delta() : 0), enabled, available: !problem, ...(problem ? { error: problem } : {}) }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => exclusive(async () => {
      if (active) return;
      active = true; last = now();
      if (enabled && !problem && !counted) { totals.total_sessions++; counted = true; dirty = true; await save(); }
      if (!problem) { timer = setInterval(() => { void tracker.flush(); }, 60_000); timer.unref(); }
      emit();
    }),
    flush: () => exclusive(async () => { account(); if (enabled) await save(); emit(); }),
    stop: () => exclusive(async () => {
      if (timer) clearInterval(timer); timer = undefined;
      if (!active) return;
      account(); active = false; if (enabled) await save(); emit();
    }),
    setEnabled: value => exclusive(async () => {
      if (typeof value !== "boolean") throw new Error("Usage tracking needs on or off");
      if (value && problem) throw new Error(unavailable);
      account();
      try { await write("config", { enabled: value }); } catch { fail(); throw new Error("Could not save the local usage setting; tracking preference was not changed"); }
      enabled = value; last = now();
      if (value && active && !counted) { totals.total_sessions++; counted = true; dirty = true; }
      await save(); emit();
    }),
  };
  return tracker;
}
