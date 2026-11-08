// Real-grader calibration (SPEC §18.4, task 3). Usage: bun packages/eval/calibration/run-grader.ts <provider>/<model> [repeats]
// Reports A1–A10, C01–C20 (both owner-scored) and all 30. The gate (owner, 2026-11-08): every single repeat passes on all 30.
// Credentials: Sage's own agent dir only (sage setup + sage login).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { evalRuntime } from "../src/eval-runtime.ts";
import { GRADER_SYSTEM, GRADE_OUTPUT, graderUser, parseGrade } from "../../agent/src/grader.ts";
import { validateGrade } from "../../engine/src/evidence.ts";
import { ANCHORS, CALIBRATION_SET, GENERATED, calibrate, type Triple } from "./set.ts";
import { CALIBRATION } from "../../engine/src/pedagogy.config.ts";

const [spec, repeatsArg] = process.argv.slice(2);
const [provider, model] = spec?.split("/") ?? [];
if (!provider || !model) { console.error("usage: run-grader.ts <provider>/<model> [repeats]"); process.exit(2); }
const repeats = Math.max(1, Number(repeatsArg ?? 1));
const reasoning = process.env.REASONING as "minimal" | "low" | "medium" | "high" | undefined; // optional; the gate result is per (model, reasoning)
const tag = reasoning ? `${model}@${reasoning}` : model!;

const rt = await evalRuntime([provider]);

const failures: string[] = [];
interface Row { id: string; target: number; scores: number[]; problems: string[]; error?: string; inTok: number; outTok: number; cost: number | "unknown"; ms: number }
async function gradeOne(t: Triple): Promise<Row> {
  const row: Row = { id: t.id, target: t.target, scores: [], problems: [], inTok: 0, outTok: 0, cost: 0, ms: 0 };
  for (let i = 0; i < repeats; i++) {
    // Same path as production (host.ts): one retry that says what was rejected.
    let user = graderUser(t, t.response);
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = "";
      try {
        const r = await rt.roleCall({ provider: provider!, model: model!, system: GRADER_SYSTEM, user, ...(process.env.OUTPUT === "text" ? {} : { output: GRADE_OUTPUT }), ...(reasoning ? { reasoning } : {}) });
        row.inTok += r.usage.input; row.outTok += r.usage.output; row.ms += r.ms; text = r.text;
        row.cost = r.usage.costUsd === "unknown" || row.cost === "unknown" ? "unknown" : row.cost + r.usage.costUsd;
        const g = parseGrade(r.text, { rubric: t.rubric, evidences: [] });
        row.scores.push(g.score0to100);
        row.problems.push(...validateGrade(g, t.response));
        if (attempt) row.problems.push("needed retry");
        break;
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        // Owner's plan quota: stop the whole run at the first limit error rather than keep spending retries against it.
        if (/usage limit|usage_limit|quota|insufficient|rate.?limit|429/i.test(msg)) { console.error(`STOPPED: ${msg.slice(0, 300)}`); process.exit(3); }
        failures.push(`## ${t.id} attempt ${attempt}: ${msg}\n${text.slice(0, 2000) || "(empty reply)"}\n`);
        if (attempt) { row.error = msg.slice(0, 160); break; }
        user += `\n\nYour previous reply was rejected: ${msg.slice(0, 400)}. Fix exactly that and reply again with JSON only.`;
      }
    }
  }
  return row;
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]!); } }));
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sg = (x?: number) => x === undefined ? "—" : (x >= 0 ? "+" : "") + x.toFixed(1);
function section(title: string, set: Triple[], rows: Row[]) {
  const scored = rows.filter(r => r.scores.length);
  const res = calibrate(Object.fromEntries(scored.map(r => [r.id, mean(r.scores)])), set);
  const lines = [`## ${title}`, "",
    `n=${res.n}/${set.length} · MAE ${res.mae.toFixed(1)} (≤${CALIBRATION.maxMae}) · mean signed ${res.meanSigned >= 0 ? "+" : ""}${res.meanSigned.toFixed(1)} (≤+${CALIBRATION.maxMeanSignedError}) · signed A ${sg(res.signedAnchors)} · signed ≤70 ${sg(res.signedLow)} · >+20: ${res.overItems.join(", ") || "none"} · ≥95 on ≤85: ${res.lenientViolations.join(", ") || "none"} · **${res.passed ? "PASS" : "FAIL"}**`, "",
    "| id | target | score | Δ | runs | validity problems | error |", "|---|---|---|---|---|---|---|",
    ...rows.map(r => { const s = r.scores.length ? mean(r.scores) : NaN;
      return `| ${r.id} | ${r.target} | ${Number.isNaN(s) ? "—" : s.toFixed(0)} | ${Number.isNaN(s) ? "—" : (s - r.target >= 0 ? "+" : "") + (s - r.target).toFixed(0)} | ${r.scores.join(", ")} | ${[...new Set(r.problems)].join("; ")} | ${r.error ?? ""} |`; }), ""];
  return { res, lines };
}

