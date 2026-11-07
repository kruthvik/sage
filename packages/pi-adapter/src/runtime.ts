// Isolated pi runtime + the one-shot role transport (SPEC §12.1, §13). Ported in spirit from v3 packages/pi/src/{runtime,planner}.ts:
// v3 ran a tool-less child session per role call; pi 1.5's ModelRuntime.complete() gives the same single request with less machinery.
import { mkdirSync } from "node:fs";
import { loadPi, type PiSdk, type SagePaths } from "./sdk.ts";

export interface SageRuntimeOptions {
  paths: SagePaths;
  /** Agent dir pi reads auth/models/packages from. Default: Sage's own (`SAGE_HOME/agent`); global pi credentials are never copied. */
  agentDir?: string;
  /** pi package sources to load (e.g. "npm:pi-web-access@0.44.0"), so extension providers/tools register. Nothing ambient loads. */
  packages?: (string | { source: string; extensions?: string[] })[];
}

export interface RoleCallInput { provider: string; model: string; system: string; user: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal }
export interface RoleCallResult { text: string; stopReason: string; usage: { input: number; output: number; costUsd: number | "unknown" }; provider: string; model: string; ms: number }

export const ROLE_MAX_OUTPUT_TOKENS = 4096;
export const ROLE_DEADLINE_MS = 60_000;
export const ROLE_MAX_INPUT_CHARS = 32_768;

export async function createSageRuntime(opts: SageRuntimeOptions) {
  const { sdk } = await loadPi(opts.paths);
  const agentDir = opts.agentDir ?? opts.paths.agent;
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir; // process-local binding (v3): pi helpers resolve Sage's dir, not ~/.pi
  const settingsManager = sdk.SettingsManager.inMemory({
    enableInstallTelemetry: false, compaction: { enabled: false }, packages: opts.packages ?? [],
  } as Parameters<PiSdk["SettingsManager"]["inMemory"]>[0], { projectTrusted: false } as Parameters<PiSdk["SettingsManager"]["inMemory"]>[1]);
  const services = await sdk.createAgentSessionServices({
    cwd: opts.paths.home, agentDir, settingsManager,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const models = services.modelRuntime;

  /** One request, no tools, bounded output and time, cancelable. Throws on anything but a complete text answer. */
  async function roleCall(input: RoleCallInput): Promise<RoleCallResult> {
    if (input.user.length + input.system.length > ROLE_MAX_INPUT_CHARS) throw new Error(`role input exceeds ${ROLE_MAX_INPUT_CHARS} chars`);
    const model = models.getModel(input.provider, input.model);
    if (!model) throw new Error(`model ${input.provider}/${input.model} is not available; check settings or auth`);
    const controller = new AbortController();
    const relay = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("role call took too long; try again or choose another model")), input.timeoutMs ?? ROLE_DEADLINE_MS);
    const started = Date.now();
    try {
      const msg = await models.complete(model, { systemPrompt: input.system, messages: [{ role: "user", content: input.user, timestamp: started }] },
        { maxTokens: Math.min(input.maxTokens ?? ROLE_MAX_OUTPUT_TOKENS, ROLE_MAX_OUTPUT_TOKENS), signal: controller.signal } as never);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("cancelled");
      if (msg.content.some(p => p.type === "toolCall")) throw new Error("role call returned a tool call; roles have no tools");
      const text = msg.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(`role call failed: ${(msg as { errorMessage?: string }).errorMessage ?? msg.stopReason}`);
      if (!text.trim()) throw new Error("role call returned no text");
      const cost = msg.usage?.cost as { total?: number } | undefined;
      return { text, stopReason: msg.stopReason, provider: input.provider, model: input.model, ms: Date.now() - started,
        usage: { input: msg.usage?.input ?? 0, output: msg.usage?.output ?? 0, costUsd: typeof cost?.total === "number" ? cost.total : "unknown" } };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", relay); }
  }

  const available = async () => (await models.getAvailable()).map(m => `${m.provider}/${m.id}`);
  return { sdk, services, agentDir, roleCall, available, diagnostics: services.diagnostics };
}
export type SageRuntime = Awaited<ReturnType<typeof createSageRuntime>>;
