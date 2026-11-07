import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, Revision, Rubric } from "../../core/src/contracts.ts";
import { LearningService } from "../src/service.ts";
import { createSagePaths } from "../src/paths.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { canonical } from "../../storage/src/store.ts";

const roots: string[] = [], services: LearningService[] = [];
afterEach(async () => { for (const s of services.splice(0)) s.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const marker = "PRIVATE-SOURCE-MARKER";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-disclosure-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service);
  let goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "learn", objective: "Explain a relation", subject: "math", horizon_days: 7, target_format: "reasoning", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "test") as unknown as Revision<Goal>;
  const file = join(root, `${marker}.md`); await writeFile(file, `${marker}: a private relation and rationale`);
  const source = await service.sources.importFile(file); service.sources.accept(source.revision_id);
  const revise = (body: Partial<Goal>) => {
    goal = service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, ...body } }, "learner", "test") as unknown as Revision<Goal>;
    return goal;
  };
  revise({ source_ids: [source.revision_id] });
  const base = installFixtures(service.store, goal)[0]!;
  const span = service.sources.preview(source.revision_id)[0]!;
  const task = service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...base.body, title: `${marker}-task`, prompt: `Explain ${marker}`, source_span_ids: [span.span_id], scoring: "rubric", review: { method: "curated", reason: "Synthetic disclosure fixture" } } }, "human", "test");
  const instance = service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } }, "human", "test");
  const response = service.store.learnerResponse(`My explanation quotes ${marker}`, "test", randomUUID(), { goal_revision_id: goal.revision_id, instance_revision_id: instance.revision_id });
  service.store.record({ operation_id: randomUUID(), kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: "private-attempt", instance_revision_id: instance.revision_id, response_event_id: response.event_id, declared_aids: [] } }, "test");
  const rubric = service.store.revision<Rubric>(base.body.rubric_revision_id, "rubric");
  const assessment = service.store.record({ operation_id: randomUUID(), kind: "assessment", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: "private-attempt", rubric_revision_id: rubric.revision_id, outcome: "failure", scores: rubric.body.dimensions.map(d => ({ dimension: d.name, score: 0, evidence: marker })), component_outcomes: base.body.component_revision_ids.map(id => ({ component_revision_id: id, outcome: "failure" })), claims: [{ component_revision_id: base.body.component_revision_ids[0], dimension: "explanation", outcome: "failure", evidence: marker }], feedback: `Private feedback ${marker}`, uncertainty: `Private assessment ${marker}` } }, "test");
  service.store.define({ operation_id: randomUUID(), kind: "hypothesis", expected_goal_revision_id: goal.revision_id, body: { component_revision_ids: [base.body.component_revision_ids[0]], category: "selection", description: `Private hypothesis ${marker}`, confidence: "low", supporting_evidence_ids: [assessment.event_id], contradicting_evidence_ids: [], status: "active", first_observed_at: assessment.occurred_at, last_observed_at: assessment.occurred_at } }, "pi", "test");
  service.store.define({ operation_id: randomUUID(), kind: "artifact", expected_goal_revision_id: goal.revision_id, body: { capability: "drawing", goal_revision_id: goal.revision_id, instance_revision_id: instance.revision_id, author: "tutor", provenance: marker, media_type: "text/plain", content: marker, evidence_kind: "inferred", interpretation_uncertainty: marker, assistance_event_ids: [] } }, "pi", "test");
  const before = service.store.throughSeq;
  return { service, source, revise, before, response, instance, goal: () => goal };
}

test("removal withholds the entire uncertain disclosure scope, including historical latest responses, while retaining originals", async () => {
  const f = await fixture();
  expect(JSON.stringify(await f.service.context({}, "test"))).toContain(marker);
  const original = canonical(f.service.store.event(f.response.event_id));
  f.service.sources.remove(f.source.revision_id);
  const current = await f.service.context({}, "test");
  expect(JSON.stringify(current)).not.toContain(marker);
  expect(current).toMatchObject({ goal: null, latest_learner_response: null, disclosure: { allowed: false } });
  const historical = await f.service.context({ through_seq: f.before, goal_revision_id: f.goal().revision_id }, "test");
  expect(JSON.stringify(historical)).not.toContain(marker);
  expect(canonical(f.service.store.event(f.response.event_id))).toBe(original);
});

