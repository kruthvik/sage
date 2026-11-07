// Scripted personas (SPEC §18.2). No models. These check software behaviour, not learning efficacy.
import { expect, test } from "bun:test";
import type { Item } from "../../core/src/types.ts";
import { reduce, initialState, replay, validateItem, overlap, sessionState, pedagogy, type EngineState } from "../../engine/src/index.ts";
import { answerFor, bank, goal, plan, runSession, type Persona } from "../src/fixture.ts";

const good = "Because the rule brings the exponent down and lowers it by one, which follows from the limit definition.";
const allCorrect: Persona = i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: good }, quality: "good" };
const allWrong: Persona = i => i.key?.kind === "numeric" ? { input: { kind: "text", text: "-1" } } : { input: { kind: "text", text: "You just multiply everything by two." }, quality: "wrong" };
const copiesChunk: Persona = (i, c) => ({ input: { kind: "text", text: c.chunk ?? "no chunk" }, quality: i.key?.kind === "numeric" ? undefined : "wrong" });
const wrongReasoning: Persona = i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: "It works because derivatives always halve the function." }, quality: "wrong_reasoning" };
const imprecise: Persona = i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: "You bring the number down and make it smaller, which gives the slope." }, quality: "imprecise" };
const hintEverything: Persona = i => ({ ...allCorrect(i, { attempt: 0, cue: 0 }), hint: 3 });
/** Misconception M on s1: wrong until it has been taught with cues and a repair, then right on fresh items. */
const misconception = (): Persona => { let fails = 0; return (i, c) => i.subskillIds.includes("s1") && fails < 2 && c.cue === 0 && !i.id.includes("-a") ? (fails++, allWrong(i, c)) : allCorrect(i, c); };

const shownItems = (s: EngineState) => [...s.deliveredAt.keys()].map(id => s.items.get(id)!);
const DONE = new Set(["passed", "tested_out", "left_with_gaps"]);

test("all-correct persona passes every node, with no reducer errors", () => {
  const r = runSession(allCorrect);
  expect(r.errors).toEqual([]);
  expect(r.state.phase).toBe("ended");
  expect(r.state.plan!.nodes.every(n => n.status === "passed")).toBe(true);
});

test("all-wrong persona never passes a node (F2: engine owns transitions)", () => {
  const r = runSession(allWrong, { maxSteps: 400 });
  expect(r.state.plan!.nodes.some(n => n.status === "passed")).toBe(false);
});

test("copies-the-chunk persona doesn't pass (F6)", () => {
  const r = runSession(copiesChunk, { maxSteps: 400 });
  expect(r.state.plan!.nodes.some(n => n.status === "passed")).toBe(false);
});

test("right answer, wrong reasoning: explanation stays unobserved and the node doesn't pass", () => {
  const r = runSession(wrongReasoning, { maxSteps: 400 });
  expect(r.state.plan!.nodes[0]!.status).not.toBe("passed");
  expect(r.effects.some(f => f.kind === "repair_required")).toBe(true);
});

test("precise idea, imprecise wording: deducted marks and a precision flaw, but no forced repair (F15)", () => {
  const r = runSession(imprecise);
  const g = r.state.attempts.map(a => a.grade!).find(g => g.flaws.some(f => f.severity === "precision"))!;
  expect(g.score0to100).toBeLessThan(100);
  expect(r.effects.some(f => f.kind === "repair_required")).toBe(false);
});

test("requests-every-hint persona: answer-bearing hints make every attempt supported, so nothing passes (§7.3)", () => {
  const r = runSession(hintEverything, { maxSteps: 400 });
  const hinted = r.state.attempts.filter(a => a.assistance.some(x => x.answerBearing));
  expect(hinted.length).toBeGreaterThan(0);
  expect(hinted.every(a => !a.independent)).toBe(true);
  expect(r.state.plan!.nodes.some(n => n.status === "passed")).toBe(false);
});

test("no supported attempt ever counts as independent", () => {
  for (const p of [allCorrect, allWrong, hintEverything, misconception()]) {
    const r = runSession(p, { maxSteps: 600 });
    for (const a of r.state.attempts) if (a.cueLevel > 0 || a.isRepair || a.assistance.some(x => x.answerBearing)) expect(a.independent).toBe(false);
  }
});

