import type { AssistanceRecord, Attempt, Candidate, Decision, Goal, Grade, Hypothesis, Item, ItemKey, LoopPhase, Plan, ResponseInput, SourcePack, SourcePackItem } from "../../core/src/types.ts";

import type { PlanFit } from "./pacing.ts";
export interface Chunk { text: string; nodeId: string; subskillIds: string[]; exampleItemId?: string; at: string; prime?: boolean }
export interface ReviewCard { subskillId: string; intervalDays: number; dueAt: string; consented: boolean }
export interface TimelineEntry { at: string; kind: string; text: string }

export interface EngineState {
  sessionId: string; goal: Goal; plan?: Plan; phase: LoopPhase; stopped: boolean;
  activeNodeId?: string;
  items: Map<string, Item>; attempts: Attempt[]; hypotheses: Map<string, Hypothesis>; decisions: Decision[];
  deliveredAt: Map<string, string>;            // itemId → first presentation
  exposedFamilies: Map<string, string>;        // familyId → first answer-bearing exposure (worked example, feedback, answer-bearing hint)
  chunk?: Chunk; chunkCollapsed: boolean;
  current?: { itemId: string; presentedAt: string; cueLevel: 0 | 1 | 2 | 3; assistance: AssistanceRecord[]; prime: boolean; familyExposedBefore: boolean; mode: "loop" | "diagnostic" | "node_check" | "final" };
  cue: Map<string, { itemId: string; level: 0 | 1 | 2 | 3 }>; // subskillId → diminishing-cue ladder after a failure
  pendingAttemptId?: string;                   // awaiting grade
  feedbackAttemptId?: string;                  // awaiting feedback.ack
  repairAttemptId?: string;                    // blocking flaw needs repair
  disputed: Set<string>;
  probing?: string;                            // hypothesis the current probe move targets
  probes: Map<string, number>;                 // hypothesisId → graded probes so far (capped by MAX_PROBES)
  candidates: Candidate[]; nextIntendedMove: string;
  check?: { nodeId: string; itemIds: string[]; idx: number; final: boolean };
  diagnostic: { status: "none" | "pending" | "running" | "skipped" | "done"; startedAt?: string };
  time: { lastAt?: string; nodeMs: Map<string, number>; idleGaps: number; noticeNodeId?: string; noticeProjectedMin?: number };
  confirm: Map<string, string>; counter: number;
  reviews: ReviewCard[]; leftWithGaps: Map<string, string[]>;
  packs: Map<string, SourcePack>; researchKeys: Set<string>;   // researcher packs; trigger keys already requested (cache)
  spend: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | "unknown" };
  timeline: TimelineEntry[];
  /** Photo intake for the current item (SPEC §7: per-message consent; the learner confirms the transcription before scoring). */
  scrap?: { itemId: string; blobHashes: string[]; status: "reading" | "review"; text?: string };
}

export type EngineEvent =
  | { type: "session_created"; sessionId: string; goal: Goal }
  | { type: "plan_proposed"; plan: Plan }
  | { type: "plan_edited"; plan: Plan }
  | { type: "plan_approved" }
  | { type: "bank_generated"; purpose: "node" | "diagnostic" | "topup" | "replace"; nodeId?: string; items: Item[] }
  | { type: "chunk_presented"; text: string; subskillIds: string[]; exampleItemId?: string }
  | { type: "item_presented"; itemId: string; adhoc?: Item }
  | { type: "hint_requested"; level: 1 | 2 | 3 }
  | { type: "chunk_peeked" }
  /** The learner opened a cited source span. The host fills `text` from the source store, never from the client. */
  | { type: "source_opened"; spanId: string; text: string }
  | { type: "response_submitted"; input: ResponseInput; responseEventId: string; latencyMs: number }
  | { type: "grade_received"; attemptId: string; grade: Grade }
  | { type: "key_dispute_resolved"; attemptId: string; keyWrong: boolean; correctedKey?: ItemKey; reason: string }
  | { type: "plan_nodes_merged"; nodeIds: string[] }
  | { type: "feedback_acked"; attemptId: string }
  | { type: "grade_disputed"; attemptId: string; argument: string }
  | { type: "move_selected"; candidateId: string; reasonCodes: string[]; nextIntendedMove: string }
  | { type: "hypothesis_proposed"; hypothesis: Omit<Hypothesis, "rev"> }
  | { type: "control"; action: "teach" | "morePractice" | "advance" | "leaveWithGaps" | "stop" | "resume"; confirmToken?: string }
  | { type: "pace_set"; pace: "normal" | "speed_up" }
  | { type: "time_extended"; minutes: number }
  | { type: "reviews_consented"; subskillIds: string[] }
  | { type: "digest_written"; nodeId: string; digest: string; cheatSheet?: string[] }
  | { type: "role_call_logged"; role: string; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "research_requested"; question: string }
  | { type: "research_pack_received"; pack: Omit<SourcePack, "status" | "acceptedItemIds">; items?: SourcePackItem[] }
  | { type: "research_pack_accepted"; packId: string; itemIds?: string[] }
  | { type: "image_consented"; blobHashes: string[]; provider: string; model: string }
  | { type: "transcription_proposed"; text: string }
  | { type: "transcription_confirmed"; text: string; responseEventId: string; latencyMs: number }
  | { type: "tick" };

