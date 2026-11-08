// Isolated pi runtime + the one-shot role transport (SPEC §12.1, §13). Ported in spirit from v3 packages/pi/src/{runtime,planner}.ts:
// v3 ran a tool-less child session per role call; pi 1.5's ModelRuntime.complete() gives the same single request with less machinery.
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { type PiSdk, type SagePaths } from "./sdk.ts";
import { isolateProcess, loadPiWithFallback } from "./update.ts";

export interface SageRuntimeOptions {
  paths: SagePaths;
  /** Agent dir pi reads auth/models/packages from. Default: Sage's own (`SAGE_HOME/agent`); global pi credentials are never copied. */
  agentDir?: string;
  /** pi package sources to load (e.g. "npm:pi-web-access@0.44.0"), so extension providers/tools register. Nothing ambient loads. */
  packages?: (string | { source: string; extensions?: string[] })[];
}

export interface RoleCallInput { provider: string; model: string; system: string; user: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal; /** Provider-neutral reasoning level; omitted ⇒ provider default (the grader was calibrated with the default). */ reasoning?: "minimal" | "low" | "medium" | "high";
  /** Structured output: the model must answer by calling this one tool; its arguments come back as `text` (JSON). Providers that ignore the forced choice may still answer in text. */
  output?: { name: string; description: string; schema: Record<string, unknown> } }
export interface RoleCallResult { text: string; stopReason: string; usage: { input: number; output: number; cached?: number; costUsd: number | "unknown" }; provider: string; model: string; ms: number }

/** Structural copy of sage-extension's SageTool, bound to a bridge (pi-adapter never imports Sage packages above core). */
export interface TutorTool { name: string; label: string; description: string; parameters: Record<string, unknown>; endsTurn: boolean; run(params: Record<string, unknown>): string }
export interface TutorTurnResult { ended: boolean; calls: { name: string; params: Record<string, unknown>; result: string }[]; text: string; usage: RoleCallResult["usage"]; ms: number }

export const ROLE_MAX_OUTPUT_TOKENS = 4096;
const nstr = { type: ["string", "null"] };
/** Researcher output schema (the submit_pack tool). The engine still re-validates every item. */
export const PACK_SCHEMA = { type: "object", required: ["items"], properties: { items: { type: "array", maxItems: 8, items: { type: "object", required: ["title", "relevance", "spans", "reliability"],
  properties: { title: { type: "string" }, url: nstr, citation: nstr, relevance: { type: "string" }, spans: { type: "array", items: { type: "string" } }, reliability: { type: "string" },
    nodeId: nstr, conflictsWithSourceId: nstr, unsourced: { type: "boolean" } } } } } } as const;
export const ROLE_DEADLINE_MS = 60_000;
export const ROLE_MAX_INPUT_CHARS = 32_768;

