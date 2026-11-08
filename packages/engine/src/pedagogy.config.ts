// Every constant cites its docs/RESEARCH_MAP.md row. ED-* rows are owner-approved engineering defaults (2026-11-07), not research findings.
import type { Dimension, Mode, Pace, SubSkill } from "../../core/src/types.ts";

export const POLICY_VERSION = "v4.0";

export const PASS_MARK = 80;                       // ED-01
export const K_CHECKS: Record<Mode, Record<Pace, number>> = {          // ED-02, ED-03
  cram: { normal: 2, speed_up: 1 }, learn: { normal: 3, speed_up: 3 }, drill: { normal: 1, speed_up: 1 }, accelerate: { normal: 2, speed_up: 1 },
};
export const minFamilies = (k: number) => Math.min(k, 2);              // ED-04, ED-05
export const CHUNK_WORDS: Record<Mode, number> = { cram: 150, learn: 120, drill: 150, accelerate: 150 }; // ED-07
export const CHECK_CHUNK_OVERLAP_MAX = 0.35;       // ED-08 share of the check's content-word 4-grams found in the chunk
export const DIAGNOSTIC: Record<Mode, { maxItems: number; maxMin: number } | null> = {             // ED-09
  cram: { maxItems: 6, maxMin: 8 }, learn: { maxItems: 6, maxMin: 8 }, drill: null, accelerate: { maxItems: 12, maxMin: 12 },
};
export const NODE_CHECK_SIZE: Record<Mode, number> = { cram: 5, learn: 7, drill: 4, accelerate: 4 }; // ED-10 (midpoints of 4–6 / 6–8)
export const NODE_CHECK_SIZE_SPEED_UP = 3;         // ED-10
export const NODE_CHECK_THIS_NODE_SHARE = 0.6;     // ED-11
export const REPAIR_MICRO_MIN = 5;                 // ED-13
export const PACE_OVERRUN = 1.1;                   // ED-14
export const IDLE_GAP_MS = 3 * 60_000;             // ED-15
export const STRUGGLE_FAILURES = 2;                // ED-17
export const STRUGGLE_LATENCY_FACTOR = 3;          // ED-17
export const STRUGGLE_LATENCY_MIN_MS = 90_000;     // ED-17
export const BANK_SIZE = 12;                       // ED-18
export const RETENTION_MIN_DELAY_MS = 86_400_000;  // ED-19, RM-15
export const REVIEW_FIRST_DAYS = 2;                // ED-20, RM-14 (owner chose v3 baseline over FSRS)
export const HIGH_OPEN_HYPOTHESIS_BLOCKS = true;   // ED-21
export const HYPOTHESIS_RESOLVE_AFTER = 2;         // independent passes on probes that resolve a hypothesis (engine-side; the tutor rarely resolved them)
export const MAX_PROBES = 3;                       // graded probes per hypothesis; still open after that → "uncertain" (no longer blocks the gate)
export const DIGEST_TOKENS = 120;                  // ED-22
export const FEEDBACK_WORDS = 60;                  // ED-24
// ED-25 (owner reply 2): deductions apply only to a met criterion worded imprecisely; partly met criteria get partial credit instead.
export const DEDUCTION = { precision: 7, precisionRange: [5, 10], polish: 1, polishRange: [0, 2], polishCap: 4 } as const;
export const CALIBRATION = { maxMae: 8, maxMeanSignedError: 3, lenientCeiling: { target: 85, score: 95 }, lowTarget: 70, maxItemOver: 20 } as const; // §18.4 + owner reply 2; lowTarget/maxItemOver owner 2026-11-08 (signed ≤ +3 also on A1–A10 and on targets ≤ 70; no item > +20)
export const RESEARCH = { maxSearches: 6, maxFetches: 6, maxOutputTokens: 4096 } as const; // ED-28
export const REPEATED_FAILURE_ESCALATION = 2;      // ED-26, RM-16
export const MAX_CUE_LEVEL = 3;                    // ED-27, RM-04

/** Required dimension groups per mode (ED-06 = SPEC §10). Each inner array is any-of. */
export function requiredDimensions(mode: Mode, s: Pick<SubSkill, "kind" | "selectionRelevant">): Dimension[][] {
  const core: Dimension = s.kind === "procedural" ? "execution" : "recall";
  switch (mode) {
    case "cram": case "accelerate": return [[core], ["explanation", "selection"], ["changed_application"]];
    case "learn": return [["recall"], ["explanation"], ...(s.kind === "procedural" ? [["execution"] as Dimension[]] : []), ...(s.selectionRelevant ? [["selection"] as Dimension[]] : []), ["changed_application"]];
    case "drill": return s.selectionRelevant ? [["execution"], ["selection"]] : [["execution"]];
  }
}

/** Prime: generation before instruction. ED-12 narrows SPEC §10 to procedural subskills (P2 is procedural-only). */
export const primeFor = (mode: Mode, pace: Pace, s: Pick<SubSkill, "kind">) => (mode === "cram" || mode === "learn") && pace === "normal" && s.kind === "procedural";

/** What each core activity can evidence (SPEC §7.2). Retention is added by delay, not by type. */
export const ACTIVITY_EVIDENCE: Record<string, Dimension[]> = {
  free_recall: ["recall", "acquisition"], explain_why: ["explanation"], apply_problem: ["execution", "changed_application"],
  conceptual_mcq: ["selection"], find_the_error: ["explanation", "selection"], method_choice: ["selection"], scrap_work: ["execution"],
  // Library (owner chose these three for Phase 1). Ordering/matching are recognition of a structure, so recall/acquisition only.
  ordering: ["recall", "acquisition"], matching: ["recall", "acquisition"], contrasting_cases: ["explanation", "selection"],
};

// ED-29 (engineering estimate, 2026-11-07; recalibrate from real sessions): learner minutes per independent item by the
// dimension it evidences, per teaching chunk and per node-check item, and a factor for failed attempts and retries.
// The plan-fit estimate (pacing.ts) is built from these and the gate itself (required dimensions, K, prime, node check size).
export const ITEM_MIN: Record<Dimension, number> = { recall: 1, acquisition: 1, selection: 1, explanation: 2, execution: 2, changed_application: 2.5, retention: 1 };
export const CHUNK_MIN = 1.5;
export const CHECK_ITEM_MIN = 1.5;
export const RETRY_FACTOR = 1.2;