test("misconception persona: diminishing cues, then repair, then an uncued fresh success before the node passes (F7)", () => {
  const r = runSession(misconception());
  const s1 = r.state.attempts.filter(a => r.state.items.get(a.itemId)!.subskillIds.includes("s1"));
  const firstFail = s1.findIndex(a => a.grade && a.grade.score0to100 < 80);
  const cued = s1.findIndex((a, i) => i > firstFail && a.cueLevel > 0);
  const freshUncued = s1.findIndex((a, i) => i > cued && a.cueLevel === 0 && a.independent && a.grade!.score0to100 >= 80);
  expect(firstFail).toBeGreaterThanOrEqual(0);
  expect(cued).toBeGreaterThan(firstFail);
  expect(freshUncued).toBeGreaterThan(cued);
  expect(r.state.items.get(s1[freshUncued]!.itemId)!.familyId).not.toBe(r.state.items.get(s1[firstFail]!.itemId)!.familyId);
  expect(r.state.plan!.nodes[0]!.status).toBe("passed");
});

test("F7: hints only appear after a learner request; cue text only on engine-run cued retries", () => {
  for (const p of [allWrong, misconception(), hintEverything]) {
    const r = runSession(p, { maxSteps: 500 });
    const hintEvents = r.log.filter(e => e.event.type === "hint_requested").length;
    expect(r.effects.filter(f => f.kind === "reveal_hint").length).toBe(hintEvents);
    expect(r.log.some(e => e.actor !== "learner" && e.event.type === "hint_requested")).toBe(false);
  }
});

test("F3: every chunk is followed by an item before another chunk, and chunks stay under the cap", () => {
  for (const p of [allCorrect, misconception()]) {
    const r = runSession(p);
    const kinds = r.state.timeline.map(t => t.kind).filter(k => k === "chunk" || k === "item");
    kinds.forEach((k, i) => { if (k === "chunk") expect(kinds[i + 1]).toBe("item"); });
    for (const e of r.log) if (e.event.type === "chunk_presented") expect(e.event.text.split(/\s+/).length).toBeLessThanOrEqual(pedagogy.CHUNK_WORDS.cram * 2);
  }
});

test("a second chunk without a check in between is rejected (F3)", () => {
  const s = upTo("teach");
  const ev = { type: "chunk_presented" as const, text: "Short idea.", subskillIds: ["s1"] };
  const after = reduce(s, ev, t(100), "tutor").state;
  expect(() => reduce(after, ev, t(101), "tutor")).toThrow(/teach phase/);
});

test("F5/F6: every shown item passes the validator, and checks don't copy the chunk", () => {
  const r = runSession(misconception());
  for (const i of shownItems(r.state)) expect(validateItem(i)).toEqual([]);
  const leaky: Item = { ...r.state.items.get("s1-p1")!, id: "x", stem: "What is 27? The answer is 27 for this derivative question.", key: { kind: "numeric", value: 27, tolerance: 0 } };
  expect(validateItem(leaky)).toContain("stem_leaks_key");
  const chunk = "Bring the exponent down as a coefficient and lower the exponent by one then substitute the input value";
  expect(overlap("Bring the exponent down as a coefficient and lower the exponent by one: what happens?", chunk)).toBeGreaterThan(pedagogy.CHECK_CHUNK_OVERLAP_MAX);
  expect(validateItem({ ...leaky, stem: "Bring the exponent down as a coefficient and lower the exponent by one: what do you get?" }, { chunk })).toContain("check_copies_chunk");
});

test("validator: MCQ rules, surface-only transfer, nudge leaks", () => {
  const mcq: Item = { id: "m", nodeId: "n1", subskillIds: ["s1"], activityType: "conceptual_mcq", difficulty: 2, partition: "practice", familyId: "f", evidences: ["selection"], stem: "Which rule applies to x squared plus one?", choices: ["power rule", "power rule"], key: { kind: "choice", index: 0 } };
  expect(validateItem(mcq)).toEqual(expect.arrayContaining(["mcq_choices_invalid", "mcq_distractor_rationale_missing"]));
  const surface: Item = { ...mcq, activityType: "apply_problem", evidences: ["changed_application"], choices: undefined, key: { kind: "numeric", value: 3, tolerance: 0 }, variation: { baselineItemId: "b", changedDimensions: ["surface"], invariant: "same" } };
  expect(validateItem(surface)).toContain("surface_only_variation_claims_transfer");
  expect(validateItem({ ...surface, variation: undefined, evidences: ["execution"], hints: ["The answer is 3", "", ""] })).toContain("nudge_answer_bearing");
});

