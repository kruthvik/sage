// M3 simulated-learner eval (owner reply 2): ≥5 Cram units from different domains (≥1 non-academic), real roles,
// adaptive tutor vs a fixed baseline (same real planner/generator/grader; deterministic non-adaptive tutor from fake-runtime).
// Primary metrics first: nodes passed within budget, minutes to pass each node, end-of-session mixed check, cost per session-hour.
// Clock is virtual: learner think/read time advances it; model latency does not (reported separately as wall time).
// Usage (Sage's own agent dir; run `sage setup` + `sage login` first): [EVAL_MODEL=provider/model] bun packages/eval/src/cram-eval.ts [unitIds,comma] [--baseline-only|--adaptive-only]
// EVAL_MODEL puts every role (and the simulated learner) on one model, e.g. antigravity/gemini-3.8-flash.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { evalRuntime } from "./eval-runtime.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import { goal } from "./fixture.ts";
import { SessionDriver, type DriverRuntime, type ServerEvent } from "../../agent/src/driver.ts";
import { DEFAULT_ROLE_MODELS, type RoleModels } from "../../agent/src/host.ts";
import { planFit } from "../../engine/src/pacing.ts";
import { extractJson } from "../../agent/src/json.ts";
import { Ledger } from "../../storage/src/ledger.ts";
import { cramMetrics } from "../../engine/src/metrics.ts";
import type { Item, ResponseInput } from "../../core/src/types.ts";

const one = process.env.EVAL_MODEL?.split("/") as [string, string] | undefined;
const MODELS: RoleModels = one ? Object.fromEntries(Object.keys(DEFAULT_ROLE_MODELS).map(r => [r, { provider: one[0], model: one[1] }])) as RoleModels : DEFAULT_ROLE_MODELS;
interface Unit { id: string; domain: string; academic: boolean; objective: string; minutes: number; learner: string }
export const UNITS: Unit[] = [
  { id: "calc", domain: "math", academic: true, minutes: 90, objective: "Cram the derivative rules (power, product, chain) for tomorrow's calculus quiz",
    learner: "You know the power rule well. You mix up the product rule (you sometimes multiply the derivatives). You forget the inner derivative in the chain rule about half the time." },
  { id: "resp", domain: "biology", academic: true, minutes: 90, objective: "Cram cellular respiration (glycolysis, Krebs cycle, electron transport chain) for a biology test",
    learner: "You remember glycolysis happens in the cytoplasm. You think the Krebs cycle makes most ATP directly. You are vague about where the electron transport chain is and about oxygen's role." },
  { id: "ww1", domain: "history", academic: true, minutes: 120, objective: "Cram the causes of the First World War for an essay exam",
    learner: "You remember the assassination of Franz Ferdinand and the word 'alliances'. You can't explain militarism or imperialism with specific examples, and you treat the assassination as the only cause." },
  { id: "esp", domain: "language", academic: true, minutes: 90, objective: "Cram when to use the Spanish preterite vs the imperfect for an oral exam (text practice)",
    learner: "You know the preterite endings for -ar verbs. You use the preterite for everything in the past, including descriptions and habits. You don't know the trigger words." },
  { id: "aid", domain: "first aid (non-academic)", academic: false, minutes: 120, objective: "Cram adult CPR and the recovery position before a workplace first-aid assessment",
    learner: "You think CPR is 15 compressions to 2 breaths and you are unsure of the depth. You know to check for breathing but not for how long. You have never seen the recovery position described step by step." },
];

const LEARNER_SYSTEM = (profile: string) => `You are role-playing a real student studying for a test. Stay in character.\nWhat you know: ${profile}\nRules: answer as this student would, briefly (1-4 sentences or a short working). Make the mistakes this student would make. You learn from feedback you were given earlier in the session, but not perfectly.\nReply with JSON only: {"choice": <0-based index>} for multiple choice, otherwise {"text": "..."}.`;

