import { expect, test } from "bun:test";
import { runRole, type RoleModels } from "../src/host.ts";
import { initialState } from "../../engine/src/state.ts";
import type { RoleCallInput, RoleCallResult } from "../../pi-adapter/src/runtime.ts";

const M = { provider: "p", model: "m" };
const models: RoleModels = { planner: M, tutor: M, grader: M, generator: M, feynman: M, summarizer: M, researcher: M };
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
  const roleCall = async () => reply(n++ === 0 ? "sorry" : JSON.stringify({ criteria: [{ index: 0, credit: 1, quote: "abc" }], flaws: [], feedback: "ok" }));
  const item = { id: "i", stem: "Q", rubric: ["r"], activityType: "free_recall", evidences: ["recall"] };
  const evs = await runRole({ kind: "call_role", role: "grader", purpose: "repair", input: { attemptId: "a9", item, response: "abc" } }, initialState(), { models, roleCall, researchCall: roleCall }, 1);
  const g = evs.find(e => e.event.type === "grade_received")!.event as { attemptId: string; grade: { score0to100: number; dimensionsObserved: string[] } };
  expect(n).toBe(2);
  expect(g.attemptId).toBe("a9");
  expect(g.grade.score0to100).toBe(100);
  expect(g.grade.dimensionsObserved).toEqual([]);
});
