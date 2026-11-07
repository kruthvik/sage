import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";
import { createDrillRound, submitDrillRound, stopDrill } from "../../runtime/src/drill.ts";
import type { Revision, Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modePath } from "../../runtime/test/mode-path-fixture.ts";

test("e03s02 task 1: registered drill prioritizes supplied questions and freezes owned round evidence", async () => {
  await modePath(async f => {
    const earlier = f.task("Earlier success");
    await f.work(earlier.revision_id, "I solved and explained earlier work", [{ dimension: "solve", score: 85, evidence: "solved" }, { dimension: "reason", score: 15, evidence: "explained" }]);
    const path = join(f.service.paths.data, "owned-questions.txt");
    await writeFile(path, "Supplied test question: Explain the invariant when the representation changes. No aids except tutor refresher when requested.");
    const source = await f.service.sources.importFile(path, "practice", "owned");
    f.service.sources.accept(source.revision_id);
    const span = f.service.sources.preview(source.revision_id)[0]!;
    const previous = f.service.store.lessonGoal("modes")!;
    f.service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: previous.entity_id, parent_revision_id: previous.revision_id, expected_goal_revision_id: previous.revision_id, body: { ...previous.body, source_ids: [source.revision_id], allowed_aids: ["tutor refresher"], drill: { prioritized_source_span_ids: [span.span_id], learner_instructions: "Correction: prioritize invariant reasoning, not arithmetic" } } }, "learner", "modes");
    const question = f.task("Explain the supplied invariant", { source_span_ids: [span.span_id], allowed_aids: ["tutor refresher"], refresher: "Compare what stays constant", drill_source_kind: "supplied_test_question" } as Partial<TaskDefinition>);
    f.task("Other question", { source_span_ids: [span.span_id], drill_source_kind: "question" } as Partial<TaskDefinition>);
    f.task("Background summary", { source_span_ids: [span.span_id], drill_source_kind: "summary" } as Partial<TaskDefinition>);
    await f.command("drill", "");
    const packet = await f.context();
    expect(packet.next_task_selection).toMatchObject({ definition_revision_id: question.revision_id, allowed_aids: ["tutor refresher"], source_priority: "supplied_test_question", source_anchors: [{ span_id: span.span_id, source_revision_id: source.revision_id, locator: span.locator }] });
    expect(JSON.stringify(packet)).toContain("Correction: prioritize invariant reasoning");
    const selection = packet.next_task_selection as { purpose: string };
    const instance = await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, body: { definition_revision_id: question.revision_id, goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, purpose: selection.purpose, conditions: [] } });
    const round = f.service.store.revisions("drill_round").at(-1)!;
    expect(round.body.task_instance_ids).toEqual([instance.revision_id]);
    expect((await f.context()).drill_progress).toMatchObject({ items_evaluated: 0, items_submitted: 0, evidenced_components: [] });
    expect(f.notices.some(n => n.includes("Compare what stays constant"))).toBe(false);
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "assistance", expected_goal_revision_id: f.service.store.lessonGoal("modes")!.revision_id, payload: { assistance_id: randomUUID(), instance_revision_id: instance.revision_id, component_revision_ids: question.component_revision_ids, kind: "hint", content: "Unrequested solution", answer_bearing: true, stage: "requested" } })).rejects.toThrow("trusted learner request");
    await f.command("refresh", "");
    expect(f.service.store.events().filter(e => e.kind === "assistance" && e.payload.instance_revision_id === instance.revision_id).map(e => e.payload.stage)).toEqual(["requested", "exposed"]);
    await f.work(question.revision_id, "The same ratio stays constant", [{ dimension: "solve", score: 85, evidence: "ratio" }, { dimension: "reason", score: 0, evidence: "same ratio" }]);
    expect((await f.context()).drill_progress).toMatchObject({ items_evaluated: 1, items_submitted: 1, evidenced_components: [] });
    expect(f.notices.join("\n")).toContain("15");
  });
});

