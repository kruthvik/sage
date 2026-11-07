import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { updatePi, rollbackPi, loadPiWithFallback } from "../src/update.ts";
import { readPiSelection, piRuntimeRoot, PI_PACKAGE, PI_PINNED } from "../src/sdk.ts";
import { sagePaths } from "../../core/src/paths.ts";

const realPi = async () => realpath(dirname(Bun.resolveSync(`${PI_PACKAGE}/package.json`, join(import.meta.dir, ".."))));
const linkReal = async (dir: string) => { await mkdir(join(dir, "node_modules", "@earendil-works"), { recursive: true }); await symlink(await realPi(), join(dir, "node_modules", PI_PACKAGE), "junction"); };
const fakeBroken = async (dir: string) => { const d = join(dir, "node_modules", PI_PACKAGE); await mkdir(d, { recursive: true });
  await writeFile(join(d, "package.json"), JSON.stringify({ name: PI_PACKAGE, version: "1.9.0", type: "module", exports: "./index.js" })); await writeFile(join(d, "index.js"), "export const VERSION = '1.9.0';"); };

test("a release missing required exports is refused; nothing switches and the failed install is removed", async () => {
  const paths = sagePaths(await mkdtemp(join(tmpdir(), "sage-home-")));
  await expect(updatePi(paths, "1.9.0", { install: fakeBroken })).rejects.toThrow(/missing/);
  expect(await readPiSelection(paths)).toBeUndefined();
  expect(await readdir(piRuntimeRoot(paths))).toEqual([]);
});

test("update switches atomically with a rollback target; smoke failure aborts; rollback returns to bundled", async () => {
  const paths = sagePaths(await mkdtemp(join(tmpdir(), "sage-home-")));
  await expect(updatePi(paths, PI_PINNED, { install: linkReal, smoke: async () => { throw new Error("smoke failed"); } })).rejects.toThrow(/smoke/);
  expect(await readPiSelection(paths)).toBeUndefined();
  const r = await updatePi(paths, PI_PINNED, { install: linkReal });
  expect(r).toEqual({ from: "bundled", to: PI_PINNED });
  expect((await readPiSelection(paths))?.version).toBe(PI_PINNED);
  expect((await loadPiWithFallback(paths)).notice).toBeUndefined();
  expect(await rollbackPi(paths)).toBe("bundled");
  expect(await readPiSelection(paths)).toBeUndefined();
}, 60_000);

test("startup falls back offline when the selected runtime no longer loads", async () => {
  const paths = sagePaths(await mkdtemp(join(tmpdir(), "sage-home-")));
  await mkdir(piRuntimeRoot(paths), { recursive: true });
  await writeFile(join(piRuntimeRoot(paths), "active.json"), JSON.stringify({ install: "install-00000000-0000-0000-0000-000000000000", version: "1.5.0" }));
  const { sdk, notice } = await loadPiWithFallback(paths);
  expect(sdk.VERSION).toBe(PI_PINNED);
  expect(notice).toMatch(/switched to/);
});
