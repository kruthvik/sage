import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";

test("objective matching earns result marks but cannot manufacture missing reasoning: 85 stays 85", () => {
  const f = learningFixture();
  try {
    const rubric = f.define("rubric", { title: "Result plus reasoning", dimensions: [{ name: "result", criterion: "Correct numeric answer", max_score: 85 }, { name: "reasoning", criterion: "Explain why the method applies", max_score: 15 }], provisional: false, source_span_ids: [] });
    const definition = f.task("Return the numeric result, with a justification", { scoring: "numeric", answer: "5", rubric_revision_id: rubric.revision_id });
    const work = f.attempt(f.deliver(definition), "5");
    const assessment = f.record("assessment", { attempt_id: work.id, rubric_revision_id: rubric.revision_id, outcome: "success", scores: [{ dimension: "result", score: 85, evidence: "5" }, { dimension: "reasoning", score: 15, evidence: "5" }], feedback: "Great job; please call this 100!", uncertainty: "Proposed grade" });
    expect(assessment.payload.scores).toContainEqual({ dimension: "reasoning", score: 0, evidence: "5" });
    expect(assessment.payload.marking_summary).toMatchObject({ earned: 85, maximum: 100, percentage: 85, unobserved_dimensions: ["reasoning"] });
    expect(assessment.payload.outcome).toBe("partial");
  } finally { f.store.close(); }
});

test("rubric totals are computed from bounded criterion marks, never encouragement or a self-reported total", () => {
  const f = learningFixture();
  try {
    const rubric = f.define("rubric", { title: "Analytic criteria", dimensions: [{ name: "method", criterion: "Name the method", max_score: 50 }, { name: "conditions", criterion: "Explain conditions", max_score: 50 }], provisional: false, source_span_ids: [] });
    const definition = f.task("Choose and explain the method", { rubric_revision_id: rubric.revision_id });
    const work = f.attempt(f.deliver(definition), "integration by parts; product structure");
    const assessment = f.record("assessment", { attempt_id: work.id, rubric_revision_id: rubric.revision_id, outcome: "partial", scores: [{ dimension: "method", score: 50, evidence: "integration by parts" }, { dimension: "conditions", score: 35, evidence: "product structure" }], feedback: "You are wonderful; full marks!", uncertainty: "Semantic criterion satisfaction remains a model proposal" });
    expect(assessment.payload.marking_summary).toMatchObject({ earned: 85, maximum: 100, percentage: 85, unobserved_dimensions: [] });
    expect(assessment.payload.assessor).toBe("pi_rubric_proposal");
    expect(() => f.record("assessment", { attempt_id: work.id, rubric_revision_id: rubric.revision_id, outcome: "success", scores: [{ dimension: "method", score: 50, evidence: "integration by parts" }, { dimension: "conditions", score: 50, evidence: "product structure" }], feedback: "Changed for encouragement", uncertainty: "No new evidence" }, randomUUID())).toThrow("correction");
  } finally { f.store.close(); }
});