test("current grant, revocation and explicit reselection control historical disclosure, not the old consent flag", async () => {
  const f = await fixture(), oldGoal = f.goal();
  f.revise({ source_ids: [] });
  expect(JSON.stringify(await f.service.context({ through_seq: f.before }, "test"))).not.toContain(marker);
  f.revise({ source_ids: [f.source.revision_id] });
  expect(JSON.stringify(await f.service.context({}, "test"))).toContain(marker);
  f.revise({ provider_sharing: false });
  const denied = await f.service.context({ goal_revision_id: oldGoal.revision_id, through_seq: f.before }, "test");
  expect(JSON.stringify(denied)).not.toContain(marker);
  expect(denied).toMatchObject({ disclosure: { allowed: false } });
});

test("a fresh lesson reusing static components does not inherit private observations or hypothesis prose", async () => {
  const f = await fixture(); f.service.sources.remove(f.source.revision_id);
  const goal = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: { ...f.goal().body, objective: "A fresh source-free lesson", source_ids: [] } }, "learner", "fresh") as unknown as Revision<Goal>;
  const task = installFixtures(f.service.store, goal)[0]!;
  f.service.store.define({ operation_id: randomUUID(), kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "practice", conditions: [] } }, "human", "fresh");
  const packet = await f.service.context({}, "fresh");
  expect(JSON.stringify(packet)).not.toContain(marker);
  expect((packet.goal as Revision<Goal>).revision_id).toBe(goal.revision_id);
});

test("fixture title collisions cannot relabel another lesson's generated source-derived task as a static fixture", async () => {
  const f = await fixture();
  const base = installFixtures(f.service.store, f.goal())[0]!;
  f.service.store.define({ operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: f.goal().revision_id, body: { ...base.body, prompt: `Source-derived generated task ${marker}`, source_span_ids: [], review: { method: "human", reviewer_role: "learner", reason: "Learner accepted generated practice" } } }, "learner", "test");
  f.service.sources.remove(f.source.revision_id);
  const goal = f.service.store.define({ operation_id: randomUUID(), kind: "goal", body: { ...f.goal().body, objective: "Fresh independent math", source_ids: [] } }, "learner", "fresh") as unknown as Revision<Goal>;
  const tasks = installFixtures(f.service.store, goal);
  expect(tasks).toHaveLength(3);
  expect(JSON.stringify(tasks)).not.toContain(marker);
});

test("unreconstructable legacy model text is withheld and a trusted permit rejects current revocation", async () => {
  const f = await fixture();
  const authorize = Reflect.get(f.service, "authorizeDisclosure");
  expect(typeof authorize).toBe("function");
  const permit = await authorize.call(f.service, "test");
  expect(JSON.stringify(permit.packet)).toContain(marker);
  f.service.store.append("checkpoint", { goal_revision_id: f.goal().revision_id, summary: marker, next_action: "Legacy text", gaps: [], stopped: false }, randomUUID(), "pi", "test");
  expect(await f.service.context({}, "test")).toMatchObject({ disclosure: { allowed: false, reason: "legacy_provenance_unknown" } });
  await expect(authorize.call(f.service, "test")).rejects.toThrow("disclosure");
});

test("transport authorization is read-only: absent goals and explicit sharing denial cannot create or re-enable consent", async () => {
  const f = await fixture();
  const emptySeq = f.service.store.throughSeq;
  await expect(f.service.authorizeDisclosure("no-intent")).rejects.toThrow("disclosure");
  expect(f.service.store.lessonGoal("no-intent")).toBeUndefined();
  expect(f.service.store.throughSeq).toBe(emptySeq);
  const denied = f.revise({ provider_sharing: false });
  const deniedSeq = f.service.store.throughSeq;
  await expect(f.service.authorizeDisclosure("test")).rejects.toThrow("disclosure");
  expect(f.service.ensureLessonGoal("test").revision_id).toBe(denied.revision_id);
  expect(f.service.store.lessonGoal("test")?.body.provider_sharing).toBe(false);
  expect(f.service.store.throughSeq).toBe(deniedSeq);
});

test("copied goal text and ambiguously attributed legacy records do not bypass a revoked source scope", async () => {
  const f = await fixture();
  f.revise({ objective: `Understand ${marker}`, criteria: [`Explain ${marker}`] });
  f.service.store.learnerResponse(`Unscoped legacy text ${marker}`, "test");
  f.revise({ source_ids: [] });
  const packet = await f.service.context({}, "test");
  expect(JSON.stringify(packet)).not.toContain(marker);
  expect(packet).toMatchObject({ disclosure: { allowed: false } });
  expect(f.service.store.lessonGoal("test")!.body.objective).toContain(marker);
});
