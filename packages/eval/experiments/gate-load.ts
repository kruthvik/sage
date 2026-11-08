// R&D: attempts the gate actually needed per passed node vs what the plan-fit estimate assumes (ED-29 RETRY_FACTOR).
// Reads eval ledgers (copies them first; the originals are never opened). Usage: bun packages/eval/experiments/gate-load.ts <ledger.sqlite>...
import { copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../storage/src/ledger.ts";
import { replay } from "../../engine/src/loop.ts";
import { K_CHECKS, RETRY_FACTOR, primeFor, requiredDimensions, NODE_CHECK_SIZE } from "../../engine/src/pedagogy.config.ts";

const rows: string[] = [];
let sumPred = 0, sumAct = 0;
for (const src of process.argv.slice(2)) {
  const copy = join(mkdtempSync(join(tmpdir(), "gate-load-")), "s.sqlite"); copyFileSync(src, copy);
  const led = new Ledger(copy);
  for (const sid of led.sessions()) {
    let s; try { s = replay(led.engineLog(sid)); } catch { console.error(`skip ${src} (recorded by an older engine)`); continue; }
    if (!s.plan) continue;
    const k = K_CHECKS[s.goal.mode][s.goal.pace];
    for (const n of s.plan.nodes) {
      if (n.status !== "passed") continue;
      const pred = n.subskills.reduce((a, x) => { const g = requiredDimensions(s.goal.mode, x).length; return a + (g + Math.max(0, k - g) + (primeFor(s.goal.mode, s.goal.pace, x) ? 1 : 0)); }, 0);
      const ids = new Set(n.subskills.map(x => x.id));
      const mine = s.attempts.filter(a => s.items.get(a.itemId)?.subskillIds.some(id => ids.has(id))), act = mine.length;
      const failed = mine.filter(a => a.grade && a.grade.score0to100 < 80).length, assisted = mine.filter(a => !a.independent).length;
      sumPred += pred * RETRY_FACTOR + NODE_CHECK_SIZE[s.goal.mode]; sumAct += act;
      rows.push(`| ${src.split(/[\/]/).at(-2)} | ${n.id} | ${n.subskills.length} | ${(pred * RETRY_FACTOR + NODE_CHECK_SIZE[s.goal.mode]).toFixed(0)} | ${act} | ${(act / (pred * RETRY_FACTOR + NODE_CHECK_SIZE[s.goal.mode])).toFixed(2)} | ${failed} | ${assisted} |`);
    }
  }
}
console.log(["| ledger | node | subskills | estimate's attempts (incl. retries + node check) | actual attempts | actual / estimate | scored < 80 | not independent |", "|---|---|---|---|---|---|---|---|", ...rows, "", `Overall actual / estimate: ${(sumAct / sumPred).toFixed(2)} over ${rows.length} passed nodes.`].join("\n"));
