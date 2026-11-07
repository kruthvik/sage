import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedPiChild, type BoundedPiChildRequest } from "../src/planner.ts";
import { loadPi, type PiSdk } from "../src/sdk.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const scenarios = ["ok", "preparation_scope", "mutable_permit", "foreign_parent", "sharing_disabled", "stale_reply", "large_input", "large_output", "empty_output", "policy_path", "unserializable", "cancel_setup", "request_snapshot", "abort_cleanup_error", "cancel_during_reply"] as const;
for (const scenario of scenarios) test(`protected child: ${scenario} obeys the parent scope and proposal boundary`, async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-protected-child-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const prompts = join(root, "prompts"); await mkdir(prompts);
  await writeFile(join(prompts, "tutor-policy.md"), "Protected test child; return an attributed draft, never learner evidence.");
  await writeFile(join(root, "synthetic-private.md"), "SYNTHETIC_POLICY_OUTSIDE");
  await mkdir(paths.config, { recursive: true });
  await writeFile(join(paths.config, "AGENTS.md"), "AMBIENT_UNAUTHORIZED");
  const ownedPaths = { ...paths, builtIn: { ...paths.builtIn, prompts } }, sdk = await loadPi(paths);
  // Use this SDK installation's declared AI package, not a second app dependency.
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const manifest = await Bun.file(new URL("../package.json", sdkEntry)).json();
  const aiPackage = Object.keys(manifest.dependencies ?? {}).find(name => name.endsWith("/pi-ai"));
  if (!aiPackage) throw new Error("The bundled SDK does not declare its AI package");
  const ai = await import(import.meta.resolve(aiPackage, fileURLToPath(sdkEntry)));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const abort = new AbortController(); let entered = 0, created = 0, disposed = 0, authorizations = 0, revision = "scope-a";
  const mutable = { session_id: "parent", revision, packet: { goal: { body: { provider_sharing: true } } } };
  modelRuntime.registerProvider("protected-offline", {
    api: "protected-offline-api", baseUrl: "https://example.invalid", apiKey: "offline",
    models: [{ id: "child", name: "Scripted child", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      entered++;
      expect(context.messages.filter(m => m.role === "system").flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : [])).toEqual([]);
      expect(JSON.stringify(context)).not.toContain("AMBIENT_UNAUTHORIZED"); expect(options?.maxTokens).toBe(4096);
      if (scenario === "request_snapshot") {
        expect(JSON.stringify(context)).toContain("Current owned facts");
        expect(JSON.stringify(context)).not.toContain("SYNTHETIC_LATE_MUTATION");
      }
      const stream = ai.createAssistantMessageEventStream();
      const text = scenario === "large_output" ? "x".repeat(32769) : scenario === "empty_output" ? "   " : "safe draft";
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
      void (async () => {
        try {
          await options?.onPayload?.({ scripted: true }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          if (scenario === "stale_reply") revision = "scope-b";
          if (scenario === "cancel_during_reply") abort.abort(new Error("Cancelled during reply"));
          stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message });
        } catch {
          stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "Scripted request refused" } });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
  const supplied = { ...sdk, createAgentSession: async (...args: Parameters<PiSdk["createAgentSession"]>) => {
    const result = await sdk.createAgentSession(...args); created++;
    const dispose = result.session.dispose.bind(result.session);
    result.session.dispose = () => { disposed++; return dispose(); };
    if (scenario === "request_snapshot") (request as Record<string, unknown>).brief = "SYNTHETIC_LATE_MUTATION";
    if (scenario === "abort_cleanup_error" || scenario === "cancel_during_reply") result.session.abort = async () => { throw new Error("Scripted abort failure"); };
    if (scenario === "cancel_setup" || scenario === "abort_cleanup_error") abort.abort(new Error("Cancelled during setup"));
    return result;
  } } satisfies PiSdk;
  let request: unknown = { brief: "Current owned facts" };
  if (scenario === "large_input") request = { brief: "x".repeat(32769) };
  if (scenario === "unserializable") { const circular: Record<string, unknown> = {}; circular.self = circular; request = circular; }
  const child: BoundedPiChildRequest = { operation: "pi_compaction_request", policyFile: scenario === "policy_path" ? "../synthetic-private.md" as BoundedPiChildRequest["policyFile"] : "tutor-policy.md", schema: { type: "string" }, request };
  const work = runBoundedPiChild(ownedPaths, child, { sdk: supplied, modelRuntime, model: modelRuntime.getModel("protected-offline", "child")!, sessionId: "parent", signal: abort.signal, calls: async () => {}, authorize: async () => {
    authorizations++;
    if (scenario === "mutable_permit") { if (authorizations > 1) mutable.revision = "scope-b"; return mutable; }
    return { session_id: scenario === "foreign_parent" ? "foreign" : "parent", revision: scenario === "preparation_scope" && authorizations > 1 ? "scope-b" : revision, packet: { goal: { body: { provider_sharing: scenario !== "sharing_disabled" } } } };
  } });
  if (scenario === "ok" || scenario === "request_snapshot") expect(await work).toBe("safe draft");
  else await expect(work).rejects.toThrow(scenario === "abort_cleanup_error" || scenario === "cancel_during_reply" ? /Scripted abort failure/ : scenario === "unserializable" ? /Invalid bounded subagent request/ : scenario === "cancel_setup" ? /Cancelled/ : scenario === "policy_path" ? /policy/ : scenario === "large_input" ? /input.*bound|exceeds/i : scenario === "large_output" || scenario === "empty_output" ? /proposal/ : /scope|disclosure/i);
  const early = ["foreign_parent", "sharing_disabled", "large_input", "policy_path", "unserializable"].includes(scenario);
  expect(created).toBe(early ? 0 : 1); expect(disposed).toBe(created);
  expect(entered).toBe(["ok", "stale_reply", "large_output", "empty_output", "request_snapshot", "cancel_during_reply"].includes(scenario) ? 1 : 0);
});
