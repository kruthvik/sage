import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import { type LearningStore } from "../../storage/src/store.ts";
import { nextActionCandidates, teachingSupport } from "../src/candidates.ts";
import { feedbackState, assertCanAdvance, presentFeedback } from "../src/feedback.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import type { Component, Goal, Revision, TaskDefinition } from "../../core/src/contracts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningService, startLearningServer } from "../src/service.ts";
import { createTutorBridge } from "../src/tutor-host.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createSagePaths } from "../src/paths.ts";
import { projectLearningState } from "../src/learning-state.ts";
import { LearningStore as PersistedStore } from "../../storage/src/store.ts";
import { createTutorExtension } from "../../pi/src/tutor.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, InputEvent, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";

test("Task3 teaching support: assisted, missing, partial, foreign and future evidence cannot compress support", () => {
  const f = fixture();
  const claims = f.component.body.target_dimensions!.map(dimension => ({ component_revision_id: f.component.revision_id, dimension, outcome: "success" as const, evidence: "choose and execute" }));
  const base = f.task("Choose a method and execute a symbolic integral");
  f.observe(base, "choose and execute", "success", "independent", { claims });
  const changed = f.task("Interpret a table of rates under changed units", { representation: "table", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Integral relation", rationale: "Changed interpretation" } });
  const instance = f.deliver(changed, "application");
  f.record("assistance", { assistance_id: randomUUID(), instance_revision_id: instance.revision_id, kind: "hint", component_revision_ids: [f.component.revision_id], answer_bearing: true, content: "Use parts", stage: "exposed" });
  const attempt = f.attempt(instance, "choose and execute");
  f.assess(attempt.id, changed, "choose and execute", "success", { claims });
  const view = f.state();
  expect(teachingSupport(view, f.component.body)).toMatchObject({ route: "paced", support: "faded" });
  expect(view.observations.at(-1)!.eligibility).toBe("supported");
  const fresh = f.task("Choose an integral relation in a different diagram context", { representation: "diagram", variation: { baseline_definition_revision_id: base.revision_id, dimensions: ["representation", "context"], invariant: "Integral relation", rationale: "Changed independent interpretation" } });
  f.observe(fresh, "choose and execute", "success", "application", { claims });
  const independent = f.state().observations.at(-1)!;
  const eligible = { ...f.state(), observations: [view.observations[0]!, independent] };
  expect(teachingSupport(eligible, f.component.body).support).toBe("light");
  for (const changedObservation of [
    { ...independent, outcome: "not_observed" as const },
    { ...independent, outcome: "partial" as const },
    { ...independent, criterion_evidence: independent.criterion_evidence.map(c => ({ ...c, observed: false, satisfied: false })) },
    { ...independent, component_revision_id: randomUUID() },
    { ...independent, assessment_event_id: randomUUID() },
    { ...independent, observed_at: "2027-01-01T00:00:00.000Z" },
  ]) expect(teachingSupport({ ...eligible, observations: [eligible.observations[0]!, changedObservation] }, f.component.body).support).not.toBe("light");
  const before = f.store.events();
  teachingSupport(eligible, f.component.body);
  expect(f.store.events()).toEqual(before);
});

test("Task3 teaching support: only explicit evidenced prerequisite blockage repairs; unknown prerequisite is not incapacity", () => {
  const f = fixture();
  const prerequisite = f.define("component", { ...f.component.body, title: "Relevant prerequisite" }) as unknown as Revision<Component>;
  const component = { ...f.component.body, prerequisite_revision_ids: [prerequisite.revision_id] };
  f.observe(f.task("A familiar target task"));
  expect(teachingSupport(f.state(), component, f.views())).toMatchObject({ route: "paced", support: "scaffold", unknown_prerequisite_revision_ids: [prerequisite.revision_id] });
  const work = f.observe(f.task("Actually sample the explicit prerequisite", { component_revision_ids: [prerequisite.revision_id] }), "wrong", "failure");
  f.hypothesis([work.assessment.event_id], [], undefined, { category: "prerequisite", prerequisite_component_revision_id: prerequisite.revision_id });
  expect(teachingSupport(f.state(), component, f.views())).toMatchObject({ route: "targeted_repair", support: "scaffold", unknown_prerequisite_revision_ids: [prerequisite.revision_id] });
  expect(teachingSupport(f.state(), f.component.body, f.views()).route).toBe("paced");
});

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(subject?: string, objective?: string) {
  const f = learningFixture(subject, objective);
  stores.push(f.store);
  return f;
}

test("Section 8 scenario 1: unfamiliar procedure where learner cannot begin offers compact worked example without false success", () => {
  const f = fixture();
  // When a learner has no prior evidence, guidance suggests orientation and worked example
  const candidates = f.candidates();
  expect(candidates.map(c => c.type)).toContain("worked_example");

  // Providing a worked example is assistance exposure, NOT learner success
  const definition = f.task("Integration by parts derivation");
  const instance = f.deliver(definition, "practice");
  f.record("assistance", {
    assistance_id: "example-1",
    instance_revision_id: instance.revision_id,
    component_revision_ids: [f.component.revision_id],
    stage: "exposed",
    kind: "example",
    content: "Set u = x, dv = e^x dx",
    answer_bearing: true,
  });

  // State reflects exposed assistance, 0 independent successes
  expect(f.state().independent_performance.success).toBe(0);
  expect(f.state().exposure_evidence.assistance_exposures).toBeGreaterThan(0);
});

test("Section 8 scenario 2: attemptable task solicits learner production before answer-bearing help", () => {
  const f = fixture();
  const definition = f.task("Solve x + 3 = 10", { scoring: "numeric", answer: "7" });
  const instance = f.deliver(definition, "independent");
  // Learner submits actual attempt
  const submission = f.attempt(instance, "7");
  const assessment = f.assess(submission.id, definition, "7", "success");
  expect(f.store.event(assessment.event_id).payload.outcome).toBe("success");
  expect(f.state().independent_performance.success).toBe(1);
});

test("Section 8 scenario 3: wrong step or weak argument requires quoted feedback and learner repair before advance", () => {
  const f = fixture();
  const current = f.store.lessonGoal("test")!;
  f.store.define({
    operation_id: randomUUID(),
    kind: "goal",
    entity_id: current.entity_id,
    parent_revision_id: current.revision_id,
    expected_goal_revision_id: current.revision_id,
    body: { ...current.body, learning_preferences: profilePreferences("balanced") },
  }, "learner", "test");

  const definition = f.task("Argue why later opening helps", { scoring: "rubric" });
  const instance = f.deliver(definition, "independent");
  const submission = f.attempt(instance, "Later opening is good because students visit more often.");

  // Record an assessment with a blocking issue quoting actual response
  const assessment = f.assess(submission.id, definition, "students visit more often", "partial", {
    feedback_review: {
      ready_to_continue: false,
      issues: [
        {
          quote: "students visit more often",
          problem: "Does not acknowledge the unmeasured grades limitation",
          suggestion: "State that academic impact is not yet measured",
          severity: "blocking",
        },
      ],
    },
  });
  presentFeedback(f.store, assessment.event_id, "test");

  const state = feedbackState(f.store, "test");
  expect(state.phase).toBe("needs_revision");
  expect(() => assertCanAdvance(f.store, "test")).toThrow("blocking");

  // Learner submits repaired response
  const repairedSubmission = f.attempt(instance, "Later opening is good because students visit more often, though academic impact is not yet measured.");
  const repairedAssessment = f.assess(repairedSubmission.id, definition, "academic impact is not yet measured", "success", {
    feedback_review: {
      ready_to_continue: true,
      issues: [],
    },
  });
  presentFeedback(f.store, repairedAssessment.event_id, "test");

  const repairedState = feedbackState(f.store, "test");
  expect(repairedState.phase).toBe("ready");
  expect(() => assertCanAdvance(f.store, "test")).not.toThrow();
});

test("Section 8 scenario 4: correct but coached work leads to fresh independent task with meaningful variation", () => {
  const f = fixture();
  const definition = f.task("Solve 2x + 1 = 9", { scoring: "numeric", answer: "4" });
  const instance = f.deliver(definition, "practice");
  // With answer-bearing help
  f.record("assistance", {
    assistance_id: "hint-1",
    instance_revision_id: instance.revision_id,
    component_revision_ids: [f.component.revision_id],
    stage: "exposed",
    kind: "hint",
    content: "Subtract 1 from both sides first",
    answer_bearing: true,
  });
  const sub = f.attempt(instance, "4");
  f.assess(sub.id, definition, "4", "success");

  // Supported success leads to fade_support or fresh independent practice
  expect(f.state().supported_performance.success).toBe(1);
  expect(f.state().independent_performance.success).toBe(0);
  expect(f.candidates().some(c => c.type === "fade_support" || c.type === "independent_practice")).toBe(true);

  // Fresh task with changed coefficients
  const freshDef = f.task("Solve 3x - 2 = 13", { scoring: "numeric", answer: "5" });
  const freshInstance = f.deliver(freshDef, "independent");
  const freshSub = f.attempt(freshInstance, "5");
  f.assess(freshSub.id, freshDef, "5", "success");
  expect(f.state().independent_performance.success).toBe(1);
});

test("Section 8 scenario 5: tight budget or explicit learner stop preserves actual evidence and creates honest checkpoint", () => {
  const f = fixture();
  f.observe(f.task("Task 1"));

  // Learner requests stop
  const candidates = nextActionCandidates({
    goal: f.goal.body,
    views: f.views(),
    components: [f.component],
    reviews: [],
    as_of_time: f.store.now(),
    stopped: true,
  });

  expect(candidates[0]!.type).toBe("checkpoint");
  expect(candidates[0]!.reason_codes).toContain("learner_stop_intent");
});

test("Section 8 scenario 6: accelerate mode prioritizes advance and transfer over redundant remediation", () => {
  const f = fixture();
  const current = f.store.lessonGoal("test")!;
  const goalRevision = f.store.define({
    operation_id: randomUUID(),
    kind: "goal",
    entity_id: current.entity_id,
    parent_revision_id: current.revision_id,
    expected_goal_revision_id: current.revision_id,
    body: {
      ...current.body,
      mode: "accelerate",
      objective: "Fast track mastery of integration",
    },
  }, "learner", "test") as unknown as Revision<typeof f.goal.body>;

  // Successful independent performance
  f.observe(f.task("Standard integration"), "integration by parts", "success", "independent");

  const candidates = nextActionCandidates({
    goal: goalRevision.body,
    views: f.views(),
    components: [f.component],
    reviews: [],
    as_of_time: f.store.now(),
  });

  // Under accelerate mode with evidenced success, advance / transfer / contrast are high priority
  expect(candidates.some(c => c.type === "advance" || c.type === "transfer_check" || c.type === "contrast")).toBe(true);
  expect(candidates.some(c => c.type === "scaffold")).toBe(false);
});

test("Section 8 scenario 7: essay and practical exam task preserves format, rubric and unobserved modalities", () => {
  const f = fixture("humanities", "Defend an essay thesis orally");
  const goal = f.store.define({
    operation_id: randomUUID(),
    kind: "goal",
    entity_id: f.goal.entity_id,
    parent_revision_id: f.goal.revision_id,
    expected_goal_revision_id: f.goal.revision_id,
    body: {
      ...f.goal.body,
      mode: "exam",
      target_format: "oral argument",
      allowed_aids: ["outline cards"],
    },
  }, "learner", "test");

  expect(goal.body.target_format).toBe("oral argument");
  expect(goal.body.allowed_aids).toContain("outline cards");
});

// Only Pi registration/UI are simulated; tools, input admission, HTTP bridge and ledger are production.
async function teachingPath(run: (f: {
  service: LearningService; bridge: ReturnType<typeof createTutorBridge>; notices: string[]; orchestration: string[];
  command(name: string, args?: string): Promise<void>;
  input(text: string, source?: InputEvent["source"]): Promise<unknown>;
  tool(name: string, body: unknown): Promise<Record<string, unknown>>;
  reopened(): { events: ReturnType<LearningStore["events"]>; state: ReturnType<typeof projectLearningState>; tables: number; integrity: string[] };
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sage-teaching-task1-"));
  const paths = createSagePaths({ home: root });
  await bootstrapSageHome(paths);
  const service = new LearningService(paths); service.activateSession("teaching");
  const server = startLearningServer(service), bridge = createTutorBridge(paths, service, server);
  try {
    const tools = new Map<string, ToolDefinition>(), commands = new Map<string, RegisteredCommand>();
    const hooks = new Map<string, (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>>();
    const notices: string[] = [], orchestration: string[] = [];
    const api = { registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand(n: string, c: RegisteredCommand) { commands.set(n, c); }, on(n: string, h: (event: InputEvent, ctx: ExtensionToolContext) => Promise<unknown>) { hooks.set(n, h); }, sendUserMessage(text: string) { orchestration.push(text); } } as unknown as ExtensionAPI;
    const ctx = { hasUI: true, mode: "rpc", isIdle: () => true, abort() {}, model: { id: "offline", provider: "offline", input: ["text"] }, sessionManager: { getSessionId: () => "teaching" }, ui: { notify(text: string) { notices.push(text); }, setStatus() {}, setWidget() {}, input() { throw new Error("No compulsory intake questionnaire"); }, confirm: async () => true } } as unknown as ExtensionToolContext;
    createTutorExtension(bridge, { planner: async () => { throw new Error("No compulsory planner"); } })(api);
    await run({ service, bridge, notices, orchestration,
      command: async (name, args = "") => { await commands.get(name)!.handler(args, ctx as unknown as ExtensionCommandContext); },
      input: (text, source = "interactive") => hooks.get("input")!({ type: "input", source, text }, ctx),
      tool: async (name, body) => {
        const result = await tools.get(name)!.execute(randomUUID(), body, undefined, undefined, ctx);
        return JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      },
      reopened: () => {
        const store = new PersistedStore(join(paths.data, "learning.sqlite"));
        try { return { events: store.events(), state: projectLearningState(store, "teaching"), tables: store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length, integrity: store.integrity() }; }
        finally { store.close(); }
      },
    });
  } finally { server.stop(); service.close(); await rm(root, { recursive: true, force: true }); }
}

function reviewedTeachingTask(service: LearningService, scoring: "numeric" | "rubric" = "numeric", fresh = false) {
  const goal = service.store.lessonGoal("teaching")!;
  const define = (kind: string, body: unknown) => service.store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: goal.revision_id, body }, "human", "teaching");
  const component = define("component", { title: "Preserve equality", behavior: "Solve and justify an equation", subject: "practical", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Owned offline software fixture; not calibrated" });
  const rubric = define("rubric", { title: "Frozen criteria", dimensions: fresh ? [{ name: "result", criterion: "Correct value", max_score: 100 }] : [{ name: "result", criterion: "Correct value", max_score: 85 }, { name: "reasoning", criterion: "Explain preserving equality", max_score: 15 }], provisional: false, source_span_ids: [] });
  const family = define("task_family", { title: "Equations", construct: "Equality", variation: "Change coefficients", lineage_revision_ids: [] });
  return define("task_definition", { title: "One equation", prompt: fresh ? "Solve 4x - 7 = 21. Give x." : "Solve 3x + 5 = 20. Give x and explain preserving equality.", family_revision_id: family.revision_id, component_revision_ids: [component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: [], format: "solve", allowed_aids: [], steps: [], scoring, ...(scoring === "numeric" ? { answer: fresh ? "7" : "5" } : {}), status: "practice_ready", review: { method: "human", reason: "Explicit owned software fixture review; no expertise assertion" }, stakes: "low", partition: "practice", changes: fresh ? ["new coefficients", "no prior hint"] : [], uncertainty: "Not efficacy, expertise or transfer calibration" }) as unknown as Revision<TaskDefinition>;
}

async function nativeQuestion(service: LearningService, definitionId: string) {
  const goal = service.store.lessonGoal("teaching")!;
  const state = (await service.context({}, "teaching")).learning_state as { state_revision: string };
  const started = service.learnControl({ operation_id: randomUUID(), action: "direct_practice", confirmed: true, acknowledge_gaps: true, definition_revision_id: definitionId, expected_goal_revision_id: goal.revision_id, expected_state_revision: state.state_revision }, "teaching");
  return service.store.revision(started.instance_revision_id!, "task_instance");
}

const teachingAttempt = (goal: Revision<Goal>, instanceId: string, responseId: string) => ({ operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: randomUUID(), instance_revision_id: instanceId, response_event_id: responseId, declared_aids: [] } });

test("e03s01 task 1: registered planner-optional intake waits for owned work and displays frozen 85/100 with unseen reasoning gaps", async () => {
  await teachingPath(async f => {
    await f.command("learn", "Solve one equation and justify it");
    const goal = f.service.store.lessonGoal("teaching")!;
    expect(goal.body.learning_preferences?.profile).toBe("balanced");
    expect(f.service.store.revisions("plan")).toEqual([]);
    expect(f.reopened().state.phase).toBe("prepare");
    expect(f.orchestration).toHaveLength(1);
    await f.input(f.orchestration[0]!, "extension");
    expect(f.reopened().events.filter(e => e.kind === "learner_response")).toEqual([]);
    const task = reviewedTeachingTask(f.service);
    const deliver = (definition = task) => ({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } });
    const instance = await nativeQuestion(f.service, task.revision_id);
    const instanceId = instance.revision_id as string;
    expect(f.reopened().state).toMatchObject({ phase: "awaiting_answer", pending_count: 1, current_task: { instance_revision_id: instanceId, rubric_revision_id: task.body.rubric_revision_id } });
    await expect(f.tool("learning_define", deliver())).rejects.toThrow("pending");
    expect(f.reopened().events.filter(e => ["assistance", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    await f.command("stop");
    expect(f.reopened().state.phase).toBe("stopped");
    expect(f.reopened().events.filter(e => e.kind === "learner_response")).toEqual([]);
    expect(f.reopened().events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    await f.input("Please keep this task narrow");
    expect(f.reopened().state.phase).toBe("submission_pending");
    expect(f.reopened().events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    // Captured ordinary text is only a claimed response; no inferred semantic intent or marks.
    await f.input("5");
    const response = f.reopened().events.filter(e => e.kind === "learner_response" && e.actor === "learner" && e.branch === "real" && e.payload.text === "5" && !e.payload.input_kind).at(-1)!;
    const attempt = teachingAttempt(goal, instanceId, response.event_id);
    await f.tool("learning_record", attempt);
    const assessmentBody = { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: task.body.rubric_revision_id, outcome: "success", scores: [{ dimension: "result", score: 85, evidence: "5" }, { dimension: "reasoning", score: 15, evidence: "5" }], feedback: "The value is correct; explanation is missing.", uncertainty: "Answer match does not observe explanation.", feedback_review: { ready_to_continue: false, issues: [{ quote: "5", problem: "No explanation", suggestion: "Explain the equality-preserving operations", severity: "blocking" }] } } };
    const assessment = await f.tool("learning_record", assessmentBody);
    expect(assessment.payload).toMatchObject({ outcome: "partial", assessor: "deterministic", marking_summary: { earned: 85, maximum: 100, percentage: 85, unobserved_dimensions: ["reasoning"] }, scores: [{ dimension: "result", score: 85, evidence: "5" }, { dimension: "reasoning", score: 0, evidence: "5" }] });
    expect(f.notices.join("\n")).toContain("85/100");
    expect(f.notices.join("\n")).toContain("Unobserved criteria: reasoning");
    expect(f.reopened().state.phase).toBe("repair");
    await expect(f.tool("learning_define", deliver())).rejects.toThrow("blocking");
    const help = { assistance_id: randomUUID(), instance_revision_id: instanceId, attempt_id: attempt.payload.attempt_id, component_revision_ids: task.body.component_revision_ids, kind: "hint", content: "Describe subtracting five on both sides", answer_bearing: true };
    await f.tool("learning_record", { operation_id: randomUUID(), kind: "assistance", expected_goal_revision_id: goal.revision_id, payload: { ...help, stage: "requested" } });
    await f.tool("learning_record", { operation_id: randomUUID(), kind: "assistance", expected_goal_revision_id: goal.revision_id, payload: { ...help, stage: "exposed" } });
    await expect(f.tool("learning_record", { ...assessmentBody, operation_id: randomUUID() })).rejects.toThrow("correction");
    await f.input("5");
    const repairedResponse = f.reopened().events.filter(e => e.kind === "learner_response").at(-1)!;
    const repair = teachingAttempt(goal, instanceId, repairedResponse.event_id);
    await f.tool("learning_record", repair);
    await f.tool("learning_record", { ...assessmentBody, operation_id: randomUUID(), payload: { ...assessmentBody.payload, attempt_id: repair.payload.attempt_id } });
    expect(assessment).toEqual({ ...f.reopened().events.find(e => e.event_id === assessment.event_id)! });
    await f.command("continue");
    const fresh = reviewedTeachingTask(f.service, "numeric", true);
    const freshInstance = await nativeQuestion(f.service, fresh.revision_id);
    expect(f.reopened().state.current_task).toMatchObject({ instance_revision_id: freshInstance.revision_id, assistance_count: 0 });
    await f.input("7");
    const freshResponse = f.reopened().events.filter(e => e.kind === "learner_response").at(-1)!;
    const freshAttempt = teachingAttempt(goal, freshInstance.revision_id as string, freshResponse.event_id);
    await f.tool("learning_record", freshAttempt);
    const freshAssessment = await f.tool("learning_record", { ...assessmentBody, operation_id: randomUUID(), payload: { ...assessmentBody.payload, attempt_id: freshAttempt.payload.attempt_id, rubric_revision_id: fresh.body.rubric_revision_id, scores: [{ dimension: "result", score: 100, evidence: "7" }], feedback: "This changed item matches its key; no broader mastery claim.", feedback_review: { ready_to_continue: true, issues: [] } } });
    expect(freshAssessment.payload).toMatchObject({ outcome: "success", marking_summary: { earned: 100, maximum: 100 } });
    // Feedback becomes possibly-exposed support only after this fresh attempt was assessed.
    expect(f.reopened().state.current_task).toMatchObject({ instance_revision_id: freshInstance.revision_id, assistance_count: 1 });
    expect(f.reopened().events.filter(e => e.kind === "assistance" && e.payload.instance_revision_id === freshInstance.revision_id).map(e => e.payload.kind)).toEqual(["feedback"]);
    expect(assessment).toEqual({ ...f.reopened().events.find(e => e.event_id === assessment.event_id)! });
    expect(f.reopened().tables).toBe(7); expect(f.reopened().integrity).toEqual(["ok"]);
    expect(f.service.store.db.query("SELECT count(*) AS count FROM model_call_log").get()).toEqual({ count: 0 });
    const attempts = f.reopened().events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind));
    // Malformed receipts challenge store admission separately, not the legitimate native-input path.
    for (const [actor, branch, input_kind, session] of [["pi", "real", "work", "teaching"], ["learner", "hypothetical", "work", "teaching"], ["learner", "real", "control", "teaching"], ["learner", "real", "message", "teaching"], ["learner", "real", "work", "foreign"]] as const) {
      const response = f.service.store.append("learner_response", { text: "7", instance_revision_id: freshInstance.revision_id, input_kind }, randomUUID(), actor, session, f.service.store.now(), undefined, branch);
      await expect(f.tool("learning_record", teachingAttempt(goal, freshInstance.revision_id as string, response.event_id))).rejects.toThrow();
    }
    expect(f.reopened().events.filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual(attempts);
  });
});


test("e03s01 task 1: semantic criterion marks remain proposals and missing criteria are displayed, not unseen credit", async () => {
  await teachingPath(async f => {
    await f.command("learn", "Explain an equation");
    const goal = f.service.store.lessonGoal("teaching")!, task = reviewedTeachingTask(f.service, "rubric");
    const instance = await nativeQuestion(f.service, task.revision_id);
    await f.input("5");
    const response = f.reopened().events.filter(e => e.kind === "learner_response").at(-1)!;
    const attempt = teachingAttempt(goal, instance.revision_id as string, response.event_id);
    await f.tool("learning_record", attempt);
    const assessment = await f.tool("learning_record", { operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: task.body.rubric_revision_id, outcome: "partial", scores: [{ dimension: "result", score: 85, evidence: "5" }], feedback: "Correct value; explanation unobserved.", uncertainty: "Semantic judgment is a proposal, not calibration.", feedback_review: { ready_to_continue: false, issues: [{ quote: "5", problem: "Reasoning not observed", suggestion: "Give the operations and why equality is preserved", severity: "blocking" }] } } });
    expect(assessment.payload).toMatchObject({ assessor: "pi_rubric_proposal", marking_summary: { earned: 85, maximum: 100, unobserved_dimensions: ["reasoning"] } });
    expect(f.notices.join("\n")).toContain("85/100");
    expect(f.notices.join("\n")).toContain("rubric proposal");
    expect(f.notices.join("\n")).toContain("Unobserved criteria: reasoning");
  });
});
