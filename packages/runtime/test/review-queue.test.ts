import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import { type LearningStore } from "../../storage/src/store.ts";
import { compileContext } from "../src/context.ts";
import { proposeReviews, reviewQueue, type AcceptedReview } from "../src/reviews.ts";
import { nextActionCandidates } from "../src/candidates.ts";
import { evaluateLearning } from "../src/evaluation.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }

test("model cannot forge review consent using an unrelated response, arbitrary consent:true, or foreign lesson", () => {
  const f = fixture();
  f.observe(f.task("Practice before a review"));
  const unrelated = f.store.learnerResponse("Answering an unrelated question", "test");
  const payload = {
    component_revision_id: f.component.revision_id,
    due_at: "2026-10-04T12:00:00.000Z",
    consent: true,
    consent_response_event_id: unrelated.event_id,
    reason: "Model-minted review schedule without host authorization",
  };
  // Must reject when no valid host authorization decision exists for this offer
  expect(() => f.record("review_scheduled", payload)).toThrow("authorization");
});

test("accepted review due on Oct 3 remains due and actionable in candidates even if a later proposal moves to Oct 4", () => {
  const f = fixture();
  const task = f.task("Initial successful practice");
  f.observe(task, "I choose parts", "success", "independent");

  // Host authorizes and learner accepts a review for Oct 3
  const dueAt = "2026-10-03T12:00:00.000Z";
  const auth = f.store.append("decision", {
    action: "review_offer_authorized",
    lesson_goal_entity_id: f.goal.entity_id,
    goal_revision_id: f.goal.revision_id,
    component_revision_id: f.component.revision_id,
    due_at: dueAt,
    offer_action: "accept",
    reason: "Learner accepted 2-day review offer",
    evidence_event_ids: [],
  }, randomUUID(), "host", "test");

  const consent = f.store.learnerResponse("Yes, schedule review for Oct 3", "test");
  const scheduled = f.store.record({
    operation_id: randomUUID(),
    kind: "review_scheduled",
    expected_goal_revision_id: f.goal.revision_id,
    payload: {
      component_revision_id: f.component.revision_id,
      due_at: dueAt,
      consent: true,
      consent_response_event_id: consent.event_id,
      authorization_event_id: auth.event_id,
      reason: "Learner accepted 2-day review offer",
    },
  }, "test");

  // Actual later practice, not a comment-only hypothetical, shifts the floating offer.
  f.time("2026-10-02T16:00:00.000Z");
  f.observe(f.task("Later practice of a distinct delivered task"), "I choose parts", "success", "independent");
  // Next day: Oct 3 arrives
  f.time("2026-10-03T14:00:00.000Z");

  const floating = proposeReviews(f.goal.body, f.views(), [f.component], f.store.now());
  expect(floating.find(r => r.component_revision_id === f.component.revision_id)?.due_at).toBe("2026-10-04T12:00:00.000Z");
  const queue = reviewQueue(f.store, "test", "2026-10-03T14:00:00.000Z");
  expect(queue.some((r: AcceptedReview) => r.schedule_event_id === scheduled.event_id && r.due)).toBe(true);

  // Context must contain the due review
  const ctx = compileContext(f.store, {}, "", "test");
  expect((ctx.due_reviews as Array<{ event_id: string }>).some(r => r.event_id === scheduled.event_id)).toBe(true);

  // Candidate generation must include retrieval because an accepted review is due,
  // regardless of what floating proposeReviews might prospectively propose
  const candidates = nextActionCandidates({
    goal: f.goal.body,
    views: f.views(),
    components: [f.component],
    reviews: proposeReviews(f.goal.body, f.views(), [f.component], "2026-10-03T14:00:00.000Z"),
    accepted_reviews: queue,
    as_of_time: "2026-10-03T14:00:00.000Z",
  });
  expect(candidates.some(c => c.type === "retrieval")).toBe(true);
});

test("an accepted due review is not hidden by the default four-component context window", () => {
  const f = fixture(); const auth = f.authorizeReview(f.component.revision_id, "2026-10-03T12:00:00.000Z"); const consent = f.store.learnerResponse("Accept", "test");
  const scheduled = f.record("review_scheduled", { component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z", consent: true, consent_response_event_id: consent.event_id, authorization_event_id: auth.event_id, reason: "Explicit accepted target" });
  for (let i = 0; i < 5; i++) f.define("component", { ...f.component.body, title: `Other owned component ${i}` });
  f.time("2026-10-03T14:00:00.000Z"); const context = compileContext(f.store, {}, "", "test");
  expect((context.due_reviews as Array<{ event_id: string }>).some(r => r.event_id === scheduled.event_id)).toBe(true);
});

test("declining or cancelling an accepted review removes it from due queue without counting as failure", () => {
  const f = fixture();
  f.observe(f.task("Practice before review"));
  const dueAt = "2026-10-04T12:00:00.000Z";
  const auth = f.store.append("decision", {
    action: "review_offer_authorized",
    lesson_goal_entity_id: f.goal.entity_id,
    goal_revision_id: f.goal.revision_id,
    component_revision_id: f.component.revision_id,
    due_at: dueAt,
    offer_action: "accept",
    reason: "Host authorization",
    evidence_event_ids: [],
  }, randomUUID(), "host", "test");
  const consent = f.store.learnerResponse("Schedule it", "test");
  const scheduled = f.store.record({
    operation_id: randomUUID(),
    kind: "review_scheduled",
    expected_goal_revision_id: f.goal.revision_id,
    payload: {
      component_revision_id: f.component.revision_id,
      due_at: dueAt,
      consent: true,
      consent_response_event_id: consent.event_id,
      authorization_event_id: auth.event_id,
      reason: "Accepted review",
    },
  }, "test");

  // Cancel the scheduled review
  f.store.append("decision", {
    action: "review_cancelled",
    lesson_goal_entity_id: f.goal.entity_id,
    schedule_event_id: scheduled.event_id,
    reason: "Learner cancelled review check",
    evidence_event_ids: [],
  }, randomUUID(), "host", "test");

  f.time("2026-10-05T12:00:00.000Z");
  const queue = reviewQueue(f.store, "test", "2026-10-05T12:00:00.000Z");
  expect(queue.find((r: AcceptedReview) => r.schedule_event_id === scheduled.event_id)?.status).toBe("cancelled");
  expect(queue.filter((r: AcceptedReview) => r.status === "pending" && r.due)).toHaveLength(0);

  // Evaluation does NOT record failure
  const report = evaluateLearning(f.store);
  expect(report.reviews.find(r => r.schedule_event_id === scheduled.event_id)?.completed).toBe(false);
  expect(f.state().independent_performance.failure).toBe(0);
});
