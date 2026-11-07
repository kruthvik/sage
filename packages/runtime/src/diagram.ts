import { SourceSchema, validate, type Artifact, type Rubric, type TaskDefinition, type Revision } from "../../core/src/contracts.ts";
import { parseInstructionDiagram, type InstructionDiagram, type InstructionDiagramBrief } from "../../core/src/diagram.ts";
import { canonical, hash, type LearningStore } from "../../storage/src/store.ts";
import { currentDisclosure } from "./disclosure.ts";
import { projectLearningState } from "./learning-state.ts";
import { publishArtifactContent } from "./artifacts.ts";
import type { SagePaths } from "./paths.ts";
export interface InstructionDiagramResult { artifact_revision_id: string; diagram: InstructionDiagram; native_preview: true; evidence_warning: string; copy_error?: string }
export type ProposeInstructionDiagram = (brief: InstructionDiagramBrief) => Promise<InstructionDiagram>;
interface DrawingInput { action: string; operation_id?: string; expected_goal_revision_id?: string; artifact_revision_id?: string; input?: string }

function currentInstruction(store: LearningStore, sessionId: string) {
  const goal = store.lessonGoal(sessionId), state = projectLearningState(store, sessionId), teaching = state.teaching;
  if (!goal || !currentDisclosure(store, sessionId).allowed || !["learn", "accelerate"].includes(goal.body.mode) || !["instruction_pending", "question_pending"].includes(state.phase) || !teaching || teaching.instance_revision_id !== null) throw new Error("Instruction diagram requires the current governed instruction, sharing and a wait for Continue; no pending question or stopped/measurement mode");
  const definition = store.revision<TaskDefinition>(teaching.definition_revision_id, "task_definition").body;
  if (definition.status !== "practice_ready" || definition.review.method === "unreviewed") throw new Error("Instruction diagram requires an approved current unit");
  for (const span of [...definition.source_span_ids, ...store.revision<Rubric>(definition.rubric_revision_id, "rubric").body.source_span_ids]) {
    if (!goal.body.source_ids.includes(store.acceptedSpan(span).source_revision_id)) throw new Error("Instruction diagram source scope changed");
  }
  const artifact = store.revision<Artifact>(teaching.instruction_revision_id, "artifact");
  if (artifact.body.goal_revision_id !== goal.revision_id || artifact.body.author !== "tutor" || !["teaching_instruction", "worked_example"].includes(artifact.body.capability) || !["text/plain", "text/markdown"].includes(artifact.body.media_type) || artifact.body.content.length > 8000) throw new Error("Instruction diagram needs a bounded owned teaching instruction, never a journal, question or arbitrary artifact");
  return { goalId: goal.revision_id, unitId: teaching.unit_id, preparedId: teaching.prepared_event_id, stateRevision: state.state_revision, brief: { instruction_revision_id: artifact.revision_id, instruction: artifact.body.content } };
}
function hostArtifact(store: LearningStore, sessionId: string, artifact: Revision<Artifact>) {
  const creator = store.events().find(e => e.seq === artifact.created_seq && e.branch === "real");
  if (!creator || creator.session_id !== sessionId || creator.actor !== "host" || creator.kind !== "decision" || creator.payload.action !== "revision_defined" || creator.payload.kind !== "artifact" || creator.payload.revision_id !== artifact.revision_id || artifact.body.capability !== "instruction_diagram" || artifact.body.author !== "tutor" || artifact.body.evidence_kind !== "artifact_only" || artifact.body.media_type !== "application/vnd.sage.instruction-diagram+json") throw new Error("Instruction diagram lacks its owned host lineage");
}
/** Same eligibility for model artifact reads; an old aid cannot bypass a newly pending question. */
export function assertInstructionDiagramReadable(store: LearningStore, sessionId: string, artifact: Revision<Artifact>): void {
  const scope = currentInstruction(store, sessionId); hostArtifact(store, sessionId, artifact);
  let provenance: unknown; try { provenance = JSON.parse(artifact.body.provenance); } catch { throw new Error("Invalid instruction diagram provenance"); }
  if (!provenance || typeof provenance !== "object" || !("kind" in provenance) || provenance.kind !== "bounded_instruction_diagram_v1" || !("unit_id" in provenance) || provenance.unit_id !== scope.unitId || !("prepared_event_id" in provenance) || provenance.prepared_event_id !== scope.preparedId || !("instruction_revision_id" in provenance) || provenance.instruction_revision_id !== scope.brief.instruction_revision_id || artifact.body.goal_revision_id !== scope.goalId) throw new Error("Instruction diagram belongs to another unit or scope");
  parseInstructionDiagram(artifact.body.content, scope.brief.instruction);
}

