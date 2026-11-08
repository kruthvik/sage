// Markdown exports (SPEC §14–15): rendered deterministically from engine state + the ledger's events. No model calls.
import type { Attempt, Dimension, PlanNode } from "../../core/src/types.ts";
import type { EngineEvent, EngineState } from "../../engine/src/state.ts";
import { gate } from "../../engine/src/evidence.ts";
import { view } from "../../engine/src/candidates.ts";
import { cramMetrics } from "../../engine/src/metrics.ts";
import { passed } from "../../engine/src/items.ts";
import { RETENTION_MIN_DELAY_MS } from "../../engine/src/pedagogy.config.ts";

export interface LogEntry { event: EngineEvent; now: string }
export interface ExportMeta { models?: Record<string, { provider: string; model: string }>; fontPath?: string }

/** Learner and model text is data: keep it on one line and out of table syntax. */
const cell = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const quote = (t: string) => `"${cell(t)}"`;
export const slug = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 48) || "untitled";
const pct = (n: number, d: number) => d ? `${Math.round(100 * n / d)}%` : "—";
const minOf = (ms: number) => Math.round(ms / 60_000);

const nodeAttempts = (s: EngineState, n: PlanNode) => s.attempts.filter(a => s.items.get(a.itemId)?.nodeId === n.id);

/** The six outcomes, never pooled (SPEC §15). Execution and selection share a row, as the spec groups them. */
const OUTCOMES: { label: string; dims: Dimension[] }[] = [
  { label: "Acquisition", dims: ["acquisition"] }, { label: "Explanation / understanding", dims: ["explanation"] }, { label: "Recall", dims: ["recall"] },
  { label: "Retention (delayed only)", dims: ["retention"] }, { label: "Execution & selection", dims: ["execution", "selection"] }, { label: "Changed application", dims: ["changed_application"] },
];
function outcomes(attempts: Attempt[]): string[] {
  const rows = OUTCOMES.map(o => {
    const hit = attempts.filter(a => a.grade && passed(a.grade) && a.grade.dimensionsObserved.some(d => o.dims.includes(d)));
    const indep = hit.filter(a => a.independent).length;
    const support = !hit.length ? "not observed" : indep === hit.length ? "independent" : indep ? `${indep} independent, ${hit.length - indep} assisted` : "assisted only";
    const delay = o.dims.includes("retention") ? (hit.length ? `≥ ${Math.round(RETENTION_MIN_DELAY_MS / 86_400_000)} day` : "needs a later session") : "same session";
    return `| ${o.label} | ${hit.length} | ${support} | ${delay} |`;
  });
  return ["| Outcome | Passed attempts | Support | Delay |", "|---|---|---|---|", ...rows];
}

function nodeStm(s: EngineState, n: PlanNode): string {
  return n.subskills.map(x => { const g = gate(x, s.goal.mode, s.goal.pace, view(s)); return `${cell(x.statement)}: STM ${Math.round(g.stm)}${g.passed ? " ✓" : g.missing.length ? ` (missing: ${g.missing.slice(0, 3).join(", ")})` : ""}`; }).join("; ");
}

export function planMd(s: EngineState): string {
  const nodes = [...(s.plan?.nodes ?? [])].sort((a, b) => a.order - b.order);
  return [`# Plan: ${cell(s.goal.objective)}`, "", ...nodes.flatMap(n => [
    `## ${n.order + 1}. ${cell(n.title)} · ${n.status}`, "",
    `Exam weight ${n.examWeight} · estimated ${n.estMinutes} min${n.prerequisites.length ? ` · after ${n.prerequisites.join(", ")}` : ""}`, "",
    ...n.subskills.map(x => `- ${cell(x.statement)} (${x.kind}${x.selectionRelevant ? ", selection" : ""}${x.proxyFor ? `; text proxy: ${cell(x.proxyFor)}` : ""})`), ""])].join("\n");
}

