import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InstructionDiagramSchema, parseInstructionDiagram, type InstructionDiagram, type InstructionDiagramBrief } from "../../core/src/diagram.ts";
import type { SagePaths } from "../../runtime/src/paths.ts";
import { runBoundedPiChild, type PlannerOptions } from "./planner.ts";
export type DelegateInstructionDiagram = (brief: InstructionDiagramBrief, ctx: ExtensionContext, signal: AbortSignal) => Promise<InstructionDiagram>;

/** One protected child; runtime callers must supply the current owned instruction, never raw model input. */
export async function diagramWithPi(paths: SagePaths, brief: InstructionDiagramBrief, options: PlannerOptions): Promise<InstructionDiagram> {
  if (!brief || typeof brief.instruction_revision_id !== "string" || !brief.instruction_revision_id || brief.instruction_revision_id.length > 180 || typeof brief.instruction !== "string" || !brief.instruction.trim() || brief.instruction.length > 8000) throw new Error("Instruction diagram requires a bounded current instruction brief");
  const request = { instruction_revision_id: brief.instruction_revision_id, instruction: brief.instruction };
  const parentAuthorize = options.authorize;
  if (typeof parentAuthorize !== "function") throw new Error("Instruction diagram requires current parent disclosure authorization");
  const authorize: PlannerOptions["authorize"] = async () => {
    const permit = await parentAuthorize.call(options);
    // The shared transport can append permit images; this text-only role must not inherit them or other parent facts.
    return { session_id: permit.session_id, revision: permit.revision, packet: { goal: permit.packet.goal } };
  };
  return parseInstructionDiagram(await runBoundedPiChild(paths, { operation: "pi_diagram_request", policyFile: "diagram-policy.md", schema: InstructionDiagramSchema, request }, { ...options, authorize }), request.instruction);
}
