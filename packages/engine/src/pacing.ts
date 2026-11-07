import type { Mode, Pace, PlanNode } from "../../core/src/types.ts";
import { CHECK_ITEM_MIN, CHUNK_MIN, IDLE_GAP_MS, ITEM_MIN, K_CHECKS, NODE_CHECK_SIZE, NODE_CHECK_SIZE_SPEED_UP, PACE_OVERRUN, RETRY_FACTOR, primeFor, requiredDimensions } from "./pedagogy.config.ts";
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

/** Minutes to pass a node, from what its gate demands (owner: estimate from the real gate cost, never lighten the gate):
 * per subskill the cheapest item for each required dimension group (at least K independent items), a prime item when the
 * mode primes, one teaching chunk, all times a retry factor; plus the node check. */
export function gateMinutes(n: Pick<PlanNode, "subskills">, mode: Mode, pace: Pace): number {
  const k = K_CHECKS[mode][pace];
  const sub = n.subskills.reduce((sum, x) => {
    const groups = requiredDimensions(mode, x).map(g => Math.min(...g.map(d => ITEM_MIN[d])));
    const extra = Math.max(0, k - groups.length) * Math.min(...groups);
    const prime = primeFor(mode, pace, x) ? ITEM_MIN.execution : 0;
    return sum + (groups.reduce((a, b) => a + b, 0) + extra + prime + CHUNK_MIN) * RETRY_FACTOR;
  }, 0);
  return Math.ceil(sub + checkSize(mode, pace) * CHECK_ITEM_MIN);
}
const checkSize = (mode: Mode, pace: Pace) => pace === "speed_up" ? NODE_CHECK_SIZE_SPEED_UP : NODE_CHECK_SIZE[mode];

export interface PlanFit { estMin: number; budgetMin?: number; fits: boolean; speedUpMin: number; mergeMin: number; mergeGroups: string[][]; text?: string }
/** Plan vs budget at approval: the three ways out the learner can pick (extend, merge adjacent nodes, Speed-up). */
export function planFit(s: EngineState): PlanFit | undefined {
  if (!s.plan) return;
  const open = [...s.plan.nodes].filter(n => !DONE.has(n.status)).sort((a, b) => a.order - b.order);
  const est = (pace: Pace) => open.reduce((a, n) => a + gateMinutes(n, s.goal.mode, pace), 0);
  const estMin = Math.ceil(usedMin(s)) + est(s.goal.pace);
  // Adjacent nodes in plan order can always merge without a cycle; each merge saves one node check.
  const mergeGroups: string[][] = [];
  for (let i = 0; i + 1 < open.length; i += 2) mergeGroups.push([open[i]!.id, open[i + 1]!.id]);
  const mergeMin = estMin - mergeGroups.length * checkSize(s.goal.mode, s.goal.pace) * CHECK_ITEM_MIN;
  const speedUpMin = Math.ceil(usedMin(s)) + est("speed_up");
  const budgetMin = s.goal.timeBudgetMin;
  const fits = !budgetMin || estMin <= budgetMin;
  const tag = (m: number) => budgetMin && m > budgetMin ? `~${Math.ceil(m)} min, still over` : `~${Math.ceil(m)} min`;
  const text = fits ? undefined : `This plan needs about ${estMin} min to pass every node; your budget is ${budgetMin} min. Options: extend time to ${estMin} min; merge nodes ${mergeGroups.map(g => g.join("+")).join(", ")} (${tag(mergeMin)}); or start in Speed-up (${tag(speedUpMin)}). The gate is the same in every option.`;
  return { estMin, ...(budgetMin ? { budgetMin } : {}), fits, speedUpMin, mergeMin: Math.ceil(mergeMin), mergeGroups, ...(text ? { text } : {}) };
}
