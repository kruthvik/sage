import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVaultArtifact, readVaultArtifact } from "../src/vault.ts";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function root() { const r = await mkdtemp(join(tmpdir(), "sage-vault-")); roots.push(r); return r; }

test("managed Markdown is atomically published only under Sage with verifiable ownership/provenance", async () => {
  const vault = await root(); const content = "# Calculus notes\nFundamental theorem of calculus";
  const result = await writeVaultArtifact({ vaultRoot: vault, relativePath: "notes/calculus.md", content });
  expect(result.created).toBe(true); expect(result.fullPath).toBe(join(vault, "Sage", "notes", "calculus.md"));
  expect(result.bytesWritten).toBeGreaterThan(0);
  expect(await readVaultArtifact(vault, "notes/calculus.md")).toBe(content);
  expect(await readFile(result.fullPath, "utf8")).toContain("Sage managed artifact");
  expect((await readdir(join(vault, "Sage", "notes"))).sort()).toEqual(["calculus.md"]);
});

test("traversal, platform absolute paths and Obsidian settings cannot be targeted", async () => {
  const vault = await root();
  for (const relativePath of ["../escaped.md", "a/../../escape.md", ".obsidian/settings.md", "notes/.obsidian/config.md", "C:\\escaped.md", "/escaped.md", "", "note.md:stream", "NUL.md"]) {
    await expect(writeVaultArtifact({ vaultRoot: vault, relativePath, content: "escape", overwrite: true })).rejects.toThrow();
    await expect(readVaultArtifact(vault, relativePath)).rejects.toThrow();
  }
});

test("an overwrite flag cannot replace immutable managed notes or user-edited notes", async () => {
  const vault = await root(); const options = { vaultRoot: vault, relativePath: "existing.md", content: "initial content" };
  const initial = await writeVaultArtifact(options);
  for (const overwrite of [false, true]) await expect(writeVaultArtifact({ ...options, content: "replacement", overwrite })).rejects.toThrow("Vault conflict");
  expect(await readVaultArtifact(vault, "existing.md")).toBe("initial content");
  const original = await readFile(initial.fullPath, "utf8");
  await writeFile(initial.fullPath, original.replace("initial content", "learner annotation"));
  await expect(writeVaultArtifact({ ...options, overwrite: true })).rejects.toThrow("modified");
  expect(await readFile(initial.fullPath, "utf8")).toContain("learner annotation");
});

test("identical verified note replay does not rewrite the file", async () => {
  const vault = await root(); const options = { vaultRoot: vault, relativePath: "replay.md", content: "unchanged" };
  const first = await writeVaultArtifact(options); const before = await stat(first.fullPath);
  const second = await writeVaultArtifact(options);
  expect(second).toMatchObject({ created: false, bytesWritten: 0, contentHash: first.contentHash });
  expect((await stat(first.fullPath)).mtimeMs).toBe(before.mtimeMs);
});

test("unmanaged user notes in the vault root and Sage subtree are never overwritten", async () => {
  const vault = await root(); await mkdir(join(vault, "Sage")); await mkdir(join(vault, ".obsidian"));
  await writeFile(join(vault, "personal.md"), "user root note");
  await writeFile(join(vault, "Sage", "personal.md"), "user subtree note");
  await writeFile(join(vault, ".obsidian", "app.json"), "user settings");
  await expect(writeVaultArtifact({ vaultRoot: vault, relativePath: "personal.md", content: "generated", overwrite: true })).rejects.toThrow("Vault conflict");
  expect(await readFile(join(vault, "personal.md"), "utf8")).toBe("user root note");
  expect(await readFile(join(vault, "Sage", "personal.md"), "utf8")).toBe("user subtree note");
  expect(await readFile(join(vault, ".obsidian", "app.json"), "utf8")).toBe("user settings");
});

test("real directory junctions/symlinks cannot escape the managed subtree for writes or reads", async () => {
  const vault = await root(), foreign = await root(); await mkdir(join(vault, "Sage"));
  await writeFile(join(foreign, "secret.md"), "private outside note");
  await symlink(foreign, join(vault, "Sage", "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(writeVaultArtifact({ vaultRoot: vault, relativePath: "linked/secret.md", content: "overwrite", overwrite: true })).rejects.toThrow("Vault path");
  await expect(readVaultArtifact(vault, "linked/secret.md")).rejects.toThrow("Vault path");
  expect(await readFile(join(foreign, "secret.md"), "utf8")).toBe("private outside note");
  expect(await readdir(foreign)).toEqual(["secret.md"]);
});
