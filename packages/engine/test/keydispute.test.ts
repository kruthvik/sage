import { expect, test } from "bun:test";
import { reduce, initialState, type Actor, type Effect, type EngineEvent, type EngineState } from "../src/index.ts";
import { bank, goal, plan } from "../../eval/src/fixture.ts";

function driver(budget: number) {
  let s = initialState(), t = Date.parse("2026-11-07T09:00:00Z"), fx: Effect[] = [];
  const go = (event: EngineEvent, actor: Actor) => { const r = reduce(s, event, new Date((t += 30_000)).toISOString(), actor); s = r.state; fx = r.effects; return fx; };
  go({ type: "session_created", sessionId: "s", goal: goal({ timeBudgetMin: budget }) }, "learner");
  return { go, get s(): EngineState { return s; } };
}
const fitOf = (fx: Effect[]) => (fx.find(f => f.kind === "plan_fit") as Extract<Effect, { kind: "plan_fit" }> | undefined)?.fit;

test("plan fit is estimated from the gate and shows extend / merge / Speed-up when over budget", () => {
  const d = driver(30);
  const fit = fitOf(d.go({ type: "plan_proposed", plan }, "role"))!;
  expect(fit.fits).toBe(false);
  expect(fit.estMin).toBe(38); // per node: (execution 2 + selection 1 + changed 2.5 + prime 2 + chunk 1.5) × 1.2 + 5 check items × 1.5
  expect(fit.speedUpMin).toBe(26);
  expect(fit.mergeGroups).toEqual([["n1", "n2"]]);
  expect(fit.text).toContain("extend time to 38 min");
  expect(d.s.plan!.nodes[0]!.estMinutes).toBe(19);
  expect(fitOf(d.go({ type: "pace_set", pace: "speed_up" }, "learner"))!.fits).toBe(true);
  d.go({ type: "pace_set", pace: "normal" }, "learner");
  const merged = fitOf(d.go({ type: "plan_nodes_merged", nodeIds: ["n1", "n2"] }, "learner"))!;
  expect(d.s.plan!.nodes.map(n => [n.id, n.subskills.map(x => x.id)])).toEqual([["n1", ["s1", "s2"]]]);
  expect(merged.estMin).toBe(30);
  expect(fitOf(d.go({ type: "time_extended", minutes: 10 }, "learner"))!.fits).toBe(true);
  expect(() => d.go({ type: "plan_nodes_merged", nodeIds: ["n1", "nope"] }, "learner")).toThrow(/known nodes/);
});

