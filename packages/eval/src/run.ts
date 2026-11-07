// `bun run eval`: runs the offline personas and writes eval/REPORT.md. Simulated learners, grader calibration and the
// fixed-baseline comparison join this report in M2/M3. These are software checks; they don't establish learning efficacy.
import { mkdirSync, writeFileSync } from "node:fs";
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

const rows = Object.entries(personas).map(([name, p]) => {
  const r = runSession(p, { maxSteps: 600 });
  const passed = r.state.plan!.nodes.filter(n => n.status === "passed").length;
  const independent = r.state.attempts.filter(a => a.independent).length;
  const mean = r.state.attempts.filter(a => a.grade).reduce((s, a) => s + a.grade!.score0to100, 0) / Math.max(1, r.state.attempts.length);
  return `| ${name} | ${passed}/${r.state.plan!.nodes.length} | ${r.state.attempts.length} | ${independent} | ${mean.toFixed(0)} | ${r.errors.length} |`;
});

const report = `# Eval report

Generated ${new Date().toISOString()} by \`bun run eval\`. Offline scripted personas on a 2-node fixture unit with stub models.
**These are software checks. They don't establish that Sage improves learning.**

| Persona | Nodes passed | Attempts | Independent | Mean score | Reducer errors |
|---|---|---|---|---|---|
${rows.join("\n")}

Pending: simulated learners (cheap model), grader calibration (≥30 triples, owner anchors), fixed-baseline comparison, per-turn token budgets.
F-row assertions live in \`packages/eval/test\` and \`packages/engine/test\`; run \`bun test\`.
`;
mkdirSync("eval", { recursive: true });
writeFileSync("eval/REPORT.md", report);
console.log(report);