const started = Date.now();
const [a, c] = [await pool(ANCHORS, 4, gradeOne), await pool(GENERATED, 4, gradeOne)];
const all = [...a, ...c];
const cost = all.some(r => r.cost === "unknown") ? "unknown" : `$${all.reduce((x, r) => x + (r.cost as number), 0).toFixed(4)}`;
const A = section("A1–A10", ANCHORS, a);
const C = section("C01–C20", GENERATED, c);
const ALL = section("All 30 (mean of repeats)", CALIBRATION_SET, all);
const perRepeat = Array.from({ length: repeats }, (_, i) => calibrate(Object.fromEntries(all.filter(r => r.scores[i] !== undefined).map(r => [r.id, r.scores[i]!])), CALIBRATION_SET));
const gatePassed = perRepeat.every(r => r.passed);
const gate = ["## Gate: each repeat on all 30", "", "| repeat | n | MAE (≤8) | signed all (≤+3) | signed A1–A10 (≤+3) | signed targets ≤70 (≤+3) | items >+20 | ≥95 on target ≤85 | result |", "|---|---|---|---|---|---|---|---|---|",
  ...perRepeat.map((r, i) => `| ${i + 1} | ${r.n}/30 | ${r.mae.toFixed(1)} | ${sg(r.meanSigned)} | ${sg(r.signedAnchors)} | ${sg(r.signedLow)} | ${r.overItems.join(", ") || "none"} | ${r.lenientViolations.join(", ") || "none"} | ${r.passed ? "pass" : "FAIL"} |`),
  "", `Worst repeat MAE ${Math.max(...perRepeat.map(r => r.mae)).toFixed(1)} · **${gatePassed ? "PASS" : "FAIL"}**`, ""];
const report = [`# Grader calibration: ${provider}/${tag}`, "",
  `${new Date().toISOString()} · repeats ${repeats} · ${Math.round((Date.now() - started) / 1000)} s wall · tokens in ${all.reduce((x, r) => x + r.inTok, 0)} / out ${all.reduce((x, r) => x + r.outTok, 0)} · cost ${cost}`,
  "Score = 100 × mean criterion credit − precision deductions (met criteria only) − min(polish, 4), computed in code from the model's judgements.", "",
  ...gate, ...ALL.lines, ...A.lines, ...C.lines].join("\n");
mkdirSync(join(import.meta.dir, "..", "..", "..", "eval"), { recursive: true });
const out = join(import.meta.dir, "..", "..", "..", "eval", `CALIBRATION-${provider}-${tag}.md`);
writeFileSync(out, report);
if (failures.length) writeFileSync(out.replace(/\.md$/, ".failures.txt"), failures.join("\n")); // raw replies that didn't parse; local diagnosis only (gitignored)
console.log(report);
console.log(`\nwrote ${out}`);
process.exit(gatePassed ? 0 : 1);