export function sessionMd(s: EngineState, meta: ExportMeta = {}): string {
  const m = cramMetrics(s), nodes = [...(s.plan?.nodes ?? [])].sort((a, b) => a.order - b.order);
  const active = nodes.find(n => n.id === s.activeNodeId);
  const graded = s.attempts.filter(a => a.grade);
  const open = [...s.hypotheses.values()].filter(h => h.status === "open");
  const models = meta.models ? Object.entries(meta.models).map(([r, x]) => `${r} ${x.provider}/${x.model}`).join(", ") : "not recorded";
  const assisted = s.attempts.filter(a => !a.independent).length, hints = s.attempts.reduce((n, a) => n + a.assistance.length, 0);
  const byFormat = new Map<string, Attempt[]>();
  for (const a of graded) { const k = s.items.get(a.itemId)?.activityType ?? "unknown"; byFormat.set(k, [...(byFormat.get(k) ?? []), a]); }
  const lat = graded.map(a => a.latencyMs).sort((a, b) => a - b), median = lat.length ? lat[Math.floor(lat.length / 2)]! : 0;
  const cost = s.spend.costUsd === "unknown" ? "unknown" : `$${s.spend.costUsd.toFixed(2)}`;
  return [
    `# ${cell(s.goal.objective)}`, "",
    `Mode ${s.goal.mode} · pace ${s.goal.pace} · budget ${s.goal.timeBudgetMin ?? "none"} min · used ${m.usedMin} min${s.goal.exam ? ` · exam: ${cell(JSON.stringify(s.goal.exam))}` : ""}`,
    `Models: ${models}`, "",
    "## Primary metrics", "",
    `- Nodes passed within budget: ${m.nodesPassedInBudget}/${m.nodesTotal}`,
    `- Minutes to pass each node: ${nodes.map(n => m.minutesToPass[n.id] ?? "—").join(", ") || "—"}`,
    `- End-of-session mixed check: ${m.finalCheck.items ? `${m.finalCheck.passed}/${m.finalCheck.items} passed, mean ${m.finalCheck.meanScore}` : "not reached"}`,
    `- Cost per session-hour: ${m.costPerHourUsd === "unknown" ? "unknown" : `$${m.costPerHourUsd}`}`, "",
    "## Plan", "",
    "| # | Node | Status | Short-term mastery by subskill |", "|---|---|---|---|",
    ...nodes.map(n => `| ${n.order + 1} | ${cell(n.title)} | ${n.status} | ${nodeStm(s, n)} |`), "",
    "## Now", "",
    `- Node: ${active ? cell(active.title) : "none"} · phase ${s.phase}${s.stopped ? " (stopped)" : ""}`,
    `- Next intended move: ${cell(s.nextIntendedMove) || "—"}`,
    `- Open hypotheses: ${open.length ? open.map(h => `${quote(h.statement)} (${h.confidence})`).join("; ") : "none"}`,
    `- Left with gaps: ${s.leftWithGaps.size ? [...s.leftWithGaps].map(([id, g]) => `${id}: ${g.join(", ")}`).join("; ") : "none"}`, "",
    "## Outcomes (shown separately, never pooled)", "", ...outcomes(s.attempts), "",
    "Software checks don't establish learning efficacy; these are counts of what the gate saw in this session.", "",
    "## Stats", "",
    `- Time per node (min): ${nodes.map(n => `${cell(n.title)} ${minOf(s.time.nodeMs.get(n.id) ?? 0)}`).join("; ") || "—"}`,
    `- Graded attempts: ${graded.length} · passed ${pct(graded.filter(a => passed(a.grade)).length, graded.length)} · assisted ${assisted} · hints/assistance ${hints} · idle gaps ${s.time.idleGaps}`,
    `- Accuracy by format: ${[...byFormat].map(([k, as]) => `${k} ${pct(as.filter(a => passed(a.grade)).length, as.length)} (${as.length})`).join("; ") || "—"}`,
    `- Median response time: ${Math.round(median / 1000)} s`,
    `- Model calls: ${s.spend.calls} · tokens in ${s.spend.inputTokens} / out ${s.spend.outputTokens} · cost ${cost}`, "",
    "## Timeline", "",
    ...s.timeline.slice(-200).map(t => `- ${t.at.slice(11, 16)} ${t.kind}: ${cell(t.text)}`), "",
  ].join("\n");
}

