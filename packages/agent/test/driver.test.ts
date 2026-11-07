import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDriver, type ServerEvent } from "../src/driver.ts";
import { DEFAULT_ROLE_MODELS } from "../src/host.ts";
import { Ledger } from "../../storage/src/ledger.ts";
import { fakeRuntime } from "../../eval/src/fake-runtime.ts";
import { goal } from "../../eval/src/fixture.ts";
import type { PublicItem } from "../../engine/src/state.ts";
import type { Item, ResponseInput } from "../../core/src/types.ts";

const correct = (i: Item): ResponseInput => i.key?.kind === "choice" ? { kind: "choice", index: i.key.index } : { kind: "text", text: i.key?.kind === "exact" ? i.key.values[0]! : i.key?.kind === "numeric" ? String(i.key.value) : "a full answer" };

test("a whole Cram session runs through driver → host → tutor tools → ledger, and replays to the same state", async () => {
  const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "sage-")), "s.sqlite"));
  const events: ServerEvent[] = [];
  let t = Date.parse("2026-11-07T09:00:00Z");
  const now = () => new Date(t += 30_000).toISOString();
  const d = SessionDriver.create(goal({ objective: "Learn three terms", timeBudgetMin: 30 }), "s1", ledger, fakeRuntime({ nodes: 2 }), DEFAULT_ROLE_MODELS, e => events.push(e), now);
  await d.drain();
  expect(d.state.phase).toBe("plan_review");
  await d.learner({ type: "plan_approved" });
  for (let step = 0; step < 200 && d.state.phase !== "ended"; step++) {
    const last = events.at(-1);
    if (d.state.feedbackAttemptId) { await d.learner({ type: "feedback_acked", attemptId: d.state.feedbackAttemptId }); continue; }
    if (d.state.current) {
      const item = d.state.items.get(d.state.current.itemId)!;
      await d.learner({ type: "response_submitted", input: correct(item), responseEventId: `r${step}`, latencyMs: 20_000 }); continue;
    }
    if (d.state.phase === "close") { await d.learner({ type: "control", action: "advance" }); continue; }
    throw new Error(`stuck in ${d.state.phase}; last event ${JSON.stringify(last).slice(0, 300)}`);
  }
  expect(d.state.phase).toBe("ended");
  expect(d.state.plan!.nodes.every(n => n.status === "passed")).toBe(true);
  expect(events.some(e => e.event === "item.present" && !("key" in ((e.data as { item: PublicItem }).item)))).toBe(true);
  expect(events.filter(e => e.event === "error")).toEqual([]);
  const resumed = SessionDriver.resume("s1", ledger, fakeRuntime(), DEFAULT_ROLE_MODELS, () => {});
  expect(resumed.state.phase).toBe("ended");
  expect(resumed.state.attempts.length).toBe(d.state.attempts.length);
  expect(ledger.calls().filter(c => c.phase === "completed").length).toBe(d.state.spend.calls);
});

test("the driver refuses non-learner events from the client (F10)", async () => {
  const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "sage-")), "s.sqlite"));
  const d = SessionDriver.create(goal(), "s2", ledger, fakeRuntime(), DEFAULT_ROLE_MODELS, () => {});
  await d.drain();
  await expect(d.learner({ type: "grade_received", attemptId: "a1", grade: {} as never })).rejects.toThrow(/not a learner action/);
});

test("a role call that fails twice is parked; session.retry re-runs it and the session moves on", async () => {
  const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "sage-")), "s.sqlite"));
  const base = fakeRuntime(); let fails = 2;
  const rt = { ...base, roleCall: async (i: Parameters<typeof base.roleCall>[0]) => { if (fails-- > 0) throw new Error("provider timeout"); return base.roleCall(i); } };
  const events: ServerEvent[] = [];
  const d = SessionDriver.create(goal(), "s3", ledger, rt, DEFAULT_ROLE_MODELS, e => events.push(e));
  await d.drain();
  expect(d.state.phase).toBe("intake");
  expect(events.find(e => e.event === "error" && (e.data as { role?: string }).role === "planner")?.data).toMatchObject({ code: "role_failed", retry: true });
  expect(await d.retry()).toBe(true);
  expect(d.state.phase).toBe("plan_review");
  expect(await d.retry()).toBe(false);
});

test("regression: drain() on an empty queue doesn't leave a stale promise that swallows later effects", async () => {
  const ledger = new Ledger(join(await mkdtemp(join(tmpdir(), "sage-")), "s.sqlite"));
  const d = SessionDriver.create(goal(), "s4", ledger, fakeRuntime(), DEFAULT_ROLE_MODELS, () => {});
  await d.idle();
  expect((d as unknown as { queue: unknown[] }).queue).toHaveLength(0);
  await d.drain(); // empty queue: what a background research completion does
  await d.learner({ type: "plan_approved" });
  expect(d.state.phase).not.toBe("bank"); // the generator call ran
  expect(d.state.items.size).toBeGreaterThan(0);
});
