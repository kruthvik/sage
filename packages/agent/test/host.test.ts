import { expect, test } from "bun:test";
import { runRole, type RoleModels } from "../src/host.ts";
import { initialState } from "../../engine/src/state.ts";
import type { RoleCallInput, RoleCallResult } from "../../pi-adapter/src/runtime.ts";

const M = { provider: "p", model: "m" };
const models: RoleModels = { planner: M, tutor: M, grader: M, generator: M, feynman: M, summarizer: M, researcher: M, checker: M, transcriber: M };
const reply = (text: string): RoleCallResult => ({ text, stopReason: "stop", provider: "p", model: "m", ms: 1, usage: { input: 10, output: 5, costUsd: "unknown" } });

test("node bank is split into three partition batches, each namespaced", async () => {
  const seen: string[] = [];
  const roleCall = async (i: RoleCallInput) => { const part = JSON.parse(i.user.split("<<<\n")[1]!.split("\n>>>")[0]!).partition; seen.push(part);
    return reply(JSON.stringify({ items: [{ id: "q1", subskillIds: ["s1"], activityType: "free_recall", partition: part, familyId: "f1", evidences: ["recall"], stem: "Recall the thing that matters here." }] })); };
  const evs = await runRole({ kind: "call_role", role: "generator", purpose: "node", input: { node: { id: "n1" } } }, initialState(), { models, roleCall, researchCall: roleCall }, 7);
  expect(seen.sort()).toEqual(["assessment", "practice", "teaching"]);
  const bank = evs.find(e => e.event.type === "bank_generated")!.event as { items: { id: string; familyId: string }[] };
  expect(new Set(bank.items.map(i => i.id)).size).toBe(3);
  expect(evs.filter(e => e.event.type === "role_call_logged")).toHaveLength(3);
});

test("a malformed grade is retried once, then the grade carries the attempt id; repair grades observe nothing", async () => {
  let n = 0;
  let output: RoleCallInput["output"];
  const roleCall = async (i: RoleCallInput) => (output = i.output, reply(n++ === 0 ? "sorry" : JSON.stringify({ criteria: [{ index: 0, credit: 1, quote: "abc" }], flaws: [], feedback: "ok" })));
  const item = { id: "i", stem: "Q", rubric: ["r"], activityType: "free_recall", evidences: ["recall"] };
  const evs = await runRole({ kind: "call_role", role: "grader", purpose: "repair", input: { attemptId: "a9", item, response: "abc" } }, initialState(), { models, roleCall, researchCall: roleCall }, 1);
  const g = evs.find(e => e.event.type === "grade_received")!.event as { attemptId: string; grade: { score0to100: number; dimensionsObserved: string[] } };
  expect(n).toBe(2);
  expect(g.attemptId).toBe("a9");
  expect(g.grade.score0to100).toBe(100);
  expect(g.grade.dimensionsObserved).toEqual([]);
  expect(output?.name).toBe("submit_grade"); // schema-constrained output (flash broke free-form JSON)
});

test("learner source ids reach the generator as excerpts with span ids, and the planner as an outline", async () => {
  const users: string[] = [];
  const roleCall = async (i: RoleCallInput) => { users.push(i.user); return reply(i.system.startsWith("You plan") || i.user.includes("Learner goal") ? JSON.stringify({ nodes: [] }) : JSON.stringify({ items: [] })); };
  const sources = { excerpts: (ids: string[]) => ids.map(id => ({ spanId: `${id}:1`, title: "Lecture 3", locator: "p4", text: "The Krebs cycle runs in the mitochondrial matrix." })), outline: (ids: string[]) => ids.length ? "Lecture 3 (pdf): Krebs cycle" : "" };
  await runRole({ kind: "call_role", role: "generator", purpose: "node", input: { node: { id: "n1", title: "Respiration", subskills: [] }, sources: { learner: ["src_a"], research: [] } } }, initialState(), { models, roleCall, researchCall: roleCall, sources }, 1);
  expect(users[0]).toContain("src_a:1"); expect(users[0]).toContain("mitochondrial matrix");
  const s = { ...initialState(), goal: { objective: "Pass bio", mode: "cram", pace: "normal", sourceIds: ["src_a"], preview: {} } } as never;
  await runRole({ kind: "call_role", role: "planner", purpose: "plan", input: {} }, s, { models, roleCall, researchCall: roleCall, sources }, 2).catch(() => []);
  expect(users.some(u => u.includes("Outline of the learner's sources") && u.includes("Krebs cycle"))).toBe(true);
});

test("diagnostic, top-up and replacement generation get the same excerpts as the node bank", async () => {
  const users: string[] = [], queries: string[] = [];
  const roleCall = async (i: RoleCallInput) => { users.push(i.user); return reply(JSON.stringify({ items: [] })); };
  const sources = { excerpts: (ids: string[], q: string) => { queries.push(q); return ids.map(id => ({ spanId: `${id}:7`, title: "Lecture 3", locator: "L1–40", text: "Glycolysis happens in the cytoplasm." })); }, outline: () => "" };
  const plan = { nodes: [{ id: "n1", title: "Respiration", subskills: [{ id: "s1", statement: "Locate glycolysis" }] }] };
  const s = { ...initialState(), plan, goal: { objective: "Pass bio", mode: "cram", pace: "normal", preview: {} } } as never;
  const src = { learner: ["src_b"], research: [] }, deps = { models, roleCall, researchCall: roleCall, sources };
  for (const [purpose, input] of [["diagnostic", { plan, sources: src }], ["topup", { nodeId: "n1", partition: "assessment", count: 2, sources: src }], ["replace", { nodeId: "n1", partition: "practice", count: 1, sources: src }]] as const) {
    users.length = 0;
    await runRole({ kind: "call_role", role: "generator", purpose, input }, s, deps, 3);
    expect(users[0]).toContain("src_b:7"); expect(users[0]).toContain("Glycolysis happens in the cytoplasm");
  }
  expect(queries.every(q => q.includes("Respiration") && q.includes("Locate glycolysis"))).toBe(true);
});
