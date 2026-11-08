// R&D: does telling the planner what a subskill costs at the gate make plans fit the budget?
// Usage: bun packages/eval/experiments/planner-fit.ts [provider/model] [repeats]  (default openai/gpt-6.1-terra, reasoning low)
import { evalRuntime } from "../src/eval-runtime.ts";
import { goal } from "../src/fixture.ts";
import { UNITS } from "../src/units.ts";
import { PLANNER_SYSTEM, plannerUser, parsePlan, budgetHint } from "../../agent/src/roles.ts";
import { gateMinutes } from "../../engine/src/pacing.ts";

const [provider, model] = (process.argv[2] ?? "openai/gpt-6.1-terra").split("/") as [string, string];
const repeats = Number(process.argv[3] ?? 2);
const rt = await evalRuntime([provider]);


const rows: string[] = [];
for (const u of UNITS) for (const arm of (process.env.ARMS ?? "current,hint").split(",") as ("current" | "hint")[]) for (let i = 0; i < repeats; i++) {
  const g = goal({ objective: u.objective, timeBudgetMin: u.minutes });
  const full = plannerUser(g), user = arm === "hint" ? full : full.replace(`\n\n${budgetHint(g)}`, ""); // plannerUser now always carries the hint
  try {
    const r = await rt.roleCall({ provider, model, system: PLANNER_SYSTEM, user, reasoning: "low" });
    const p = parsePlan(r.text);
    const est = p.nodes.reduce((a, n) => a + gateMinutes(n, g.mode, g.pace), 0);
    const subs = p.nodes.reduce((a, n) => a + n.subskills.length, 0);
    rows.push(`| ${u.id} | ${arm} | ${u.minutes} | ${est} | ${est <= u.minutes ? "yes" : "no"} | ${p.nodes.length} | ${subs} | ${typeof r.usage.costUsd === "number" ? r.usage.costUsd.toFixed(4) : "?"} | ${p.nodes.map(n => n.title).join("; ")} |`);
  } catch (e) { rows.push(`| ${u.id} | ${arm} | ${u.minutes} | error | | | | | ${String((e as Error).message).slice(0, 80)} |`); }
  console.error(rows.at(-1));
}
console.log(["| unit | arm | budget | gate estimate | fits | nodes | subskills | cost | node titles |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n"));
