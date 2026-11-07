// Domain model (SPEC §6). Plain types; JSON Schemas for the API boundary come with the server (M3).

export type Mode = "cram" | "learn" | "drill" | "accelerate";
export type Pace = "normal" | "speed_up";
export type Dimension = "acquisition" | "recall" | "explanation" | "selection" | "execution" | "changed_application" | "retention";
export const DIMENSIONS: readonly Dimension[] = ["acquisition", "recall", "explanation", "selection", "execution", "changed_application", "retention"];

export type ExamFormat = "mcq" | "short" | "free_response" | "problem" | "essay" | "oral" | "practical";
export interface ExamBlueprint {
  formats: ExamFormat[];
  topicWeights: { nodeOrSubskillId: string; importance: "high" | "medium" | "low" }[];
  /** A specific exam or course (exam board, a particular class). Triggers the researcher (owner reply 2, trigger d). */
  name?: string; timing?: string; gradingCriteria?: string; sampleSourceIds?: string[];
}

export interface LearningPreview {
  profile: "balanced" | "cram" | "thorough" | "custom";
  toggles: { diagnostic: boolean; hints: boolean; studio: boolean; diagrams: boolean; pdfCheatsheets: boolean; obsidianExport: boolean; reviewBeforeAdvance: boolean; autoAcceptResearch?: boolean };
  feedbackRigor: "rigorous" | "focused";
}

export interface Goal {
  objective: string; mode: Mode; pace: Pace; timeBudgetMin?: number; horizonDays?: number;
  exam?: ExamBlueprint; allowedAids: string[]; accommodations?: string; learnerParams?: string; preview: LearningPreview;
  /** Learner-attached, accepted sources. They outrank anything the researcher finds. */
  sourceIds?: string[];
}

/** declarative ⇒ recall-type; procedural ⇒ execution-type (SPEC §10 "by subskill type"). */
export type SubSkillKind = "declarative" | "procedural";
export interface SubSkill {
  id: string; nodeId: string; statement: string; kind: SubSkillKind; selectionRelevant: boolean;
  /** Any-of groups: every group needs one observed member. Set by the engine from the mode at plan approval. */
  requiredDimensions: Dimension[][];
  /** Text can't verify pronunciation, physical execution or performance; name the text-checkable proxy used instead (owner reply 2). */
  proxyFor?: string;
}
export type NodeStatus = "locked" | "ready" | "active" | "gated" | "passed" | "tested_out" | "needs_repair" | "left_with_gaps";
export interface PlanNode {
  id: string; title: string; order: number; prerequisites: string[]; subskills: SubSkill[];
  examWeight: "high" | "medium" | "low"; misconceptionsToProbe: string[]; estMinutes: number; status: NodeStatus;
  digest?: string; micro?: boolean; passedAtMin?: number;
  /** Planner's confidence in its own knowledge of this node; `low` triggers research (niche, recent, course-specific, local rules). */
  knowledgeConfidence?: "low" | "medium" | "high";
  /** Accepted sources covering this node. Empty while the learner has sources ⇒ uncovered ⇒ research. */
  sourceIds?: string[];
}
export interface Plan { rev: number; nodes: PlanNode[]; edges: [string, string][]; approvedAt?: string }

export type ActivityType = "free_recall" | "explain_why" | "apply_problem" | "conceptual_mcq" | "find_the_error" | "method_choice" | "scrap_work";
export type Partition = "teaching" | "practice" | "assessment";
export type ChangedDimension = "surface" | "representation" | "context" | "cueing" | "format" | "structure";
export type ItemKey =
  | { kind: "choice"; index: number }
  | { kind: "numeric"; value: number; tolerance: number }
  | { kind: "exact"; values: string[] }
  | { kind: "reference"; text: string }; // open response, graded by the grader role

