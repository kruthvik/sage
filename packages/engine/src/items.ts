import type { Grade, Item, ResponseInput } from "../../core/src/types.ts";
import { ACTIVITY_EVIDENCE, CHECK_CHUNK_OVERLAP_MAX, PASS_MARK } from "./pedagogy.config.ts";

/** The learner's final answer in a worked response: the value after the last "=" and the last number in the text
 * (simple fractions like -1/8 and \frac{1}{4} included). Intermediate working never counts; a bare answer is both. */
export function finalNumbers(text: string): number[] {
  const re = /-?\d+(?:\.\d+)?(?:e-?\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/gi;
  const val = (m: string) => { const [p, q] = m.split("/").map(x => Number(x.trim())); return q === undefined ? p! : p! / q; };
  const clean = text.replace(/(\d),(\d{3})/g, "$1$2").replace(/\\frac\{(-?[\d.]+)\}\{(-?[\d.]+)\}/g, "$1/$2").replace(/[−–]/g, "-");
  const all = [...clean.matchAll(re)].map(m => m[0]);
  const afterEq = clean.includes("=") ? clean.slice(clean.lastIndexOf("=") + 1).match(re)?.[0] : undefined;
  return [...new Set([all.at(-1), afterEq].filter((m): m is string => !!m).map(val))].filter(Number.isFinite);
}

/** v3 cosmetic-variant fingerprint: numbers normalised, so a numeric substitution is the same family (RM-10). */
export const fingerprint = (stem: string) => stem.toLowerCase().replace(/(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/g, "#").replace(/\s+/g, " ").trim();

const STOP = new Set("a an the of to in on and or is are was were be by for with as at that this it its from which what why how does do".split(" "));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
const content = (s: string) => words(s).filter(w => !STOP.has(w));
const grams = (ws: string[], n = 4) => new Set(ws.length < n ? [] : ws.slice(0, ws.length - n + 1).map((_, i) => ws.slice(i, i + n).join(" ")));

/** Share of the check's content-word 4-grams that also occur in the chunk (F6). */
export function overlap(check: string, chunk: string): number {
  const a = grams(content(check)), b = grams(content(chunk));
  if (!a.size) return 0;
  let hit = 0; for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

export function keyTerms(item: Item): string[] {
  const k = item.key;
  if (!k) return [];
  if (k.kind === "choice") return item.choices?.[k.index] ? [item.choices[k.index]!] : [];
  if (k.kind === "numeric") return [String(k.value)];
  if (k.kind === "exact") return k.values;
  return [];
}
const distinctive = (term: string) => content(term).filter(w => w.length > 3 || /\d/.test(w));
/** True if `text` gives away the key: the whole key, or for multi-word keys most of its distinctive words. */
export function leaksKey(text: string, item: Item): boolean {
  const hay = ` ${content(text).join(" ")} `;
  return keyTerms(item).some(term => {
    const d = distinctive(term);
    if (!d.length) return false;
    if (hay.includes(` ${d.join(" ")} `)) return true;
    return d.length > 1 && d.filter(w => hay.includes(` ${w} `)).length / d.length >= 0.75;
  });
}

/** Deterministic validator (SPEC §12.5). Returns problems; empty means valid. `chunk` is the teaching text the check follows, if any. */
export function validateItem(item: Item, opts: { chunk?: string; deliveredItemIds?: Set<string> } = {}): string[] {
  const p: string[] = [];
  const stem = item.stem?.trim() ?? "";
  if (stem.length < 12 || /\{\{|\[(?:insert|todo|placeholder)/i.test(stem)) p.push("empty_or_templated_stem");
  if (!item.evidences?.length) p.push("missing_evidences");
  if (!item.partition) p.push("missing_partition");
  const allowed = ACTIVITY_EVIDENCE[item.activityType] ?? [];
  if (item.evidences?.some(d => d !== "retention" && !allowed.includes(d) && !(d === "explanation" && item.activityType === "conceptual_mcq" && item.rubric?.length))) p.push("evidence_not_supported_by_activity");
  if (leaksKey(stem, item)) p.push("stem_leaks_key");
  if (item.activityType === "conceptual_mcq" || item.key?.kind === "choice") {
    const c = item.choices ?? [];
    if (c.length < 2 || c.length > 8 || new Set(c.map(x => x.trim().toLowerCase())).size !== c.length) p.push("mcq_choices_invalid");
    if (item.key?.kind !== "choice" || item.key.index < 0 || item.key.index >= c.length) p.push("mcq_key_invalid");
    if ((item.distractorRationales?.filter(r => r?.trim()).length ?? 0) < c.length - 1) p.push("mcq_distractor_rationale_missing");
  }
  const distinct = (xs: string[]) => new Set(xs.map(x => x.trim().toLowerCase())).size === xs.length && xs.every(x => x.trim());
  const perm = (xs: number[], n: number) => xs.length === n && new Set(xs).size === n && xs.every(i => Number.isInteger(i) && i >= 0 && i < n);
  if (item.activityType === "ordering") {
    const c = item.choices ?? [], k = item.key;
    if (c.length < 3 || c.length > 8 || !distinct(c)) p.push("ordering_choices_invalid");
    if (k?.kind !== "order" || !perm(k.order, c.length)) p.push("ordering_key_invalid");
    else if (k.order.every((x, i) => x === i)) p.push("ordering_shown_in_answer_order"); // the displayed order would be the answer
  }
  if (item.activityType === "matching") {
    const c = item.choices ?? [], t = item.targets ?? [], k = item.key;
    if (c.length < 2 || c.length > 8 || !distinct(c) || t.length < c.length || t.length > c.length + 3 || !distinct(t)) p.push("matching_columns_invalid");
    if (k?.kind !== "match" || k.pairs.length !== c.length || new Set(k.pairs).size !== c.length || !k.pairs.every(i => Number.isInteger(i) && i >= 0 && i < t.length)) p.push("matching_key_invalid");
  }
  if (item.activityType === "contrasting_cases" && (item.cases?.length !== 2 || !item.cases.every(x => x.trim().length >= 12) || !item.rubric?.length)) p.push("contrasting_cases_invalid");
  // Explanation needs a reason criterion after the identification criterion (rubric[0]).
  if (item.activityType === "contrasting_cases" && item.evidences?.includes("explanation") && (item.rubric?.length ?? 0) < 2) p.push("contrasting_cases_explanation_needs_reason_criterion");
  if (!item.key && !item.rubric?.length) p.push("no_key_or_rubric");
  if (item.hints && leaksKey(item.hints[0], item)) p.push("nudge_answer_bearing");
  if (item.evidences?.includes("changed_application")) {
    const v = item.variation;
    if (!v?.baselineItemId || !v.changedDimensions?.length || !v.invariant?.trim()) p.push("variation_incomplete");
    else if (v.changedDimensions.every(d => d === "surface")) p.push("surface_only_variation_claims_transfer");
    else if (opts.deliveredItemIds && !opts.deliveredItemIds.has(v.baselineItemId)) p.push("variation_baseline_not_delivered");
  }
  if (opts.chunk && overlap(stem, opts.chunk) > CHECK_CHUNK_OVERLAP_MAX) p.push("check_copies_chunk");
  return p;
}

/** Objective items are graded in code (SPEC §12.1). Returns undefined for open responses (grader role). */
export function gradeDeterministic(item: Item, input: ResponseInput): Grade | undefined {
  const k = item.key;
  if (!k || k.kind === "reference") return undefined;
  if (k.kind === "order" || k.kind === "match") return gradeStructure(item, k, input);
  let ok: boolean, quote: string;
  if (k.kind === "choice") { const idx = input.kind === "choice" ? input.index : -1; ok = idx === k.index; quote = item.choices?.[idx] ?? "(no choice)"; }
  else {
    const text = input.kind === "text" ? input.text.trim() : input.kind === "fields" ? Object.values(input.fields).join(" ").trim() : "";
    quote = text;
    if (k.kind === "numeric") ok = finalNumbers(text).some(n => Math.abs(n - k.value) <= Math.max(k.tolerance, 1e-9 * Math.abs(k.value)));
    else { const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim(); ok = k.values.some(v => norm(v) === norm(text)); }
  }
  const correctText = keyTerms(item)[0] ?? "";
  const dims = ok ? item.evidences.filter(d => d !== "explanation" && d !== "retention") : [];
  return {
    score0to100: ok ? 100 : 0,
    criterionEvidence: [{ criterion: "correct answer", satisfied: ok, quote }],
    flaws: ok ? [] : [{ quote, problem: "Incorrect answer", suggestion: `Correct answer: ${correctText}`, severity: "blocking" }],
    dimensionsObserved: dims, grader: "deterministic",
    feedback: ok ? "Correct." : (k.kind === "choice" && input.kind === "choice" ? item.distractorRationales?.[input.index] ?? "" : "") || `Not quite. The answer is ${correctText}.`,
  };
}

/** Ordering and matching: the score is the share of positions/pairs right; only a fully right answer passes. */
function gradeStructure(item: Item, k: Extract<NonNullable<Item["key"]>, { kind: "order" | "match" }>, input: ResponseInput): Grade {
  const c = item.choices ?? [], t = item.targets ?? [];
  const want = k.kind === "order" ? k.order : k.pairs, got = input.kind === "indices" ? input.indices : [];
  const show = (xs: number[]) => k.kind === "order" ? xs.map(i => c[i] ?? "?").join(" → ") : xs.map((j, i) => `${c[i] ?? "?"} → ${t[j] ?? "?"}`).join("; ");
  const right = want.filter((x, i) => got[i] === x).length, ok = right === want.length && got.length === want.length;
  const quote = got.length ? show(got) : "(no answer)", answer = show(want);
  const dims = ok ? item.evidences.filter(d => d !== "explanation" && d !== "retention") : [];
  return {
    score0to100: Math.round(100 * right / Math.max(1, want.length)),
    criterionEvidence: [{ criterion: k.kind === "order" ? "correct order" : "correct pairs", satisfied: ok, quote }],
    flaws: ok ? [] : [{ quote, problem: `${want.length - right} of ${want.length} ${k.kind === "order" ? "steps out of place" : "pairs wrong"}`, suggestion: `Correct: ${answer}`, severity: "blocking" }],
    dimensionsObserved: dims, grader: "deterministic", feedback: ok ? "Correct." : `Not quite. Correct: ${answer}.`,
  };
}

export const passed = (g?: Grade) => !!g && g.score0to100 >= PASS_MARK && !g.flaws.some(f => f.severity === "blocking");
