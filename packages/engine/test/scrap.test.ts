// scrap_work photo intake (SPEC §7): per-message consent, model-proposed transcription, learner-confirmed response.
import { expect, test } from "bun:test";
import { reduce, type EngineState } from "../src/index.ts";
import { runSession } from "../../eval/src/fixture.ts";

const H = "a".repeat(64);
function atItem(): EngineState {
  let s: EngineState | undefined;
  runSession(i => ({ input: { kind: "text", text: "x" }, quality: i.key?.kind === "numeric" ? undefined : "good" }), { maxSteps: 400, onStep: st => { if (!s && st.current && !st.pendingAttemptId && !st.feedbackAttemptId) s = st; } });
  return s!;
}

test("consent → transcriber call → review → the learner's confirmed text becomes the attempt", () => {
  const now = "2026-11-08T10:00:00.000Z";
  let s = atItem();
  const c = reduce(s, { type: "image_consented", blobHashes: [H], provider: "antigravity", model: "gemini-3.8-flash" }, now, "learner");
  expect(c.effects).toContainEqual(expect.objectContaining({ kind: "call_role", role: "transcriber" }));
  expect(c.state.timeline.at(-1)!.kind).toBe("consent");
  expect(() => reduce(c.state, { type: "transcription_confirmed", text: "x = 2", responseEventId: "r", latencyMs: 1 }, now, "learner")).toThrow(); // not proposed yet
  expect(() => reduce(c.state, { type: "transcription_proposed", text: "x = 2" }, now, "learner")).toThrow(); // only the role proposes
  const p = reduce(c.state, { type: "transcription_proposed", text: "x = 3" }, now, "role");
  expect(p.effects).toContainEqual({ kind: "transcription_review", itemId: s.current!.itemId, text: "x = 3" });
  expect(() => reduce(p.state, { type: "transcription_confirmed", text: "x = 2", responseEventId: "r", latencyMs: 1 }, now, "role")).toThrow(); // a model can't confirm
  s = reduce(p.state, { type: "transcription_confirmed", text: "x = 2", responseEventId: "r", latencyMs: 1 }, now, "learner").state;
  expect(s.attempts.at(-1)).toMatchObject({ response: "x = 2", fromImages: [H] });
  expect(s.scrap).toBeUndefined();
});

test("consent needs 1–4 stored image hashes", () => {
  const s = atItem(), now = "2026-11-08T10:00:00.000Z";
  expect(() => reduce(s, { type: "image_consented", blobHashes: [], provider: "p", model: "m" }, now, "learner")).toThrow();
  expect(() => reduce(s, { type: "image_consented", blobHashes: ["../etc"], provider: "p", model: "m" }, now, "learner")).toThrow();
});
