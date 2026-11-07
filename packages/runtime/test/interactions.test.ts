import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ActivityRequest } from "../../core/src/interactions.ts";
import type { FeynmanReview } from "../../core/src/feynman.ts";
import type { TaskDefinition } from "../../core/src/contracts.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { prepareActivity, submitActivity, readFeynmanReview, saveFeynmanReview } from "../src/interactions.ts";
import { learningFixture } from "./learning-fixture.ts";

const stores: LearningStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(format: "mcq" | "explain" = "mcq") {
  const f = learningFixture(); stores.push(f.store);
  const extra: Partial<TaskDefinition> = format === "mcq" ? { format, scoring: "exact", answer: "B", choices: [{ id: "A", text: "Use substitution" }, { id: "B", text: "Use integration by parts" }] } : { format, scoring: "rubric" };
  const task = f.task(format === "mcq" ? "Which method fits this integral?" : "Teach a novice why this method works.", extra);
  const instance = f.deliver(task);
  const input: ActivityRequest = { action: format === "mcq" ? "mcq" : "feynman", operation_id: randomUUID(), expected_goal_revision_id: f.goal.revision_id, instance_revision_id: instance.revision_id };
  return { ...f, task, instance, input };
}

test("activity preparation supplies public choices and rubric but no answer key; cancellation stays read-only", () => {
  const f = fixture(); const before = f.store.throughSeq;
  const packet = prepareActivity(f.store, f.input, "test");
  expect(packet.choices).toEqual(f.task.body.choices);
  expect(packet.criteria).toEqual([f.goal.body.objective]);
  expect(packet).not.toHaveProperty("answer");
  expect(packet).not.toHaveProperty("definition");
  expect(packet).not.toHaveProperty("completed");
  expect(f.store.throughSeq).toBe(before);
  // A dismissed menu creates no response/attempt or evidence.
  expect(f.store.events().filter(e => e.kind === "learner_response" || e.kind === "attempt_submitted")).toEqual([]);
  expect(() => prepareActivity(f.store, { ...f.input, answer: "B" }, "test")).toThrow("Invalid operation");
  expect(() => prepareActivity(f.store, { ...f.input, action: "feynman" }, "test")).toThrow("explanation task");
});

test("MCQ definitions require distinct reviewed choices and a keyed choice; submissions validate selections", () => {
  const f = fixture(); const before = f.store.throughSeq;
  expect(() => f.task).not.toThrow();
  const create = (extra: Partial<TaskDefinition>) => f.define("task_definition", { ...f.task.body, ...extra });
  expect(() => create({ answer: "C" })).toThrow("keyed choice");
  expect(() => create({ answer: "A", choices: [{ id: "A", text: "Same" }, { id: "a", text: "Other" }] })).toThrow("distinct");
  expect(() => create({ choices: [{ id: "A", text: " Same " }, { id: "B", text: "same" }] })).toThrow("distinct");
  expect(() => create({ choices: [{ id: "A", text: "One" }] })).toThrow("Invalid operation");
  expect(() => create({ format: "free_response" })).toThrow("only to MCQ");
  expect(() => submitActivity(f.store, f.input, { text: "invalid", selected_choice_id: "C" }, "test")).toThrow("stored choices");
  expect(() => submitActivity(f.store, f.input, { text: "", selected_choice_id: "B" }, "test")).toThrow("response");
  expect(() => submitActivity(f.store, f.input, { text: "B", selected_choice_id: "B", reasoning: "x".repeat(2001) }, "test")).toThrow("response");
  expect(f.store.throughSeq).toBe(before);
});

test("actual UI choice receipts preserve reasoning, retry once and use the selected choice for exact scoring", () => {
  const f = fixture();
  const receipt = submitActivity(f.store, f.input, { text: "B", selected_choice_id: "B", reasoning: "It is a product whose derivative simplifies." }, "test");
  const response = f.store.event(receipt.response_event_id, "learner_response");
  expect(response.actor).toBe("learner");
  expect(response.payload.selected_choice_id).toBe("B");
  expect(response.payload.reasoning).toContain("product");
  expect(response.payload.instance_revision_id).toBe(f.instance.revision_id);
  const seq = f.store.throughSeq;
  expect(submitActivity(f.store, f.input, { text: "B", selected_choice_id: "B" }, "test")).toEqual(receipt);
  expect(prepareActivity(f.store, f.input, "test").completed).toEqual(receipt);
  expect(f.store.throughSeq).toBe(seq);
  expect(() => prepareActivity(f.store, f.input, "other-session")).toThrow("different scope");
  const scored = f.assess(receipt.attempt_id, f.task, "B", "failure");
  expect(scored.payload.outcome).toBe("success");
  expect(scored.payload.assessor).toBe("deterministic");
  expect(scored.payload.uncertainty).toContain("reasoning is not established");
  const wrong = { ...f.input, operation_id: randomUUID() };
  const bad = submitActivity(f.store, wrong, { text: "A", selected_choice_id: "A", reasoning: "Maybe because it is a product" }, "test");
  expect(f.assess(bad.attempt_id, f.task, "A", "success").payload.outcome).toBe("failure");
  expect(f.store.events().filter(e => e.kind === "attempt_submitted")).toHaveLength(2);
});