export interface Item {
  id: string; nodeId: string; subskillIds: string[]; activityType: ActivityType; difficulty: 1 | 2 | 3 | 4 | 5;
  partition: Partition; familyId: string; fingerprint?: string;
  variation?: { baselineItemId: string; changedDimensions: ChangedDimension[]; invariant: string };
  evidences: Dimension[]; stem: string; choices?: string[]; key?: ItemKey; rubric?: string[];
  distractorRationales?: string[]; hints?: [nudge: string, strategy: string, worked: string];
  format?: ExamFormat; validated?: boolean; keyVerifiedBy?: "calculate" | "model" | "none"; sourceSpans?: string[];
  /** Set when a learner dispute showed the key was wrong: the item never counts as evidence and is never presented again. */
  voided?: string;
}

export type FlawSeverity = "blocking" | "precision" | "polish";
export interface Grade {
  score0to100: number;
  criterionEvidence: { criterion: string; satisfied: boolean | "not_observed"; quote: string }[];
  flaws: { quote: string; problem: string; suggestion: string; severity: FlawSeverity }[];
  dimensionsObserved: Dimension[]; feedback: string; grader: "deterministic" | "model"; disputed?: boolean;
}

export type AssistanceKind = "nudge" | "strategy" | "worked_step" | "chunk_peek" | "key_view" | "feedback";
export interface AssistanceRecord {
  kind: AssistanceKind; stage: "offered" | "requested" | "possibly_exposed" | "exposed";
  answerBearing: boolean; itemId: string; at: string;
}

export interface Attempt {
  id: string; itemId: string; responseEventId: string; response: string; at: string;
  assistance: AssistanceRecord[]; independent: boolean; isRepair: boolean; cueLevel: 0 | 1 | 2 | 3; latencyMs: number;
  grade?: Grade; supersededGrades?: Grade[]; diagnostic?: boolean; check?: "node_check" | "final";
}

export type HypothesisCategory = "conceptual" | "procedural" | "selection" | "representation" | "prerequisite" | "slip" | "unknown";
export interface Hypothesis {
  id: string; rev: number; subskillId: string; category: HypothesisCategory; statement: string; confidence: "low" | "medium" | "high";
  supportingAttemptIds: string[]; contradictingAttemptIds: string[]; status: "open" | "resolved" | "uncertain";
}

export type MoveKind = "teach" | "check" | "cued_retry" | "fresh_retry" | "represent_differently" | "probe_hypothesis"
  | "vary_application" | "method_choice" | "node_check" | "advance" | "checkpoint";
export interface Candidate { id: string; kind: MoveKind; targetSubskillIds: string[]; reasonCodes: string[]; evidenceIds: string[] }
export interface Decision {
  policyVersion: string; candidateIds: string[]; selectedId: string; reasonCodes: string[];
  targetSubskillIds: string[]; evidenceIds: string[]; learnerOverride?: string; at: string;
}

export type LoopPhase = "intake" | "plan_review" | "diagnostic" | "bank" | "prime" | "teach" | "check" | "grading"
  | "feedback" | "repair" | "adapt" | "node_check" | "close" | "ended";

export interface SessionState {
  activeNodeId?: string; loopPhase: LoopPhase; currentItemId?: string; openHypothesisIds: string[]; coverageDebt: string[];
  candidates: Candidate[]; nextIntendedMove: string; timeUsedMin: number; timeBudgetMin?: number; nodesPassed: number; nodesTotal: number;
  spend: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | "unknown" };
}

/** Voice recall is deferred (SPEC §16); only the input shape is defined. */
export type ResponseInput = { kind: "text"; text: string } | { kind: "choice"; index: number } | { kind: "fields"; fields: Record<string, string> }
  | { kind: "image"; blobHashes: string[] } | { kind: "audio_transcript"; text: string };

/** Researcher output (owner reply 2). Each item goes through the normal preview → accept source flow. */
export interface SourcePackItem {
  id: string; title: string; url?: string; citation?: string; relevance: string; spans: string[]; reliability: string;
  nodeId?: string; conflictsWithSourceId?: string; unsourced?: boolean;
}
export interface SourcePack { id: string; trigger: "intake" | "node_uncovered" | "low_confidence" | "exam" | "tutor_request"; nodeId?: string; question?: string; items: SourcePackItem[]; status: "pending" | "accepted" | "partially_accepted" | "declined"; acceptedItemIds: string[] }
