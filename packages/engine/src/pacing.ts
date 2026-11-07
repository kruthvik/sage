import { IDLE_GAP_MS, PACE_OVERRUN } from "./pedagogy.config.ts";
import type { EngineState } from "./state.ts";

/** Adds on-task time since the last event; gaps over the idle limit are excluded and counted as a focus signal (SPEC §11). Mutates `s`. */
export function accrue(s: EngineState, now: string): void {
  const last = s.time.lastAt;
  s.time.lastAt = now;
  if (!last || !s.activeNodeId) return;
  const gap = Date.parse(now) - Date.parse(last);
  if (gap > IDLE_GAP_MS) { s.time.idleGaps++; return; }
  if (gap > 0) s.time.nodeMs.set(s.activeNodeId, (s.time.nodeMs.get(s.activeNodeId) ?? 0) + gap);
}

export const usedMin = (s: EngineState) => [...s.time.nodeMs.values()].reduce((a, b) => a + b, 0) / 60_000;
const DONE = new Set(["passed", "tested_out", "left_with_gaps"]);

/** Projected total minutes: time used + remaining nodes at the observed per-node pace (estMinutes until a node has finished). */
export function projectedMin(s: EngineState): number {
  const nodes = s.plan?.nodes ?? [];
  const finished = nodes.filter(n => DONE.has(n.status) && s.time.nodeMs.has(n.id));
  const ratio = finished.length ? finished.reduce((a, n) => a + (s.time.nodeMs.get(n.id) ?? 0) / 60_000, 0) / finished.reduce((a, n) => a + n.estMinutes, 0) : 1;
  const remaining = nodes.filter(n => !DONE.has(n.status)).reduce((a, n) => a + Math.max(0, n.estMinutes * ratio - (s.time.nodeMs.get(n.id) ?? 0) / 60_000), 0);
  return usedMin(s) + remaining;
}

const hm = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, "0")}`;

/** Non-blocking pace notice: ≤1 per node unless the projection worsens. Mutates `s.time` when a notice is due. */
export function paceNotice(s: EngineState): { text: string; options: string[] } | undefined {
  const budget = s.goal.timeBudgetMin;
  if (!budget || !s.plan) return;
  const p = projectedMin(s);
  if (p <= budget * PACE_OVERRUN) return;
  if (s.time.noticeNodeId === s.activeNodeId && p <= (s.time.noticeProjectedMin ?? Infinity)) return;
  s.time.noticeNodeId = s.activeNodeId; s.time.noticeProjectedMin = p;
  const done = s.plan.nodes.filter(n => DONE.has(n.status)).length;
  return { text: `${hm(usedMin(s))} of ${hm(budget)} · ${done}/${s.plan.nodes.length} nodes · projected ~${hm(p)}`, options: ["Continue normal", "Speed up", "Extend time", "Review plan"] };
}
