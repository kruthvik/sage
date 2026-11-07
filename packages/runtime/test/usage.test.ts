import { afterEach, expect, test } from "bun:test";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSagePaths, type SagePaths } from "../src/paths.ts";
import { privacyInventory } from "../src/privacy.ts";
import { LearningStore } from "../../storage/src/store.ts";

type Tracker = { start(): Promise<void>; stop(): Promise<void>; flush(): Promise<void>; setEnabled(enabled: boolean): Promise<void>; subscribe(listener: () => void): () => void; snapshot(): { enabled: boolean; available: boolean; total_sessions: number; total_hours: number; error?: string } };
const roots: string[] = [], trackers: Tracker[] = [];
afterEach(async () => { for (const t of trackers.splice(0)) await t.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "sage-usage-")); roots.push(root); return { root, paths: createSagePaths({ home: join(root, "home") }) }; }
async function create(paths: SagePaths, now: () => number): Promise<Tracker> {
  const url = new URL("../src/usage.ts", import.meta.url);
  expect(await Bun.file(url).exists()).toBe(true);
  const module = await import(url.href), tracker = await module.createUsageTracker(paths, { now });
  trackers.push(tracker); return tracker;
}

test("local usage: privacy inventory discloses counter locations and limits without changing learning records", async () => {
  const { paths } = await fixture(), store = new LearningStore(":memory:");
  try {
    const t = await create(paths, () => 0); await t.start();
    const before = store.events(), inventory = await privacyInventory(paths, store);
    expect(Reflect.get(inventory, "usage_tracking")).toEqual({ totals_path: join(paths.data, "usage.json"), settings_path: join(paths.config, "usage.json"), metrics: ["total_sessions", "total_hours"], default_enabled: true, network_reporting: false, excluded_from_learning_backup: true, disabling_deletes_totals: false });
    expect(store.events()).toEqual(before);
  } finally { store.close(); }
});

test("local usage: defaults on, counts a launcher once and persists only sessions/hours", async () => {
  const { paths } = await fixture(); let now = 0;
  const t = await create(paths, () => now);
  expect(t.snapshot()).toMatchObject({ enabled: true, available: true, total_sessions: 0, total_hours: 0 });
  await t.start(); await t.start(); now = 3_600_000; await t.flush(); await t.stop();
  const saved = JSON.parse(await readFile(join(paths.data, "usage.json"), "utf8"));
  expect(saved).toEqual({ total_sessions: 1, total_hours: 1 });
  expect(Object.keys(saved).sort()).toEqual(["total_hours", "total_sessions"]);
  expect(await access(join(paths.data, "learning.sqlite")).then(() => true, () => false)).toBe(false);
});

test("local usage: opt-out excludes disabled time and re-enable does not recount the same launch", async () => {
  const { paths } = await fixture(); let now = 0;
  const t = await create(paths, () => now); await t.start();
  now = 900_000; await t.setEnabled(false);
  const off = await readFile(join(paths.data, "usage.json"), "utf8");
  expect(JSON.parse(await readFile(join(paths.config, "usage.json"), "utf8"))).toEqual({ enabled: false });
  now = 7_200_000; await t.flush(); expect(await readFile(join(paths.data, "usage.json"), "utf8")).toBe(off);
  await t.setEnabled(true); now += 900_000; await t.stop();
  expect(JSON.parse(await readFile(join(paths.data, "usage.json"), "utf8"))).toEqual({ total_sessions: 1, total_hours: 0.5 });
});

test("local usage: an opted-out launch writes no counters and counts once only if enabled", async () => {
  const { paths } = await fixture(); let now = 0;
  const settings = await create(paths, () => now); await settings.setEnabled(false); await settings.stop();
  const t = await create(paths, () => now); await t.start(); now = 3_600_000; await t.stop();
  expect(t.snapshot()).toMatchObject({ enabled: false, total_sessions: 0, total_hours: 0 });
  expect(await access(join(paths.data, "usage.json")).then(() => true, () => false)).toBe(false);
  const next = await create(paths, () => now); await next.start(); await next.setEnabled(true); now += 1_800_000; await next.stop();
  expect(JSON.parse(await readFile(join(paths.data, "usage.json"), "utf8"))).toEqual({ total_sessions: 1, total_hours: 0.5 });
});

test("local usage: reopening adds one session without measuring time between launches", async () => {
  const { paths } = await fixture(); let now = 0;
  const first = await create(paths, () => now); await first.start(); now = 3_600_000; await first.stop();
  now += 86_400_000;
  const second = await create(paths, () => now); await second.start(); now += 1_800_000; await second.stop();
  expect(second.snapshot()).toMatchObject({ total_sessions: 2, total_hours: 1.5 });
});

test("local usage: malformed or unexpected local data is preserved and the user can still opt out", async () => {
  for (const content of ['{"private":"DO-NOT-ECHO",', '{"total_sessions":1,"total_hours":0,"extra":"DO-NOT-ECHO"}', '{"total_sessions":-1,"total_hours":0}', '{"total_sessions":9007199254740991,"total_hours":0}']) {
    const { paths } = await fixture(); await mkdir(paths.data, { recursive: true }); await writeFile(join(paths.data, "usage.json"), content);
    const t = await create(paths, () => 0); await t.start(); await t.flush();
    expect(t.snapshot().available).toBe(false); expect(t.snapshot().error).not.toContain("DO-NOT-ECHO");
    await t.setEnabled(false); expect(t.snapshot().enabled).toBe(false);
    expect(await readFile(join(paths.data, "usage.json"), "utf8")).toBe(content);
    await expect(t.setEnabled(true)).rejects.toThrow();
  }
});

test("local usage: a failed status listener cannot break launch counting or shutdown", async () => {
  const { paths } = await fixture(); let now = 0;
  const t = await create(paths, () => now), detach = t.subscribe(() => { throw new Error("Owned closed UI"); });
  try { await expect(t.start()).resolves.toBeUndefined(); now = 3_600_000; await expect(t.stop()).resolves.toBeUndefined(); }
  finally { detach(); }
  expect(JSON.parse(await readFile(join(paths.data, "usage.json"), "utf8"))).toEqual({ total_sessions: 1, total_hours: 1 });
});

test("local usage: external counter edits fail closed without overwriting and opt-out remains available", async () => {
  const { paths } = await fixture(); let now = 0;
  const t = await create(paths, () => now); await t.start();
  const content = '{"total_sessions":77,"total_hours":88}'; await writeFile(join(paths.data, "usage.json"), content);
  now = 3_600_000; await t.flush(); expect(t.snapshot().available).toBe(false);
  await t.setEnabled(false); expect(t.snapshot().enabled).toBe(false);
  expect(await readFile(join(paths.data, "usage.json"), "utf8")).toBe(content);
});

test("local usage: linked data files and escaped data directories cannot overwrite another file", async () => {
  for (const kind of ["hardlink", "junction"] as const) {
    const { root, paths } = await fixture(), outside = join(root, "outside"); await mkdir(outside);
    const sentinel = join(outside, "usage.json"), content = '{"total_sessions":12,"total_hours":34}'; await writeFile(sentinel, content);
    if (kind === "hardlink") { await mkdir(paths.data, { recursive: true }); await link(sentinel, join(paths.data, "usage.json")); }
    else { await mkdir(paths.home); await symlink(outside, paths.data, "junction"); }
    const t = await create(paths, () => 0); await t.start(); await t.stop();
    expect(t.snapshot().available).toBe(false); expect(await readFile(sentinel, "utf8")).toBe(content);
  }
});
