import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FeynmanRequestSchema, FeynmanReviewSchema, parseFeynmanReview, type FeynmanRequest, type FeynmanReview } from "../../core/src/feynman.ts";
import { validate } from "../../core/src/contracts.ts";
import type { SagePaths } from "../../runtime/src/paths.ts";
import { runBoundedPiChild, type PlannerOptions } from "./planner.ts";

export type DelegateFeynman = (request: FeynmanRequest, ctx: ExtensionContext, signal: AbortSignal) => Promise<FeynmanReview>;

/** One bounded Pi child reviews an explanation; the parent teaches and decides. */
export async function reviewWithPi(paths: SagePaths, request: FeynmanRequest, options: PlannerOptions): Promise<FeynmanReview> {
  validate<FeynmanRequest>(FeynmanRequestSchema, request);
  const text = await runBoundedPiChild(paths, { policyFile: "feynman-policy.md", operation: "pi_feynman_request", schema: FeynmanReviewSchema, request }, options);
  return parseFeynmanReview(text, request.explanation);
}
