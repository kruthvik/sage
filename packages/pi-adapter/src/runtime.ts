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

export interface RoleCallInput { provider: string; model: string; system: string; user: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal; /** Provider-neutral reasoning level; omitted ⇒ provider default (the grader was calibrated with the default). */ reasoning?: "minimal" | "low" | "medium" | "high" }
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
      const ctx = { systemPrompt: input.system, messages: [{ role: "user" as const, content: input.user, timestamp: started }] };
      const o = { maxTokens: Math.min(input.maxTokens ?? ROLE_MAX_OUTPUT_TOKENS, ROLE_MAX_OUTPUT_TOKENS), signal: controller.signal };
      const msg = input.reasoning ? await models.completeSimple(model, ctx, { ...o, reasoning: input.reasoning }) : await models.complete(model, ctx, o as never);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("cancelled");
      if (msg.content.some(p => p.type === "toolCall")) throw new Error("role call returned a tool call; roles have no tools");
      const text = msg.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
      if (msg.stopReason === "length") throw new Error(`role call hit the ${o.maxTokens}-token output limit; ask for less per call`);
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(`role call failed: ${(msg as { errorMessage?: string }).errorMessage ?? msg.stopReason}`);
      if (!text.trim()) throw new Error("role call returned no text");
      const cost = msg.usage?.cost as { total?: number } | undefined;
      return { text, stopReason: msg.stopReason, provider: input.provider, model: input.model, ms: Date.now() - started,
        usage: { input: msg.usage?.input ?? 0, output: msg.usage?.output ?? 0, costUsd: typeof cost?.total === "number" ? cost.total : "unknown" } };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", relay); }
  }

  // Researcher (owner reply 2): the only role with tools — pi-web-access search/fetch, hard-capped by a blocking hook.
  let researchServices: Promise<Awaited<ReturnType<PiSdk["createAgentSessionServices"]>>> | undefined;
  let budget = { searches: 0, fetches: 0, limits: { maxSearches: 6, maxFetches: 6 } };
  let queue: Promise<unknown> = Promise.resolve(); // shortcut: research calls run one at a time so the budget counter is per call; parallelise if packs queue up
  function researchCall(input: RoleCallInput & { system: string; limits: { maxSearches: number; maxFetches: number } }): Promise<RoleCallResult & { searches: number; fetches: number }> {
    const run = async () => {
      researchServices ??= sdk.createAgentSessionServices({
        cwd: opts.paths.home, agentDir, settingsManager,
        resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => input.system, appendSystemPromptOverride: () => [],
          extensionFactories: [{ name: "sage-research-limits", factory: pi => {
            pi.on("tool_call", ev => {
              const name = (ev as { toolName: string }).toolName;
              if (name === "web_search") return ++budget.searches > budget.limits.maxSearches ? { block: true, reason: `search limit ${budget.limits.maxSearches} reached; write the pack now` } : undefined;
              if (name === "fetch_content") return ++budget.fetches > budget.limits.maxFetches ? { block: true, reason: `fetch limit ${budget.limits.maxFetches} reached; write the pack now` } : undefined;
              if (name === "get_search_content") return undefined; // reads already-fetched results; no network
              return { block: true, reason: "the researcher may only search and fetch" };
            });
          } }] },
      });
      const svc = await researchServices;
      const model = svc.modelRuntime.getModel(input.provider, input.model);
      if (!model) throw new Error(`model ${input.provider}/${input.model} is not available; check settings or auth`);
      budget = { searches: 0, fetches: 0, limits: input.limits };
      const { session } = await sdk.createAgentSessionFromServices({ services: svc, sessionManager: sdk.SessionManager.inMemory(opts.paths.home), model,
        tools: ["web_search", "fetch_content", "get_search_content"] });
      const timer = setTimeout(() => void session.abort(), input.timeoutMs ?? 4 * ROLE_DEADLINE_MS);
      const relay = () => void session.abort();
      input.signal?.addEventListener("abort", relay, { once: true });
      const started = Date.now();
      try {
        const missing = ["web_search", "fetch_content"].filter(t => !session.getActiveToolNames().includes(t));
        if (missing.length) throw new Error(`research tools unavailable (${missing.join(", ")}); is pi-web-access installed?`);
        await session.prompt(input.user, { expandPromptTemplates: false, source: "extension" } as never);
        const msgs = session.messages.filter(m => m.role === "assistant") as { content: { type: string; text?: string }[]; usage?: { input: number; output: number; cost?: { total?: number } }; stopReason: string }[];
        const last = msgs.at(-1);
        if (!last || last.stopReason !== "stop") throw new Error(`research did not finish (${last?.stopReason ?? "no reply"})`);
        const text = last.content.filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
        const tot = msgs.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0),
          cost: typeof m.usage?.cost?.total === "number" && a.cost !== "unknown" ? a.cost + m.usage.cost.total : "unknown" as const }), { input: 0, output: 0, cost: 0 as number | "unknown" });
        return { text, stopReason: last.stopReason, provider: input.provider, model: input.model, ms: Date.now() - started,
          usage: { input: tot.input, output: tot.output, costUsd: tot.cost }, searches: Math.min(budget.searches, input.limits.maxSearches), fetches: Math.min(budget.fetches, input.limits.maxFetches) };
      } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", relay); session.dispose(); }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  const available = async () => (await models.getAvailable()).map(m => `${m.provider}/${m.id}`);
  return { sdk, services, agentDir, roleCall, researchCall, available, diagnostics: services.diagnostics };
}
export type SageRuntime = Awaited<ReturnType<typeof createSageRuntime>>;
