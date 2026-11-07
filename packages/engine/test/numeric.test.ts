import { expect, test } from "bun:test";
import { finalNumbers, gradeDeterministic } from "../src/items.ts";
import type { Item } from "../../core/src/types.ts";

const item = (value: number, tolerance = 0): Item => ({ id: "i", nodeId: "n", subskillIds: ["s"], activityType: "apply_problem", difficulty: 2, partition: "practice", familyId: "f", evidences: ["execution"], stem: "Compute it.", key: { kind: "numeric", value, tolerance } });
const g = (v: number, text: string, tol = 0) => gradeDeterministic(item(v, tol), { kind: "text", text })!.score0to100;

test("worked answers are graded on the final value, not the first number (eval regression)", () => {
  expect(g(82, "u'(x) = 24x^2 - 10x + 6. u'(2) = 24(4) - 20 + 6 = 96 - 20 + 6 = 82")).toBe(100);
  expect(g(-0.125, "y' = -4x^(-5). At x = 2: -4/32 = -1/8 (or -0.125).", 0.001)).toBe(100);
  expect(g(0.25, String.raw`y'(4) = -\frac{12}{16} + \frac{2}{2} = -\frac{3}{4} + 1 = \frac{1}{4}`, 0.001)).toBe(100);
  expect(g(19.3333, "y'(1) = 10/3 + 16 = 58/3.", 0.01)).toBe(100);
  expect(g(-15, "V'(4) = -1 + 16 = 15, so E = -15.", 0.01)).toBe(100);
  expect(g(7, "the velocity is 7 meters per second")).toBe(100);
  expect(g(82, "82")).toBe(100);
  expect(g(1200, "1,200")).toBe(100);
});

test("intermediate values don't earn credit", () => {
  expect(g(96, "24(4) - 20 + 6 = 96 - 20 + 6 = 82")).toBe(0);
  expect(g(5, "x = 0 is a solution, so the largest value is 0.")).toBe(0);
  expect(finalNumbers("no numbers here")).toEqual([]);
});