test("e03s02 task 3: trusted stop reopen and explicit resume preserve pending work without replay credit", async () => {
  await modePath(async f => {
    await f.command("drill", "");
    const first = f.task("Explain original ratio", { steps: ["State", "Explain"] });
    await f.work(first.revision_id, "Both quantities scale together", [{ dimension: "solve", score: 85, evidence: "scale" }, { dimension: "reason", score: 15, evidence: "together" }]);
    const second = f.task("Defend a graph interpretation", { representation: "graphical", steps: ["Read graph", "Defend interpretation"], variation: { baseline_definition_revision_id: first.revision_id, dimensions: ["representation"], invariant: "ratio", rationale: "New representation demand" } });
    const goal = f.service.store.lessonGoal("modes")!;
    const operation = { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: second.revision_id, goal_revision_id: goal.revision_id, purpose: "application", conditions: [] } };
    const instance = await f.tool("learning_define", operation);
    const roundIds = f.service.store.revisions("drill_round").map(r => r.revision_id);
    expect(roundIds).toHaveLength(2);
    const original = f.service.store.events().find(e => e.kind === "attempt_submitted")!;
    const seq = f.service.store.throughSeq;
    await f.tool("learning_define", operation);
    expect(f.service.store.throughSeq).toBe(seq);
    await f.command("stop", "");
    expect((await f.context()).drill_progress).toMatchObject({ items_evaluated: 0, items_submitted: 0 });
    expect(f.notices.join("\n")).toContain("0 assessed");
    await f.reopen();
    expect((await f.context()).learning_state).toMatchObject({ phase: "stopped", pending_count: 1, current_task: { instance_revision_id: instance.revision_id } });
    const stopped = f.service.store.throughSeq;
    await expect(f.tool("learning_define", { operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, mode: "learn" } })).rejects.toThrow("trusted learner controls");
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "checkpoint", expected_goal_revision_id: goal.revision_id, payload: { goal_revision_id: goal.revision_id, summary: "Forged resume", next_action: "continue", gaps: [], stopped: false } })).rejects.toThrow("trusted native learner controls");
    await expect(f.work(second.revision_id, "Late graph answer", [{ dimension: "solve", score: 85, evidence: "graph" }])).rejects.toThrow();
    expect(f.notices.join("\n")).toContain("Drill is stopped");
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: original.payload })).rejects.toThrow();
    expect(f.service.store.throughSeq).toBe(stopped);
    await f.command("continue", "");
    expect((await f.context()).learning_state).toMatchObject({ phase: "awaiting_answer", pending_count: 1, current_task: { instance_revision_id: instance.revision_id } });
    const resumed = f.service.store.throughSeq;
    await f.command("continue", "");
    expect(f.service.store.throughSeq).toBe(resumed);
    await f.work(second.revision_id, "Graph preserves the same ratio", [{ dimension: "solve", score: 85, evidence: "ratio" }, { dimension: "reason", score: 15, evidence: "preserves" }]);
    expect((await f.context()).drill_progress).toMatchObject({ items_evaluated: 1, items_submitted: 1 });
    const latest = f.service.store.events().filter(e => e.kind === "attempt_submitted").at(-1)!;
    const assessed = f.service.store.events().filter(e => e.kind === "assessment").length;
    await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: latest.payload })).rejects.toThrow();
    await expect(f.service.operation("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: latest.payload }, "foreign")).rejects.toThrow();
    expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(assessed);
    expect(f.service.store.revisions("drill_round").map(r => r.revision_id)).toEqual(roundIds);
  });
});

