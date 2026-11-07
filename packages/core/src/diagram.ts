import { Type, type Static } from "typebox";
import { validate } from "./contracts.ts";
const printable = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]+$" });
const id = Type.String({ pattern: "^[a-z][a-z0-9_]{0,15}$" }), quote = Type.String({ minLength: 1, maxLength: 240 });
export const InstructionDiagramSchema = Type.Object({
  title: printable(120),
  nodes: Type.Array(Type.Object({ id, label: printable(80), quote }, { additionalProperties: false }), { minItems: 2, maxItems: 6 }),
  edges: Type.Array(Type.Object({ from: id, to: id, label: printable(80), quote }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
  explanation: printable(600),
}, { additionalProperties: false });
export type InstructionDiagram = Static<typeof InstructionDiagramSchema>;
export interface InstructionDiagramBrief { instruction_revision_id: string; instruction: string }

function check(value: unknown): asserts value is InstructionDiagram {
  validate<InstructionDiagram>(InstructionDiagramSchema, value);
  const ids = new Set(value.nodes.map(n => n.id)), referenced = new Set(value.edges.flatMap(e => [e.from, e.to]));
  if (ids.size !== value.nodes.length || value.edges.some(e => e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) || value.nodes.some(n => !referenced.has(n.id)) || new Set(value.edges.map(e => `${e.from}:${e.to}:${e.label}`)).size !== value.edges.length) throw new Error("Invalid instruction diagram references");
}

/** Lexical quote binding, not semantic verification of a relationship or learning claim. */
export function parseInstructionDiagram(text: string, instruction: string): InstructionDiagram {
  try {
    if (text.length > 32768) throw new Error("Diagram bound");
    const value: unknown = JSON.parse(text); check(value);
    if ([...value.nodes, ...value.edges].some(item => !item.quote.trim() || !instruction.includes(item.quote))) throw new Error("Diagram quote does not belong to the current instruction");
    return value;
  } catch { throw new Error("Invalid instruction diagram proposal, references or quoted instruction evidence"); }
}

export function nativeInstructionDiagram(value: unknown): string {
  check(value);
  const number = (id: string) => value.nodes.findIndex(n => n.id === id) + 1;
  return [`AI instruction diagram: ${value.title}`, ...value.nodes.map((node, i) => `[${i + 1}] ${node.label}`), "Relationships (arrow direction is explicit):", ...value.edges.map(edge => `[${number(edge.from)}] -- ${edge.label} --> [${number(edge.to)}]`), value.explanation, "AI-generated aid; relationship meaning unverified; not learner performance."].join("\n");
}