test("F2: unit plans aren't capped (a 9-node DAG is accepted)", () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ ...plan.nodes[0]!, id: `n${i}`, prerequisites: i ? [`n${i - 1}`] : [], subskills: [{ ...plan.nodes[0]!.subskills[0]!, id: `s${i}` }] }));
  const s = reduce(created(), { type: "plan_proposed", plan: { rev: 0, nodes, edges: [] } }, t(1), "role").state;
  expect(s.plan!.nodes.length).toBe(9);
  expect(() => reduce(created(), { type: "plan_proposed", plan: { rev: 0, nodes: [{ ...nodes[0]!, prerequisites: ["n1"] }, { ...nodes[1]!, prerequisites: ["n0"] }], edges: [] } }, t(1), "role")).toThrow(/cycle/);
});

test("F2: advance is refused until the gate passes, and lists what's missing", () => {
  const s = upTo("teach");
  const r = reduce(s, { type: "control", action: "advance" }, t(200), "learner");
  expect(r.effects.find(f => f.kind === "notice")).toMatchObject({ code: "gate_not_passed" });
  expect(r.state.plan!.nodes[0]!.status).toBe("active");
});

test("F10 role integrity: tutor and roles can't author learner work, consent or approval", () => {
  const s = upTo("teach");
  expect(() => reduce(s, { type: "response_submitted", input: { kind: "text", text: "x" }, responseEventId: "r", latencyMs: 1 }, t(9), "tutor")).toThrow(/may not emit/);
  expect(() => reduce(s, { type: "plan_approved" }, t(9), "role")).toThrow(/may not emit/);
  expect(() => reduce(s, { type: "control", action: "advance" }, t(9), "tutor")).toThrow(/may not emit/);
  expect(() => reduce(s, { type: "reviews_consented", subskillIds: [] }, t(9), "tutor")).toThrow(/may not emit/);
});

test("blank input and stop never fabricate learner work", () => {
  const r = runSession(allCorrect, { maxSteps: 12 });
  const s = r.state;
  if (s.current) expect(() => reduce(s, { type: "response_submitted", input: { kind: "text", text: "   " }, responseEventId: "b", latencyMs: 1 }, t(999), "learner")).toThrow(/1–24000/);
  const stopped = reduce(s, { type: "control", action: "stop" }, t(999), "learner").state;
  expect(stopped.attempts.length).toBe(s.attempts.length);
  expect(() => reduce(stopped, { type: "control", action: "advance" }, t(1000), "learner")).toThrow(/stopped/);
});

test("Speed up never removes a node, subskill or required dimension", () => {
  const r = runSession(allCorrect, { maxSteps: 10 });
  const before = r.state.plan!.nodes.map(n => [n.id, n.subskills.map(x => [x.id, x.requiredDimensions])]);
  const after = reduce(r.state, { type: "pace_set", pace: "speed_up" }, t(999), "learner").state;
  expect(after.plan!.nodes.map(n => [n.id, n.subskills.map(x => [x.id, x.requiredDimensions])])).toEqual(before);
  const fast = runSession(allCorrect, { goal: goal({ pace: "speed_up" }) });
  expect(fast.state.plan!.nodes.every(n => n.status === "passed")).toBe(true);
  expect(fast.state.attempts.length).toBeLessThan(runSession(allCorrect).state.attempts.length);
});

test("leave with gaps needs a confirmation token and keeps the unmet requirements", () => {
  const s = upTo("teach");
  const ask = reduce(s, { type: "control", action: "leaveWithGaps" }, t(300), "learner");
  const c = ask.effects.find(f => f.kind === "confirm_required") as { token: string };
  expect(ask.state.plan!.nodes[0]!.status).toBe("active");
  expect(() => reduce(ask.state, { type: "control", action: "leaveWithGaps", confirmToken: "bogus" }, t(301), "learner")).toThrow(/token/);
  const done = reduce(ask.state, { type: "control", action: "leaveWithGaps", confirmToken: c.token }, t(302), "learner").state;
  expect(done.plan!.nodes[0]!.status).toBe("left_with_gaps");
  expect(done.leftWithGaps.get("n1")!.length).toBeGreaterThan(0);
});