async function runUnit(u: Unit, arm: "adaptive" | "baseline", real: Awaited<ReturnType<typeof evalRuntime>>) {
  const fake = fakeRuntime();
  const rt: DriverRuntime = arm === "adaptive" ? real : { roleCall: real.roleCall, researchCall: real.researchCall, tutorTurn: fake.tutorTurn };
  const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), `sage-eval-${u.id}-`)), "s.sqlite"));
  let clock = Date.parse("2026-11-07T09:00:00Z");
  const now = () => new Date(clock).toISOString();
  const events: ServerEvent[] = [];
  const memory: string[] = []; // what the simulated learner has been told (feedback, chunks): it "learns" from these
  const wall = Date.now();
  const d = SessionDriver.create(goal({ objective: u.objective, timeBudgetMin: u.minutes, mode: "cram" }), `${u.id}-${arm}`, ledger, rt, MODELS, e => {
    events.push(e);
    if (e.event === "tutor.done") { const t = (e.data as { text: string }).text; memory.push(`Tutor taught: ${t}`); clock += Math.max(20, t.split(/\s+/).length / 200 * 60) * 1000; }
    if (e.event === "feedback.present") memory.push(`Feedback on your answer: ${(e.data as { grade: { feedback: string } }).grade.feedback}`);
  }, now);
  await d.drain();
  if (d.state.phase !== "plan_review") return { u, arm, error: `planning failed: ${JSON.stringify(events.filter(e => e.event === "error").map(e => e.data)).slice(0, 300)}`, d, events, wallS: 0 };
  const fit = planFit(d.state); // what the learner would see at approval; the simulated learner approves as planned
  await d.learner({ type: "plan_approved" });
  const answer = async (item: Item): Promise<ResponseInput> => {
    const r = await real.roleCall({ provider: MODELS.generator.provider, model: MODELS.generator.model, system: LEARNER_SYSTEM(u.learner),
      user: `${memory.slice(-6).join("\n")}\n\nQuestion (${item.activityType}):\n${item.stem}${item.choices ? `\nChoices:\n${item.choices.map((c, i) => `${i}. ${c}`).join("\n")}` : ""}` });
    try { const j = extractJson(r.text) as { choice?: number; text?: string }; return typeof j.choice === "number" && item.choices ? { kind: "choice", index: j.choice } : { kind: "text", text: String(j.text ?? r.text) }; }
    catch { return { kind: "text", text: r.text.slice(0, 500) }; }
  };
  let steps = 0, stuck = 0;
  while ((d.state.phase as string) !== "ended" && steps++ < 600) {
    if (clock - Date.parse("2026-11-07T09:00:00Z") > u.minutes * 1.6 * 60_000) { await d.learner({ type: "control", action: "stop" }).catch(() => {}); break; }
    const s = d.state;
    try {
      if (s.feedbackAttemptId) { clock += 15_000; await d.learner({ type: "feedback_acked", attemptId: s.feedbackAttemptId }); stuck = 0; continue; }
      if (s.current && !s.pendingAttemptId) { // a parked grade is retried below, never answered twice
        const item = s.items.get(s.current.itemId)!; const input = await answer(item);
        const think = input.kind === "choice" ? 30_000 : 75_000; clock += think;
        await d.learner({ type: "response_submitted", input, responseEventId: `r${steps}`, latencyMs: think }); stuck = 0; continue;
      }
      if (s.repairAttemptId) { // the grader found a blocking flaw: the learner fixes it (repairs never count as evidence)
        const a = s.attempts.find(x => x.id === s.repairAttemptId)!; const item = s.items.get(a.itemId)!;
        memory.push(`You must fix: ${a.grade?.flaws.filter(f => f.severity === "blocking").map(f => f.problem).join("; ")}`);
        const input = await answer(item); clock += 60_000;
        await d.learner({ type: "response_submitted", input, responseEventId: `r${steps}`, latencyMs: 60_000 }); stuck = 0; continue;
      }
      if (s.phase === "close") { clock += 5_000; await d.learner({ type: "control", action: "advance" }); stuck = 0; continue; }
    } catch (e) { events.push({ event: "error", sessionId: d.sessionId, data: { code: "learner_action_rejected", message: (e as Error).message } }); }
    if (d.failed && stuck < 2) { stuck++; await d.retry(); continue; } // what a client does on error.data.retry
    if (++stuck > 2) break; // the engine is waiting on nothing the learner can do: report it
    await d.drain();
  }
  return { u, arm, d, events, fit, wallS: Math.round((Date.now() - wall) / 1000), stuckIn: (d.state.phase as string) !== "ended" && stuck > 2 ? d.state.phase : undefined };
}

