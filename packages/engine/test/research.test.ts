import { expect, test } from "bun:test";
import { reduce, initialState, type Effect, type EngineState } from "../src/index.ts";
import { bank, goal, plan } from "../../eval/src/fixture.ts";
import type { Goal, Plan } from "../../core/src/types.ts";

let n = 0;
const t = () => new Date(Date.parse("2026-11-07T10:00:00.000Z") + (n += 10) * 1000).toISOString();
const researchCalls = (fx: Effect[]) => fx.filter(f => f.kind === "call_role" && f.role === "researcher") as Extract<Effect, { kind: "call_role" }>[];
function start(g: Partial<Goal>, p: Plan = plan) {
  const a = reduce(initialState(), { type: "session_created", sessionId: "s", goal: goal({ pace: "speed_up", ...g }) }, t(), "learner");
  const b = reduce(a.state, { type: "plan_proposed", plan: p }, t(), "role");
  const c = reduce(b.state, { type: "plan_approved" }, t(), "learner");
  return { created: a.effects, approved: c.effects, state: c.state };
}
const pack = (id: string, extra: object = {}) => ({ type: "research_pack_received" as const, pack: { id, trigger: "intake" as const, items: [{ id: `${id}-1`, title: "Paul's Notes: power rule", url: "https://example.org/power", relevance: "covers n1", spans: ["d/dx x^n = n x^(n-1)"], reliability: "university course notes", nodeId: "n1", ...extra }] } });

test("(a) intake with no learner sources queues research in the background; with sources it doesn't", () => {
  const none = start({});
  expect(researchCalls(none.created).map(c => [c.purpose, c.background])).toEqual([["intake", true]]);
  expect(researchCalls(start({ sourceIds: ["src1"] }).created)).toEqual([]);
});

test("(d) a named exam or course triggers research for its format and samples", () => {
  const r = start({ sourceIds: ["src1"], exam: { name: "AP Calculus AB", formats: ["mcq", "free_response"], topicWeights: [] } });
  expect(researchCalls(r.created).map(c => c.purpose)).toEqual(["exam"]);
});

test("(b)/(c) node start: uncovered by learner sources, or low planner confidence", () => {
  const lowPlan: Plan = { ...plan, nodes: plan.nodes.map((x, i) => ({ ...x, knowledgeConfidence: i === 0 ? "low" as const : "high" as const })) };
  expect(researchCalls(start({ sourceIds: ["src1"] }, lowPlan).approved).map(c => c.purpose)).toEqual(["low_confidence"]);
  expect(researchCalls(start({ sourceIds: ["src1"] }).approved).map(c => c.purpose)).toEqual(["node_uncovered"]);
  const covered: Plan = { ...plan, nodes: plan.nodes.map(x => ({ ...x, sourceIds: ["src1"] })) };
  expect(researchCalls(start({ sourceIds: ["src1"] }, covered).approved)).toEqual([]);
});

test("(e) request_research queues without blocking the lesson and is deduplicated", () => {
  let s = reduce(start({}).state, { type: "bank_generated", purpose: "node", nodeId: "n1", items: bank("n1", "s1") }, t(), "role").state;
  const phase = s.phase;
  const r1 = reduce(s, { type: "research_requested", question: "Common exam traps for the power rule" }, t(), "tutor");
  expect(r1.state.phase).toBe(phase);
  expect(researchCalls(r1.effects).length).toBe(1);
  s = r1.state;
  expect(researchCalls(reduce(s, { type: "research_requested", question: "common exam traps for the power rule " }, t(), "tutor").effects)).toEqual([]);
});

test("packs wait for the learner; the tutor and roles can't accept them (F10)", () => {
  let s: EngineState = reduce(start({}).state, pack("p1"), t(), "role").state;
  expect(s.packs.get("p1")!.status).toBe("pending");
  expect(() => reduce(s, { type: "research_pack_accepted", packId: "p1" }, t(), "tutor")).toThrow(/may not emit/);
  s = reduce(s, { type: "research_pack_accepted", packId: "p1" }, t(), "learner").state;
  expect(s.packs.get("p1")!.status).toBe("accepted");
});

test("auto-accept only via the learner's own preview toggle; conflicts are flagged, learner material stays primary", () => {
  const g = goal().preview;
  const st = start({ preview: { ...g, toggles: { ...g.toggles, autoAcceptResearch: true } } }).state;
  const r = reduce(st, pack("p2", { conflictsWithSourceId: "src1" }), t(), "role");
  expect(r.state.packs.get("p2")!.status).toBe("accepted");
  expect(r.effects.find(f => f.kind === "notice")).toMatchObject({ code: "research_ready" });
  expect((r.effects.find(f => f.kind === "notice") as { text: string }).text).toMatch(/conflict.*yours stays primary/);
});

test("pack items need a URL or citation, or must be labelled unsourced", () => {
  const st = start({}).state;
  expect(() => reduce(st, pack("p3", { url: undefined }), t(), "role")).toThrow(/unsourced/);
  expect(reduce(st, pack("p4", { url: undefined, unsourced: true }), t(), "role").state.packs.has("p4")).toBe(true);
});

test("a background research pack can still land while the session is stopped", () => {
  let s = reduce(start({ sourceIds: ["src1"] }).state, { type: "control", action: "stop" }, t(), "learner").state;
  s = reduce(s, pack("p5"), t(), "role").state; // a background pack can land while stopped
  expect(s.packs.has("p5")).toBe(true);
});
