import type { AssistanceRecord, Attempt, Candidate, Decision, Goal, Grade, Hypothesis, Item, LoopPhase, Plan, ResponseInput } from "../../core/src/types.ts";

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
  candidates: Candidate[]; nextIntendedMove: string;
  check?: { nodeId: string; itemIds: string[]; idx: number; final: boolean };
  diagnostic: { status: "none" | "pending" | "running" | "skipped" | "done"; startedAt?: string };
  time: { lastAt?: string; nodeMs: Map<string, number>; idleGaps: number; noticeNodeId?: string; noticeProjectedMin?: number };
  confirm: Map<string, string>; counter: number;
  reviews: ReviewCard[]; leftWithGaps: Map<string, string[]>;
  spend: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | "unknown" };
  timeline: TimelineEntry[];
}

export type EngineEvent =
  | { type: "session_created"; sessionId: string; goal: Goal }
  | { type: "plan_proposed"; plan: Plan }
  | { type: "plan_edited"; plan: Plan }
  | { type: "plan_approved" }
  | { type: "bank_generated"; purpose: "node" | "diagnostic" | "topup"; nodeId?: string; items: Item[] }
  | { type: "chunk_presented"; text: string; subskillIds: string[]; exampleItemId?: string }
  | { type: "item_presented"; itemId: string; adhoc?: Item }
  | { type: "hint_requested"; level: 1 | 2 | 3 }
  | { type: "chunk_peeked" }
  | { type: "response_submitted"; input: ResponseInput; responseEventId: string; latencyMs: number }
  | { type: "grade_received"; attemptId: string; grade: Grade }
  | { type: "feedback_acked"; attemptId: string }
  | { type: "grade_disputed"; attemptId: string; argument: string }
  | { type: "move_selected"; candidateId: string; reasonCodes: string[]; nextIntendedMove: string }
  | { type: "hypothesis_proposed"; hypothesis: Omit<Hypothesis, "rev"> }
  | { type: "control"; action: "teach" | "morePractice" | "advance" | "leaveWithGaps" | "stop" | "resume"; confirmToken?: string }
  | { type: "pace_set"; pace: "normal" | "speed_up" }
  | { type: "time_extended"; minutes: number }
  | { type: "reviews_consented"; subskillIds: string[] }
  | { type: "digest_written"; nodeId: string; digest: string }
  | { type: "role_call_logged"; role: string; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "tick" };

/** Who may emit each event (DESIGN.md). The reducer rejects anything else, so a model can't author learner work (F10). */
export const EVENT_ACTOR: Record<EngineEvent["type"], "learner" | "role" | "tutor" | "host"> = {
  session_created: "learner", plan_edited: "learner", plan_approved: "learner", hint_requested: "learner", chunk_peeked: "learner",
  response_submitted: "learner", feedback_acked: "learner", grade_disputed: "learner", control: "learner", pace_set: "learner",
  time_extended: "learner", reviews_consented: "learner",
  plan_proposed: "role", bank_generated: "role", grade_received: "role", digest_written: "role", role_call_logged: "host",
  chunk_presented: "tutor", item_presented: "tutor", move_selected: "tutor", hypothesis_proposed: "tutor", tick: "host",
};

export type Effect =
  | { kind: "call_role"; role: "planner" | "generator" | "grader" | "summarizer"; purpose: string; input: Record<string, unknown> }
  | { kind: "tutor_turn"; phase: LoopPhase; tools: readonly string[]; candidates: Candidate[] }
  | { kind: "present_chunk"; text: string }
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
  | { kind: "item_rejected"; itemId: string; problems: string[] };

export type PublicItem = Pick<Item, "id" | "nodeId" | "activityType" | "stem" | "choices" | "format" | "difficulty">;
export const publicItem = (i: Item): PublicItem => ({ id: i.id, nodeId: i.nodeId, activityType: i.activityType, stem: i.stem, choices: i.choices, format: i.format, difficulty: i.difficulty });

/** Phase-relevant tool advertising (F9, SPEC §12.3). */
export const TOOLS_BY_PHASE: Partial<Record<LoopPhase, readonly string[]>> = {
  diagnostic: ["context", "present"], prime: ["context", "present"], teach: ["context", "present", "activity"],
  check: ["context", "present", "activity"], adapt: ["context", "select_move", "propose"], repair: ["context"],
};

export function initialState(): EngineState {
  return {
    sessionId: "", goal: undefined as unknown as Goal, phase: "intake", stopped: false,
    items: new Map(), attempts: [], hypotheses: new Map(), decisions: [], deliveredAt: new Map(), exposedFamilies: new Map(),
    chunkCollapsed: false, cue: new Map(), disputed: new Set(), candidates: [], nextIntendedMove: "",
    diagnostic: { status: "none" }, time: { nodeMs: new Map(), idleGaps: 0 }, confirm: new Map(), counter: 0,
    reviews: [], leftWithGaps: new Map(), spend: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, timeline: [],
  };
}