test("a successful key dispute voids the item, re-scores its attempts, drops it from evidence and asks for a replacement", () => {
  const d = driver(120);
  d.go({ type: "plan_proposed", plan }, "role");
  d.go({ type: "plan_approved" }, "learner");
  d.go({ type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, "role");
  d.go({ type: "item_presented", itemId: "s1-p1" }, "tutor"); // key says 27
  d.go({ type: "response_submitted", input: { kind: "text", text: "f'(3) = 26" }, responseEventId: "r1", latencyMs: 1000 }, "learner");
  expect(d.s.attempts[0]!.grade!.score0to100).toBe(0);
  expect(d.s.cue.get("s1")?.itemId).toBe(undefined); // prime attempt: no ladder; the void path still clears any
  const fx = d.go({ type: "grade_disputed", attemptId: "a1", argument: "3·3² − 1 = 26, the key forgot the −x term" }, "learner");
  expect(fx).toContainEqual(expect.objectContaining({ kind: "call_role", role: "grader", purpose: "key_dispute" }));
  const after = d.go({ type: "key_dispute_resolved", attemptId: "a1", keyWrong: true, correctedKey: { kind: "numeric", value: 26, tolerance: 0.001 }, reason: "the key dropped a term" }, "role");
  const a = d.s.attempts[0]!;
  expect(a.grade!.score0to100).toBe(100);
  expect(a.grade!.disputed).toBe(true);
  expect(a.grade!.dimensionsObserved).toEqual([]);
  expect(a.supersededGrades![0]!.score0to100).toBe(0);
  expect(d.s.items.get("s1-p1")!.voided).toBe("the key dropped a term");
  expect(d.s.phase).toBe("feedback");
  expect(after).toContainEqual(expect.objectContaining({ kind: "call_role", role: "generator", purpose: "replace" }));
  expect(after).toContainEqual(expect.objectContaining({ kind: "notice", code: "item_voided" }));
  d.go({ type: "bank_generated", purpose: "replace", items: [{ ...bank("n1", "s1")[1]!, id: "s1-r1", familyId: "s1-famR", stem: "A replacement item about the derivative value at input seven" }] }, "role");
  expect(d.s.items.get("s1-r1")!.validated).toBe(true);
  expect(d.s.phase).toBe("feedback");
  expect(() => d.go({ type: "grade_disputed", attemptId: "a1", argument: "again" }, "learner")).toThrow();
});

test("a rejected key dispute keeps the grade; key disputes need the feedback to be showing", () => {
  const d = driver(120);
  d.go({ type: "plan_proposed", plan }, "role");
  d.go({ type: "plan_approved" }, "learner");
  d.go({ type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, "role");
  d.go({ type: "item_presented", itemId: "s1-p1" }, "tutor");
  d.go({ type: "response_submitted", input: { kind: "text", text: "26" }, responseEventId: "r1", latencyMs: 1000 }, "learner");
  d.go({ type: "grade_disputed", attemptId: "a1", argument: "I think it's 26" }, "learner");
  const fx = d.go({ type: "key_dispute_resolved", attemptId: "a1", keyWrong: false, reason: "3·3² = 27; there is no −x term" }, "role");
  expect(fx).toContainEqual(expect.objectContaining({ kind: "notice", code: "dispute_rejected" }));
  expect(d.s.attempts[0]!.grade!.score0to100).toBe(0);
  expect(d.s.items.get("s1-p1")!.voided).toBeUndefined();
  d.go({ type: "feedback_acked", attemptId: "a1" }, "learner");
  expect(() => d.go({ type: "grade_disputed", attemptId: "a1", argument: "late" }, "learner")).toThrow();
});

test("regression (flash eval): choosing checkpoint saves and hands the tutor another turn without it, so the session never waits on nothing", () => {
  const d = driver(120);
  d.go({ type: "plan_proposed", plan }, "role");
  d.go({ type: "plan_approved" }, "learner");
  d.go({ type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, "role");
  d.go({ type: "item_presented", itemId: "s1-p1" }, "tutor");
  d.go({ type: "response_submitted", input: { kind: "text", text: "27" }, responseEventId: "r1", latencyMs: 1000 }, "learner");
  d.go({ type: "feedback_acked", attemptId: "a1" }, "learner"); // prime → teach
  d.go({ type: "chunk_presented", text: "Bring the exponent down and lower it by one.", subskillIds: ["s1"] }, "tutor");
  d.go({ type: "item_presented", itemId: "s1-p2" }, "tutor");
  d.go({ type: "response_submitted", input: { kind: "text", text: "5" }, responseEventId: "r2", latencyMs: 1000 }, "learner");
  d.go({ type: "feedback_acked", attemptId: "a2" }, "learner");
  expect(d.s.phase).toBe("adapt");
  const cp = d.s.candidates.find(c => c.kind === "checkpoint")!;
  const fx = d.go({ type: "move_selected", candidateId: cp.id, reasonCodes: ["natural_pause"], nextIntendedMove: "pause" }, "tutor");
  expect(fx.map(f => f.kind)).toEqual(["checkpoint", "write_export", "tutor_turn"]);
  const t = fx.find(f => f.kind === "tutor_turn") as Extract<Effect, { kind: "tutor_turn" }>;
  expect(t.candidates.some(c => c.kind === "checkpoint")).toBe(false);
  expect(t.candidates.length).toBeGreaterThan(0);
});
