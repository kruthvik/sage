// Dev-only live probe of the researcher role (submit_pack tool call) through the real host and reducer: one publisher-transcript
// search for a YouTube source and one intake search. Usage: bun packages/eval/src/research-probe.ts  (model via CHEAP, provider/model)
import { evalRuntime } from "./eval-runtime.ts";
import { runRole, type RoleModels, type RoleModel } from "../../agent/src/host.ts";
import { reduce, initialState } from "../../engine/src/index.ts";
import type { Effect, EngineEvent, EngineState } from "../../engine/src/state.ts";
import { goal } from "./fixture.ts";

const cheap = process.env.CHEAP ?? "antigravity/gemini-3.8-flash";
const [provider, model] = cheap.split("/") as [string, string];
const m: RoleModel = { provider, model };
const models = Object.fromEntries(["planner", "tutor", "grader", "generator", "feynman", "summarizer", "researcher", "checker", "transcriber"].map(r => [r, m])) as RoleModels;
const rt = await evalRuntime([provider]);

// A TED talk: TED publishes official transcripts on ted.com, so a correct pack points there, not at YouTube or a transcript farm.
const video = { sourceId: "src_probe_video", title: "Do schools kill creativity? | Sir Ken Robinson | TED", url: "https://www.youtube.com/watch?v=iG9CE55wbtY" };
const runs: [string, Parameters<typeof goal>[0]][] = [
  ["video_transcript", { objective: "Understand Ken Robinson's argument about creativity in schools", sourceIds: [video.sourceId], videoSources: [video], timeBudgetMin: 60 }],
  ["intake", { objective: "Learn the basic accounting principles and the accounting equation", timeBudgetMin: 60 }],
];
for (const [label, g] of runs) {
  let s: EngineState = initialState(); const fxs: Effect[] = [];
  const apply = (e: EngineEvent, actor: "learner" | "role" | "host") => { const r = reduce(s, e, new Date().toISOString(), actor); s = r.state; fxs.push(...r.effects); };
  apply({ type: "session_created", sessionId: `probe-${label}`, goal: goal(g) }, "learner");
  const fx = fxs.find(f => f.kind === "call_role" && f.role === "researcher") as Extract<Effect, { kind: "call_role" }> | undefined;
  if (!fx) { console.log(`${label}: no researcher call queued`); continue; }
  const t = Date.now();
  try {
    const evs = await runRole(fx, s, { models, roleCall: rt.roleCall, researchCall: rt.researchCall }, 1);
    for (const e of evs) apply(e.event, e.actor);
    const log = evs.map(e => e.event).filter((e): e is Extract<EngineEvent, { type: "role_call_logged" }> => e.type === "role_call_logged").at(-1);
    const p = [...s.packs.values()].at(-1);
    console.log(`\n${label} (${fx.purpose}): ${Math.round((Date.now() - t) / 1000)} s, ${log ? `${log.inputTokens} in / ${log.outputTokens} out tok, $${(log.costUsd ?? 0).toFixed(4)}` : "no log"}; pack ${p?.id ?? "none"} status=${p?.status}`);
    for (const i of p?.items ?? []) console.log(`  - ${i.unsourced ? "[unsourced] " : ""}${i.title} <${i.url ?? i.citation ?? "-"}>\n    reliability: ${i.reliability}\n    spans: ${i.spans.length}${i.spans[0] ? ` e.g. "${i.spans[0].slice(0, 120)}"` : ""}`);
  } catch (e) { console.log(`\n${label}: FAILED after ${Math.round((Date.now() - t) / 1000)} s: ${(e as Error).message}`); }
}
process.exit(0);
