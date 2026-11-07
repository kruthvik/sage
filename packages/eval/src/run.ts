// `bun run eval`: runs the offline personas and writes eval/REPORT.md. Simulated learners on ≥5 domains, grader calibration and the
// fixed-baseline comparison join this report in M2/M3. These are software checks; they don't establish learning efficacy.
import { mkdirSync, writeFileSync } from "node:fs";
import { cramMetrics } from "../../engine/src/index.ts";
import { answerFor, runSession, type Persona } from "./fixture.ts";

const good = "Because the rule brings the exponent down and lowers it by one.";
const personas: Record<string, Persona> = {
  "all-correct": i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: good }, quality: "good" },
  "all-wrong": i => ({ input: { kind: "text", text: "-1" }, quality: i.key?.kind === "numeric" ? undefined : "wrong" }),
  "copies-chunk": (i, c) => ({ input: { kind: "text", text: c.chunk ?? "-" }, quality: i.key?.kind === "numeric" ? undefined : "wrong" }),
  "right-answer-wrong-reasoning": i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: "It just halves." }, quality: "wrong_reasoning" },
  "imprecise-wording": i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: "You bring the number down." }, quality: "imprecise" },
  "requests-every-hint": i => ({ input: { kind: "text", text: i.key?.kind === "numeric" ? answerFor(i) : good }, quality: "good", hint: 3 }),
};

const primary: string[] = [], secondary: string[] = [];
for (const [name, p] of Object.entries(personas)) {
  const r = runSession(p, { maxSteps: 600 });
  const m = cramMetrics(r.state);
  const ttp = Object.entries(m.minutesToPass).map(([id, min]) => `${id} ${min}m`).join(", ") || "–";
  const fc = m.finalCheck.items ? `${m.finalCheck.passed}/${m.finalCheck.items} (mean ${m.finalCheck.meanScore})` : "no items left";
  primary.push(`| ${name} | ${m.nodesPassedInBudget}/${m.nodesTotal} in ${m.budgetMin ?? "∞"} min | ${ttp} | ${fc} | ${m.costPerHourUsd === "unknown" ? "unknown (stub models)" : `$${m.costPerHourUsd}`} |`);
  const independent = r.state.attempts.filter(a => a.independent).length;
  const mean = r.state.attempts.filter(a => a.grade).reduce((s, a) => s + a.grade!.score0to100, 0) / Math.max(1, r.state.attempts.length);
  secondary.push(`| ${name} | ${r.state.attempts.length} | ${independent} | ${mean.toFixed(0)} | ${r.errors.length} |`);
}

const report = `# Eval report

Generated ${new Date().toISOString()} by \`bun run eval\`. Offline scripted personas on a 2-node fixture unit (calculus) with stub models.
**These are software checks. They don't establish that Sage improves learning.** The fixture subject is a test case, not the product's scope.

## Primary: single-session Cram efficiency

| Persona | Nodes passed within budget | Time to pass each node | End-of-session mixed check | Cost per session-hour |
|---|---|---|---|---|
${primary.join("\n")}

## Secondary

| Persona | Attempts | Independent | Mean score | Reducer errors |
|---|---|---|---|---|
${secondary.join("\n")}

Pending: simulated learners on ≥5 domains (≥1 non-academic), grader calibration (10 owner anchors + ≥20 triples over ≥6 domains), fixed-baseline comparison, per-turn token budgets.
F-row assertions live in \`packages/eval/test\` and \`packages/engine/test\`; run \`bun test\`.
`;
mkdirSync("eval", { recursive: true });
writeFileSync("eval/REPORT.md", report);
console.log(report);
