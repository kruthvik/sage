// Library activities (owner, 2026-11-08): ordering, matching, contrasting cases. Deterministic validation and grading.
import { expect, test } from "bun:test";
import type { Item } from "../../core/src/types.ts";
import { gradeDeterministic, passed, validateItem } from "../src/items.ts";

const base: Pick<Item, "id" | "nodeId" | "subskillIds" | "difficulty" | "partition" | "familyId" | "evidences"> = { id: "i", nodeId: "n", subskillIds: ["s"], difficulty: 2, partition: "practice", familyId: "f", evidences: ["acquisition"] };
const ordering = (order: number[]): Item => ({ ...base, activityType: "ordering", stem: "Put the steps of long division in order.", choices: ["Multiply", "Divide", "Bring down", "Subtract"], key: { kind: "order", order } });
const matching: Item = { ...base, activityType: "matching", stem: "Match each organelle to its job.", choices: ["Mitochondrion", "Ribosome"], targets: ["Makes proteins", "Releases energy", "Stores water"], key: { kind: "match", pairs: [1, 0] } };

test("ordering: valid key passes validation; a key equal to the shown order is refused", () => {
  expect(validateItem(ordering([1, 0, 3, 2]))).toEqual([]);
  expect(validateItem(ordering([0, 1, 2, 3]))).toContain("ordering_shown_in_answer_order");
  expect(validateItem(ordering([1, 1, 3, 2]))).toContain("ordering_key_invalid");
});

test("ordering: only the exact order passes; the score is the share of positions right", () => {
  const it = ordering([1, 0, 3, 2]);
  const ok = gradeDeterministic(it, { kind: "indices", indices: [1, 0, 3, 2] })!;
  expect(passed(ok)).toBe(true); expect(ok.dimensionsObserved).toEqual(["acquisition"]);
  const half = gradeDeterministic(it, { kind: "indices", indices: [1, 0, 2, 3] })!;
  expect(half.score0to100).toBe(50); expect(passed(half)).toBe(false);
  expect(half.criterionEvidence[0]!.quote).toBe("Divide → Multiply → Bring down → Subtract");
  expect(half.flaws[0]!.suggestion).toBe("Correct: Divide → Multiply → Subtract → Bring down");
  expect(passed(gradeDeterministic(it, { kind: "text", text: "1,0,3,2" }))).toBe(false); // wrong input shape never passes
});

test("matching: validation and grading", () => {
  expect(validateItem(matching)).toEqual([]);
  expect(validateItem({ ...matching, key: { kind: "match", pairs: [0, 0] } })).toContain("matching_key_invalid");
  expect(validateItem({ ...matching, targets: ["only one"] })).toContain("matching_columns_invalid");
  expect(passed(gradeDeterministic(matching, { kind: "indices", indices: [1, 0] }))).toBe(true);
  const wrong = gradeDeterministic(matching, { kind: "indices", indices: [2, 0] })!;
  expect(wrong.score0to100).toBe(50); expect(wrong.criterionEvidence[0]!.quote).toBe("Mitochondrion → Stores water; Ribosome → Makes proteins");
});

test("contrasting cases need two cases and a rubric, and go to the grader role", () => {
  const cc: Item = { ...base, activityType: "contrasting_cases", evidences: ["selection"], stem: "What differs between the two cases, and why does it matter?",
    cases: ["A ball dropped in a vacuum falls at 9.8 m/s².", "A feather dropped in air drifts down slowly."], rubric: ["names air resistance"], key: { kind: "reference", text: "Air resistance." } };
  expect(validateItem(cc)).toEqual([]);
  expect(validateItem({ ...cc, cases: ["only one case here"] })).toContain("contrasting_cases_invalid");
  expect(gradeDeterministic(cc, { kind: "text", text: "air" })).toBeUndefined();
});

// ---- owner evidence rules (2026-11-08) ----
import type { Attempt, Grade, SubSkill } from "../../core/src/types.ts";
import { gate, observedDims } from "../src/evidence.ts";
import { requiredDimensions } from "../src/pedagogy.config.ts";