test("activity rejects stale goals, withheld source scope and retired tasks before capturing evidence", () => {
  const f = fixture();
  expect(() => prepareActivity(f.store, { ...f.input, expected_goal_revision_id: "old-goal" }, "test")).toThrow("changed");
  const source = randomUUID();
  const registered = f.store.append("source_status", { source_revision_id: source, status: "received" }, randomUUID(), "learner", "test");
  f.store.insertRevision(source, randomUUID(), "source", null, { title: "Private source" }, registered.seq, randomUUID(), {});
  f.store.db.query("INSERT INTO source_span(span_id,source_revision_id,ordinal,locator,text,method,confidence) VALUES(?,?,?,?,?,?,?)").run(`${source}:0`, source, 0, "line 1", "Private problem text", "utf8-lines-v1", 1);
  f.store.append("source_accepted", { source_revision_id: source, status: "indexed" }, randomUUID(), "learner", "test");
  const sourced = f.define("task_definition", { ...f.task.body, source_span_ids: [`${source}:0`] });
  const instance = f.deliver(sourced as typeof f.task);
  expect(() => prepareActivity(f.store, { ...f.input, instance_revision_id: instance.revision_id }, "test")).toThrow("sharing permissions");
  f.define("task_definition", { ...f.task.body, status: "retired" }, f.task);
  expect(() => prepareActivity(f.store, f.input, "test")).toThrow("available task");
  expect(f.store.events().filter(e => e.kind === "learner_response")).toEqual([]);
});

test("Feynman review requires real explanation, remains diagnostic and records conservative scoped support", () => {
  const f = fixture("explain");
  const explanation = "The first factor becomes simpler when differentiated.";
  const review: FeynmanReview = { summary: "Mechanism needs clarification", strengths: ["Names differentiation"], gaps: [{ quote: "becomes simpler", issue: "May leave why this helps unclear", question: "Why does simpler help?" }], follow_up: "Why does a simpler factor help us finish the integral?", uncertainty: "An explanation alone does not prove independent application." };
  expect(() => saveFeynmanReview(f.store, f.input, review, "test")).toThrow("actual captured explanation");
  const receipt = submitActivity(f.store, f.input, { text: explanation }, "test");
  expect(receipt.explanation).toBe(explanation);
  expect(readFeynmanReview(f.store, f.input, "test")).toBeUndefined();
  const before = f.store.throughSeq;
  expect(() => saveFeynmanReview(f.store, f.input, { ...review, gaps: [{ ...review.gaps[0]!, quote: "invented" }] }, "test")).toThrow("verbatim");
  expect(f.store.throughSeq).toBe(before);
  expect(saveFeynmanReview(f.store, f.input, review, "test")).toEqual(review);
  expect(readFeynmanReview(f.store, f.input, "test")).toEqual(review);
  const seq = f.store.throughSeq;
  expect(saveFeynmanReview(f.store, f.input, review, "test")).toEqual(review);
  expect(f.store.throughSeq).toBe(seq);
  expect(f.store.events().filter(e => e.kind === "assessment")).toEqual([]);
  const support = f.store.events().find(e => e.operation_id === `feynman-help:${f.input.operation_id}`)!;
  expect(support.payload).toMatchObject({ instance_revision_id: f.instance.revision_id, attempt_id: receipt.attempt_id, component_revision_ids: [f.component.revision_id], stage: "possibly_exposed", kind: "feedback", answer_bearing: true, content: review.follow_up });
  expect(f.state().independent_performance.success).toBe(0);
});

test("native open response captures actual text once without a child, assistance or an assessment", () => {
  const f = fixture("explain");
  const input = { ...f.input, action: "open_response" };
  const before = f.store.throughSeq;
  const packet = prepareActivity(f.store, input, "test");
  expect(packet.prompt).toBe(f.task.body.prompt);
  expect(packet.criteria).toEqual([f.goal.body.objective]);
  expect(packet.choices).toBeUndefined();
  expect(f.store.throughSeq).toBe(before);
  const text = "The operation preserves the invariant. Changing only one side breaks it; a nonzero counterexample shows why.";
  const receipt = submitActivity(f.store, packet.request, { text }, "test");
  expect(f.store.event(receipt.response_event_id, "learner_response").payload.text).toBe(text);
  expect(f.store.events().filter(event => event.kind === "attempt_submitted")).toHaveLength(1);
  expect(f.store.events().filter(event => ["assessment", "assistance"].includes(event.kind))).toEqual([]);
  const saved = f.store.throughSeq;
  expect(submitActivity(f.store, packet.request, { text: "A retry must not overwrite my actual answer" }, "test")).toEqual(receipt);
  expect(f.store.throughSeq).toBe(saved);
});

test("native open response rejects MCQ tasks and selection metadata without writing evidence", () => {
  const mcq = fixture();
  const before = mcq.store.throughSeq;
  expect(() => prepareActivity(mcq.store, { ...mcq.input, action: "open_response" }, "test")).toThrow("text-response task");
  expect(mcq.store.throughSeq).toBe(before);
  const f = fixture("explain");
  const packet = prepareActivity(f.store, { ...f.input, action: "open_response" }, "test");
  const seq = f.store.throughSeq;
  expect(() => submitActivity(f.store, packet.request, { text: "Actual words", selected_choice_id: "B" }, "test")).toThrow("selection metadata");
  expect(() => submitActivity(f.store, packet.request, { text: " " }, "test")).toThrow("response");
  expect(() => submitActivity(f.store, packet.request, { text: "x".repeat(8001) }, "test")).toThrow("response");
  expect(f.store.throughSeq).toBe(seq);
});
