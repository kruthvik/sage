import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import type { LearningStore } from "../../storage/src/store.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }
function authorization(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}, actor = "host", branch: "real" | "hypothetical" = "real") {
  return f.store.append("decision", { action: "review_offer_authorized", lesson_goal_entity_id: f.goal.entity_id, goal_revision_id: f.goal.revision_id, component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z", offer_action: "accept", reason: "Explicit owned review control", evidence_event_ids: [], ...extra }, randomUUID(), actor, "test", f.store.now(), undefined, branch);
}
function schedule(f: ReturnType<typeof fixture>, authorizationId: string, consentId: string, componentId = f.component.revision_id, occurred_at?: string) {
  return f.store.record({ operation_id: randomUUID(), kind: "review_scheduled", expected_goal_revision_id: f.store.lessonGoal("test")!.revision_id, occurred_at, payload: { component_revision_id: componentId, due_at: "2026-10-03T12:00:00.000Z", consent: true, consent_response_event_id: consentId, authorization_event_id: authorizationId, reason: "Accepted owned review" } }, "test");
}
function accepted(f: ReturnType<typeof fixture>) { const auth = authorization(f); const consent = f.store.learnerResponse("Accept this review", "test"); return schedule(f, auth.event_id, consent.event_id); }

test("review authorization must be a real trusted-host receipt, not a learner/model assertion or hypothetical receipt", () => {
  for (const [actor, branch] of [["learner", "real"], ["human", "real"], ["host", "hypothetical"]] as const) {
    const f = fixture(); const auth = authorization(f, {}, actor, branch); const consent = f.store.learnerResponse("Accept", "test"); const before = f.store.throughSeq;
    expect(() => schedule(f, auth.event_id, consent.event_id)).toThrow("authorization"); expect(f.store.throughSeq).toBe(before);
  }
});

test("AI or hypothetical learner_response rows cannot supply review consent", () => {
  for (const [actor, branch] of [["pi", "real"], ["learner", "hypothetical"]] as const) {
    const f = fixture(); const auth = authorization(f); const consent = f.store.append("learner_response", { text: "Accept" }, randomUUID(), actor, "test", f.store.now(), undefined, branch); const before = f.store.throughSeq;
    expect(() => schedule(f, auth.event_id, consent.event_id)).toThrow("consent"); expect(f.store.throughSeq).toBe(before);
  }
});

test("missing, stale and unsupported-action authorization cannot be accepted under a current goal", () => {
  for (const extra of [{ goal_revision_id: undefined }, { lesson_goal_entity_id: undefined }, { offer_action: "silently schedule" }]) {
    const f = fixture(); const auth = authorization(f, extra); const consent = f.store.learnerResponse("Accept", "test"); const before = f.store.throughSeq;
    expect(() => schedule(f, auth.event_id, consent.event_id)).toThrow("authorization"); expect(f.store.throughSeq).toBe(before);
  }
  const f = fixture(); const auth = authorization(f);
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, budget_minutes: 19 } }, "learner", "test");
  const consent = f.store.learnerResponse("Accept", "test"); const before = f.store.throughSeq;
  expect(() => schedule(f, auth.event_id, consent.event_id)).toThrow("authorization"); expect(f.store.throughSeq).toBe(before);
});

test("another conversation's identical component cannot be scheduled through a local authorization", () => {
  const f = fixture(); const foreignGoal = f.store.define({ operation_id: randomUUID(), kind: "goal", body: f.goal.body }, "learner", "foreign");
  const foreignComponent = f.store.define({ operation_id: randomUUID(), kind: "component", expected_goal_revision_id: foreignGoal.revision_id, body: f.component.body }, "human", "foreign");
  const auth = authorization(f, { component_revision_id: foreignComponent.revision_id }); const consent = f.store.learnerResponse("Accept", "test"); const before = f.store.throughSeq;
  expect(() => schedule(f, auth.event_id, consent.event_id, foreignComponent.revision_id)).toThrow("lesson"); expect(f.store.throughSeq).toBe(before);
});

test("consent must follow the precise authorization and a schedule cannot be backdated before either", () => {
  const f = fixture(); const prior = f.store.learnerResponse("Unrelated earlier yes", "test"); const auth = authorization(f); const before = f.store.throughSeq;
  expect(() => schedule(f, auth.event_id, prior.event_id)).toThrow("consent"); expect(f.store.throughSeq).toBe(before);
  const consent = f.store.learnerResponse("Accept", "test"); const at = f.store.throughSeq;
  expect(() => schedule(f, auth.event_id, consent.event_id, f.component.revision_id, "2026-09-30T12:00:00.000Z")).toThrow("consent"); expect(f.store.throughSeq).toBe(at);
});

test("review completion cannot reuse another conversation's retention evidence or a step-only assessment", () => {
  const f = fixture(); const review = accepted(f); f.time("2026-10-03T13:00:00.000Z");
  const observed = f.observe(f.task("Fresh retention check"), "I choose parts", "success", "retention");
  const stepOnly = f.store.append("assessment", { ...observed.assessment.payload, step_attempt_id: "step-only" }, randomUUID(), "pi", "test");
  const before = f.store.throughSeq;
  expect(() => f.record("review_completed", { schedule_event_id: review.event_id, assessment_event_id: stepOnly.event_id })).toThrow("whole"); expect(f.store.throughSeq).toBe(before);
  const foreign = f.store.append("assessment", observed.assessment.payload, randomUUID(), "pi", "foreign"); const beforeForeign = f.store.throughSeq;
  expect(() => f.record("review_completed", { schedule_event_id: review.event_id, assessment_event_id: foreign.event_id })).toThrow("lesson"); expect(f.store.throughSeq).toBe(beforeForeign);
});

test("cancelled or already completed reviews cannot be completed again", () => {
  for (const cancel of [true, false]) {
    const f = fixture(); const review = accepted(f); f.time("2026-10-03T13:00:00.000Z"); const observed = f.observe(f.task("Retention after due date"), "I choose parts", "success", "retention");
    if (cancel) f.store.append("decision", { action: "review_cancelled", lesson_goal_entity_id: f.goal.entity_id, schedule_event_id: review.event_id, reason: "Learner cancelled", evidence_event_ids: [] }, randomUUID(), "host", "test");
    else f.record("review_completed", { schedule_event_id: review.event_id, assessment_event_id: observed.assessment.event_id });
    const before = f.store.throughSeq;
    expect(() => f.record("review_completed", { schedule_event_id: review.event_id, assessment_event_id: observed.assessment.event_id })).toThrow("pending"); expect(f.store.throughSeq).toBe(before);
  }
});