const sub: SubSkill = { id: "s", nodeId: "n", statement: "Name each organelle's job", kind: "declarative", selectionRelevant: false, requiredDimensions: requiredDimensions("cram", { kind: "declarative", selectionRelevant: false }) };
const attempt = (itemId: string, grade: Grade, i: number): Attempt => ({ id: `a${i}`, itemId, responseEventId: `r${i}`, response: "indices 1,0", at: new Date(Date.UTC(2026, 10, 8, 9, i)).toISOString(), assistance: [], independent: true, isRepair: false, cueLevel: 0, latencyMs: 9000, grade });

test("ordering and matching can't claim recall", () => {
  expect(validateItem({ ...matching, evidences: ["recall"] })).toContain("evidence_not_supported_by_activity");
  expect(validateItem({ ...ordering([1, 0, 3, 2]), evidences: ["recall"] })).toContain("evidence_not_supported_by_activity");
});

test("matching-only evidence can't pass the Cram gate, however many items, families or overclaimed dimensions", () => {
  const items = new Map<string, Item>(), attempts: Attempt[] = [];
  for (let i = 0; i < 12; i++) {
    const it: Item = { ...matching, id: `m${i}`, familyId: `f${i % 4}`, validated: true };
    items.set(it.id, it);
    const g = gradeDeterministic(it, { kind: "indices", indices: [1, 0] })!;
    expect(passed(g)).toBe(true);
    // Even a grade claiming every Cram dimension only yields what the activity can evidence.
    attempts.push(attempt(it.id, { ...g, dimensionsObserved: ["recall", "explanation", "selection", "changed_application", "acquisition"] }, i));
  }
  const r = gate(sub, "cram", "normal", { items, attempts, hypotheses: new Map(), deliveredAt: new Map([...items.keys()].map(k => [k, "2026-11-08T09:00:00.000Z"])) });
  expect(r.observed).toEqual(["acquisition"]);
  expect(r.passed).toBe(false);
  expect(r.missing).toEqual(expect.arrayContaining(["dimension:recall", "dimension:explanation|selection", "dimension:changed_application"]));
  expect(r.stm).toBe(0);
});

test("contrasting cases: selection when the difference is named; explanation only with the reason and the full rubric", () => {
  const cc: Item = { ...base, activityType: "contrasting_cases", evidences: ["selection", "explanation"], validated: true, stem: "Which case shows air resistance mattering, and why?",
    cases: ["A ball dropped in a vacuum falls at 9.8 m/s².", "A feather dropped in air drifts down slowly."], rubric: ["names the difference / which case applies", "explains that drag depends on area relative to weight"], key: { kind: "reference", text: "B; drag." } };
  expect(validateItem(cc)).toEqual([]);
  expect(validateItem({ ...cc, rubric: ["names the difference / which case applies"] })).toContain("contrasting_cases_explanation_needs_reason_criterion");
  const g = (met: boolean[], score: number, blocking = false): Grade => ({ score0to100: score, grader: "model", feedback: "", dimensionsObserved: ["selection", "explanation"],
    criterionEvidence: met.map((m, i) => ({ criterion: cc.rubric![i]!, satisfied: m, quote: m ? "case B" : "" })), flaws: blocking ? [{ quote: "case B", problem: "wrong reason", suggestion: "", severity: "blocking" }] : [] });
  const dims = (gr: Grade) => observedDims(attempt("i", gr, 1), sub, { items: new Map([["i", cc]]), attempts: [], hypotheses: new Map(), deliveredAt: new Map() });
  expect(dims(g([true, false], 50))).toEqual(["selection"]);                  // named the case, no reason: selection only (even though it fails overall)
  expect(dims(g([true, true], 100))).toEqual(["selection", "explanation"]);  // reason given, rubric met
  expect(dims(g([true, true], 100, true))).toEqual([]);                      // a blocking flaw (e.g. wrong reason) earns neither
  expect(dims(g([false, true], 50))).toEqual([]);                            // a reason without naming the difference: nothing
});
