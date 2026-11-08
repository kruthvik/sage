// R&D: for each graded attempt, was the gate still missing something this item could evidence? (Reads copies of eval ledgers.)
// Usage: bun packages/eval/experiments/gate-waste.ts <ledger.sqlite>...
import { copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../storage/src/ledger.ts";
import { reduce } from "../../engine/src/loop.ts";
import { initialState } from "../../engine/src/state.ts";
import { gate } from "../../engine/src/evidence.ts";
import { view, subskill } from "../../engine/src/candidates.ts";

console.log("| ledger | graded attempts | useful (item could evidence a missing dimension) | wasted | top wasted activity × evidences | what was missing then (top) |\n|---|---|---|---|---|---|");
for (const src of process.argv.slice(2)) {
  const copy = join(mkdtempSync(join(tmpdir(), "gate-waste-")), "s.sqlite"); copyFileSync(src, copy);
  const led = new Ledger(copy);
  for (const sid of led.sessions()) {
    let s = initialState(), useful = 0, wasted = 0; const waste: Record<string, number> = {}, missingTop: Record<string, number> = {};
    try {
      for (const e of led.engineLog(sid)) {
        if (e.event.type === "response_submitted" && s.current && s.current.mode === "loop") {
          const it = s.items.get(s.current.itemId)!;
          const miss = it.subskillIds.flatMap(id => { const x = subskill(s, id); return x ? gate(x, s.goal.mode, s.goal.pace, view(s)).missing : []; });
          const hit = (it.evidences ?? []).some(d => miss.some(m => m.includes(d))) || miss.some(m => /^(independent_checks|families|stm)/.test(m));
          if (hit) useful++; else { wasted++; const k = `${it.activityType} [${(it.evidences ?? []).join("+")}]`; waste[k] = (waste[k] ?? 0) + 1; for (const m of miss) missingTop[m.replace(/:.*/, "")] = (missingTop[m.replace(/:.*/, "")] ?? 0) + 1; if (!miss.length) missingTop["(nothing: already passed)"] = (missingTop["(nothing: already passed)"] ?? 0) + 1; }
        }
        s = reduce(s, e.event, e.now, e.actor).state;
      }
    } catch { console.error(`skip ${src} (recorded by an older engine)`); continue; }
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${v}× ${k}`).join("; ");
    console.log(`| ${src.split(/[\/]/).at(-2)} | ${useful + wasted} | ${useful} | ${wasted} (${Math.round(100 * wasted / Math.max(1, useful + wasted))}%) | ${top(waste)} | ${top(missingTop)} |`);
  }
}
