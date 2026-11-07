import type { Candidate, MoveKind, PlanNode, SubSkill } from "../../core/src/types.ts";
import { gate, type EvidenceView, type GateResult } from "./evidence.ts";
import { passed } from "./items.ts";
import { POLICY_VERSION, REPEATED_FAILURE_ESCALATION } from "./pedagogy.config.ts";
import type { EngineState } from "./state.ts";

export const view = (s: EngineState): EvidenceView => ({ items: s.items, attempts: s.attempts, hypotheses: s.hypotheses, deliveredAt: s.deliveredAt });
export const activeNode = (s: EngineState): PlanNode | undefined => s.plan?.nodes.find(n => n.id === s.activeNodeId);
export const subskill = (s: EngineState, id: string): SubSkill | undefined => s.plan?.nodes.flatMap(n => n.subskills).find(x => x.id === id);
export const gates = (s: EngineState, n: PlanNode): Map<string, GateResult> => new Map(n.subskills.map(x => [x.id, gate(x, s.goal.mode, s.goal.pace, view(s))]));
const attemptsOn = (s: EngineState, id: string) => s.attempts.filter(a => !a.isRepair && s.items.get(a.itemId)?.subskillIds.includes(id));

/**
 * ≤4 next-move candidates + checkpoint, in v3's transparent priority order (SPEC §9.6):
 * prerequisite repair / discriminating hypothesis → fresh work after help → error-sensitive correction →
 * varied application / selection → conditional advance. Stop/constraints are learner controls, so checkpoint is always offered.
 */
export function nextCandidates(s: EngineState): Candidate[] {
  const node = activeNode(s);
  if (!node) return [];
  const g = gates(s, node);
  const out: Candidate[] = [];
  const add = (kind: MoveKind, targets: string[], reasons: string[], evidenceIds: string[] = []) => {
    if (!out.some(c => c.kind === kind && c.targetSubskillIds.join() === targets.join())) out.push({ id: `${POLICY_VERSION}:${kind}:${targets.join(",")}`, kind, targetSubskillIds: targets, reasonCodes: reasons, evidenceIds });
  };
  for (const h of s.hypotheses.values()) if (h.status === "open" && node.subskills.some(x => x.id === h.subskillId)) add("probe_hypothesis", [h.subskillId], [`open_${h.category}_hypothesis`], [h.id]);
  for (const x of node.subskills) {
    const r = g.get(x.id)!, mine = attemptsOn(s, x.id), last = mine.at(-1);
    if (!mine.length) { add(s.chunk?.subskillIds.includes(x.id) ? "check" : "teach", [x.id], ["no_evidence_yet"]); continue; }
    if (r.passed) continue;
    const fails = mine.filter(a => a.grade && !passed(a.grade)).length;
    const lastFailed = !!last?.grade && !passed(last.grade);
    // After a failure: cues descend strongest → weaker (on success too), then a different representation, then a fresh item from a new family (SPEC §9.6, RM-04).
    const ladder = s.cue.get(x.id);
    if (ladder && ladder.level > 0 && last) add("cued_retry", [x.id], ["diminishing_cues_after_failure"], [last.id]);
    if (lastFailed && fails >= REPEATED_FAILURE_ESCALATION) add("represent_differently", [x.id], ["repeated_failure"], [last!.id]);
    if (last && (lastFailed ? !ladder || ladder.level === 0 : !last.independent)) add("fresh_retry", [x.id], [lastFailed ? "uncued_retry_after_cues" : "fresh_work_after_help"], [last.id]);
    if (r.missing.some(m => m.includes("changed_application"))) add("vary_application", [x.id], ["changed_application_unobserved"]);
    if (r.missing.some(m => m.includes("selection")) && x.selectionRelevant) add("method_choice", [x.id], ["selection_unobserved"]);
    if (r.missing.some(m => m.startsWith("independent_checks") || m.startsWith("families") || m.startsWith("dimension:"))) add("check", [x.id], ["more_independent_evidence_needed"]);
  }
  if ([...g.values()].every(r => r.passed)) add("node_check", node.subskills.map(x => x.id), ["all_subskill_gates_passed"]);
  const capped = out.slice(0, 4);
  capped.push({ id: `${POLICY_VERSION}:checkpoint`, kind: "checkpoint", targetSubskillIds: [], reasonCodes: ["natural_pause"], evidenceIds: [] });
  return capped;
}