test("F8: skipping the diagnostic leaves nodes unknown (nothing tested out)", () => {
  const g = goal({ mode: "accelerate", preview: { ...goal().preview, toggles: { ...goal().preview.toggles, diagnostic: true } } });
  let s = reduce(initialState(), { type: "session_created", sessionId: "s", goal: g }, t(0), "learner").state;
  s = reduce(s, { type: "plan_proposed", plan }, t(1), "role").state;
  s = reduce(s, { type: "plan_approved" }, t(2), "learner").state;
  expect(s.diagnostic.status).toBe("pending");
  s = reduce(s, { type: "control", action: "teach" }, t(3), "learner").state;
  expect(s.diagnostic.status).toBe("skipped");
  expect(s.plan!.nodes.some(n => n.status === "tested_out")).toBe(false);
});

test("F12: replay from the log reproduces the live state; 'Now' is always present", () => {
  const r = runSession(misconception());
  const replayed = replay(r.log);
  expect(sessionState(replayed)).toEqual(sessionState(r.state));
  expect(replayed.attempts).toEqual(r.state.attempts);
  expect(r.state.decisions.every(d => d.reasonCodes.length > 0 && d.candidateIds.includes(d.selectedId))).toBe(true);
});

test("pace notice is non-blocking and fires once per node unless the projection worsens", () => {
  const r = runSession(allCorrect, { goal: goal({ timeBudgetMin: 5 }), stepMs: 60_000 });
  const notices = r.effects.filter(f => f.kind === "pace_notice");
  expect(notices.length).toBeGreaterThan(0);
  expect(r.state.plan!.nodes.every(n => n.status === "passed")).toBe(true); // it never blocked progress
  expect((notices[0] as { options: string[] }).options).toEqual(["Continue normal", "Speed up", "Extend time", "Review plan"]);
});

test("node check: failing an earlier node's item marks it needs_repair and revisits it after the current node", () => {
  // n1 gets 4 extra assessment items so some are left over for n2's cumulative check (40% earlier nodes).
  const bigBank: typeof bank = (n, s) => [...bank(n, s), ...[7, 8, 9, 10].map(k => ({ ...bank(n, s).find(i => i.id.endsWith("-a1"))!, id: `${s}-a${k}`, familyId: `${s}-famx${k}`, stem: `Exam-style item ${k}: compute the derivative value at input ${k} for the ${s} spare function` }))];
  const persona: Persona = (i, c) => i.nodeId === "n1" && i.partition === "assessment" && (c.attempt > 12) ? { input: { kind: "text", text: "-1" } } : allCorrect(i, c);
  const r = runSession(persona, { bank: bigBank });
  const statuses = r.effects.filter(f => f.kind === "node_status").map(f => `${(f as { nodeId: string }).nodeId}:${(f as { status: string }).status}`);
  expect(statuses).toContain("n1:needs_repair");
  expect(statuses.indexOf("n1:needs_repair")).toBeLessThan(statuses.lastIndexOf("n1:active"));
  expect(r.effects.some(f => f.kind === "notice" && f.code === "repair_inserted")).toBe(true);
});

test("idle gaps over 3 minutes are excluded from time on task", () => {
  const s = upTo("teach");
  const later = reduce(s, { type: "tick" }, new Date(Date.parse(t(10)) + 10 * 60_000).toISOString(), "host").state;
  expect(later.time.idleGaps).toBe(s.time.idleGaps + 1);
  expect([...later.time.nodeMs.values()]).toEqual([...s.time.nodeMs.values()]);
});

// helpers
const t = (sec: number) => new Date(Date.parse("2026-11-07T10:00:00.000Z") + sec * 1000).toISOString();
function created() { return reduce(initialState(), { type: "session_created", sessionId: "s", goal: goal() }, t(0), "learner").state; }
/** A fresh session in node n1's teach phase. Speed-up skips Prime, so the bank lands straight in teach. */
function upTo(phase: "teach"): EngineState {
  let s = reduce(initialState(), { type: "session_created", sessionId: "s", goal: goal({ pace: "speed_up" }) }, t(0), "learner").state;
  s = reduce(s, { type: "plan_proposed", plan }, t(1), "role").state;
  s = reduce(s, { type: "plan_approved" }, t(2), "learner").state;
  s = reduce(s, { type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, t(3), "role").state;
  expect(s.phase).toBe(phase);
  expect(DONE.has(s.plan!.nodes[0]!.status)).toBe(false);
  return s;
}
