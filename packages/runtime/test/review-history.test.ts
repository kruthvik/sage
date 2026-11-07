import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "./learning-fixture.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import { reviewQueue } from "../src/reviews.ts";
import { compileContext } from "../src/context.ts";
import { evaluateLearning } from "../src/evaluation.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const f = learningFixture(); stores.push(f.store); return f; }
function accepted(f: ReturnType<typeof fixture>) {
  const auth = f.authorizeReview(f.component.revision_id, "2026-10-03T12:00:00.000Z"); const consent = f.store.learnerResponse("Accept this exact review", "test");
  return f.record("review_scheduled", { component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z", consent: true, consent_response_event_id: consent.event_id, authorization_event_id: auth.event_id, reason: "Accepted review" });
}
function cancel(f: ReturnType<typeof fixture>, scheduleId: string, actor = "host", occurredAt = f.store.now()) {
  return f.store.append("decision", { action: "review_cancelled", lesson_goal_entity_id: f.goal.entity_id, schedule_event_id: scheduleId, reason: "Explicit review control", evidence_event_ids: [] }, randomUUID(), actor, "test", occurredAt);
}

test("historical context does not consume cancellation records beyond its sequence cutoff", () => {
  const f = fixture(); const schedule = accepted(f); const before = f.store.throughSeq; f.time("2026-10-03T13:00:00.000Z"); cancel(f, schedule.event_id);
  const context = compileContext(f.store, { through_seq: before, as_of_time: f.store.now() }, "", "test");
  expect((context.due_reviews as Array<{ event_id: string }>).some(r => r.event_id === schedule.event_id)).toBe(true);
});

test("a later-recorded backdated control cannot rewrite what the historical queue knew", () => {
  const f = fixture(); const schedule = accepted(f); f.time("2026-10-03T13:00:00.000Z"); cancel(f, schedule.event_id, "host", "2026-10-01T12:00:00.000Z");
  expect(reviewQueue(f.store, "test", "2026-10-01T13:00:00.000Z").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("pending");
  expect(reviewQueue(f.store, "test").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("cancelled");
});

test("non-host controls and unlinked reschedule claims cannot retire accepted work", () => {
  const f = fixture(); const schedule = accepted(f); cancel(f, schedule.event_id, "human");
  expect(reviewQueue(f.store, "test").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("pending");
  f.store.append("decision", { action: "review_rescheduled", lesson_goal_entity_id: f.goal.entity_id, schedule_event_id: schedule.event_id, new_due_at: "2026-10-04T12:00:00.000Z", reason: "Claim without committed replacement", evidence_event_ids: [] }, randomUUID(), "host", "test");
  expect(reviewQueue(f.store, "test").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("pending");
});

test("compatible preference refinements preserve reviews but changed objectives do not silently reuse them", () => {
  const f = fixture(); const schedule = accepted(f);
  const preference = f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, budget_minutes: 19 } }, "learner", "test");
  expect(reviewQueue(f.store, "test").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("pending");
  f.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: preference.revision_id, expected_goal_revision_id: preference.revision_id, body: { ...f.goal.body, objective: "A different construct" } }, "learner", "test");
  expect(reviewQueue(f.store, "test")).toHaveLength(0);
});

test("legacy mixed-conversation review selection follows the actual lesson binding and historical time", () => {
  const f = fixture(); const schedule = accepted(f); f.store.bindLesson("test", f.goal.entity_id); f.time("2026-10-02T12:00:00.000Z");
  // Synthetic additive legacy import: production defines deliberately prohibit creating a second lesson in-place.
  const revision = randomUUID(), entity = randomUUID(), operation = randomUUID();
  const created = f.store.append("decision", { action: "revision_defined", kind: "goal", revision_id: revision, reason: "Owned mixed-session migration fixture", evidence_event_ids: [] }, randomUUID(), "learner", "test");
  f.store.insertRevision(revision, entity, "goal", null, { ...f.goal.body, objective: "Other goal in a legacy conversation" }, created.seq, operation, { fixture: operation });
  f.store.bindLesson("test", entity);
  expect(reviewQueue(f.store, "test")).toHaveLength(0);
  expect(reviewQueue(f.store, "test", "2026-10-01T13:00:00.000Z").find(r => r.schedule_event_id === schedule.event_id)?.status).toBe("pending");
  expect(evaluateLearning(f.store).reviews.some(r => r.schedule_event_id === schedule.event_id)).toBe(true); // Local all-lesson analytics must retain valid archived receipts.
});

test("a separate accepted offer cannot be relabelled as an authorized replacement for another schedule", () => {
  const f = fixture(); const original = accepted(f); const due = "2026-10-04T12:00:00.000Z";
  const auth = f.authorizeReview(f.component.revision_id, due); const consent = f.store.learnerResponse("Accept a separate offer", "test");
  const separate = f.record("review_scheduled", { component_revision_id: f.component.revision_id, due_at: due, consent: true, consent_response_event_id: consent.event_id, authorization_event_id: auth.event_id, reason: "Separate acceptance, not replacement" });
  f.store.append("decision", { action: "review_rescheduled", lesson_goal_entity_id: f.goal.entity_id, schedule_event_id: original.event_id, replacement_schedule_event_id: separate.event_id, new_due_at: due, reason: "Incorrect replacement link", evidence_event_ids: [] }, randomUUID(), "host", "test");
  expect(reviewQueue(f.store, "test").find(r => r.schedule_event_id === original.event_id)?.status).toBe("pending");
});

test("unvalidated legacy schedule actor rows never become canonical pending reviews", () => {
  const f = fixture(); const auth = f.authorizeReview(f.component.revision_id, "2026-10-03T12:00:00.000Z"); const consent = f.store.learnerResponse("Accept", "test");
  f.store.append("review_scheduled", { component_revision_id: f.component.revision_id, due_at: "2026-10-03T12:00:00.000Z", consent: true, consent_response_event_id: consent.event_id, authorization_event_id: auth.event_id, reason: "Unvalidated legacy actor" }, randomUUID(), "learner", "test");
  const queue = reviewQueue(f.store, "test");
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ status: "unresolved", unresolved_reason: "Review schedule lacks canonical admission actor" });
  expect(queue.filter(r => r.status === "pending")).toHaveLength(0);
});

test("local evaluation cannot borrow a foreign legacy completion claim for an owned review", () => {
  const f = fixture(); const schedule = accepted(f); f.time("2026-10-03T13:00:00.000Z");
  const observation = f.observe(f.task("A whole retention check"), "I choose parts", "success", "retention");
  f.store.append("review_completed", { schedule_event_id: schedule.event_id, assessment_event_id: observation.assessment.event_id }, randomUUID(), "pi", "foreign");
  expect(evaluateLearning(f.store).reviews.find(r => r.schedule_event_id === schedule.event_id)?.completed).toBe(false);
});

test("invalid historical queue time is rejected rather than silently returning no reviews", () => {
  const f = fixture(); accepted(f); expect(() => reviewQueue(f.store, "test", "not-a-time")).toThrow("date-time");
});
