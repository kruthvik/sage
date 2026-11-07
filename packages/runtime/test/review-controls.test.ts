import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { createTutorExtension } from "../../pi/src/tutor.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { reviewQueue } from "../src/reviews.ts";
import { compileContext } from "../src/context.ts";
import { evaluateLearning } from "../src/evaluation.ts";
import { LearningStore } from "../../storage/src/store.ts";
import type { TaskDefinition } from "../../core/src/contracts.ts";

const fixtures: Array<{ root: string; service: LearningService }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { f.service.close(); await rm(f.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-review-controls-")); const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); fixtures.push({ root, service }); let at = "2026-10-01T12:00:00.000Z";
  Object.defineProperty(service.store, "now", { value: () => at });
  const goal = service.ensureLessonGoal("test", "Write a short program");
  const component = service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: goal.revision_id, body: { title: "Variables", behavior: "Use a variable", subject: "practical", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Sparse evidence", target_dimensions: ["execution"], knowledge_kind: "procedural" } }, "human", "test");
  service.activateSession("test"); return { root, service, goal, component, time: (value: string) => { at = value; } };
}
function accept(f: Awaited<ReturnType<typeof fixture>>) { return f.service.reviewControl("accept", { component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z" }, "test"); }

function contents(store: LearningStore) {
  const tables = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  expect(tables).toHaveLength(7);
  return {
    event: store.db.query("SELECT * FROM event ORDER BY seq").all(),
    object_revision: store.db.query("SELECT * FROM object_revision ORDER BY rowid").all(),
    projection: store.db.query("SELECT * FROM projection ORDER BY rowid").all(),
    blob_manifest: store.db.query("SELECT * FROM blob_manifest ORDER BY rowid").all(),
    source_span: store.db.query("SELECT * FROM source_span ORDER BY rowid").all(),
    model_call_log: store.db.query("SELECT * FROM model_call_log ORDER BY seq").all(),
    job: store.db.query("SELECT * FROM job ORDER BY rowid").all(),
  };
}
function retention(f: Awaited<ReturnType<typeof fixture>>) {
  const store = f.service.store;
  const define = (kind: string, body: unknown) => store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: f.goal.revision_id, body }, "human", "test");
  const rubric = define("rubric", { title: "Owned review criterion", dimensions: [{ name: "target", criterion: "Use a variable", max_score: 2 }], provisional: false, source_span_ids: [] });
  const family = define("task_family", { title: "Variable use", construct: "Use a variable", variation: "Different values", lineage_revision_ids: [], component_revision_ids: [f.component.revision_id], solution_structure: "Assign and use", method_selection: "Choose a variable", representations: ["code"], structural_signature: "review-controls:variables" });
  const definition = define("task_definition", { title: "Fresh retention", prompt: "Assign and use a variable", family_revision_id: family.revision_id, component_revision_ids: [f.component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: [], format: "free_response", allowed_aids: [], steps: [], scoring: "rubric", status: "practice_ready", review: { method: "curated", reason: "Local software fixture, not calibrated learning evidence" }, stakes: "low", partition: "practice", changes: [], uncertainty: "Scoped criterion", representation: "code" });
  const instance = define("task_instance", { definition_revision_id: definition.revision_id, goal_revision_id: f.goal.revision_id, purpose: "retention", conditions: [] });
  const response = store.learnerResponse("let x = 2; print(x)", "test");
  const attempt = randomUUID();
  store.record({ operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: attempt, instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] } }, "test");
  return store.record({ operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: f.goal.revision_id, payload: { attempt_id: attempt, rubric_revision_id: (definition.body as unknown as TaskDefinition).rubric_revision_id, outcome: "success", scores: [{ dimension: "target", score: 2, evidence: "let x = 2; print(x)" }], feedback: "Compare with the criterion", uncertainty: "Local fixture" } }, "test");
}
function complete(f: Awaited<ReturnType<typeof fixture>>, scheduleId: string, assessmentId: string) {
  return f.service.store.record({ operation_id: randomUUID(), kind: "review_completed", expected_goal_revision_id: f.service.store.lessonGoal("test")!.revision_id, payload: { schedule_event_id: scheduleId, assessment_event_id: assessmentId } }, "test");
}

test("e01s03 task 2: exact accept duplicate and rejected stale foreign late controls leave all seven tables unchanged", async () => {
  const f = await fixture(); const original = accept(f); const before = contents(f.service.store);
  expect(accept(f)).toMatchObject({ duplicate: true, schedule_event_id: original.schedule_event_id });
  expect(contents(f.service.store)).toEqual(before);
  for (const action of ["cancel", "reschedule"]) {
    expect(() => f.service.reviewControl(action, { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "foreign")).toThrow();
    expect(contents(f.service.store)).toEqual(before);
  }
  expect(() => f.service.reviewControl("accept", { component_revision_id: f.component.revision_id, due_at: f.service.store.now() }, "test")).toThrow("future");
  expect(contents(f.service.store)).toEqual(before);
  f.service.store.define({ operation_id: randomUUID(), kind: "component", parent_revision_id: f.component.revision_id, expected_goal_revision_id: f.goal.revision_id, body: f.component.body }, "human", "test");
  const revised = contents(f.service.store);
  expect(() => f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "test")).toThrow("Stale");
  expect(contents(f.service.store)).toEqual(revised);
  expect(reviewQueue(f.service.store, "test")[0]?.status).toBe("pending");
});

test("e01s03 task 2: replacement linkage failure rolls back committed replacement consent authorization and projection", async () => {
  const f = await fixture(); const original = accept(f); const before = contents(f.service.store);
  const append = f.service.store.append.bind(f.service.store);
  const failing = spyOn(f.service.store, "append").mockImplementation((...args) => {
    if (args[0] === "decision" && args[1].action === "review_rescheduled") throw new Error("Injected linkage failure");
    return append(...args);
  });
  try { expect(() => f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "test")).toThrow("Injected linkage failure"); } finally { failing.mockRestore(); }
  expect(contents(f.service.store)).toEqual(before);
  const reopened = new LearningStore(join(f.service.paths.data, "learning.sqlite"), f.service.store.now);
  try { expect(contents(reopened)).toEqual(before); expect(reviewQueue(reopened, "test")[0]?.status).toBe("pending"); expect(reopened.integrity()).toEqual(["ok"]); } finally { reopened.close(); }
});

test("e01s03 task 2: owned retention completion agrees with queue context history and reopen without new marks or consent", async () => {
  const f = await fixture(); const original = accept(f); const separate = f.service.reviewControl("accept", { component_revision_id: f.component.revision_id, due_at: "2026-10-04T12:00:00.000Z" }, "test");
  f.time("2026-10-03T12:00:00.000Z"); const assessment = retention(f); const beforeSeq = f.service.store.throughSeq;
  const evidence = f.service.store.events().filter(e => ["assessment", "learner_response"].includes(e.kind));
  const receipt = complete(f, String(original.schedule_event_id), assessment.event_id);
  const queue = reviewQueue(f.service.store, "test");
  expect(queue.find(r => r.schedule_event_id === original.schedule_event_id)).toMatchObject({ status: "completed", assessment_event_id: assessment.event_id, completed_at: receipt.occurred_at });
  expect(queue.find(r => r.schedule_event_id === separate.schedule_event_id)?.status).toBe("pending");
  expect(f.service.store.events().filter(e => ["assessment", "learner_response"].includes(e.kind))).toEqual(evidence);
  expect((compileContext(f.service.store, {}, "", "test").due_reviews as unknown[])).toHaveLength(0);
  expect((compileContext(f.service.store, { through_seq: beforeSeq }, "", "test").due_reviews as Array<{ event_id: string }>).map(r => r.event_id)).toContain(String(original.schedule_event_id));
  expect(evaluateLearning(f.service.store).reviews.find(r => r.schedule_event_id === original.schedule_event_id)?.completed).toBe(true);
  const before = contents(f.service.store);
  expect(() => complete(f, String(original.schedule_event_id), assessment.event_id)).toThrow("pending");
  expect(() => f.service.reviewControl("cancel", { schedule_event_id: original.schedule_event_id }, "test")).toThrow("pending");
  expect(contents(f.service.store)).toEqual(before);
  const reopened = new LearningStore(join(f.service.paths.data, "learning.sqlite"), f.service.store.now);
  try { expect(reviewQueue(reopened, "test")).toEqual(queue); expect(evaluateLearning(reopened).reviews).toEqual(evaluateLearning(f.service.store).reviews); expect(contents(reopened)).toEqual(before); } finally { reopened.close(); }
});

test("e01s03 task 2: forged legacy completion actors and missing evidence never hide the owned due original", async () => {
  for (const actor of ["learner", "human", "host", "pi"]) {
    const f = await fixture(); const original = accept(f); f.time("2026-10-03T12:00:00.000Z"); const assessment = retention(f);
    const forged = f.service.store.append("review_completed", { schedule_event_id: original.schedule_event_id, assessment_event_id: actor === "pi" ? "unresolvable-assessment" : assessment.event_id }, randomUUID(), actor, "test");
    const before = contents(f.service.store);
    expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === original.schedule_event_id)).toMatchObject({ status: "pending", due: true });
    const context = compileContext(f.service.store, {}, "", "test");
    if (actor === "pi") expect(context.disclosure).toMatchObject({ allowed: false, reason: "legacy_provenance_unknown" });
    else expect((context.due_reviews as Array<{ event_id: string }>).map(r => r.event_id)).toContain(String(original.schedule_event_id));
    expect(evaluateLearning(f.service.store).reviews.find(r => r.schedule_event_id === original.schedule_event_id)?.completed).toBe(false);
    expect(f.service.store.event(forged.event_id)).toEqual(forged); expect(contents(f.service.store)).toEqual(before);
  }
});

