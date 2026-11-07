import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { acquireTutorLock } from "../../runtime/src/tutor-lock.ts";
import { LearningService } from "../../runtime/src/service.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { projectLearningState } from "../../runtime/src/learning-state.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

/** Compatibility probe only: no prompt/provider, credentials, package install, or TTY claim. */
async function nativeCli(args: string[], input = "") {
  const root = await mkdtemp(join(tmpdir(), "sage-native-cli-")); roots.push(root);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string; bin: { pi: string } };
  const child = Bun.spawn([process.execPath, join(packageRoot, manifest.bin.pi), ...args], { cwd: root, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, HOME: root, USERPROFILE: root,
    PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill(); }, 10000);
  try {
    child.stdin.write(input); await child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (expired) throw new Error("Owned native Pi compatibility subprocess exceeded its deadline");
    return { stdout, stderr, code, version: manifest.version };
  } finally { clearTimeout(deadline); if (child.exitCode === null) { child.kill(); await child.exited; } }
}

test("e02s01 task 3: owned Sage native runtime subprocess resumes denied pending work and releases server/lease on EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-owned-native-")); roots.push(root);
  const modulePath = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
  const script = join(root, "owned-lifecycle.ts");
  await writeFile(script, `
import { createSagePaths } from ${modulePath("../../runtime/src/paths.ts")};
import { bootstrapSageHome } from ${modulePath("../../runtime/src/bootstrap.ts")};
import { LearningService, startLearningServer } from ${modulePath("../../runtime/src/service.ts")};
import { createTutorBridge } from ${modulePath("../../runtime/src/tutor-host.ts")};
import { installFixtures } from ${modulePath("../../activities/src/fixtures.ts")};
import { acquireTutorLock } from ${modulePath("../../runtime/src/tutor-lock.ts")};
import { createTutorRuntime } from ${modulePath("../src/tutor.ts")};
import { loadPi } from ${modulePath("../src/sdk.ts")};
import { randomUUID } from "node:crypto";
const paths = createSagePaths({ home: ${JSON.stringify(join(root, "home"))}, cwd: ${JSON.stringify(root)} });
await bootstrapSageHome(paths);
const release = acquireTutorLock(paths.home), service = new LearningService(paths), server = startLearningServer(service);
const bridge = createTutorBridge(paths, service, server), sdk = await loadPi(paths);
const models = await sdk.ModelRuntime.create({ authPath: paths.agent + "/auth.json", modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
const native = await createTutorRuntime(paths, bridge, { ...sdk, createAgentSessionServices: options => sdk.createAgentSessionServices({ ...options, modelRuntime: models }) });
try {
 const owner = native.session.sessionId;
 await bridge.goal({ mode: "learn", objective: "Owned pending math", subject: "math", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] }, owner);
 const goal = service.store.lessonGoal(owner), task = installFixtures(service.store, goal)[0];
 const started = service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, definition_revision_id: task.revision_id, expected_goal_revision_id: goal.revision_id, expected_state_revision: (await service.context({}, owner)).learning_state.state_revision }, owner);
 const pending = service.store.revision(started.instance_revision_id);
 native.session.sessionManager.appendMessage({ role: "user", content: "Local lifecycle fixture, not submitted evidence", timestamp: Date.now() });
 const sessionFile = native.session.sessionFile;
 const denied = service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, provider_sharing: false } }, "learner", owner);
 await native.newSession(); await native.switchSession(sessionFile);
 for await (const chunk of Bun.stdin.stream()) { if (new TextDecoder().decode(chunk).trim() !== "stop") throw new Error("Unknown test control"); await bridge.stop(owner); }
 const packet = await bridge.operation("learning_context", {}, owner);
 console.log(JSON.stringify({ version: sdk.VERSION, owner, pending: pending.revision_id, denied: denied.revision_id, goal: service.store.lessonGoal(owner).revision_id, sharing: service.store.lessonGoal(owner).body.provider_sharing, retained: service.store.revision(pending.revision_id).revision_id === pending.revision_id, attempts: service.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind)).length, server: server.url, stopped: service.store.events().some(e => e.kind === "checkpoint" && e.payload.stopped === true) }));
} finally { await native.dispose(); server.stop(); service.close(); release(); }
`);
  const child = Bun.spawn([process.execPath, script], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, HOME: root, USERPROFILE: root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill(); }, 10000);
  try {
    child.stdin.write("stop\n"); await child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(expired).toBe(false); expect(code).toBe(0); expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({ version: "1.0.0", sharing: false, retained: true, stopped: true, attempts: 0 });
    expect(result.goal).toBe(result.denied);
    const reopened = new LearningService(createSagePaths({ home: join(root, "home"), cwd: root }));
    try {
      const state = projectLearningState(reopened.store, result.owner);
      expect(state.current_task?.instance_revision_id).toBe(result.pending);
      expect(state.pending_count).toBe(1);
      expect(state.phase).toBe("stopped");
      expect(reopened.store.lessonGoal(result.owner)?.revision_id).toBe(result.denied);
      expect(reopened.store.lessonGoal(result.owner)?.body.provider_sharing).toBe(false);
      expect(reopened.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    } finally { reopened.close(); }
    await expect(access(join(root, "home", "tutor.lock"))).rejects.toThrow();
    const release = acquireTutorLock(join(root, "home")); release();
    expect(result.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(Bun.connect({ hostname: "127.0.0.1", port: Number(new URL(result.server).port), socket: { data() {} } })).rejects.toThrow();
  } finally { clearTimeout(deadline); if (child.exitCode === null) { child.kill(); await child.exited; } }
}, 15000);

test("bundled native Pi CLI launches through Bun using its declared bin and version", async () => {
  const result = await nativeCli(["--version"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout.trim()).toBe(result.version);
}, 15000);

test("native offline RPC starts isolated, answers local state discovery and exits cleanly on EOF", async () => {
  const result = await nativeCli(["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline"], [{ id: "state", type: "get_state" }, { id: "commands", type: "get_commands" }].map(command => JSON.stringify(command)).join("\n") + "\n");
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records.find(r => r.id === "state")).toMatchObject({ type: "response", command: "get_state", success: true, data: { messageCount: 0, isStreaming: false } });
  expect(records.find(r => r.id === "commands")).toMatchObject({ type: "response", command: "get_commands", success: true, data: { commands: [] } });
}, 15000);
