// Dev-only live probe: session → planner → approve → bank (3 batches) → first tutor turn, plus one researcher pack, through the real host
// and reducer. Usage: bun packages/eval/src/live-probe.ts "<objective>"  (models via STRONG / CHEAP env, provider/model)
import { evalRuntime } from "./eval-runtime.ts";
import { runRole, type RoleModels, type RoleModel } from "../../agent/src/host.ts";
import { reduce, initialState } from "../../engine/src/index.ts";
import type { Effect, EngineEvent } from "../../engine/src/state.ts";
import { goal } from "./fixture.ts";

const m = (s: string, reasoning?: RoleModel["reasoning"]): RoleModel => { const [provider, model] = s.split("/") as [string, string]; return { provider, model, ...(reasoning ? { reasoning } : {}) }; };
const strong = process.env.STRONG ?? "openai/gpt-6.1-sol", cheap = process.env.CHEAP ?? "antigravity/gemini-3.8-flash";
const models: RoleModels = { planner: m(strong, "low"), tutor: m(strong), grader: m(strong), generator: m(cheap), feynman: m(cheap), summarizer: m(cheap), researcher: m(cheap), checker: m(cheap) };
const rt = await evalRuntime([...new Set([strong, cheap].map(x => x.split("/")[0]!))]);
const g = goal({ objective: process.argv[2] ?? "Pass a beginner sourdough bread practical next week", timeBudgetMin: 90 });

let s = initialState(), seq = 0;
const now = () => new Date().toISOString();
const pending: Effect[] = [];
const apply = (event: EngineEvent, actor: "learner" | "role" | "host") => { const st = reduce(s, event, now(), actor); s = st.state; pending.push(...st.effects); return st.effects; };
apply({ type: "session_created", sessionId: "probe", goal: g }, "learner");
const t0 = Date.now();
while (pending.length) {
  const fx = pending.shift()!;
  if (fx.kind === "notice") console.log("notice:", fx.text);
  if (fx.kind === "item_rejected") console.log("rejected:", fx.itemId, fx.problems.join(","));
  if (fx.kind === "tutor_turn") { console.log(`tutor_turn phase=${fx.phase} tools=${fx.tools.join(",")} candidates=${fx.candidates.map(c => c.kind).join(",")}`); break; }
  if (fx.kind !== "call_role") continue;
  const t = Date.now();
  try {
    const evs = await runRole(fx, s, { models, roleCall: rt.roleCall, researchCall: rt.researchCall }, ++seq);
    for (const e of evs) apply(e.event, e.actor);
    const logs = evs.filter(e => e.event.type === "role_call_logged").map(e => e.event as Extract<EngineEvent, { type: "role_call_logged" }>);
    console.log(`${fx.role}/${fx.purpose}: ${Date.now() - t} ms, ${logs.length} call(s), out ${logs.map(l => l.outputTokens).join("+")} tok`);
    if (fx.role === "planner") { console.log(s.plan!.nodes.map(n => `  ${n.id} ${n.title} [${n.knowledgeConfidence}] ${n.subskills.length} subskills${n.subskills.some(x => x.proxyFor) ? " (has proxies)" : ""}`).join("\n")); apply({ type: "plan_approved" }, "learner"); }
    if (fx.role === "generator") console.log(`  items accepted: ${[...s.items.values()].filter(i => i.nodeId === s.activeNodeId).map(i => i.partition).join(",")}`);
    if (fx.role === "researcher") { const p = [...s.packs.values()].at(-1); console.log(`  pack ${p?.id} status=${p?.status}: ${p?.items.map(i => `${i.title} <${i.url ?? i.citation ?? "unsourced"}> spans=${i.spans.length}`).join(" | ")}`); }
  } catch (e) { console.log(`${fx.role}/${fx.purpose} FAILED after ${Date.now() - t} ms: ${(e as Error).message}`); }
}
console.log(`total ${Math.round((Date.now() - t0) / 1000)} s · spend ${JSON.stringify(s.spend)}`);
process.exit(0);