test("e01s03 task 2: unresolvable legacy schedules stay explicit in queue context history and SQLite reopen", async () => {
  for (const extra of [{ authorization_event_id: "missing-authorization" }, { due_at: "corrupt-date" }, { component_revision_id: "missing-component" }, {}]) {
    const f = await fixture(); const accepted = accept(f); const schedule = f.service.store.event(String(accepted.schedule_event_id));
    const cutoff = f.service.store.throughSeq; f.time("2026-10-03T12:00:00.000Z");
    // Additive owned legacy fixture, never mutate the original schedule or SQLite guards.
    const e = f.service.store.append("review_scheduled", { ...schedule.payload, ...extra }, randomUUID(), "pi", "test");
    const before = contents(f.service.store); const queue = reviewQueue(f.service.store, "test");
    expect(queue.find(r => r.schedule_event_id === e.event_id)).toMatchObject({ status: "unresolved", unresolved_reason: expect.any(String) });
    const context = compileContext(f.service.store, {}, "", "test");
    if ("authorization_event_id" in extra || "component_revision_id" in extra) {
      expect(context.disclosure).toMatchObject({ allowed: false, reason: "legacy_provenance_unknown" });
      expect(context.omissions).toEqual([expect.stringContaining("Originals remain local")]);
    } else {
      expect((context.unresolved_reviews as Array<{ event_id: string }>).map(r => r.event_id)).toContain(e.event_id);
      expect(context.review_queue_summary).toMatchObject({ unresolved_count: 1, due_count: 1, completed_count: 0 });
    }
    expect(evaluateLearning(f.service.store).reviews.find(r => r.schedule_event_id === e.event_id)).toMatchObject({ status: "unresolved", completed: false });
    expect(reviewQueue(f.service.store, "test", f.service.store.now(), cutoff).some(r => r.schedule_event_id === e.event_id)).toBe(false);
    expect(evaluateLearning(f.service.store, cutoff).reviews.some(r => r.schedule_event_id === e.event_id)).toBe(false);
    expect(queue.find(r => r.schedule_event_id === accepted.schedule_event_id)).toMatchObject({ status: "pending", due: true, overdue: false });
    const reopened = new LearningStore(join(f.service.paths.data, "learning.sqlite"), f.service.store.now);
    try { expect(reviewQueue(reopened, "test")).toEqual(queue); expect(contents(reopened)).toEqual(before); } finally { reopened.close(); }
  }
});