export function itemsMd(s: EngineState, n: PlanNode): string {
  const rows = nodeAttempts(s, n);
  return [`# Items: ${cell(n.title)}`, "", ...rows.flatMap((a, i) => {
    const it = s.items.get(a.itemId)!;
    const flaws = a.grade?.flaws.filter(f => f.severity !== "polish") ?? [];
    return [`## ${i + 1}. ${it.activityType} · ${a.grade ? `${a.grade.score0to100}` : "ungraded"}${a.independent ? "" : " · assisted"}${a.isRepair ? " · repair" : ""}${a.check ? ` · ${a.check}` : ""}`, "",
      `**Question:** ${cell(it.stem)}`, "", `**Your answer:** ${quote(a.response)}`, "",
      ...(flaws.length ? flaws.map(f => `- ${f.severity}: ${quote(f.quote)}: ${cell(f.problem)}`) : []), ...(flaws.length ? [""] : []),
      ...(a.grade?.feedback ? [`Feedback: ${cell(a.grade.feedback)}`, ""] : [])];
  })].join("\n");
}

export function lessonMd(log: LogEntry[], n: PlanNode): string {
  const ids = new Set(n.subskills.map(x => x.id));
  const chunks = log.filter(e => e.event.type === "chunk_presented" && e.event.subskillIds.some(id => ids.has(id))).map(e => (e.event as Extract<EngineEvent, { type: "chunk_presented" }>).text);
  return [`# Lesson: ${cell(n.title)}`, "", ...(chunks.length ? chunks.flatMap(t => [t.trim(), "", "---", ""]) : ["No teaching chunks were shown for this node.", ""])].join("\n");
}

/** One page: the summarizer's review lines + the learner's own quoted mistakes (SPEC §15). */
export function cheatsheetMd(s: EngineState, n: PlanNode): string {
  const mistakes = nodeAttempts(s, n).flatMap(a => (a.grade?.flaws ?? []).filter(f => f.severity !== "polish").map(f => `- ${quote(f.quote)}: ${cell(f.problem)}${f.suggestion ? ` → ${cell(f.suggestion)}` : ""}`));
  const hyps = [...s.hypotheses.values()].filter(h => n.subskills.some(x => x.id === h.subskillId) && h.status !== "resolved").map(h => `- Possible misconception (${h.status}): ${cell(h.statement)}`);
  return [`# Cheat sheet: ${cell(n.title)}`, "",
    "## Key ideas", "", ...(n.cheatSheet?.length ? n.cheatSheet.map(l => `- ${cell(l)}`) : n.subskills.map(x => `- ${cell(x.statement)}`)), "",
    "## Your mistakes", "", ...([...new Set(mistakes)].slice(0, 10).concat(hyps).length ? [...new Set(mistakes)].slice(0, 10).concat(hyps) : ["- None recorded."]), ""].join("\n");
}

/** Session cheat sheet: every node's sheet, then what was left with gaps. */
export function sessionCheatsheetMd(s: EngineState): string {
  const nodes = [...(s.plan?.nodes ?? [])].sort((a, b) => a.order - b.order).filter(n => n.status === "passed" || n.status === "left_with_gaps" || n.cheatSheet);
  return [`# Session cheat sheet: ${cell(s.goal.objective)}`, "", ...nodes.map(n => cheatsheetMd(s, n).replace(/^# /, "## ").replace(/^## (Key ideas|Your mistakes)/gm, "### $1")),
    "## Left with gaps", "", ...(s.leftWithGaps.size ? [...s.leftWithGaps].map(([id, g]) => `- ${cell(s.plan?.nodes.find(n => n.id === id)?.title ?? id)}: ${g.map(cell).join(", ")}`) : ["- None."]), ""].join("\n");
}
