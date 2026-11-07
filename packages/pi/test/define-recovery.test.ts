import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { LearningDefineSchema } from "../../core/src/contracts.ts";
import { createTutorExtension, type TutorBridge } from "../src/tutor.ts";

function fixture() {
  const tools = new Map<string, ToolDefinition>(), writes: unknown[] = [];
  const bridge: TutorBridge = { operation: async (_name, body) => { writes.push(body); return {}; }, input: async () => {}, goal: async () => ({}), source: async () => [], approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {} };
  createTutorExtension(bridge)({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  return { tool: tools.get("learning_define")!, tools, writes };
}

test("definition recovery: object-root advertisement retains every original kind and exact union authority", () => {
  const { tool, tools } = fixture();
  const parameters = tool.parameters as unknown as { type: string; properties: { kind: { enum: string[] } } };
  expect(parameters.type).toBe("object");
  expect(parameters.properties.kind.enum).toEqual(LearningDefineSchema.anyOf.map(branch => branch.properties.kind.const));
  expect(tools.size).toBe(7);
  for (const branch of LearningDefineSchema.anyOf) {
    const input = Value.Create(branch);
    expect(Value.Check(LearningDefineSchema, input)).toBe(true);
    for (const candidate of [input, { ...input, body: {} }, { ...input, extra: true }, { ...input, kind: "lesson" }]) {
      expect(Value.Check(tool.parameters, candidate)).toBe(Value.Check(LearningDefineSchema, candidate));
    }
    const original = JSON.stringify(input);
    expect(tool.prepareArguments!(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(original);
  }
});

test("definition recovery: aliases and missing body fields get actionable diagnostics without private values or writes", () => {
  const { tool, writes } = fixture();
  expect(typeof tool.prepareArguments).toBe("function");
  for (const kind of ["lesson", "learning operation", "component", "task_family", "lesson_preparation", "task_definition"]) {
    let error = "";
    try { tool.prepareArguments!({ operation_id: "owned", kind, body: { private_note: "PRIVATE-MARKER" } }); } catch (cause) { error = (cause as Error).message; }
    expect(error).toContain(kind === "lesson" || kind === "learning operation" ? "lesson_preparation" : kind);
    expect(error).not.toContain("PRIVATE-MARKER");
    expect(error.length).toBeGreaterThan(20);
  }
  expect(() => tool.prepareArguments!({ operation_id: "owned", kind: "component", title: "PRIVATE-MARKER" })).toThrow("/body");
  expect(writes).toEqual([]);
});

test("definition recovery: kind-specific optional-null normalization produces valid input before SDK conversion", () => {
  const { tool } = fixture();
  const branch = LearningDefineSchema.anyOf.find(branch => branch.properties.kind.const === "component")!;
  const input = { ...Value.Create(branch), entity_id: null, parent_revision_id: null, body: { title: "Owned", behavior: "Explain a synthetic rule", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Synthetic", importance: null } };
  const original = JSON.stringify(input);
  const prepared = tool.prepareArguments!(input);
  expect(Value.Check(LearningDefineSchema, prepared)).toBe(true);
  const normalized = prepared as { kind: string; entity_id?: string; body: { importance?: string; behavior: string } };
  expect(normalized.kind).toBe("component"); expect(normalized.body.importance).toBeUndefined();
  expect(normalized.entity_id).toBeUndefined(); expect(normalized.body.behavior).toBe(input.body.behavior);
  expect(JSON.stringify(input)).toBe(original);
});

test("definition recovery: no scalar coercion, unknown-key deletion or required-null repair", () => {
  const { tool, writes } = fixture();
  const branch = LearningDefineSchema.anyOf.find(branch => branch.properties.kind.const === "component")!;
  const base = Value.Create(branch);
  for (const body of [{ ...base.body, title: 123 }, { ...base.body, behavior: null }, { ...base.body, unknown_field: null }]) {
    expect(() => tool.prepareArguments!({ ...base, body })).toThrow();
  }
  expect(writes).toEqual([]);
});
