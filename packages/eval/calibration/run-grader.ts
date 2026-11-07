// Real-grader calibration (SPEC §18.4, task 3). Usage: bun packages/eval/calibration/run-grader.ts <provider>/<model> [repeats]
// Reports A1–A10 (owner-scored, final) and C01–C20 (Claude-written, UNREVIEWED) separately; only A1–A10 is a gate until the owner confirms C.
// Credentials: Sage's own agent dir by default. SAGE_EVAL_AGENT_DIR=<dir> is an explicit dev opt-in to read another pi agent dir
// (e.g. ~/.pi/agent) in place; nothing is copied. Extension providers from that dir's settings load only for the requested provider.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSageRuntime } from "../../pi-adapter/src/runtime.ts";
import { sagePaths } from "../../core/src/paths.ts";
import { GRADER_SYSTEM, graderUser, parseGrade } from "../../agent/src/grader.ts";
import { validateGrade } from "../../engine/src/evidence.ts";
import { ANCHORS, GENERATED, calibrate, type Triple } from "./set.ts";
import { CALIBRATION } from "../../engine/src/pedagogy.config.ts";

const [spec, repeatsArg] = process.argv.slice(2);
const [provider, model] = spec?.split("/") ?? [];
if (!provider || !model) { console.error("usage: run-grader.ts <provider>/<model> [repeats]"); process.exit(2); }
const repeats = Math.max(1, Number(repeatsArg ?? 1));

const agentDir = process.env.SAGE_EVAL_AGENT_DIR?.replace(/^~/, homedir());
let packages: (string | { source: string; extensions?: string[] })[] = [];
if (agentDir) {
  try {
    const all = (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).packages ?? []) as typeof packages;
    packages = all.filter(p => (typeof p === "string" ? p : p.source).includes(provider)); // only the package that provides this provider
  } catch { /* no settings: builtin providers only */ }
}
const rt = await createSageRuntime({ paths: sagePaths(process.env.SAGE_HOME ?? join(homedir(), ".sage")), agentDir, packages });

interface Row { id: string; target: number; scores: number[]; problems: string[]; error?: string; inTok: number; outTok: number; cost: number | "unknown"; ms: number }
async function gradeOne(t: Triple): Promise<Row> {
  const row: Row = { id: t.id, target: t.target, scores: [], problems: [], inTok: 0, outTok: 0, cost: 0, ms: 0 };
  for (let i = 0; i < repeats; i++) {
    try {
      const r = await rt.roleCall({ provider: provider!, model: model!, system: GRADER_SYSTEM, user: graderUser(t, t.response) });
      row.inTok += r.usage.input; row.outTok += r.usage.output; row.ms += r.ms;
      row.cost = r.usage.costUsd === "unknown" || row.cost === "unknown" ? "unknown" : row.cost + r.usage.costUsd;
      const g = parseGrade(r.text, { rubric: t.rubric, evidences: [] });
      row.scores.push(g.score0to100);
      row.problems.push(...validateGrade(g, t.response));
    } catch (e) { row.error = String((e as Error).message ?? e).slice(0, 160); }
  }
  return row;
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]!); } }));
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function section(title: string, set: Triple[], rows: Row[]) {
  const scored = rows.filter(r => r.scores.length);
  const res = calibrate(Object.fromEntries(scored.map(r => [r.id, mean(r.scores)])), set, { maxMae: CALIBRATION.maxMae, maxMeanSignedError: CALIBRATION.maxMeanSignedError, ceiling: CALIBRATION.lenientCeiling });
  const lines = [`## ${title}`, "",
    `n=${res.n}/${set.length} · MAE ${res.mae.toFixed(1)} (≤${CALIBRATION.maxMae}) · mean signed ${res.meanSigned >= 0 ? "+" : ""}${res.meanSigned.toFixed(1)} (≤+${CALIBRATION.maxMeanSignedError}) · lenient ceiling violations: ${res.lenientViolations.join(", ") || "none"} · **${res.passed ? "PASS" : "FAIL"}**`, "",
    "| id | target | score | Δ | runs | validity problems | error |", "|---|---|---|---|---|---|---|",
    ...rows.map(r => { const s = r.scores.length ? mean(r.scores) : NaN;
      return `| ${r.id} | ${r.target} | ${Number.isNaN(s) ? "—" : s.toFixed(0)} | ${Number.isNaN(s) ? "—" : (s - r.target >= 0 ? "+" : "") + (s - r.target).toFixed(0)} | ${r.scores.join(", ")} | ${[...new Set(r.problems)].join("; ")} | ${r.error ?? ""} |`; }), ""];
  return { res, lines };
}

const started = Date.now();
const [a, c] = [await pool(ANCHORS, 4, gradeOne), await pool(GENERATED, 4, gradeOne)];
const all = [...a, ...c];
const cost = all.some(r => r.cost === "unknown") ? "unknown" : `$${all.reduce((x, r) => x + (r.cost as number), 0).toFixed(4)}`;
const A = section("A1–A10 (owner-scored, final; this is the gate)", ANCHORS, a);
const C = section("C01–C20 (Claude-written, UNREVIEWED; informational until the owner confirms)", GENERATED, c);
const report = [`# Grader calibration: ${provider}/${model}`, "",
  `${new Date().toISOString()} · repeats ${repeats} · ${Math.round((Date.now() - started) / 1000)} s wall · tokens in ${all.reduce((x, r) => x + r.inTok, 0)} / out ${all.reduce((x, r) => x + r.outTok, 0)} · cost ${cost}`,
  "Score = 100 × mean criterion credit − precision deductions (met criteria only) − min(polish, 4), computed in code from the model's judgements.", "",
  ...A.lines, ...C.lines].join("\n");
mkdirSync(join(import.meta.dir, "..", "..", "..", "eval"), { recursive: true });
const out = join(import.meta.dir, "..", "..", "..", "eval", `CALIBRATION-${provider}-${model}.md`);
writeFileSync(out, report);
console.log(report);
console.log(`\nwrote ${out}`);
process.exit(A.res.passed ? 0 : 1);