test("e03s02 review P1: native resume assesses only the exact saved pending attempt", async () => {
  for (const boundary of ["pending", "goal_changed", "skipped", "overridden", "new_work"] as const) {
    await modePath(async f => {
      await f.command("drill", "");
      const task = f.task("Explain the saved invariant");
      const goal = f.service.store.lessonGoal("modes")!;
      const instance = await f.tool("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } });
      await f.input("Both quantities scale together");
      const response = f.service.store.events().filter(e => e.kind === "learner_response" && e.payload.instance_revision_id === instance.revision_id).at(-1)!;
      const attemptId = randomUUID();
      const attempt = await f.tool("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attemptId, instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] } });
      const payload = { attempt_id: attemptId, rubric_revision_id: task.rubric_revision_id, outcome: "success", scores: [{ dimension: "solve", score: 85, evidence: "scale" }, { dimension: "reason", score: 15, evidence: "together" }], feedback: "Saved actual reasoning assessed against the original criteria", uncertainty: "Uncalibrated fixture", feedback_review: { issues: [], ready_to_continue: true } };
      await f.command("stop", "");
      await f.reopen();
      expect((await f.context()).learning_state).toMatchObject({ phase: "stopped", resume_phase: "assessment_pending", pending_count: 1, current_task: { instance_revision_id: instance.revision_id, attempt_id: attemptId } });
      const stopped = f.service.store.throughSeq;
      await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload })).rejects.toThrow("stopped");
      await f.input("A late replacement answer");
      expect(f.service.store.throughSeq).toBe(stopped);
      if (boundary === "goal_changed") await f.command("mode", "drill");
      await f.command("continue", "");
      expect((await f.context()).learning_state).toMatchObject({ phase: "assessment_pending", pending_count: 1, current_task: { instance_revision_id: instance.revision_id, attempt_id: attemptId } });
      if (boundary === "skipped") {
        const state = (await f.context()).learning_state as { state_revision: string };
        f.service.skipTask({ operation_id: randomUUID(), expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision, instance_revision_id: instance.revision_id }, "modes");
      }
      if (boundary === "overridden") f.service.store.append("decision", { action: "response_review_override", goal_revision_id: goal.revision_id, lesson_goal_entity_id: goal.entity_id, reason: "Trusted synthetic learner override", evidence_event_ids: [attempt.event_id], user_override: true }, randomUUID(), "learner", "modes");
      if (boundary === "new_work") await f.input("New work must not be borrowed by the saved attempt");
      const currentGoalId = f.service.store.lessonGoal("modes")!.revision_id;
      const assessment = { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: currentGoalId, payload };
      const before = f.service.store.throughSeq;
      await expect(f.service.operation("learning_record", assessment, "foreign")).rejects.toThrow();
      await expect(f.tool("learning_record", { operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: currentGoalId, payload: { attempt_id: randomUUID(), instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] } })).rejects.toThrow();
      if (boundary !== "pending") {
        await expect(f.tool("learning_record", assessment)).rejects.toThrow();
        expect(f.service.store.throughSeq).toBe(before);
        expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(0);
        return;
      }
      await f.tool("learning_record", assessment);
      expect((await f.context()).drill_progress).toMatchObject({ items_submitted: 1, items_evaluated: 1 });
      expect(f.service.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(1);
      expect(f.service.store.events().find(e => e.kind === "assessment")!.payload.scores).toEqual(payload.scores);
      expect(f.notices.join("\n")).toContain("Marks: 100/100");
      const completed = f.service.store.throughSeq;
      await f.tool("learning_record", assessment);
      expect(f.service.store.throughSeq).toBe(completed);
      await f.command("stop", ""); await f.command("continue", "");
      await expect(f.tool("learning_record", { ...assessment, operation_id: randomUUID() })).rejects.toThrow();
      expect(f.service.store.events().filter(e => e.kind === "assessment")).toHaveLength(1);
    });
  }
});

const fixtures: ReturnType<typeof learningFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.store.close(); });

test("drill rounds continue across successive submissions until explicit stop", () => {
  const f = learningFixture();
  fixtures.push(f);

  const goal = f.store.define({
    operation_id: randomUUID(),
    kind: "goal",
    entity_id: f.goal.entity_id,
    parent_revision_id: f.goal.revision_id,
    expected_goal_revision_id: f.goal.revision_id,
    body: {
      ...f.goal.body,
      mode: "drill",
      objective: "Master algebraic substitutions",
    },
  }, "learner", "test") as unknown as Revision<Goal>;

  // Round 1
  const t1 = f.task("Round 1 task", { scoring: "numeric", answer: "3" });
  const i1 = f.deliver(t1, "exam");
  const round1 = createDrillRound(f.store, goal.revision_id, {
    ordinal: 1,
    task_instance_ids: [i1.revision_id],
    source_anchor_span_ids: [],
    format: "solve",
    conditions: [],
    difficulty_target: "similar",
  }, "test");

  submitDrillRound(f.store, round1.revision_id, [{ instance_id: i1.revision_id, text: "3" }], "test");
  f.assess(f.store.events().find(e => e.kind === "attempt_submitted")!.payload.attempt_id as string, t1, "3", "success");

  // Round 2 - harder conceptual variation
  const t2 = f.task("Round 2 harder composite task", { scoring: "numeric", answer: "9" });
  const i2 = f.deliver(t2, "exam");
  const round2 = createDrillRound(f.store, goal.revision_id, {
    ordinal: 2,
    task_instance_ids: [i2.revision_id],
    source_anchor_span_ids: [],
    format: "solve",
    conditions: [],
    prior_round_revision_id: round1.revision_id,
    difficulty_target: "harder",
    learner_instructions: "Increase reasoning depth",
  }, "test");

  expect(round2.body.ordinal).toBe(2);
  expect(round2.body.prior_round_revision_id).toBe(round1.revision_id);
  expect(round2.body.difficulty_target).toBe("harder");

  // Learner decides to stop
  const stop = stopDrill(f.store, round2.revision_id, "test");
  expect(stop.payload.stopped).toBe(true);
});
