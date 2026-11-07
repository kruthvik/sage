import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSagePaths } from "../src/paths.ts";
import { LearningService } from "../src/service.ts";
import { backup, restore } from "../src/backup.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "sage-brand-")); roots.push(root); return root; }

test("Sage branding: package and launch command use Sage", async () => {
  const pkg = JSON.parse(await readFile(resolve(import.meta.dir, "../../../package.json"), "utf8"));
  expect(pkg.name).toBe("sage"); expect(pkg.bin.sage).toBe("apps/cli/src/index.ts");
});

test("Sage branding: canonical home wins and legacy home still works", async () => {
  const root = await temporary(), canonical = join(root, "canonical"), legacy = join(root, "legacy");
  const env = { ...process.env, SAGE_HOME: canonical, SATO_HOME: legacy }; // legacy brand compatibility
  const run = async (settings: Record<string, string | undefined>) => {
    const child = Bun.spawn([process.execPath, "apps/cli/src/index.ts", "--smoke"], { cwd: resolve(import.meta.dir, "../../.."), env: settings, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(stderr).toBe(""); return stdout;
  };
  expect(await run(env)).toContain("Sage resource smoke test passed");
  expect(await access(join(canonical, "agent")).then(() => true, () => false)).toBe(true);
  const oldOnly: Record<string, string | undefined> = { ...env }; delete oldOnly.SAGE_HOME;
  expect(await run(oldOnly)).toContain("Sage resource smoke test passed");
  expect(await access(join(legacy, "agent")).then(() => true, () => false)).toBe(true);
});

test("Sage backup: malformed JSON fails without copying private bytes into the error or writing a home", async () => {
  const root = await temporary(), filename = join(root, "malformed.json"), paths = createSagePaths({ home: join(root, "untouched") });
  await writeFile(filename, '{"private":"DO-NOT-ECHO-BACKUP",');
  await expect(restore(paths, filename)).rejects.toThrow("Invalid Sage backup JSON");
  expect(await access(paths.home).then(() => true, () => false)).toBe(false);
});

test("Sage branding: old backups restore without rewriting or overwriting saved evidence", async () => {
  const root = await temporary(), paths = createSagePaths({ home: join(root, "original") });
  const service = new LearningService(paths), filename = join(root, "backup.json");
  try {
    await backup(service.store, paths, filename);
    const input = JSON.parse(await readFile(filename, "utf8"));
    input.format = "sato-backup-v1"; // legacy brand compatibility
    await writeFile(filename, JSON.stringify(input));
    const restored = createSagePaths({ home: join(root, "restored") });
    await restore(restored, filename);
    const bytes = await readFile(join(restored.data, "learning.sqlite"));
    await expect(restore(restored, filename)).rejects.toThrow("fresh");
    expect(await readFile(join(restored.data, "learning.sqlite"))).toEqual(bytes);
    expect(JSON.parse(await readFile(filename, "utf8")).format).toBe(input.format);
  } finally { service.close(); }
});
