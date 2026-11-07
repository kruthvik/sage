// Primary Cram metrics (owner reply 2): shown first in eval/REPORT.md and session.md.
import { passed } from "./items.ts";
import { usedMin } from "./pacing.ts";
import type { EngineState } from "./state.ts";

export interface CramMetrics {
  nodesPassedInBudget: number; nodesTotal: number; budgetMin?: number; usedMin: number;
  minutesToPass: Record<string, number>;
  finalCheck: { items: number; passed: number; meanScore: number | null };
  costPerHourUsd: number | "unknown";
}

export function cramMetrics(s: EngineState): CramMetrics {
  const nodes = s.plan?.nodes ?? [];
  const budget = s.goal?.timeBudgetMin;
  const inBudget = nodes.filter(n => n.status === "passed" && n.passedAtMin !== undefined && (budget === undefined || n.passedAtMin <= budget)).length;
  const final = s.attempts.filter(a => a.check === "final" && a.grade);
  const used = usedMin(s);
  return {
    nodesPassedInBudget: inBudget, nodesTotal: nodes.length, budgetMin: budget, usedMin: Math.round(used),
    minutesToPass: Object.fromEntries(nodes.filter(n => n.status === "passed").map(n => [n.id, Math.round((s.time.nodeMs.get(n.id) ?? 0) / 60_000)])),
    finalCheck: { items: final.length, passed: final.filter(a => passed(a.grade)).length, meanScore: final.length ? Math.round(final.reduce((x, a) => x + a.grade!.score0to100, 0) / final.length) : null },
    costPerHourUsd: s.spend.costUsd === "unknown" || s.spend.calls === 0 || used === 0 ? "unknown" : Math.round((s.spend.costUsd / (used / 60)) * 100) / 100,
  };
}