test("e01s03 task 2: reschedule sequence and recorded time cutoffs agree across queue context and history", async () => {
  const f = await fixture(); const original = accept(f); const seq = f.service.store.throughSeq;
  f.time("2026-10-03T12:00:00.000Z");
  const replacement = f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "test");
  const queue = reviewQueue(f.service.store, "test", f.service.store.now(), seq);
  expect(queue).toHaveLength(1); expect(queue[0]).toMatchObject({ schedule_event_id: original.schedule_event_id, status: "pending", due: true, overdue: false });
  expect((compileContext(f.service.store, { through_seq: seq }, "", "test").due_reviews as Array<{ event_id: string }>)[0]?.event_id).toBe(String(original.schedule_event_id));
  expect(evaluateLearning(f.service.store, seq).reviews[0]?.status).toBe("pending");
  expect(reviewQueue(f.service.store, "test", "2026-10-03T11:59:59.999Z")[0]).toMatchObject({ status: "pending", due: false });
  expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === original.schedule_event_id)?.status).toBe("rescheduled");
  expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === replacement.schedule_event_id)?.status).toBe("pending");
  const before = contents(f.service.store);
  expect(() => f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-05T12:00:00.000Z" }, "test")).toThrow("pending");
  expect(contents(f.service.store)).toEqual(before);
});

