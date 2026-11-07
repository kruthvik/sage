import { expect, test } from "bun:test";
import { formatLearningStatus } from "../src/status.ts";
const goal = { body: { mode: "learn", objective: "Choose a method", target_format: "reasoning", horizon_days: 7, constraints: [] } };

test("native status exposes saved phase, pending work and the next broad-plan move without making ability claims", () => {
  const status = formatLearningStatus({ goal, learning_state: { phase: "awaiting_answer", pending_count: 1, plan: { next_activities: ["Check method choice", "Try transfer"] } }, task: { definition: { body: { title: "Explain your method" } } }, components: [] });
  expect(status).toContain("Current action: awaiting answer");
  expect(status).toContain("Current task: Explain your method");
  expect(status).toContain("Saved plan: Check method choice");
  expect(status).toContain("No assessed attempts yet");
  const stopped = formatLearningStatus({ goal, learning_state: { phase: "stopped", resume_phase: "awaiting_answer", pending_count: 1 }, components: [] });
  expect(stopped).toContain("Resume at: awaiting answer");
  expect(stopped).not.toContain("completed");
});

test("status uses the canonical launcher and reads current direct review-queue fields", () => {
  expect(formatLearningStatus({ goal: null })).toContain("sage demo");
  expect(formatLearningStatus({ goal: null })).not.toContain("learn demo");
  const status = formatLearningStatus({ goal, components: [], due_reviews: [{ component_revision_id: "component", due_at: "2026-10-10T12:00:00.000Z" }] });
  expect(status).toContain("2026-10-10");
  expect(formatLearningStatus({ goal: null, disclosure: { allowed: false, reason: "sharing_disabled" } })).toContain("authorization paused");
});