/** Who may emit each event (DESIGN.md). The reducer rejects anything else, so a model can't author learner work (F10). */
export const EVENT_ACTOR: Record<EngineEvent["type"], "learner" | "role" | "tutor" | "host"> = {
  session_created: "learner", plan_edited: "learner", plan_approved: "learner", hint_requested: "learner", chunk_peeked: "learner", source_opened: "learner",
  response_submitted: "learner", feedback_acked: "learner", grade_disputed: "learner", control: "learner", pace_set: "learner",
  time_extended: "learner", reviews_consented: "learner", research_pack_accepted: "learner", research_requested: "tutor", research_pack_received: "role",
  plan_proposed: "role", bank_generated: "role", grade_received: "role", key_dispute_resolved: "role", plan_nodes_merged: "learner", digest_written: "role", role_call_logged: "host",
  chunk_presented: "tutor", item_presented: "tutor", move_selected: "tutor", hypothesis_proposed: "tutor", tick: "host",
  image_consented: "learner", transcription_proposed: "role", transcription_confirmed: "learner",
};

export type Effect =
  | { kind: "call_role"; role: "planner" | "generator" | "grader" | "summarizer" | "researcher" | "transcriber"; purpose: string; background?: boolean; input: Record<string, unknown> }
  | { kind: "tutor_turn"; phase: LoopPhase; tools: readonly string[]; candidates: Candidate[] }
  | { kind: "present_chunk"; text: string; sourceSpans?: string[] }
  | { kind: "present_item"; item: PublicItem; cueText?: string }
  | { kind: "reveal_hint"; level: 1 | 2 | 3; text: string }
  | { kind: "show_chunk"; text: string }
  | { kind: "present_feedback"; attemptId: string; grade: Grade }
  | { kind: "repair_required"; attemptId: string; flaws: Grade["flaws"] }
  | { kind: "offer_hint"; text: string }
  | { kind: "pace_notice"; text: string; options: string[] }
  | { kind: "confirm_required"; action: string; token: string; text: string }
  | { kind: "notice"; code: string; text: string }
  | { kind: "gate_update"; nodeId: string; subskillId: string; passed: boolean; stm: number; missing: string[] }
  | { kind: "node_status"; nodeId: string; status: string }
  | { kind: "write_export"; what: "session" | "node" | "final" }
  | { kind: "checkpoint" }
  | { kind: "item_rejected"; itemId: string; problems: string[] }
  | { kind: "plan_fit"; fit: PlanFit }
  | { kind: "transcription_review"; itemId: string; text: string };

export type PublicItem = Pick<Item, "id" | "nodeId" | "activityType" | "stem" | "choices" | "targets" | "cases" | "format" | "difficulty">;
export const publicItem = (i: Item): PublicItem => ({ id: i.id, nodeId: i.nodeId, activityType: i.activityType, stem: i.stem, choices: i.choices, ...(i.targets ? { targets: i.targets } : {}), ...(i.cases ? { cases: i.cases } : {}), format: i.format, difficulty: i.difficulty });

/** Phase-relevant tool advertising (F9, SPEC §12.3). */
export const TOOLS_BY_PHASE: Partial<Record<LoopPhase, readonly string[]>> = {
  diagnostic: ["context", "present"], prime: ["context", "present"], teach: ["context", "present", "activity", "request_research"],
  check: ["context", "present", "activity", "request_research"], adapt: ["context", "select_move", "propose", "request_research"], repair: ["context"],
};

export function initialState(): EngineState {
  return {
    sessionId: "", goal: undefined as unknown as Goal, phase: "intake", stopped: false,
    items: new Map(), attempts: [], hypotheses: new Map(), decisions: [], deliveredAt: new Map(), exposedFamilies: new Map(),
    chunkCollapsed: false, cue: new Map(), disputed: new Set(), probes: new Map(), candidates: [], nextIntendedMove: "",
    diagnostic: { status: "none" }, time: { nodeMs: new Map(), idleGaps: 0 }, confirm: new Map(), counter: 0,
    reviews: [], leftWithGaps: new Map(), packs: new Map(), researchKeys: new Set(), spend: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, timeline: [],
  };
}
