import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DefineSchema, LearningDefineSchema, RecordSchema, validate } from "../src/contracts.ts";

const message = (schema: Parameters<typeof validate>[0], value: unknown) => {
  try { validate(schema, value); } catch (error) { return (error as Error).message; }
  throw new Error("Expected rejection");
};

describe("operation validation diagnostics", () => {
  test("definition unions report the requested kind, not goal requirements", () => {
    for (const schema of [DefineSchema, LearningDefineSchema]) {
      for (const [kind, required] of [["rubric", "dimensions"], ["component", "behavior"], ["task_family", "construct"], ["task_definition", "prompt"]]) {
        const error = message(schema, { operation_id: "invalid", kind, body: {} });
        expect(error).toContain("/body:");
        expect(error).toContain(required!);
        expect(error).not.toContain("horizon_days");
        expect(error).not.toContain("must be equal to constant");
      }
    }
  });

  test("preparation reports its own missing authority and content fields", () => {
    const error = message(LearningDefineSchema, { operation_id: "invalid", kind: "lesson_preparation", body: {} });
    expect(error).toContain("expected_state_revision");
    expect(error).toContain("instruction");
    expect(error).not.toContain("horizon_days");
  });

  test("record unions report the selected payload and nested field path", () => {
    const missing = message(RecordSchema, { operation_id: "invalid", kind: "assessment", payload: {} });
    expect(missing).toContain("rubric_revision_id");
    expect(missing).not.toContain("declared_aids");
    const nested = message(DefineSchema, { operation_id: "invalid", kind: "rubric", body: { title: "PRIVATE CONTENT", dimensions: [{ name: "criterion", criterion: "PRIVATE CONTENT", max_score: "PRIVATE CONTENT" }], provisional: true, source_span_ids: [] } });
    expect(nested).toContain("/body/dimensions/0/max_score:");
    expect(nested).not.toContain("PRIVATE CONTENT");
  });

  test("complete union schemas still decide acceptance for valid and malformed input", () => {
    const valid = { operation_id: "valid", kind: "component", body: { title: "Component", behavior: "Explain", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Synthetic" } };
    const values = [valid, { ...valid, unexpected: true }, { ...valid, body: { ...valid.body, subject: "invalid" } }, { ...valid, kind: "unknown" }, { ...valid, kind: "lesson_preparation" }, {}, null, [], "component"];
    for (const schema of [DefineSchema, LearningDefineSchema, RecordSchema]) {
      for (const value of values) {
        if (Value.Check(schema, value)) expect(() => validate(schema, value)).not.toThrow();
        else expect(() => validate(schema, value)).toThrow("Invalid operation:");
      }
    }
  });

  test("ambiguous discriminators and ordinary schemas retain full diagnostics", () => {
    const schema = Type.Union([Type.Object({ kind: Type.Literal("same"), left: Type.String() }), Type.Object({ kind: Type.Literal("same"), right: Type.Number() })]);
    const value = { kind: "same" };
    const error = message(schema, value);
    expect(error).toContain("left");
    expect(error).toContain("right");
    expect(message(Type.Number(), "PRIVATE CONTENT")).not.toContain("PRIVATE CONTENT");
  });
});
