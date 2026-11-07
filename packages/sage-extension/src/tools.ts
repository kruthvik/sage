// Tutor tools (SPEC §12.3): context, select_move, present, propose, activity, request_research.
// Plain JSON Schema + an execute that turns a call into one engine event; pi-adapter wraps these into pi ToolDefinitions.
// Grading, scoring, gating, scheduling and time are deliberately not tools.
import type { EngineEvent, EngineState } from "../../engine/src/state.ts";
import type { ActivityType, Item } from "../../core/src/types.ts";
import { ACTIVITY_EVIDENCE } from "../../engine/src/pedagogy.config.ts";

export interface TutorBridge {
  state(): EngineState;
  /** Apply a tutor event through the reducer. Returns undefined on success or the engine's rejection message. */
  dispatch(ev: EngineEvent): string | undefined;
  drill(id: string): string;
}
export interface SageTool { name: string; label: string; description: string; parameters: Record<string, unknown>; /** A successful call hands control back (to the learner or the next phase); later turn-ending calls in the same run are refused. */ endsTurn: boolean; run(params: Record<string, unknown>, b: TutorBridge): string }

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const S = { type: "string" }, SA = { type: "array", items: { type: "string" } };
const ok = (b: TutorBridge, what: string) => `ok: ${what}. Now in phase ${b.state().phase}. End your turn.`;

export const SAGE_TOOLS: SageTool[] = [
  { name: "context", label: "Context", endsTurn: false, description: "Look up one id from the packet (item, attempt, hypothesis, node, source) for more detail. Read-only.",
    parameters: obj({ id: S }, ["id"]), run: (p, b) => b.drill(String(p.id)) },
  { name: "select_move", label: "Select move", endsTurn: true, description: "Adapt phase: choose one of the offered candidate moves.",
    parameters: obj({ candidateId: S, reasonCodes: SA, nextIntendedMove: { type: "string", description: "≤30 words" } }, ["candidateId", "reasonCodes", "nextIntendedMove"]),
    run: (p, b) => b.dispatch({ type: "move_selected", candidateId: String(p.candidateId), reasonCodes: (p.reasonCodes as string[]) ?? [], nextIntendedMove: String(p.nextIntendedMove ?? "") }) ?? ok(b, "move selected") },
  { name: "present", label: "Present", endsTurn: true,
    description: "Teach phase: present a chunk (text + subskillIds, optionally exampleItemId of a teaching item as a worked example). Check/prime/diagnostic phase: present a practice bank item by itemId.",
    parameters: obj({ text: S, subskillIds: SA, exampleItemId: S, itemId: S }, []),
    run: (p, b) => {
      if (typeof p.itemId === "string" && p.itemId) return b.dispatch({ type: "item_presented", itemId: p.itemId }) ?? ok(b, `item ${p.itemId} shown; the learner answers next`);
      if (typeof p.text === "string" && p.text) return b.dispatch({ type: "chunk_presented", text: p.text, subskillIds: (p.subskillIds as string[]) ?? [], ...(typeof p.exampleItemId === "string" && p.exampleItemId ? { exampleItemId: p.exampleItemId } : {}) }) ?? ok(b, "chunk shown");
      return "error: give either itemId, or text with subskillIds";
    } },
  { name: "activity", label: "Activity", endsTurn: true,
    description: `Write and present one ad hoc practice item when no unused bank item fits. activityType and evidences must match: ${Object.entries(ACTIVITY_EVIDENCE).map(([a, d]) => `${a}→${d.join("/")}`).join("; ")}. MCQ needs choices, key {kind:"choice",index}, distractorRationales; open answers need a rubric (2-4 criteria) and key {kind:"reference",text}.`,
    parameters: obj({ activityType: { type: "string", enum: Object.keys(ACTIVITY_EVIDENCE) }, subskillIds: SA, evidences: SA, stem: S, difficulty: { type: "integer", minimum: 1, maximum: 5 },
      choices: SA, key: { type: "object" }, rubric: SA, distractorRationales: SA, hints: SA }, ["activityType", "subskillIds", "evidences", "stem"]),
    run: (p, b) => {
      const s = b.state(), id = `adhoc-${s.items.size + 1}`;
      const item: Item = { id, nodeId: s.activeNodeId ?? "", subskillIds: p.subskillIds as string[], activityType: p.activityType as ActivityType, difficulty: Math.min(5, Math.max(1, Number(p.difficulty) || 2)) as Item["difficulty"],
        partition: "practice", familyId: `${id}.f`, evidences: p.evidences as Item["evidences"], stem: String(p.stem),
        ...(Array.isArray(p.choices) ? { choices: p.choices as string[] } : {}), ...(p.key && typeof p.key === "object" ? { key: p.key as Item["key"] } : {}),
        ...(Array.isArray(p.rubric) ? { rubric: p.rubric as string[] } : {}), ...(Array.isArray(p.distractorRationales) ? { distractorRationales: p.distractorRationales as string[] } : {}),
        ...(Array.isArray(p.hints) && p.hints.length === 3 ? { hints: p.hints as [string, string, string] } : {}) };
      return b.dispatch({ type: "item_presented", itemId: id, adhoc: item }) ?? ok(b, `ad hoc item ${id} shown; the learner answers next`);
    } },
  { name: "propose", label: "Propose hypothesis", endsTurn: false, description: "Adapt phase: record a hypothesis about a specific misconception, citing attempt ids. Does not end the adapt phase; still select a move after.",
    parameters: obj({ subskillId: S, category: { type: "string", enum: ["conceptual", "procedural", "selection", "representation", "prerequisite", "slip", "unknown"] }, statement: S,
      confidence: { type: "string", enum: ["low", "medium", "high"] }, supportingAttemptIds: SA }, ["subskillId", "category", "statement", "confidence", "supportingAttemptIds"]),
    run: (p, b) => b.dispatch({ type: "hypothesis_proposed", hypothesis: { id: `h${b.state().hypotheses.size + 1}`, subskillId: String(p.subskillId), category: p.category as never, statement: String(p.statement),
      confidence: p.confidence as never, supportingAttemptIds: (p.supportingAttemptIds as string[]) ?? [], contradictingAttemptIds: [], status: "open" } }) ?? "ok: hypothesis recorded. Now select a move." },
  { name: "request_research", label: "Request research", endsTurn: false, description: "Queue background research with one precise question (1-300 chars). Does not pause the lesson.",
    parameters: obj({ question: S }, ["question"]), run: (p, b) => b.dispatch({ type: "research_requested", question: String(p.question) }) ?? "ok: research queued; keep teaching." },
];