const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2].split(",") : undefined;
const arms = process.argv.includes("--baseline-only") ? ["baseline"] as const : process.argv.includes("--adaptive-only") ? ["adaptive"] as const : ["adaptive", "baseline"] as const;
const units = UNITS.filter(u => !only || only.includes(u.id));
const real = await evalRuntime([...new Set(Object.values(MODELS).map(m => m.provider))]);
const jobs = units.flatMap(u => arms.map(a => [u, a] as const));
const results: Awaited<ReturnType<typeof runUnit>>[] = [];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => { while (next < jobs.length) { const [u, a] = jobs[next++]!; const r = await runUnit(u, a, real).catch(e => ({ u, arm: a, error: String((e as Error).stack ?? e).slice(0, 400) }) as never); results.push(r); console.log(`${u.id}/${a} done in ${(r as { wallS?: number }).wallS ?? "?"} s`); } }));

const rows = results.sort((a, b) => a.u.id.localeCompare(b.u.id) || a.arm.localeCompare(b.arm)).map(r => {
  if ("error" in r && r.error) return `| ${r.u.id} | ${r.u.domain} | ${r.arm} | ${r.u.minutes} | ERROR: ${r.error.replace(/\|/g, "/").replace(/\n/g, " ")} ||||||||`;
  const m = cramMetrics(r.d.state), errs = r.events.filter(e => e.event === "error");
  const nodes = r.d.state.plan?.nodes ?? [];
  return `| ${r.u.id} | ${r.u.domain} | ${r.arm} | ${r.u.minutes} | ${r.fit ? `${r.fit.estMin}${r.fit.fits ? "" : " (over)"}` : "—"} | ${m.nodesPassedInBudget}/${nodes.length} | ${nodes.map(n => n.passedAtMin === undefined ? "—" : Math.round(n.passedAtMin)).join(", ")} | ${m.finalCheck.items ? `${m.finalCheck.passed}/${m.finalCheck.items} (mean ${m.finalCheck.meanScore?.toFixed(0)})` : "not reached"} | ${m.costPerHourUsd === "unknown" ? "unknown" : `$${m.costPerHourUsd.toFixed(2)}`} | ${r.d.state.spend.calls} | ${(() => { const g = r.d.state.attempts.filter(a => a.grade && !a.isRepair); const ind = g.filter(a => a.independent); return `${g.length} graded (${ind.length} independent), mean ${g.length ? Math.round(g.reduce((x, a) => x + a.grade!.score0to100, 0) / g.length) : "—"}, ${Math.round(m.usedMin)} min used, reached ${nodes.filter(n => n.status !== "locked" && n.status !== "ready").length} nodes`; })()} | ${r.wallS} s | ${r.stuckIn ?? r.d.state.phase}${errs.length ? `; ${errs.length} errors: ${[...new Set(errs.map(e => (e.data as { code: string }).code))].join(", ")}` : ""} |`;
});
for (const r of results) if ("events" in r && r.events) for (const e of r.events.filter(e => e.event === "error")) console.log(`${r.u.id}/${r.arm} ERROR`, JSON.stringify(e.data).slice(0, 600));
const report = [`# Cram eval (M3): ${new Date().toISOString()}`, "",
  `Roles: ${Object.entries(MODELS).map(([r, m]) => `${r} ${m.model}`).join(", ")}. Simulated learner: ${MODELS.generator.model} with a fixed knowledge profile per unit. Baseline = same real roles, deterministic non-adaptive tutor (first candidate, first unused item, one-line chunks).`,
  "Clock is virtual (learner think and read time only); model latency is in the wall column. Learners never use hints, so assisted paths are not exercised here.", "",
  "| unit | domain | arm | budget min | plan estimate min | nodes passed in budget | minutes to pass each node | end-of-session mixed check | cost per session-hour | model calls | progress | wall | end state |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|", ...rows, ""].join("\n");
mkdirSync(join(import.meta.dir, "..", "..", "..", "eval"), { recursive: true });
writeFileSync(join(import.meta.dir, "..", "..", "..", "eval", "CRAM_EVAL.md"), report);
console.log(report);
process.exit(0);
