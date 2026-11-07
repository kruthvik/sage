import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { replay, sessionState } from "../../engine/src/index.ts";
import { runSession, answerFor } from "../../eval/src/fixture.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "sage-ledger-")); dirs.push(d); return join(d, "sage.sqlite"); };

test("records are immutable and op IDs are idempotent (v3 semantics)", async () => {
  const l = new Ledger(await temp());
  const a = l.append("v4.tick", { type: "tick" }, "op1", "host", "s");
  expect(l.append("v4.tick", { type: "tick" }, "op1", "host", "s").event_id).toBe(a.event_id);
  expect(() => l.append("v4.tick", { type: "tick", x: 1 }, "op1", "host", "s")).toThrow(/different content/);
  expect(() => l.db.exec("UPDATE event SET actor='pi'")).toThrow(/Immutable/);
  expect(() => l.db.exec("DELETE FROM event")).toThrow(/Immutable/);
  expect(() => l.append("v4.tick", { type: "tick" }, "op2", "host", "s", "2999-01-01T00:00:00.000Z")).toThrow(/Future/);
  expect(l.integrity()).toEqual(["ok"]);
  l.close();
});

test("a whole session persists to SQLite and replays to the same state after reopening", async () => {
  const file = await temp();
  const r = runSession(i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: "Because the exponent comes down and drops by one." }, quality: "good" });
  const clock = { t: r.log.at(-1)!.now };
  const l = new Ledger(file, () => clock.t);
  r.log.forEach((e, i) => l.appendEngine("s", e.event, e.actor, e.now, `op-${i}`));
  l.close();
  const reopened = new Ledger(file, () => clock.t);
  const s = replay(reopened.engineLog("s"));
  expect(sessionState(s)).toEqual(sessionState(r.state));
  expect(s.attempts).toEqual(r.state.attempts);
  expect(reopened.sessions()).toEqual(["s"]);
  reopened.close();
});

test("a newer schema is refused rather than silently opened", async () => {
  const file = await temp();
  const l = new Ledger(file); l.db.exec("PRAGMA user_version=99"); l.close();
  expect(() => new Ledger(file)).toThrow(/newer/);
});

test("call log needs an observed start before other phases", async () => {
  const l = new Ledger(":memory:");
  expect(() => l.logCall({ call_id: "c", phase: "completed" })).toThrow(/start/);
  l.logCall({ call_id: "c", phase: "started", role: "grader" }); l.logCall({ call_id: "c", phase: "completed", input_tokens: 900 });
  expect(l.calls().length).toBe(2);
});
