import type { Assessment, Hypothesis } from "./contracts.ts";

export const POLICY_VERSION = "transparent-2";
export const PROJECTOR_VERSION = "2";
export type LearningActionType = "teach" | "orient" | "worked_example" | "completion_problem" | "scaffold" | "hint" | "independent_practice" | "retrieval" | "contrast" | "interleave" | "discriminate" | "transfer_check" | "representation_change" | "prerequisite_repair" | "misconception_probe" | "fade_support" | "review" | "assessment" | "advance" | "checkpoint";
export interface EvidenceSummary {
  success: number; partial: number; failure: number; not_observed: number;
  evidence_ids: string[]; last_observed_at?: string;
}
export interface HypothesisView extends Hypothesis {
  id: string; revision_id: string; derived_status: Hypothesis["status"];
  evidence_balance: "supported_only" | "mixed" | "contradicted" | "unknown";
  uncertainty: string;
}
export interface FamilyExposure {
  family_key: string; family_revision_ids: string[]; attempts: number; recent_attempts: number; independent_successes: number;
  definition_revision_ids: string[]; last_attempt_at: string;
}
export interface ReviewProposal {
  component_revision_id: string; due_at: string; due: boolean; interval_days: number;
  policy_version: string; reason_codes: string[]; evidence_ids: string[];
  task_requirement: string; confidence: "low"; requires_consent: true;
}
/** Decision features, not probabilities or calibrated psychometric scores. */
export interface NextActionCandidate {
  id: string; type: LearningActionType; target_component_revision_ids: string[];
  reason_codes: string[]; supporting_evidence_ids: string[]; hypothesis_revision_ids: string[];
  features: {
    goal_relevance: "active"; deadline_relevance: "near" | "later" | "unspecified";
    prerequisite_blockage: boolean; evidence_uncertainty: "high" | "medium";
    support_dependency: "observed" | "unknown" | "not_recently_observed";
    retention_need: boolean; transfer_need: boolean; discrimination_need: boolean;
    family_overexposure: boolean; coverage_debt: string[];
    learner_cost: "small" | "moderate";
  };
  constraints: string[]; policy_version: string;
}
export function evidenceSummary(items: Array<{ outcome: Assessment["outcome"]; assessment_event_id: string; observed_at: string }>): EvidenceSummary {
  const summary: EvidenceSummary = { success: 0, partial: 0, failure: 0, not_observed: 0, evidence_ids: [] };
  for (const item of items) {
    summary[item.outcome as "success" | "partial" | "failure" | "not_observed"]++;
    summary.evidence_ids.push(item.assessment_event_id);
    if (!summary.last_observed_at || item.observed_at > summary.last_observed_at) summary.last_observed_at = item.observed_at;
  }
  return summary;
}