/** Current instruction only; no model-authored brief or autonomous task-selection loop. */
export async function createInstructionDiagram(paths: SagePaths, store: LearningStore, input: unknown, sessionId: string, propose: ProposeInstructionDiagram, assertCurrent: () => void, signal?: AbortSignal): Promise<InstructionDiagramResult> {
  validate<DrawingInput>(SourceSchema, input);
  if (input.action !== "drawing" || !input.operation_id || !input.expected_goal_revision_id || !input.artifact_revision_id || Object.entries(input).some(([key, value]) => value !== undefined && !["action", "operation_id", "expected_goal_revision_id", "artifact_revision_id"].includes(key))) throw new Error("Instruction diagram requests need operation/goal/current instruction pins and no raw input or extra source fields");
  assertCurrent(); signal?.throwIfAborted();
  const scope = currentInstruction(store, sessionId);
  if (input.expected_goal_revision_id !== scope.goalId || input.artifact_revision_id !== scope.brief.instruction_revision_id) throw new Error("Instruction diagram goal or current instruction is stale");
  const request = { action: "drawing", operation_id: input.operation_id, expected_goal_revision_id: input.expected_goal_revision_id, artifact_revision_id: input.artifact_revision_id };
  const operation = `instruction-diagram:${hash(input.operation_id)}`;
  const provenance = JSON.stringify({ kind: "bounded_instruction_diagram_v1", unit_id: scope.unitId, prepared_event_id: scope.preparedId, instruction_revision_id: scope.brief.instruction_revision_id, request_hash: hash(canonical(request)) });
  const existing = store.db.query<{ revision_id: string }, [string]>("SELECT revision_id FROM object_revision WHERE operation_id=?").get(operation);
  let artifact: Revision<Artifact>, diagram: InstructionDiagram;
  if (existing) {
    artifact = store.revision<Artifact>(existing.revision_id, "artifact"); hostArtifact(store, sessionId, artifact);
    if (artifact.body.provenance !== provenance || artifact.body.goal_revision_id !== scope.goalId) throw new Error("Instruction diagram operation was reused with different content or scope");
    diagram = parseInstructionDiagram(artifact.body.content, scope.brief.instruction);
  } else {
    diagram = parseInstructionDiagram(JSON.stringify(await propose({ ...scope.brief })), scope.brief.instruction);
    assertCurrent(); signal?.throwIfAborted();
    const now = currentInstruction(store, sessionId);
    if (now.stateRevision !== scope.stateRevision || now.unitId !== scope.unitId || now.preparedId !== scope.preparedId) throw new Error("Instruction diagram scope changed during generation; proposal discarded");
    const saved = store.define({ operation_id: operation, kind: "artifact", expected_goal_revision_id: scope.goalId, body: { capability: "instruction_diagram", goal_revision_id: scope.goalId, author: "tutor", provenance, media_type: "application/vnd.sage.instruction-diagram+json", content: JSON.stringify(diagram), evidence_kind: "artifact_only", interpretation_uncertainty: "AI-generated relationships are unverified; quoted instruction is lexical provenance, not correctness or learner performance", assistance_event_ids: [] } }, "host", sessionId);
    artifact = store.revision<Artifact>(saved.revision_id, "artifact");
  }
  let copy_error: string | undefined;
  try { await publishArtifactContent(paths, store, artifact.revision_id); }
  catch { copy_error = "Instruction diagram original saved; managed copy blocked and existing files preserved. Retry explicit export after reviewing the conflict."; }
  // A committed original may survive a scope change, but its late proposal must not be shown.
  assertCurrent(); signal?.throwIfAborted(); assertInstructionDiagramReadable(store, sessionId, artifact);
  return { artifact_revision_id: artifact.revision_id, diagram, native_preview: true, evidence_warning: "AI-generated instruction aid; meaning unverified, not learner performance or question release", ...(copy_error ? { copy_error } : {}) };
}
