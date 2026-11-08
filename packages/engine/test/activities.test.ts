// Library activities (owner, 2026-11-08): ordering, matching, contrasting cases. Deterministic validation and grading.
import { expect, test } from "bun:test";
import type { Item } from "../../core/src/types.ts";
import { gradeDeterministic, passed, validateItem } from "../src/items.ts";

const base = { id: "i", nodeId: "n", subskillIds: ["s"], difficulty: 2, partition: "practice", familyId: "f", evidences: ["recall"] } as const;
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
  expect(passed(ok)).toBe(true); expect(ok.dimensionsObserved).toEqual(["recall"]);
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
  const cc: Item = { ...base, activityType: "contrasting_cases", evidences: ["explanation"], stem: "What differs between the two cases, and why does it matter?",
    cases: ["A ball dropped in a vacuum falls at 9.8 m/s².", "A feather dropped in air drifts down slowly."], rubric: ["names air resistance"], key: { kind: "reference", text: "Air resistance." } };
  expect(validateItem(cc)).toEqual([]);
  expect(validateItem({ ...cc, cases: ["only one case here"] })).toContain("contrasting_cases_invalid");
  expect(gradeDeterministic(cc, { kind: "text", text: "air" })).toBeUndefined();
});