test("e01s03 task 2: an unresolvable current lesson binding preserves local unresolved originals instead of an empty list", async () => {
  const f = await fixture(); const original = accept(f); const beforeBinding = f.service.store.throughSeq;
  f.time("2026-10-03T12:00:00.000Z");
  f.service.store.append("decision", { action: "lesson_bound", goal_entity_id: "unresolvable-goal-entity", reason: "Additive corrupt legacy binding fixture", evidence_event_ids: [] }, randomUUID(), "host", "test");
  const before = contents(f.service.store);
  expect(reviewQueue(f.service.store, "test")[0]).toMatchObject({ schedule_event_id: original.schedule_event_id, status: "unresolved", unresolved_reason: "Review lesson reference is unresolved" });
  expect(f.service.reviewControl("list", {}, "test")).toMatchObject({ queue: [{ schedule_event_id: original.schedule_event_id, status: "unresolved" }], proposals: [] });
  expect(reviewQueue(f.service.store, "test", f.service.store.now(), beforeBinding)[0]).toMatchObject({ status: "pending", due: true });
  expect(evaluateLearning(f.service.store).reviews[0]).toMatchObject({ schedule_event_id: original.schedule_event_id, completed: false });
  expect(() => f.service.reviewControl("cancel", { schedule_event_id: original.schedule_event_id }, "test")).toThrow("Select a lesson");
  expect(contents(f.service.store)).toEqual(before);
});

test("e01s03 task 2: forged assessment actors cannot authorize completion or retire originals", async () => {
  for (const actor of ["learner", "human", "host"]) {
    const f = await fixture(); const original = accept(f); f.time("2026-10-03T12:00:00.000Z");
    const assessment = retention(f);
    const forged = f.service.store.append("assessment", assessment.payload, randomUUID(), actor, "test");
    const before = contents(f.service.store);
    expect(() => complete(f, String(original.schedule_event_id), forged.event_id)).toThrow();
    expect(contents(f.service.store)).toEqual(before);
    f.service.store.append("review_completed", { schedule_event_id: original.schedule_event_id, assessment_event_id: forged.event_id, disclosure_scope: assessment.payload.disclosure_scope }, randomUUID(), "pi", "test");
    expect(reviewQueue(f.service.store, "test")[0]).toMatchObject({ status: "pending", due: true });
    expect(evaluateLearning(f.service.store).reviews[0]?.completed).toBe(false);
  }
});

