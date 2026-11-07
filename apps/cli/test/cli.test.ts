import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseLaunchArgs } from "../src/index.ts";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

test("root package publishes a Bun executable and bundles Pi", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  expect(manifest.name).toBe("sage");
  expect(manifest.bin).toEqual({ sage: "apps/cli/src/index.ts" });
  expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBeDefined();
  expect(manifest.files).toContain("docs/");
  expect(manifest.files).toContain("brain.md");
  expect((await readFile(resolve(root, manifest.bin.sage), "utf8")).startsWith("#!/usr/bin/env bun")).toBe(true);
});

test("usage help: local controls are discoverable and maintenance does not count a launch", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "sage-help-usage-"));
  try {
    const child = Bun.spawn([process.execPath, resolve(root, "apps/cli/src/index.ts"), "--help"], { cwd: root, env: { ...process.env, SAGE_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(error).toBe(""); expect(text).toContain("/usage"); expect(text).toContain("/sage-settings"); expect(text).toContain("on by default"); expect(text).toContain("no uploads");
    expect(await access(resolve(home, "data/usage.json")).then(() => true, () => false)).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("privacy confirmed CLI purge takes one runtime lease and removes nested synthetic sessions", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "sage-confirmed-purge-"));
  try {
    const transcript = resolve(home, "sessions/nested/trace.jsonl"), auth = resolve(home, "agent/auth.json");
    await mkdir(resolve(home, "sessions/nested"), { recursive: true });
    await mkdir(resolve(home, "agent"), { recursive: true });
    await writeFile(transcript, "synthetic private trace"); await writeFile(auth, '{"synthetic":"keep"}');
    const child = Bun.spawn([process.execPath, resolve(root, "apps/cli/src/index.ts"), "privacy", "purge", "--confirm"], { cwd: root, env: { ...process.env, SAGE_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ success: true, dryRun: false, sessions_removed: 1 });
    expect(await access(transcript).then(() => true, () => false)).toBe(false);
    expect(await readFile(auth, "utf8")).toBe('{"synthetic":"keep"}');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("runtime launch: cram reaches the existing native mode through both CLI forms", () => {
  expect(parseLaunchArgs(["cram", "Calculus final"])).toEqual({ action: "tutor", selection: { mode: "cram", goal: "Calculus final" } });
  expect(parseLaunchArgs(["--mode", "cram", "Calculus final"])).toEqual({ action: "tutor", selection: { mode: "cram", goal: "Calculus final" } });
  expect(parseLaunchArgs(["cram"])).toEqual({ action: "tutor", selection: { mode: "cram", goal: undefined } });
});

test("parseLaunchArgs parses existing launch modes, --mode flag, help, version and subcommands", () => {
  expect(parseLaunchArgs([])).toEqual({ action: "tutor", selection: {} });
  expect(parseLaunchArgs(["--force"])).toEqual({ action: "tutor", selection: {} });
  expect(parseLaunchArgs(["--force", "learn", "Python"])).toEqual({ action: "tutor", selection: { mode: "learn", goal: "Python" } });
  expect(parseLaunchArgs(["learn", "Python"])).toEqual({ action: "tutor", selection: { mode: "learn", goal: "Python" } });
  expect(parseLaunchArgs(["exam", "Calculus final"])).toEqual({ action: "tutor", selection: { mode: "exam", goal: "Calculus final" } });
  expect(parseLaunchArgs(["drill", "Integration by parts"])).toEqual({ action: "tutor", selection: { mode: "drill", goal: "Integration by parts" } });
  expect(parseLaunchArgs(["accelerate"])).toEqual({ action: "tutor", selection: { mode: "accelerate", goal: undefined } });
  expect(parseLaunchArgs(["--mode", "drill", "Quantum mechanics"])).toEqual({ action: "tutor", selection: { mode: "drill", goal: "Quantum mechanics" } });
  expect(parseLaunchArgs(["--version"])).toEqual({ action: "version" });
  expect(parseLaunchArgs(["--help"])).toEqual({ action: "help", all: false });
  expect(parseLaunchArgs(["help", "--all"])).toEqual({ action: "help", all: true });
  expect(parseLaunchArgs(["doctor"])).toEqual({ action: "subcommand", command: "doctor", rest: [] });
  expect(parseLaunchArgs(["privacy", "inventory"])).toEqual({ action: "subcommand", command: "privacy", rest: ["inventory"] });
  expect(() => parseLaunchArgs(["--mode", "invalid"])).toThrow();
  expect(() => parseLaunchArgs(["--version", "extra"])).toThrow();
});
