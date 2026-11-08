// Tutor turn runner: packet → one pi session with phase-scoped Sage tools → engine events (applied live through `apply`).
// If the model doesn't act, it gets one corrective retry; then a deterministic fallback keeps the session moving (labelled, never silent).
import type { Effect, EngineEvent, EngineState } from "../../engine/src/state.ts";
import { CHUNK_WORDS } from "../../engine/src/pedagogy.config.ts";
import type { RoleCallInput, TutorTool, TutorTurnResult } from "../../pi-adapter/src/runtime.ts";
import { SAGE_TOOLS } from "../../sage-extension/src/tools.ts";
import { TUTOR_POLICY } from "../../sage-extension/src/policy.ts";
import { buildPacket, drill } from "./packet.ts";
import type { RoleModel } from "./host.ts";

type TutorTurnFx = Extract<Effect, { kind: "tutor_turn" }>;
export interface TutorDeps {
  model: RoleModel;
  tutorTurn(i: Omit<RoleCallInput, "system"> & { system: string; tools: TutorTool[]; active: readonly string[] }): Promise<TutorTurnResult>;
  state(): EngineState;
  /** Apply an event via the reducer and the ledger; returns the engine's rejection message, if any. */
  apply(ev: EngineEvent, actor: "tutor" | "host"): string | undefined;
  signal?: AbortSignal;
}
export interface TutorOutcome { acted: boolean; fallback?: string; message?: string; chars: number; calls: TutorTurnResult["calls"] }

function task(fx: TutorTurnFx, s: EngineState): string {
  const cap = CHUNK_WORDS[s.goal.mode];
  switch (fx.phase) {
    case "diagnostic": return "Diagnostic: present the next unused practice item by itemId that best tells you what the learner already knows. Do not teach.";
    case "prime": return "Prime: present one unused practice item by itemId so the learner tries before being taught. Do not teach yet.";
    case "teach": return `Teach: present one chunk of at most ${cap} words for the subskill most in need (list its subskillIds). You may attach one teaching item as exampleItemId for a worked example.`;
    case "check": return "Check: present one unused practice item by itemId that checks what was just taught; if none fits, write one with activity.";
    case "adapt": return "Adapt: choose the next move with select_move from the candidates. Propose a hypothesis first only if attempts show a specific misconception.";
    case "repair": return "Repair: the learner's last answer had a blocking flaw. In at most 60 words, tell the learner what to fix without giving the answer. Reply with text only.";
    default: return `Phase ${fx.phase}: no action needed.`;
  }
}

/** Deterministic fallback when the tutor model fails twice: same choices the stub tutor makes, applied through the same reducer in the tutor role (it stands in for the tutor; the outcome is labelled). */
function fallback(fx: TutorTurnFx, s: EngineState, apply: TutorDeps["apply"]): string | undefined {
  if (fx.phase === "adapt") {
    // Real moves first, in the engine's priority order; a rejected one (e.g. an exhausted cue ladder) falls through to the next.
    for (const c of [...fx.candidates.filter(x => x.kind !== "checkpoint"), ...fx.candidates.filter(x => x.kind === "checkpoint")])
      if (!apply({ type: "move_selected", candidateId: c.id, reasonCodes: ["fallback_first_candidate"], nextIntendedMove: c.kind }, "tutor")) return `selected ${c.kind}`;
  }
  if (fx.phase === "check" || fx.phase === "prime" || fx.phase === "diagnostic") {
    // Every unused practice item in bank order; the engine rejects the ones that don't fit (variation baseline unseen, same family as a failure).
    for (const it of [...s.items.values()].filter(i => i.partition === "practice" && i.validated && !s.deliveredAt.has(i.id) && (fx.phase === "diagnostic" || i.nodeId === s.activeNodeId)))
      if (!apply({ type: "item_presented", itemId: it.id }, "tutor")) return `presented ${it.id}`;
  }
  return undefined;
}

export async function runTutorTurn(fx: TutorTurnFx, deps: TutorDeps): Promise<TutorOutcome> {
  const s0 = deps.state();
  const packet = buildPacket(s0, fx.candidates, task(fx, s0));
  const bridge = { state: deps.state, dispatch: (ev: EngineEvent) => deps.apply(ev, "tutor"), drill: (id: string) => drill(deps.state(), id) };
  const tools: TutorTool[] = SAGE_TOOLS.map(t => ({ ...t, run: (p: Record<string, unknown>) => { const r = t.run(p, bridge); return r.startsWith("ok") || t.name === "context" ? r : `error: ${r.replace(/^error:\s*/, "")}`; } }));
  const textOnly = !fx.tools.some(n => SAGE_TOOLS.find(t => t.name === n)?.endsTurn);
  const base = { provider: deps.model.provider, model: deps.model.model, system: TUTOR_POLICY, tools, active: fx.tools,
    ...(deps.model.reasoning ? { reasoning: deps.model.reasoning } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
  const calls: TutorTurnResult["calls"] = [];
  let user = `${packet.prefix}\n\n---\n\n${packet.dynamic}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await deps.tutorTurn({ ...base, user });
    calls.push(...r.calls);
    deps.apply({ type: "role_call_logged", role: "tutor", inputTokens: r.usage.input, outputTokens: r.usage.output, ...(r.usage.costUsd === "unknown" ? {} : { costUsd: r.usage.costUsd }) }, "host");
    if (r.ended) return { acted: true, chars: packet.chars, calls };
    if (textOnly && r.text.trim()) return { acted: true, message: r.text.trim(), chars: packet.chars, calls };
    const errs = r.calls.filter(c => c.result.startsWith("error")).map(c => `${c.name}: ${c.result}`).join("\n");
    user += `\n\nYour previous attempt did not complete the task.${errs ? `\nEngine rejections:\n${errs}` : " You must call a tool."}\nCall one of: ${fx.tools.filter(n => n !== "context").join(", ")}.`;
  }
  const fb = fallback(fx, deps.state(), deps.apply);
  return { acted: !!fb, ...(fb ? { fallback: fb } : {}), chars: packet.chars, calls };
}
