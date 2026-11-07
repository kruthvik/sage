import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, Revision, Rubric } from "../../core/src/contracts.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { LearningService, startLearningServer } from "../src/service.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { profilePreferences, LearningPreferencesSchema } from "../../core/src/experience.ts";
import { validate } from "../../core/src/contracts.ts";
import { assertCanAdvance, feedbackState, presentFeedback, overrideFeedback } from "../src/feedback.ts";
import { learningFixture } from "./learning-fixture.ts";
const stores: ReturnType<typeof learningFixture>["store"][] = [];
function fixture() {
  const f = learningFixture(); stores.push(f.store);
  const next = f.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: f.goal.entity_id, parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, learning_preferences: profilePreferences("thorough") } }, "learner", "test");
  Object.assign(f.goal, next);
  const definition = f.task("Explain the method choice.");
  const instance = f.deliver(definition);
  const work = f.attempt(instance, "I choose integration by parts, but it always applies.");
  const assess = (ready: boolean, blocking = false, quote = "always applies") => f.record("assessment", { attempt_id: work.id, rubric_revision_id: definition.body.rubric_revision_id, outcome: "partial", scores: [{ dimension: "target", score: 1, evidence: "integration by parts" }], feedback: "Check the scope of the claim.", uncertainty: "Proposal, not independent semantic validation", feedback_review: { ready_to_continue: ready, issues: blocking ? [{ quote, problem: "An unrestricted claim is incorrect.", suggestion: "State the conditions under which the method is useful.", severity: "blocking" }] : [{ quote, problem: "This wording overstates the claim.", suggestion: "Qualify its scope.", severity: "precision" }] } });
  return { ...f, definition, instance, work, assess };
}
const roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("learning profiles are explicit editable preferences, not shared state or ability labels", () => {
  const cram = profilePreferences("cram");
  validate(LearningPreferencesSchema, cram);
  expect(cram.features.planner).toBe(false);
  expect(cram.features.teach_back).toBe(false);
  expect(cram.review_before_advance).toBe(true);
  cram.features.mcq = false;
  expect(profilePreferences("cram").features.mcq).toBe(true);
  expect(profilePreferences("thorough").feedback).toBe("rigorous");
});

test("automatic advancement waits for actual assessment and trusted feedback presentation", () => {
  const f = fixture();
  expect(feedbackState(f.store, "test").phase).toBe("awaiting_review");
  expect(() => assertCanAdvance(f.store, "test")).toThrow("Review");
  const assessment = f.assess(true);
  expect(feedbackState(f.store, "test").phase).toBe("awaiting_feedback");
  expect(() => assertCanAdvance(f.store, "test")).toThrow();
  presentFeedback(f.store, assessment.event_id, "test");
  expect(feedbackState(f.store, "test").phase).toBe("ready");
  expect(() => assertCanAdvance(f.store, "test")).not.toThrow();
  expect(overrideFeedback(f.store, "test")).toMatchObject({ overridden: false });
  expect(f.store.events().filter(e => e.kind === "decision" && e.payload.action === "response_review_override")).toHaveLength(0);
});

test("blocking feedback needs repair while an explicit learner override remains available", () => {
  const f = fixture(); const assessment = f.assess(false, true);
  presentFeedback(f.store, assessment.event_id, "test");
  expect(feedbackState(f.store, "test").phase).toBe("needs_revision");
  expect(() => assertCanAdvance(f.store, "test")).toThrow();
  overrideFeedback(f.store, "test");
  expect(feedbackState(f.store, "test").phase).toBe("overridden");
  expect(() => assertCanAdvance(f.store, "test")).not.toThrow();
  expect(f.store.events().filter(e => e.kind === "assessment")).toHaveLength(1);
});

