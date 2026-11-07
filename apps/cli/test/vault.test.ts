import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSagePaths } from "../../../packages/runtime/src/paths.ts";
import { bootstrapSageHome } from "../../../packages/runtime/src/bootstrap.ts";
import { LearningService } from "../../../packages/runtime/src/service.ts";
import { createTutorArtifact } from "../../../packages/runtime/src/artifacts.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-vault-cli-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const selected = join(root, "explicit vault"); await mkdir(selected);
  return { root, paths, selected };
}
async function cli(home: string, args: string[], command = "vault") {
  const env: Record<string, string> = { SAGE_HOME: home, HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(home, "agent"), APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_CONFIG_HOME: join(home, "config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["PATH", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([process.execPath, entry, command, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}

test("local CLI explicitly configures a vault, exports an attributed artifact and emits a verified URI", async () => {
  const f = await fixture();
  const configured = await cli(f.paths.home, ["configure", f.selected]); expect(configured.code).toBe(0);
  const service = new LearningService(f.paths);
  let id: string, sequence: number;
  try { id = createTutorArtifact(service.store, { capability: "lesson_summary", content: "# Area under a curve\nTutor-generated summary; not learner evidence.", provenance: "Owned offline fixture" }, "fixture").revision_id; sequence = service.store.throughSeq; }
  finally { service.close(); }
  const exported = await cli(f.paths.home, ["export", id, "lessons/area.md"]); expect(exported.code).toBe(0);
  const filename = join(f.selected, "Sage", "lessons", "area.md");
  const content = await readFile(filename, "utf8"); expect(content).toContain(id); expect(content).toContain('"origin":"tutor"');
  expect(content).toContain("not learner evidence");
  const opened = await cli(f.paths.home, ["uri", "lessons/area.md"]); expect(opened.code).toBe(0);
  expect(new URL(opened.stdout.trim()).searchParams.get("path")).toBe(filename);
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(sequence); } finally { checked.close(); }
}, 30000);

test("CLI rejects unconfigured export and does not overwrite a user note or accept unsafe arguments", async () => {
  const f = await fixture();
  const missing = await cli(f.paths.home, ["export", "missing-artifact", "note.md"]); expect(missing.code).not.toBe(0); expect(missing.stderr).toContain("configure");
  expect((await cli(f.paths.home, ["configure", f.selected, "unexpected"])).code).not.toBe(0);
  expect((await cli(f.paths.home, ["configure", f.selected])).code).toBe(0);
  const service = new LearningService(f.paths); let id: string;
  try { id = createTutorArtifact(service.store, { capability: "lesson_summary", content: "Generated summary", provenance: "Owned offline fixture" }, "fixture").revision_id; } finally { service.close(); }
  await mkdir(join(f.selected, "Sage")); await writeFile(join(f.selected, "Sage", "personal.md"), "User-owned note");
  const collision = await cli(f.paths.home, ["export", id, "personal.md"]); expect(collision.code).not.toBe(0); expect(collision.stderr).toContain("Vault conflict");
  expect(await readFile(join(f.selected, "Sage", "personal.md"), "utf8")).toBe("User-owned note");
}, 30000);

test("Task72 CLI default export uses creation session/type while legacy exports and storage stay unchanged", async () => {
  const f = await fixture(), service = new LearningService(f.paths);
  let id: string, sequence: number;
  try { id = createTutorArtifact(service.store, { capability: "lesson_summary", content: "Owned summary", provenance: "Owned CLI fixture" }, "fixture").revision_id; sequence = service.store.throughSeq; } finally { service.close(); }
  const result = await cli(f.paths.home, ["export", id], "artifact"); expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout) as { fullPath: string; relativePath: string; created: boolean };
  expect(receipt.fullPath).toContain(join(f.paths.home, "content"));
  expect(receipt.relativePath).toMatch(/^session-[a-f0-9]{64}\/lesson_summary\/[a-f0-9-]+\.md$/);
  expect(await readFile(receipt.fullPath, "utf8")).toContain('"author": "tutor"');
  const legacy = join(f.root, "explicit.md");
  expect((await cli(f.paths.home, ["export", id, legacy], "artifact")).code).toBe(0);
  expect(await readFile(legacy, "utf8")).toBe("Owned summary");
  const again = await cli(f.paths.home, ["export", id], "artifact"); expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).created).toBe(false);
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(sequence); } finally { checked.close(); }
}, 30000);

test("Task72 CLI rebuild is exact-hash confirmed, copy-only, recoverable and preserves user edits", async () => {
  const f = await fixture(), service = new LearningService(f.paths);
  let id: string;
  try { id = createTutorArtifact(service.store, { capability: "lesson_summary", content: "Owned source", provenance: "Owned CLI fixture" }, "fixture").revision_id; } finally { service.close(); }
  const legacy = join(f.root, "historical.md"); await writeFile(legacy, "Unverified historical export");
  const preview = await cli(f.paths.home, ["rebuild"], "artifact"); expect(preview.code).toBe(0);
  const plan = JSON.parse(preview.stdout) as { plan_hash: string; items: Array<{ artifact_revision_id: string }> };
  expect(plan.items.map(item => item.artifact_revision_id)).toEqual([id]);
  expect((await cli(f.paths.home, ["rebuild", "--confirm", "wrong"], "artifact")).code).not.toBe(0);
  const applied = await cli(f.paths.home, ["rebuild", "--confirm", plan.plan_hash], "artifact"); expect(applied.code).toBe(0);
  const receipts = JSON.parse(applied.stdout).receipts as Array<{ fullPath: string; created: boolean }>;
  expect(receipts).toHaveLength(1); expect(receipts[0]!.created).toBe(true);
  expect(await readFile(legacy, "utf8")).toBe("Unverified historical export");
  const resumed = await cli(f.paths.home, ["rebuild", "--confirm", plan.plan_hash], "artifact"); expect(resumed.code).toBe(0);
  expect(JSON.parse(resumed.stdout).receipts[0].created).toBe(false);
  await writeFile(receipts[0]!.fullPath, "User annotation");
  expect((await cli(f.paths.home, ["rebuild", "--confirm", plan.plan_hash], "artifact")).code).not.toBe(0);
  expect(await readFile(receipts[0]!.fullPath, "utf8")).toBe("User annotation");
}, 30000);

test("unknown privacy scope flags cannot silently become a confirmed all-data purge", async () => {
  const f = await fixture(); const service = new LearningService(f.paths); let sequence: number;
  try { createTutorArtifact(service.store, { capability: "lesson_summary", content: "Preserve this synthetic artifact", provenance: "Owned fixture" }, "fixture"); sequence = service.store.throughSeq; }
  finally { service.close(); }
  const rejected = await cli(f.paths.home, ["purge", "--lesson", "unknown-lesson", "--confirm"], "privacy");
  expect(rejected.code).not.toBe(0); expect(rejected.stderr).toContain("Usage");
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(sequence); } finally { checked.close(); }
}, 30000);
