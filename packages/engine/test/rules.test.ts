import { expect, test } from "bun:test";
import { reduce, initialState, nextIntervalDays, type EngineState, type EngineEvent, type Actor, gates } from "../src/index.ts";
import { bank, goal, plan, stubGrade } from "../../eval/src/fixture.ts";
import type { Goal } from "../../core/src/types.ts";

let clock = 0;
const t = () => new Date(Date.parse("2026-11-07T10:00:00.000Z") + (clock += 10) * 1000).toISOString();
const go = (s: EngineState, e: EngineEvent, a: Actor) => reduce(s, e, t(), a);
function teach(g: Partial<Goal> = {}): EngineState {
  let s = go(initialState(), { type: "session_created", sessionId: "s", goal: goal({ pace: "speed_up", ...g }) }, "learner").state;
  s = go(s, { type: "plan_proposed", plan }, "role").state;
  s = go(s, { type: "plan_approved" }, "learner").state;
  return go(s, { type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, "role").state;
}
function answerExplain(s: EngineState, quality: string): EngineState {
  s = go(s, { type: "chunk_presented", text: "The exponent comes down and drops by one.", subskillIds: ["s1"] }, "tutor").state;
  s = go(s, { type: "item_presented", itemId: "s1-w1" }, "tutor").state;
  s = go(s, { type: "response_submitted", input: { kind: "text", text: "Because the derivative halves things." }, responseEventId: "r1", latencyMs: 5000 }, "learner").state;
  return go(s, { type: "grade_received", attemptId: "a1", grade: stubGrade(s.items.get("s1-w1")!, "Because the derivative halves things.", quality) }, "role").state;
}

test("a grade must quote the actual response (no invented evidence)", () => {
  let s = teach();
  s = go(s, { type: "chunk_presented", text: "The exponent comes down.", subskillIds: ["s1"] }, "tutor").state;
  s = go(s, { type: "item_presented", itemId: "s1-w1" }, "tutor").state;
  s = go(s, { type: "response_submitted", input: { kind: "text", text: "Because it does." }, responseEventId: "r", latencyMs: 1 }, "learner").state;
  const fake = { ...stubGrade(s.items.get("s1-w1")!, "a quote the learner never wrote", "good") };
  expect(() => go(s, { type: "grade_received", attemptId: "a1", grade: fake }, "role")).toThrow(/unquoted_criterion/);
});

test("dispute: once per item, both grades kept, criterion-grounded regrade can change the mark", () => {
  let s = answerExplain(teach(), "wrong");
  s = go(s, { type: "grade_disputed", attemptId: "a1", argument: "I named the rule in my answer." }, "learner").state;
  expect(s.phase).toBe("grading");
  s = go(s, { type: "grade_received", attemptId: "a1", grade: stubGrade(s.items.get("s1-w1")!, "Because the derivative halves things.", "imprecise") }, "role").state;
  const a = s.attempts[0]!;
  expect(a.grade!.disputed).toBe(true);
  expect(a.supersededGrades!.length).toBe(1);
  expect(a.supersededGrades![0]!.score0to100).toBe(35);
  expect(() => go(s, { type: "grade_disputed", attemptId: "a1", argument: "again" }, "learner")).toThrow(/one dispute/);
});

test("blocking flaw ⇒ repair before continuing; repair is supported, never independent", () => {
  let s = answerExplain(teach(), "wrong");
  s = go(s, { type: "feedback_acked", attemptId: "a1" }, "learner").state;
  expect(s.phase).toBe("repair");
  expect(() => go(s, { type: "move_selected", candidateId: "x", reasonCodes: ["r"], nextIntendedMove: "x" }, "tutor")).toThrow(/adapt/);
  s = go(s, { type: "response_submitted", input: { kind: "text", text: "The rule brings the exponent down; halving was wrong." }, responseEventId: "r2", latencyMs: 1 }, "learner").state;
  expect(s.attempts[1]!.isRepair).toBe(true);
  expect(s.attempts[1]!.independent).toBe(false);
});

test("advancement waits for the feedback-display receipt", () => {
  const s = answerExplain(teach(), "good");
  expect(s.phase).toBe("feedback");
  expect(() => go(s, { type: "control", action: "morePractice" }, "learner")).toThrow(/feedback/);
  expect(() => go(s, { type: "feedback_acked", attemptId: "nope" }, "learner")).toThrow();
});

test("hypotheses: evidence must be about the subskill; resolving needs contradicting evidence; open+high blocks the gate", () => {
  let s = answerExplain(teach(), "wrong");
  const h = { id: "h1", subskillId: "s1", category: "conceptual" as const, statement: "Thinks derivatives halve", confidence: "high" as const, supportingAttemptIds: ["a1"], contradictingAttemptIds: [], status: "open" as const };
  expect(() => go(s, { type: "hypothesis_proposed", hypothesis: { ...h, subskillId: "s2" } }, "tutor")).toThrow(/not about/);
  expect(() => go(s, { type: "hypothesis_proposed", hypothesis: { ...h, status: "resolved" } }, "tutor")).toThrow(/contradicting/);
  expect(() => go(s, { type: "hypothesis_proposed", hypothesis: { ...h, contradictingAttemptIds: ["a1"] } }, "tutor")).toThrow(/both/);
  s = go(s, { type: "hypothesis_proposed", hypothesis: h }, "tutor").state;
  expect(gates(s, s.plan!.nodes[0]!).get("s1")!.missing).toContain("open_high_hypothesis");
  expect(s.hypotheses.get("h1")!.rev).toBe(1);
});

test("tutor can't present assessment items, repeat an item, or reuse the failed family uncued", () => {
  let s = teach();
  s = go(s, { type: "chunk_presented", text: "Exponent down, minus one.", subskillIds: ["s1"] }, "tutor").state;
  expect(() => go(s, { type: "item_presented", itemId: "s1-a1" }, "tutor")).toThrow(/held back/);
  s = go(s, { type: "item_presented", itemId: "s1-p1" }, "tutor").state;
  s = go(s, { type: "response_submitted", input: { kind: "text", text: "-1" }, responseEventId: "r", latencyMs: 1 }, "learner").state;
  s = go(s, { type: "feedback_acked", attemptId: "a1" }, "learner").state;
  expect(s.phase).toBe("adapt");
  expect(s.candidates.map(c => c.kind)).toContain("cued_retry");
  const fresh = s.candidates.find(c => c.kind === "check" || c.kind === "fresh_retry");
  if (fresh) {
    const s2 = go(s, { type: "move_selected", candidateId: fresh.id, reasonCodes: ["x"], nextIntendedMove: "fresh check" }, "tutor").state;
    expect(() => go(s2, { type: "item_presented", itemId: "s1-p1" }, "tutor")).toThrow(/never repeat/);
  }
  expect(s.candidates.length).toBeLessThanOrEqual(5);
  expect(s.candidates.at(-1)!.kind).toBe("checkpoint");
});

test("scheduler: v3 transparent baseline", () => {
  expect(nextIntervalDays(undefined, undefined)).toBe(2);
  expect(nextIntervalDays(2, true)).toBe(4);
  expect(nextIntervalDays(8, false)).toBe(2);
  expect(nextIntervalDays(8, true, 10)).toBe(10);
});

test("accelerate test-out needs independent changed-task evidence for every required dimension; one familiar success isn't enough", () => {
  const g = goal({ mode: "accelerate", preview: { ...goal().preview, toggles: { ...goal().preview.toggles, diagnostic: true } } });
  let s = go(initialState(), { type: "session_created", sessionId: "s", goal: g }, "learner").state;
  s = go(s, { type: "plan_proposed", plan }, "role").state;
  s = go(s, { type: "plan_approved" }, "learner").state;
  const items = bank("n1", "s1").filter(i => i.id === "s1-p1");
  s = go(s, { type: "bank_generated", purpose: "diagnostic", items }, "role").state;
  s = go(s, { type: "item_presented", itemId: "s1-p1" }, "tutor").state;
  s = go(s, { type: "response_submitted", input: { kind: "text", text: "27" }, responseEventId: "r", latencyMs: 1 }, "learner").state;
  s = go(s, { type: "feedback_acked", attemptId: "a1" }, "learner").state;
  s = go(s, { type: "control", action: "teach" }, "learner").state;
  expect(s.attempts[0]!.grade!.score0to100).toBe(100);
  expect(s.plan!.nodes[0]!.status).not.toBe("tested_out");
});
