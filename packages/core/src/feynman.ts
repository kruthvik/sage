import { Type, type Static } from "typebox";
import { validate } from "./contracts.ts";

const short = Type.String({ minLength: 1, maxLength: 1200 });
export const FeynmanRequestSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 4000 }),
  explanation: Type.String({ minLength: 1, maxLength: 12000 }),
  criteria: Type.Array(short, { maxItems: 8 }),
  objective: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
export type FeynmanRequest = Static<typeof FeynmanRequestSchema>;

/** A bounded child proposal, never a grade or independent performance claim. */
export const FeynmanReviewSchema = Type.Object({
  summary: short,
  strengths: Type.Array(short, { maxItems: 3 }),
  gaps: Type.Array(Type.Object({ quote: short, issue: short, question: short }, { additionalProperties: false }), { maxItems: 3 }),
  follow_up: short,
  uncertainty: short,
}, { additionalProperties: false });
export type FeynmanReview = Static<typeof FeynmanReviewSchema>;

export function parseFeynmanReview(text: string, explanation: string): FeynmanReview {
  if (text.length > 12000) throw new Error("Teach-back review output exceeds its bound");
  const normalized = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  const review: unknown = JSON.parse(normalized);
  validate<FeynmanReview>(FeynmanReviewSchema, review);
  for (const gap of review.gaps) {
    if (!gap.quote.trim() || !explanation.includes(gap.quote)) throw new Error("Teach-back review quotes must appear verbatim in the learner explanation");
  }
  return review;
}