test("one existing Bun server serves scoped browser work, captures once and resumes only for review", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-studio-")); roots.push(root);
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); stores.push(service.store);
  const filename = join(root, "lesson.md"); await writeFile(filename, "Learning source for browser fixture.");
  const selected = await service.sources.importFile(filename); service.sources.accept(selected.revision_id);
  const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "exam", objective: "Linear equations", subject: "math", horizon_days: 1, target_format: "solve", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [selected.revision_id], learning_preferences: profilePreferences("cram") } }, "learner", "browser") as unknown as Revision<Goal>;
  const definition = installFixtures(service.store, goal)[0]!;
  const instance = service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } }, "human", "browser");
  const server = startLearningServer(service); const resumed: unknown[] = [];
  try {
    const ui = await service.renderUi('page "Equation"\ninput answer "Value of x"\n---js\nexport function check() {}', "browser", server.url, receipt => { resumed.push(receipt); }, async () => ({ use: "supplementary" }));
    expect((await fetch(ui.url)).status).toBe(200);
    expect(service.store.events().filter(e => e.kind === "assistance")).toHaveLength(1);
    const api = `${server.url}/api/ui/${ui.id}`;
    const payload = await (await fetch(api)).json() as { activity: { prompt: string; criteria: string[] } };
    expect(payload.activity.prompt).toBe(definition.body.prompt);
    expect(payload.activity.criteria.length).toBeGreaterThan(0);
    const submit = () => fetch(api, { method: "POST", headers: { Origin: server.url, "Content-Type": "application/json" }, body: JSON.stringify({ type: "submit", text: "5" }) });
    expect((await submit()).status).toBe(200);
    expect((await submit()).status).toBe(200);
    expect(resumed).toHaveLength(1);
    expect(service.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(1);
    const help = service.store.events().find(e => e.kind === "assistance" && e.payload.kind === "external")!;
    const response = service.store.events().find(e => e.kind === "learner_response")!;
    expect(help.seq).toBeLessThan(response.seq);
    expect(help.payload.stage).toBe("possibly_exposed");
    expect(feedbackState(service.store, "browser").phase).toBe("awaiting_review");
    await expect(service.operation("learning_define", { operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "practice", conditions: [] } }, "browser")).rejects.toThrow("Review");
    await expect(service.operation("learning_define", { operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, objective: "Automatic scope change" } }, "browser")).rejects.toThrow("Review");
    expect(instance.revision_id).toBeDefined();
    const attempt = service.store.events().find(e => e.kind === "attempt_submitted")!;
    const rubric = service.store.revision<Rubric>(definition.body.rubric_revision_id).body;
    service.store.record({ operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attempt.payload.attempt_id, rubric_revision_id: definition.body.rubric_revision_id, outcome: "success", scores: rubric.dimensions.map(d => ({ dimension: d.name, score: d.max_score, evidence: "5 satisfies 3x + 5 = 20" })), feedback: "The value satisfies the equation.", uncertainty: "Browser assistance use is unobserved", feedback_review: { ready_to_continue: true, issues: [] } } }, "browser");
    const evidence = projectComponents(service.store, service.store.throughSeq, new Date().toISOString()).find(v => v.component_revision_id === definition.body.component_revision_ids[0])!;
    expect(evidence.observations.at(-1)?.eligibility).toBe("uncertain");
    expect(evidence.independent).toHaveLength(0);
    service.sources.remove(selected.revision_id);
    expect((await fetch(api)).status).toBe(403);
    expect(service.store.currentGoal()?.revision_id).toBe(goal.revision_id);
    service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, provider_sharing: false } }, "learner", "browser");
    expect((await fetch(api)).status).toBe(403);
  } finally { server.stop(); }
});

test("feedback cannot invent quotes, contradict readiness or be forged as delivered by Pi", () => {
  const f = fixture();
  expect(() => f.assess(false, true, "a sentence I never wrote")).toThrow("quote");
  expect(() => f.assess(true, true)).toThrow("blocking");
  const assessment = f.assess(true);
  f.record("decision", { action: "response_feedback_presented", evidence_event_ids: [assessment.event_id], reason: "Model assertion is not a display receipt" });
  expect(feedbackState(f.store, "test").phase).toBe("awaiting_feedback");
  expect(() => presentFeedback(f.store, assessment.event_id, "other-session")).toThrow();
});
