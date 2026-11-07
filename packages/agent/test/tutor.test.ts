import { expect, test } from "bun:test";
import { buildPacket, PACKET_MAX_CHARS } from "../src/packet.ts";
import { runTutorTurn } from "../src/tutor.ts";
import { runSession } from "../../eval/src/fixture.ts";
import { reduce, EngineError } from "../../engine/src/loop.ts";
import type { Effect, EngineEvent, EngineState } from "../../engine/src/state.ts";

// A mid-session state from the scripted fixture: some attempts, a bank, an active node.
function midSession(): EngineState {
  let snap: EngineState | undefined;
  runSession(() => ({ input: { kind: "text", text: "a wrong-ish answer" }, quality: "weak" }) as never, { maxSteps: 40, onStep: s => { if (s.attempts.length >= 3 && !snap) snap = structuredClone(s); } });
  return snap!;
}

test("packet stays under the cap, lists omissions under pressure and never contains keys or rubrics", () => {
  const s = midSession();
  const p = buildPacket(s, s.candidates, "Adapt.");
  expect(p.chars).toBeLessThanOrEqual(PACKET_MAX_CHARS);
  for (const i of s.items.values()) {
    if (i.key?.kind === "reference") expect(p.prefix + p.dynamic).not.toContain(i.key.text);
    for (const r of i.rubric ?? []) expect(p.dynamic).not.toContain(r);
  }
  const tight = buildPacket(s, s.candidates, "Adapt.", 1_500);
  expect(tight.omitted.length).toBeGreaterThan(0);
  expect(tight.dynamic).toContain("Omitted for space");
});

test("a tutor that never acts gets one retry, then the labelled deterministic fallback moves the session", async () => {
  let s = midSession();
  // put the session into a tutor phase that needs an item
  const fx: Extract<Effect, { kind: "tutor_turn" }> = { kind: "tutor_turn", phase: s.phase as never, tools: ["context", "present"], candidates: s.candidates };
  let turns = 0;
  const out = await runTutorTurn(fx, {
    model: { provider: "p", model: "m" },
    tutorTurn: async () => { turns++; return { ended: false, calls: [], text: "", usage: { input: 1, output: 1, costUsd: "unknown" }, ms: 1 }; },
    state: () => s,
    apply: (ev: EngineEvent, actor) => { try { s = reduce(s, ev, "2026-11-07T10:00:00.000Z", actor).state; return undefined; } catch (e) { if (e instanceof EngineError) return e.message; throw e; } },
  });
  expect(turns).toBe(2);
  expect(s.spend.calls).toBeGreaterThanOrEqual(2);
  if (["check", "prime", "diagnostic", "adapt"].includes(fx.phase)) expect(out.fallback).toBeDefined();
});
