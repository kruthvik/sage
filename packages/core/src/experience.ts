import { Type, type Static } from "typebox";
export const learningProfiles = ["balanced", "cram", "thorough", "custom"] as const;
export const learningFeatures = ["mcq", "teach_back", "scrap_work", "browser_ui", "planner"] as const;
export const LearningPreferencesSchema = Type.Object({
  profile: Type.Enum([...learningProfiles]),
  features: Type.Object({ mcq: Type.Boolean(), teach_back: Type.Boolean(), scrap_work: Type.Boolean(), browser_ui: Type.Boolean(), planner: Type.Boolean() }, { additionalProperties: false }),
  feedback: Type.Enum(["rigorous", "focused"]),
  review_before_advance: Type.Boolean(),
  parameters: Type.String({ maxLength: 2000 }),
}, { additionalProperties: false });
export type LearningPreferences = Static<typeof LearningPreferencesSchema>;
export function profilePreferences(profile: LearningPreferences["profile"] = "balanced"): LearningPreferences {
  return { profile, features: { mcq: true, teach_back: profile === "thorough", scrap_work: true, browser_ui: true, planner: profile !== "cram" }, feedback: "rigorous", review_before_advance: true, parameters: "" };
}
export const FeedbackReviewSchema = Type.Object({
  ready_to_continue: Type.Boolean(),
  issues: Type.Array(Type.Object({ quote: Type.String({ minLength: 1, maxLength: 1200 }), problem: Type.String({ minLength: 1, maxLength: 2000 }), suggestion: Type.String({ minLength: 1, maxLength: 2000 }), severity: Type.Enum(["blocking", "precision", "polish"]) }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });
export type FeedbackReview = Static<typeof FeedbackReviewSchema>;