test("e01s03 task 2: registered native reviews command uses the production bridge for exact immutable controls", async () => {
  const f = await fixture(); const server = startLearningServer(f.service);
  try {
    const bridge = createTutorBridge(f.service.paths, f.service, server);
    const commands = new Map<string, RegisteredCommand>(); const notices: string[] = [];
    // Only native registration/UI are offline; commands run the actual service bridge and SQLite.
    createTutorExtension(bridge)({ registerTool() {}, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on() {} } as unknown as ExtensionAPI);
    const ctx = { sessionManager: { getSessionId: () => "test" }, ui: { notify(text: string) { notices.push(text); } } } as unknown as ExtensionCommandContext;
    const command = (args: string) => commands.get("reviews")!.handler(args, ctx);
    await command(`accept ${f.component.revision_id} 2026-10-03T12:00:00.000Z`);
    const original = JSON.parse(notices.at(-1)!); const before = contents(f.service.store);
    await command(`accept ${f.component.revision_id} 2026-10-03T12:00:00.000Z`);
    expect(JSON.parse(notices.at(-1)!)).toMatchObject({ duplicate: true, schedule_event_id: original.schedule_event_id });
    expect(contents(f.service.store)).toEqual(before);
    await command(`reschedule ${original.schedule_event_id} 2026-10-04T12:00:00.000Z`);
    const replacement = JSON.parse(notices.at(-1)!);
    await command(`cancel ${replacement.schedule_event_id}`); await command("list");
    expect(JSON.parse(notices.at(-1)!).queue.map((r: { status: string }) => r.status).sort()).toEqual(["cancelled", "rescheduled"]);
    const settled = contents(f.service.store);
    await command(`accept ${f.component.revision_id} 2026-10-03T12:00:00.000Z`);
    expect(JSON.parse(notices.at(-1)!)).toMatchObject({ duplicate: true, scheduled: false, schedule_event_id: original.schedule_event_id });
    expect(contents(f.service.store)).toEqual(settled);
    await command(`accept ${f.component.revision_id} 2026-10-04T12:00:00.000Z`);
    expect(JSON.parse(notices.at(-1)!)).toMatchObject({ duplicate: true, scheduled: false, schedule_event_id: replacement.schedule_event_id });
    expect(contents(f.service.store)).toEqual(settled);
    await expect(command(`cancel ${original.schedule_event_id}`)).rejects.toThrow("pending");
    expect(contents(f.service.store)).toEqual(settled);
    expect(f.service.store.events().filter(e => ["assessment", "attempt_submitted"].includes(e.kind))).toHaveLength(0);
    expect(f.service.store.events().filter(e => e.kind === "learner_response").every(e => e.payload.input_kind === "control")).toBe(true);
  } finally { server.stop(); }
});

test("accepting a foreign component fails before any authorization or control response is committed", async () => {
  const f = await fixture(); const foreignGoal = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "foreign");
  const foreignComponent = f.service.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: foreignGoal.revision_id, body: f.component.body }, "human", "foreign");
  const before = f.service.store.throughSeq;
  expect(() => f.service.reviewControl("accept", { component_revision_id: foreignComponent.revision_id, due_at: "2026-10-03T12:00:00.000Z" }, "test")).toThrow("lesson"); expect(f.service.store.throughSeq).toBe(before);
});

test("failed accept rolls back its authorization and synthetic control response", async () => {
  const f = await fixture(); const before = f.service.store.throughSeq; const failing = spyOn(f.service.store, "record").mockImplementation(() => { throw new Error("Injected schedule failure"); });
  try { expect(() => accept(f)).toThrow("Injected schedule failure"); } finally { failing.mockRestore(); }
  expect(f.service.store.throughSeq).toBe(before); expect(reviewQueue(f.service.store, "test")).toHaveLength(0);
});

test("failed reschedule preserves the original pending review and writes no partial replacement", async () => {
  const f = await fixture(); const original = accept(f); const before = f.service.store.throughSeq;
  const failing = spyOn(f.service.store, "record").mockImplementation(() => { throw new Error("Injected replacement failure"); });
  try { expect(() => f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "test")).toThrow("Injected replacement failure"); } finally { failing.mockRestore(); }
  expect(f.service.store.throughSeq).toBe(before); expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === original.schedule_event_id)?.status).toBe("pending");
});

test("review-control acknowledgements are explicitly control-origin, never generated learner performance", async () => {
  const f = await fixture(); accept(f);
  const consent = f.service.store.events().find(e => e.kind === "learner_response"); expect(consent?.payload.input_kind).toBe("control");
});

test("default review offers use the ledger clock, not the machine's unrelated wall clock", async () => {
  const f = await fixture(); const scheduled = f.service.reviewControl("accept", { component_revision_id: f.component.revision_id }, "test"); expect(scheduled.due_at).toBe("2026-10-03T12:00:00.000Z");
});

test("successful reschedule links the exact replacement and keeps both immutable schedule receipts", async () => {
  const f = await fixture(); const original = accept(f);
  const replacement = f.service.reviewControl("reschedule", { schedule_event_id: original.schedule_event_id, due_at: "2026-10-04T12:00:00.000Z" }, "test");
  const decision = f.service.store.events().find(e => e.kind === "decision" && e.payload.action === "review_rescheduled"); expect(decision?.payload.replacement_schedule_event_id).toBe(replacement.schedule_event_id);
  expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === original.schedule_event_id)?.status).toBe("rescheduled");
  expect(reviewQueue(f.service.store, "test").find(r => r.schedule_event_id === replacement.schedule_event_id)?.status).toBe("pending");
  expect(f.service.store.events().filter(e => e.kind === "review_scheduled")).toHaveLength(2);
});
