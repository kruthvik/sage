import type { Attempt, Dimension, Grade, Hypothesis, Item, Mode, Pace, SubSkill } from "../../core/src/types.ts";
import { HIGH_OPEN_HYPOTHESIS_BLOCKS, K_CHECKS, minFamilies, RETENTION_MIN_DELAY_MS } from "./pedagogy.config.ts";
import { passed } from "./items.ts";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Model grades must quote the actual response (v3: invented evidence quotes are rejected). Returns problems. */
export function validateGrade(g: Grade, response: string): string[] {
  const p: string[] = [];
  if (!Number.isFinite(g.score0to100) || g.score0to100 < 0 || g.score0to100 > 100) p.push("score_out_of_range");
  if (g.grader === "model") {
    const r = norm(response);
    for (const c of g.criterionEvidence) if (c.satisfied === true && (!c.quote.trim() || !r.includes(norm(c.quote)))) p.push(`unquoted_criterion:${c.criterion}`);
    for (const f of g.flaws) if (f.quote.trim() && !r.includes(norm(f.quote))) p.push("flaw_quote_not_in_response");
    if (g.dimensionsObserved.length && !g.criterionEvidence.some(c => c.satisfied === true)) p.push("dimension_claim_without_evidence");
  }
  if (g.feedback.split(/\s+/).filter(Boolean).length > 60) p.push("feedback_over_60_words");
  return p;
}

export interface EvidenceView { items: Map<string, Item>; attempts: Attempt[]; hypotheses: Map<string, Hypothesis>; deliveredAt: Map<string, string> }

/** Dimensions an attempt establishes for a subskill. Only independent, validated, passing, quote-backed attempts count (SPEC §8.1). */
export function observedDims(a: Attempt, s: SubSkill, v: EvidenceView): Dimension[] {
  const item = v.items.get(a.itemId);
  if (!item || !item.validated || !item.subskillIds.includes(s.id) || !a.independent || a.isRepair || !passed(a.grade)) return [];
  const dims = new Set(a.grade!.dimensionsObserved.filter(d => item.evidences.includes(d) && d !== "retention"));
  if (dims.has("changed_application")) {
    const vr = item.variation;
    if (!vr || vr.changedDimensions.every(d => d === "surface") || !v.deliveredAt.has(vr.baselineItemId)) dims.delete("changed_application");
  }
  // Retention: an independent success after a real delay since the last relevant practice or help (RM-15).
  const prior = v.attempts.filter(x => x.at < a.at && v.items.get(x.itemId)?.subskillIds.includes(s.id)).at(-1);
  if (prior && Date.parse(a.at) - Date.parse(prior.at) >= RETENTION_MIN_DELAY_MS && (dims.has("recall") || dims.has("execution"))) dims.add("retention");
  return [...dims];
}

export interface GateResult { passed: boolean; stm: number; k: number; checks: number; families: number; missing: string[]; observed: Dimension[] }

export function gate(s: SubSkill, mode: Mode, pace: Pace, v: EvidenceView): GateResult {
  const k = K_CHECKS[mode][pace];
  const mine = v.attempts.filter(a => v.items.get(a.itemId)?.subskillIds.includes(s.id));
  const observed = new Set<Dimension>(), checkItems = new Set<string>(), families = new Set<string>();
  for (const a of mine) {
    const dims = observedDims(a, s, v);
    if (!dims.length) continue;
    dims.forEach(d => observed.add(d));
    checkItems.add(a.itemId); families.add(v.items.get(a.itemId)!.familyId);
  }
  const groups = s.requiredDimensions;
  const done = groups.filter(g => g.some(d => observed.has(d)));
  const missing = groups.filter(g => !g.some(d => observed.has(d))).map(g => `dimension:${g.join("|")}`);
  if (checkItems.size < k) missing.push(`independent_checks:${checkItems.size}/${k}`);
  if (families.size < minFamilies(k)) missing.push(`families:${families.size}/${minFamilies(k)}`);
  const latest = mine.filter(a => !a.isRepair && a.grade).at(-1);
  if (latest && !passed(latest.grade)) missing.push("latest_attempt_failed");
  if (HIGH_OPEN_HYPOTHESIS_BLOCKS && [...v.hypotheses.values()].some(h => h.subskillId === s.id && h.status === "open" && h.confidence === "high")) missing.push("open_high_hypothesis");
  return { passed: missing.length === 0, stm: groups.length ? done.length / groups.length : 1, k, checks: checkItems.size, families: families.size, missing, observed: [...observed] };
}

/** Coverage debt: what hasn't been observed yet (v3 semantics). */
export function coverageDebt(s: SubSkill, g: GateResult, v: EvidenceView): string[] {
  const debt: string[] = [];
  const mine = v.attempts.filter(a => v.items.get(a.itemId)?.subskillIds.includes(s.id));
  if (!mine.some(a => a.independent)) debt.push(`${s.id}:independence_untested`);
  for (const m of g.missing) if (m.startsWith("dimension:")) debt.push(`${s.id}:${m.slice(10)}_unobserved`);
  if (g.families < 2 && g.checks > 0) debt.push(`${s.id}:narrow_family_sampling`);
  if (!g.observed.includes("retention")) debt.push(`${s.id}:retention_untested`);
  return debt;
}
