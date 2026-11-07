import { expect, test } from "bun:test";
import { CHECKER_SYSTEM, compareKey, evalArithmetic, parseKeyDispute } from "../src/keycheck.ts";
import { runRole, type RoleModels } from "../src/host.ts";
import { initialState } from "../../engine/src/state.ts";
import type { Item } from "../../core/src/types.ts";
import { goal } from "../../eval/src/fixture.ts";
import type { RoleCallInput, RoleCallResult } from "../../pi-adapter/src/runtime.ts";

const item = (key: Item["key"], extra: Partial<Item> = {}): Item => ({ id: "i", nodeId: "n1", subskillIds: ["s1"], activityType: "apply_problem", difficulty: 2, partition: "practice", familyId: "f", evidences: ["execution"], stem: "Compute it please.", key, ...extra });

test("arithmetic is evaluated in code, safely", () => {
  expect(evalArithmetic("24*2^2 - 10*2 + 6")).toBe(82);
  expect(evalArithmetic("-(2/3)*8^(-5/3)")).toBeCloseTo(-1 / 48, 12);
  expect(evalArithmetic("sqrt(16)*3/2")).toBe(6);
  expect(evalArithmetic("2 ** 3 × 2")).toBe(16);
  for (const bad of ["process.exit()", "1+", "x*2", "(1", "2)(3"]) expect(evalArithmetic(bad)).toBeUndefined();
});

test("the solver's expression beats its own number; disagreement and ambiguity are flagged", () => {
  const k = item({ kind: "numeric", value: 5, tolerance: 0.001 });
  expect(compareKey(k, { answer: 5.0004 }).verdict).toBe("agree");
  expect(compareKey(k, { answer: 5, expression: "0" }).verdict).toBe("disagree"); // the eval's wrong key: code says 0
  expect(compareKey(k, { answer: null, note: "two answers" }).verdict).toBe("disagree");
  expect(compareKey(k, undefined).verdict).toBe("unknown");
  expect(compareKey(item({ kind: "choice", index: 1 }, { choices: ["a", "b"] }), { answer: 1 }).verdict).toBe("agree");
  expect(compareKey(item({ kind: "exact", values: ["Mitochondria"] }), { answer: "mitochondria." }).verdict).toBe("agree");
});

test("a wrong key is regenerated once; a replacement that still disagrees is dropped", async () => {
  const M = { provider: "p", model: "m" };
  const models: RoleModels = { planner: M, tutor: M, grader: M, generator: M, feynman: M, summarizer: M, researcher: M, checker: M };
  const reply = (text: string): RoleCallResult => ({ text, stopReason: "stop", provider: "p", model: "m", ms: 1, usage: { input: 1, output: 1, costUsd: "unknown" } });
  const q = (id: string, value: number, stem: string) => ({ id, subskillIds: ["s1"], activityType: "apply_problem", partition: "practice", familyId: id, evidences: ["execution"], stem, key: { kind: "numeric", value, tolerance: 0 } });
  let gens = 0;
  const roleCall = async (i: RoleCallInput) => {
    if (i.system === CHECKER_SYSTEM) {
      const items = JSON.parse(i.user.split("<<<\n")[1]!.split("\n>>>")[0]!) as { id: string; stem: string }[];
      expect(i.user).not.toContain("value"); // blind: the checker never sees the key
      return reply(JSON.stringify({ answers: items.map(x => ({ id: x.id, answer: Number(x.stem.match(/= (\d+)/)![1]), expression: null })) }));
    }
    gens++;
    if (i.user.includes("Replace")) return reply(JSON.stringify({ items: [q("r1", 9, "Item whose answer = 7 really.")] }));
    return reply(JSON.stringify({ items: [q("good", 4, "Item whose answer = 4 really."), q("bad", 5, "Item whose answer = 0 really.")] }));
  };
  const evs = await runRole({ kind: "call_role", role: "generator", purpose: "topup", input: { nodeId: "n1", count: 2 } }, { ...initialState(), goal: goal() }, { models, roleCall, researchCall: roleCall }, 3);
  const bank = evs.find(e => e.event.type === "bank_generated")!.event as { items: Item[] };
  expect(bank.items.map(i => i.id)).toEqual(["g3.good"]);
  expect(gens).toBe(2);
});

test("key dispute replies become corrected keys of the same kind", () => {
  const n = item({ kind: "numeric", value: 5, tolerance: 0.01 });
  expect(parseKeyDispute(JSON.stringify({ keyWrong: true, correctAnswer: 1, expression: "0", reason: "x=0 is the only real root" }), n)).toEqual({ keyWrong: true, reason: "x=0 is the only real root", correctedKey: { kind: "numeric", value: 0, tolerance: 0.01 } });
  expect(parseKeyDispute(JSON.stringify({ keyWrong: false, reason: "the key is right" }), n)).toEqual({ keyWrong: false, reason: "the key is right" });
  expect(parseKeyDispute(JSON.stringify({ keyWrong: true, correctAnswer: 7, reason: "r" }), item({ kind: "choice", index: 0 }, { choices: ["a", "b"] })).correctedKey).toBeUndefined();
  expect(() => parseKeyDispute("{}", n)).toThrow();
});
