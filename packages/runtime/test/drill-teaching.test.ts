import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { modePath } from "./mode-path-fixture.ts";
import * as drills from "../src/drill.ts";

const scores = [{ dimension: "solve", score: 85, evidence: "scaled" }, { dimension: "reason", score: 0, evidence: "could not justify" }];

test("drill gap teaching: opt-in persists, pauses for explanation and native Continue releases a fresh recheck without changing marks", async () => {
  await modePath(async f => {
    await f.command("drill", "");
    const first = f.task("Explain the invariant");
    await f.work(first.revision_id, "I scaled but could not justify", scores);
    const round = f.service.store.revisions("drill_round").at(-1)!;
    const before = f.service.store.throughSeq, goal = f.service.store.lessonGoal("modes")!;
    const original = JSON.stringify(f.service.store.events().filter(e => e.kind === "assessment"));
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: false, ready: false } });
    await f.command("drill", "teach-gaps on");
    expect(f.service.store.lessonGoal("modes")!.revision_id).toBe(goal.revision_id);
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: true, ready: true, assessment_event_ids: [expect.any(String)] } });
    expect((await f.context()).next_task_selection).toBeNull();
    expect(drills.diagnoseDrill(f.service.store, round.revision_id, "modes", before).gap_teaching).toMatchObject({ enabled: false, ready: false });
    await f.reopen();
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: true, ready: true } });
    const repair = f.task("Explain why the same invariant holds on fresh quantities");
    await f.command("continue", "");
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: true, ready: false } });
    expect((await f.context()).next_task_selection).toMatchObject({ definition_revision_id: repair.revision_id });
    expect(JSON.stringify(f.service.store.events().filter(e => e.kind === "assessment"))).toBe(original);
    expect(f.notices.join("\n")).toContain("Teach gaps: on");
    await f.command("drill", "teach-gaps off");
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: false, ready: false } });
  });
});

test("drill gap teaching: pending work and stale state cannot change the native switch", async () => {
  await modePath(async f => {
    await f.command("drill", "");
    const task = f.task("Solve and explain");
    const state = (await f.context()).learning_state as { state_revision: string };
    const goal = f.service.store.lessonGoal("modes")!;
    await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } });
    const before = f.service.store.throughSeq;
    await f.command("drill", "teach-gaps on");
    expect(f.service.store.throughSeq).toBe(before);
    expect(f.notices.join("\n")).toContain("between fully assessed rounds");
    const change = Reflect.get(drills, "setDrillGapTeaching"); expect(typeof change).toBe("function");
    expect(() => change(f.service.store, "modes", true, "stale")).toThrow("Stale");
    expect(f.service.store.throughSeq).toBe(before);
  });
});

test("drill gap teaching: unobserved components alone are not diagnosed deficits", async () => {
  await modePath(async f => {
    await f.command("drill", ""); const task = f.task("An unobserved explanation");
    await f.work(task.revision_id, "A response", [{ dimension: "solve", score: 85, evidence: "response" }, { dimension: "reason", score: 15, evidence: "response" }], false, "success", [], []);
    await f.command("drill", "teach-gaps on");
    expect((await f.context()).drill_progress).toMatchObject({ gap_teaching: { enabled: true, ready: false, assessment_event_ids: [] } });
  });
});

test("drill gap teaching: model and foreign-conversation decisions cannot enable teaching", async () => {
  await modePath(async f => {
    await f.command("drill", ""); const task = f.task("Explain the missing reason");
    await f.work(task.revision_id, "I scaled but could not justify", scores);
    const goal = f.service.store.lessonGoal("modes")!;
    for (const [actor, owner] of [["pi", "modes"], ["learner", "foreign"]] as const) f.service.store.append("decision", { action: "drill_gap_teaching_changed", enabled: true, goal_revision_id: goal.revision_id }, randomUUID(), actor, owner);
    // Deliberately malformed foreign history remains subject to disclosure quarantine.
    expect(drills.drillGapTeachingEnabled(f.service.store, "modes")).toBe(false);
  });
});
