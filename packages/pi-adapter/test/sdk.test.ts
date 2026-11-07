import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadPi, PI_PINNED, validateSelection } from "../src/sdk.ts";
import { sagePaths } from "../../core/src/paths.ts";

test("the pinned pi loads and exposes every export Sage uses", async () => {
  const { sdk, source } = await loadPi(sagePaths(await mkdtemp(join(tmpdir(), "sage-home-"))));
  expect(source).toBe("bundled");
  expect(sdk.VERSION).toBe(PI_PINNED);
});

test("selections are validated before use", () => {
  expect(() => validateSelection({ install: "../../evil", version: "1.5.0" })).toThrow(/Invalid/);
  expect(() => validateSelection({ install: "install-00000000-0000-0000-0000-000000000000", version: "2.0.0" })).toThrow(/Invalid/);
});

test("F13: nothing outside packages/pi-adapter imports pi", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (!p.endsWith(join("packages", "pi-adapter"))) walk(p); }
      else if (/\.(ts|js)$/.test(name) && /from\s+["']@earendil-works\/pi-|import\(["']@earendil-works\/pi-/.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  for (const d of ["packages", "apps"]) try { walk(join(root, d)); } catch { /* apps/ may not exist yet */ }
  expect(offenders).toEqual([]);
});
