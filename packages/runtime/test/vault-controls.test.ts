import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vault from "../src/vault.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";

const controls = vault;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-vault-control-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const selected = join(root, "chosen vault"); await mkdir(selected);
  return { root, paths, selected };
}

test("one vault is explicitly configured in Sage's own settings, never inferred or copied globally", async () => {
  expect(typeof controls.configureVault).toBe("function"); expect(typeof controls.readVaultConfig).toBe("function");
  const f = await fixture(); expect(await controls.readVaultConfig(f.paths)).toBeUndefined();
  const configured = await controls.configureVault(f.paths, f.selected);
  expect(configured).toMatchObject({ version: 1, vaultRoot: await realpath(f.selected) });
  expect(await controls.readVaultConfig(f.paths)).toEqual(configured);
  expect(await readFile(join(f.paths.config, "vault.json"), "utf8")).not.toMatch(/credential|token|apiKey/);
});

test("configuration replay is idempotent and switching vaults does not silently overwrite settings or migrate notes", async () => {
  expect(typeof controls.configureVault).toBe("function");
  const f = await fixture(); const configured = await controls.configureVault(f.paths, f.selected);
  const filename = join(f.paths.config, "vault.json"); const before = await stat(filename);
  expect(await controls.configureVault(f.paths, f.selected)).toEqual(configured);
  expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
  const other = join(f.root, "other vault"); await mkdir(other);
  await expect(controls.configureVault(f.paths, other)).rejects.toThrow("already configured");
  expect(await controls.readVaultConfig(f.paths)).toEqual(configured);
});

test("corrupt settings are preserved and a configuration directory junction cannot publish outside Sage home", async () => {
  expect(typeof controls.configureVault).toBe("function"); expect(typeof controls.readVaultConfig).toBe("function");
  const f = await fixture(); const filename = join(f.paths.config, "vault.json");
  await mkdir(f.paths.config);
  await writeFile(filename, "broken user settings");
  await expect(controls.configureVault(f.paths, f.selected)).rejects.toThrow();
  expect(await readFile(filename, "utf8")).toBe("broken user settings");
  await rm(f.paths.config, { recursive: true });
  const foreign = join(f.root, "foreign settings"); await mkdir(foreign); await writeFile(join(foreign, "vault.json"), "foreign sentinel");
  await symlink(foreign, f.paths.config, process.platform === "win32" ? "junction" : "dir");
  await expect(controls.readVaultConfig(f.paths)).rejects.toThrow("configuration path");
  await expect(controls.configureVault(f.paths, f.selected)).rejects.toThrow("configuration path");
  expect(await readFile(join(foreign, "vault.json"), "utf8")).toBe("foreign sentinel");
});

test("a replaced configured directory requires explicit resolution instead of redirecting future writes", async () => {
  expect(typeof controls.configureVault).toBe("function");
  const f = await fixture(); await controls.configureVault(f.paths, f.selected);
  const { rename } = await import("node:fs/promises");
  await rename(f.selected, join(f.root, "original vault preserved")); await mkdir(f.selected);
  await expect(controls.readVaultConfig(f.paths)).rejects.toThrow("changed");
});

test("open integration produces a verified local Obsidian URI without launching or reading outside the managed subtree", async () => {
  expect(typeof controls.vaultOpenUri).toBe("function");
  const f = await fixture(); const note = await vault.writeVaultArtifact({ vaultRoot: f.selected, relativePath: "lessons/notes.md", content: "Learner-safe projection" });
  const uri = new URL(await controls.vaultOpenUri(f.selected, "lessons/notes.md"));
  expect(uri.protocol).toBe("obsidian:"); expect(uri.searchParams.get("path")).toBe(note.fullPath);
  await expect(controls.vaultOpenUri(f.selected, "../private.md")).rejects.toThrow();
  await writeFile(note.fullPath, "learner changed this note");
  await expect(controls.vaultOpenUri(f.selected, "lessons/notes.md")).rejects.toThrow("Vault conflict");
  expect(await readFile(note.fullPath, "utf8")).toBe("learner changed this note");
});
