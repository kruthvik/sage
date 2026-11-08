import { expect, test } from "bun:test";
import { CALIBRATION_SET, GENERATED, calibrate } from "../calibration/set.ts";
import { CALIBRATION } from "../../engine/src/pedagogy.config.ts";

test("set shape: 10 owner anchors + ≥20 triples over ≥6 domains, each with a wrong-reason and a precision-only case", () => {
  expect(CALIBRATION_SET.every(t => t.author === "owner")).toBe(true); // owner reviewed C01–C20 on 2026-11-08
  expect(GENERATED.length).toBeGreaterThanOrEqual(20);
  const domains = new Map<string, Set<string>>();
  for (const t of GENERATED) { const k = ["music", "chess"].includes(t.domain) ? "practical" : ["stats", "economics", "personal_finance"].includes(t.domain) ? "econ_stats" : t.domain; domains.set(k, new Set([...(domains.get(k) ?? []), ...t.tags])); }
  expect(domains.size).toBeGreaterThanOrEqual(6);
  for (const [d, tags] of domains) { expect(tags.has("right_answer_wrong_reason"), d).toBe(true); expect(tags.has("precision_only"), d).toBe(true); }
});

test("every flaw quote is verbatim from its response (the grader is held to the same rule)", () => {
  for (const t of CALIBRATION_SET) for (const f of t.flaws) expect(t.response.includes(f.quote), `${t.id}: ${f.quote}`).toBe(true);
});

test("limits come from config", () => {
  expect(CALIBRATION.maxMeanSignedError).toBe(3);
  expect(CALIBRATION.maxMae).toBe(8);
});

test("calibrate: a perfect grader passes; a consistently lenient one fails on mean signed error even with small MAE", () => {
  const exact = Object.fromEntries(CALIBRATION_SET.map(t => [t.id, t.target]));
  expect(calibrate(exact).passed).toBe(true);
  const lenient = Object.fromEntries(CALIBRATION_SET.map(t => [t.id, Math.min(100, t.target + 5)]));
  const r = calibrate(lenient);
  expect(r.mae).toBeLessThanOrEqual(8);
  expect(r.meanSigned).toBeGreaterThan(3);
  expect(r.passed).toBe(false);
  expect(calibrate({ ...exact, A5: 96 }).lenientViolations).toEqual(["A5"]); // a 75 answer scored ≥95 (F1)
  expect(calibrate({ A1: 94 }).passed).toBe(false); // partial coverage never passes
});
