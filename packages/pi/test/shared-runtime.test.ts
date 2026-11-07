import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { loadInstalledPi, validatePiSdk } from "../src/sdk.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function api() {
  const file = new URL("../src/shared-runtime.ts", import.meta.url); expect(await Bun.file(file).exists()).toBe(true);
  return import(file.href) as Promise<{ inspectSharedPi(source: string): Promise<{ source: string; version: string; fingerprint: string }>; resolveSharedPi(directory: string): Promise<string | undefined> }>;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-shared-runtime-")); roots.push(root);
  const source = join(root, "1.2.3"), install = join(root, "install"), pkg = join(source, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(pkg, { recursive: true }); await mkdir(install);
  await writeFile(join(source, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.3", type: "module", exports: { import: "./entry.mjs" } }));
  const names = ["createAgentSession", "createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "SettingsManager", "SessionManager", "DefaultResourceLoader", "DefaultPackageManager", "InteractiveMode", "BorderedLoader", "loadSkills"];
  await writeFile(join(pkg, "entry.mjs"), `export const VERSION="1.2.3";${names.map(name => `export function ${name}(){}`).join("\n")}`);
  return { root, source, install, pkg };
}
async function bind(f: Awaited<ReturnType<typeof fixture>>) {
  const m = await api(), binding = await m.inspectSharedPi(f.source);
  await writeFile(join(f.install, "shared.json"), JSON.stringify(binding)); return { m, binding };
}

test("shared Pi: registered code loads without copying configuration or modifying the source", async () => {
  const f = await fixture(), { m, binding } = await bind(f);
  const original = await readFile(join(f.pkg, "entry.mjs"), "utf8");
  expect(binding.version).toBe("1.2.3"); expect(binding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(await m.resolveSharedPi(f.install)).toBe(binding.source);
  const sdk = await loadInstalledPi(f.install); validatePiSdk(sdk); expect(sdk.VERSION).toBe("1.2.3");
  expect(await readFile(join(f.pkg, "entry.mjs"), "utf8")).toBe(original);
  expect(await Bun.file(join(f.source, "compatibility-check")).exists()).toBe(false);
});

test.each(["engine", "dependency", "registration"] as const)("shared Pi: changed %s is refused before import, including a previously cached module", async kind => {
  const f = await fixture();
  await mkdir(join(f.source, "node_modules", "dependency")); await writeFile(join(f.source, "node_modules", "dependency", "index.js"), "export default 1");
  const { m } = await bind(f); await loadInstalledPi(f.install);
  if (kind === "engine") await writeFile(join(f.pkg, "entry.mjs"), "throw new Error('Changed code must not execute')");
  else if (kind === "dependency") await writeFile(join(f.source, "node_modules", "dependency", "index.js"), "export default 2");
  else await writeFile(join(f.install, "shared.json"), JSON.stringify({ source: f.source, version: "1.2.3", fingerprint: "x" }));
  await expect(m.resolveSharedPi(f.install)).rejects.toThrow(/Shared Pi/);
  await expect(loadInstalledPi(f.install)).rejects.toThrow(/Shared Pi/);
});

test("shared Pi: unversioned roots and dependency links outside the installed release are refused", async () => {
  const f = await fixture(), m = await api();
  await expect(m.inspectSharedPi(f.root)).rejects.toThrow(/Shared Pi/);
  const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "private.txt"), "not runtime code");
  await symlink(outside, join(f.source, "node_modules", "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(m.inspectSharedPi(f.source)).rejects.toThrow(/Shared Pi/);
});

test("shared Pi: oversized or unknown registration fields fail closed; ordinary isolated installs remain supported", async () => {
  const f = await fixture(), m = await api();
  expect(await m.resolveSharedPi(f.source)).toBeUndefined(); expect((await loadInstalledPi(f.source)).VERSION).toBe("1.2.3");
  await writeFile(join(f.install, "shared.json"), " ".repeat(4097)); await expect(m.resolveSharedPi(f.install)).rejects.toThrow(/Shared Pi/);
  const binding = await m.inspectSharedPi(f.source);
  await writeFile(join(f.install, "shared.json"), JSON.stringify({ ...binding, config: "foreign" })); await expect(m.resolveSharedPi(f.install)).rejects.toThrow(/Shared Pi/);
});

test("shared Pi: adoption requires trust before changing any selection", async () => {
  const f = await fixture(), paths = createSagePaths({ home: join(f.root, "home") });
  const updates = await import("../src/updates.ts") as unknown as { sharePi?: (candidatePaths: typeof paths, source: string, trusted?: boolean) => Promise<unknown> };
  expect(typeof updates.sharePi).toBe("function");
  await expect(updates.sharePi!(paths, f.source)).rejects.toThrow(/trust/);
  expect(await Bun.file(join(paths.home, "pi-runtime", "active.json")).exists()).toBe(false);
});

test("shared Pi CLI: help exposes explicit sharing and missing trust cannot activate an engine", async () => {
  const f = await fixture(), cli = fileURLToPath(new URL("../../../apps/cli/src/index.ts", import.meta.url));
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env, SAGE_HOME: join(f.root, "home") } });
  const help = run("help", "--all"); expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("share INSTALLED_ROOT --trust");
  const refused = run("pi", "share", f.source); expect(refused.exitCode).not.toBe(0); expect(refused.stderr.toString()).toContain("--trust");
  expect(await Bun.file(join(f.root, "home", "pi-runtime", "active.json")).exists()).toBe(false);
});

test("shared Pi performance: bounded speculative opens preserve legacy fingerprints and drain on rejection", async () => {
  const f = await fixture(), dependency = join(f.source, "node_modules", "a-dependency");
  await mkdir(dependency);
  for (let i = 0; i < 32; i++) await writeFile(join(dependency, `${String(i).padStart(2, "0")}.js`), `export default ${i};`);
  await symlink(dependency, join(f.source, "node_modules", "b-alias"), process.platform === "win32" ? "junction" : "dir");
  const script = join(f.root, "bounded-io.ts");
  await writeFile(script, `
    import { mock } from "bun:test";
    import * as namespace from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { join, relative } from "node:path";
    const fs = { ...namespace }, source = ${JSON.stringify(f.source)};
    const root = await fs.realpath(source), hash = createHash("sha256"), visited = new Set();
    async function legacy(file) {
      const actual = await fs.realpath(file);
      hash.update(relative(root, file)).update("\\0").update(relative(root, actual)).update("\\0");
      if (visited.has(actual)) return; visited.add(actual);
      const info = await fs.lstat(actual);
      if (info.isDirectory()) { for (const child of (await fs.readdir(actual)).sort()) await legacy(join(actual, child)); }
      else { hash.update(await fs.readFile(actual)).update("\\0"); }
    }
    await legacy(join(root, "node_modules")); const expected = hash.digest("hex");
    let outstanding = 0, peak = 0, failStat = false;
    mock.module("node:fs/promises", () => ({ ...fs, async open(...args) {
      outstanding++; peak = Math.max(peak, outstanding); let handle;
      try { handle = await fs.open(...args); } catch (error) { outstanding--; throw error; }
      return new Proxy(handle, { get(target, key) {
        if (key === "close") return async () => { try { await target.close(); } finally { outstanding--; } };
        if (key === "stat" && failStat) return async () => { throw new Error("Scripted descriptor failure"); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } }));
    const { inspectSharedPi } = await import(${JSON.stringify(new URL("../src/shared-runtime.ts", import.meta.url).href)});
    const good = await inspectSharedPi(source), goodOutstanding = outstanding;
    failStat = true; let statRejected = false;
    try { await inspectSharedPi(source); } catch { statRejected = true; }
    const statOutstanding = outstanding; failStat = false;
    const outside = ${JSON.stringify(join(f.root, "outside"))}; await fs.mkdir(outside);
    await fs.symlink(outside, join(source, "node_modules", "a-dependency", "zz-escape"), ${JSON.stringify(process.platform === "win32" ? "junction" : "dir")});
    let rejected = false; try { await inspectSharedPi(source); } catch { rejected = true; }
    console.log(JSON.stringify({ sameFingerprint: good.fingerprint === expected, peak, goodOutstanding, statRejected, statOutstanding, finalOutstanding: outstanding, rejected }));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 15000);
  try {
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(exit).toBe(0);
    const result = JSON.parse(output) as { sameFingerprint: boolean; peak: number; goodOutstanding: number; statRejected: boolean; statOutstanding: number; finalOutstanding: number; rejected: boolean };
    expect(result.sameFingerprint).toBe(true); expect(result.peak).toBeGreaterThan(1); expect(result.peak).toBeLessThanOrEqual(2);
    expect(result.goodOutstanding).toBe(0); expect(result.finalOutstanding).toBe(0); expect(result.rejected).toBe(true);
    expect(result.statRejected).toBe(true); expect(result.statOutstanding).toBe(0);
  } finally { clearTimeout(deadline); }
}, 20000);

test("shared Pi: same-size changed bytes are still refused without a metadata cache", async () => {
  const f = await fixture(), file = join(f.pkg, "payload.js"); await writeFile(file, "export default 1");
  const { m } = await bind(f); await writeFile(file, "export default 2");
  await expect(m.resolveSharedPi(f.install)).rejects.toThrow(/Shared Pi/);
});

test("shared Pi info: one report performs one full verification, not two", async () => {
  const f = await fixture(), { binding } = await bind(f), home = join(f.root, "home");
  const install = "install-11111111-1111-1111-1111-111111111111", directory = join(home, "pi-runtime", install);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "shared.json"), JSON.stringify(binding));
  await writeFile(join(home, "pi-runtime", "active.json"), JSON.stringify({ install, version: "1.2.3" }));
  const script = join(f.root, "single-scan.ts");
  await writeFile(script, `
    import { mock } from "bun:test";
    import * as namespace from "node:fs/promises";
    import { resolve } from "node:path";
    const fs = { ...namespace }; let scans = 0;
    mock.module("node:fs/promises", () => ({ ...fs, realpath(...args) {
      if (resolve(String(args[0])) === resolve(${JSON.stringify(binding.source)})) scans++;
      return fs.realpath(...args);
    } }));
    const { createSagePaths } = await import(${JSON.stringify(new URL("../../runtime/src/paths.ts", import.meta.url).href)});
    const { piInfo } = await import(${JSON.stringify(new URL("../src/sdk.ts", import.meta.url).href)});
    const info = await piInfo(createSagePaths({ home: ${JSON.stringify(home)} }));
    console.log(JSON.stringify({ scans, version: info.version, source: info.source }));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 15000);
  try {
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(exit).toBe(0);
    expect(JSON.parse(output)).toEqual({ scans: 1, version: "1.2.3", source: "shared" });
  } finally { clearTimeout(deadline); }
}, 20000);