export async function createSageRuntime(opts: SageRuntimeOptions) {
  isolateProcess(opts.paths); // temp files and npm cache under SAGE_HOME
  const { sdk, notice } = await loadPiWithFallback(opts.paths);
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
      const out = input.output;
      const ctx = { systemPrompt: input.system, messages: [{ role: "user" as const, content: input.user, timestamp: started }],
        ...(out ? { tools: [{ name: out.name, description: out.description, parameters: out.schema }] } : {}) };
      // "required" is what antigravity maps to Gemini's forced function call (mode ANY); pi's own type only lists auto/none.
      // A stable key per system prompt lets the provider reuse its prompt cache across one-shot role calls (cached input bills at ~10%).
      const sessionId = `sage-${createHash("sha256").update(input.system).digest("hex").slice(0, 16)}`;
      const o = { maxTokens: Math.min(input.maxTokens ?? ROLE_MAX_OUTPUT_TOKENS, ROLE_MAX_OUTPUT_TOKENS), signal: controller.signal, sessionId, ...(out ? { toolChoice: "required" } : {}) };
      const msg = input.reasoning ? await models.completeSimple(model, ctx, { ...o, reasoning: input.reasoning } as never) : await models.complete(model, ctx, o as never);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("cancelled");
      const calls = msg.content.filter(p => p.type === "toolCall") as { name: string; arguments: unknown }[];
      if (calls.some(c => c.name !== out?.name)) throw new Error("role call returned a tool call; roles have no tools");
      const text = calls.length ? JSON.stringify(calls[0]!.arguments) : msg.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
      if (msg.stopReason === "length") throw new Error(`role call hit the ${o.maxTokens}-token output limit; ask for less per call`);
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(`role call failed: ${(msg as { errorMessage?: string }).errorMessage ?? msg.stopReason}`);
      if (!text.trim()) throw new Error("role call returned no text");
      const cost = msg.usage?.cost as { total?: number } | undefined;
      return { text, stopReason: msg.stopReason, provider: input.provider, model: input.model, ms: Date.now() - started,
        usage: { input: msg.usage?.input ?? 0, output: msg.usage?.output ?? 0, cached: (msg.usage as { cacheRead?: number } | undefined)?.cacheRead ?? 0, costUsd: typeof cost?.total === "number" ? cost.total : "unknown" } };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", relay); }
  }

  // Researcher (owner reply 2): the only role with tools — pi-web-access search/fetch, hard-capped by a blocking hook.
  let researchServices: Promise<Awaited<ReturnType<PiSdk["createAgentSessionServices"]>>> | undefined;
  let budget = { searches: 0, fetches: 0, limits: { maxSearches: 6, maxFetches: 6 } };
  let researchSystem = "";
  let queue: Promise<unknown> = Promise.resolve(); // shortcut: research calls run one at a time so the budget counter is per call; parallelise if packs queue up
  function researchCall(input: RoleCallInput & { system: string; limits: { maxSearches: number; maxFetches: number } }): Promise<RoleCallResult & { searches: number; fetches: number }> {
    const run = async () => {
      researchServices ??= sdk.createAgentSessionServices({
        cwd: opts.paths.home, agentDir, settingsManager,
        resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => researchSystem, appendSystemPromptOverride: () => [],
          extensionFactories: [{ name: "sage-research-limits", factory: pi => {
            pi.on("tool_call", ev => {
              const name = (ev as { toolName: string }).toolName;
              if (name === "web_search") return ++budget.searches > budget.limits.maxSearches ? { block: true, reason: `search limit ${budget.limits.maxSearches} reached; write the pack now` } : undefined;
              if (name === "fetch_content") return ++budget.fetches > budget.limits.maxFetches ? { block: true, reason: `fetch limit ${budget.limits.maxFetches} reached; write the pack now` } : undefined;
              if (name === "get_search_content" || name === "submit_pack") return undefined; // reads cached results / returns the pack; no network
              return { block: true, reason: "the researcher may only search and fetch" };
            });
          } }] },
      });
      const svc = await researchServices;
      const model = svc.modelRuntime.getModel(input.provider, input.model);
      if (!model) throw new Error(`model ${input.provider}/${input.model} is not available; check settings or auth`);
      budget = { searches: 0, fetches: 0, limits: input.limits }; researchSystem = input.system;
      // The pack comes back as tool-call arguments validated against PACK_SCHEMA, not as free-form JSON in prose (flash ended with prose).
      let submitted: unknown;
      const submit = sdk.defineTool({ name: "submit_pack", label: "Submit pack", description: "Submit the finished source pack. Call exactly once, when you are done searching.", parameters: PACK_SCHEMA as never,
        async execute(_id, params) { submitted = params; return { content: [{ type: "text" as const, text: "ok: pack received; stop now" }], details: undefined }; } });
      const { session } = await sdk.createAgentSessionFromServices({ services: svc, sessionManager: sdk.SessionManager.inMemory(opts.paths.home), model,
        customTools: [submit] as never, tools: ["web_search", "fetch_content", "get_search_content", "submit_pack"] });
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
        const text = submitted !== undefined ? JSON.stringify(submitted) : last.content.filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
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

  // Tutor: one fresh pi session per turn (the packet carries context, so history never grows), only Sage's tools active.
  let tutorServices: Promise<Awaited<ReturnType<PiSdk["createAgentSessionServices"]>>> | undefined;
  let tutorSystem = "";
  async function tutorTurn(input: Omit<RoleCallInput, "system"> & { system: string; tools: TutorTool[]; active: readonly string[] }): Promise<TutorTurnResult> {
    tutorSystem = input.system;
    tutorServices ??= sdk.createAgentSessionServices({ cwd: opts.paths.home, agentDir, settingsManager,
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => tutorSystem, appendSystemPromptOverride: () => [] } });
    const svc = await tutorServices;
    const model = svc.modelRuntime.getModel(input.provider, input.model);
    if (!model) throw new Error(`model ${input.provider}/${input.model} is not available; check settings or auth`);
    const calls: TutorTurnResult["calls"] = [];
    let ended = false;
    const customTools = input.tools.filter(t => input.active.includes(t.name)).map(t => sdk.defineTool({
      name: t.name, label: t.label, description: t.description, parameters: t.parameters as never,
      async execute(_id, params) {
        let text: string;
        if (ended && t.endsTurn) text = "error: this turn already ended; stop now";
        else { text = t.run(params as Record<string, unknown>); if (t.endsTurn && text.startsWith("ok")) ended = true; }
        calls.push({ name: t.name, params: params as Record<string, unknown>, result: text });
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }));
    // Stable id per tutor system prompt = stable prompt_cache_key, so the packet's fixed prefix is cached across turns (a fresh id per turn never hit the cache).
    // shortcut: concurrent learner sessions share the id, and dispose() runs pi's per-id cleanup (only openai-codex websockets); key it per Sage session if that ever bites.
    const cacheId = `sage-tutor-${createHash("sha256").update(input.system).digest("hex").slice(0, 16)}`;
    const { session } = await sdk.createAgentSessionFromServices({ services: svc, sessionManager: sdk.SessionManager.inMemory(opts.paths.home, { id: cacheId }), model,
      customTools: customTools as never, tools: [...input.active], ...(input.reasoning ? { thinkingLevel: input.reasoning as never } : {}) });
    const timer = setTimeout(() => void session.abort(), input.timeoutMs ?? 2 * ROLE_DEADLINE_MS);
    const relay = () => void session.abort();
    input.signal?.addEventListener("abort", relay, { once: true });
    const started = Date.now();
    try {
      const extra = session.getActiveToolNames().filter(n => !input.active.includes(n));
      if (extra.length) throw new Error(`tutor isolation check failed: unexpected tools ${extra.join(", ")}`);
      await session.prompt(input.user, { expandPromptTemplates: false, source: "extension" } as never);
      const msgs = session.messages.filter(m => m.role === "assistant") as { content: { type: string; text?: string }[]; usage?: { input: number; output: number; cacheRead?: number; cost?: { total?: number } } }[];
      const usage = msgs.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0), cached: a.cached + (m.usage?.cacheRead ?? 0),
        costUsd: typeof m.usage?.cost?.total === "number" && a.costUsd !== "unknown" ? a.costUsd + m.usage.cost.total : "unknown" as const }), { input: 0, output: 0, cached: 0, costUsd: 0 as number | "unknown" });
      const text = msgs.at(-1)?.content.filter(p => p.type === "text").map(p => p.text ?? "").join("\n") ?? "";
      return { ended, calls, text, usage, ms: Date.now() - started };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", relay); session.dispose(); }
  }

  const available = async () => (await models.getAvailable()).map(m => `${m.provider}/${m.id}`);
  return { sdk, services, agentDir, roleCall, researchCall, tutorTurn, available, diagnostics: services.diagnostics, piNotice: notice };
}
export type SageRuntime = Awaited<ReturnType<typeof createSageRuntime>>;
