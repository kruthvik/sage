import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { learningFeatures, learningProfiles, profilePreferences, type LearningPreferences } from "../../core/src/experience.ts";
const labels = { balanced: "Balanced · general learning", cram: "Cram · deadline-focused practice", thorough: "Thorough · explanations and precision", custom: "Custom · keep your own switches" };
const featureLabels = { mcq: "MCQ", teach_back: "Teach-back", scrap_work: "Scrap-work images", browser_ui: "Browser activity studio", planner: "Optional planning child" };

/** A native single-choice profile plus independent switches, not learning-style classification. */
export async function learningPreview(ctx: ExtensionContext, previous?: LearningPreferences): Promise<LearningPreferences | undefined> {
  let prefs = previous ? structuredClone(previous) : profilePreferences();
  if (!ctx.hasUI) return prefs;
  for (;;) {
    const profiles = learningProfiles.map(profile => `${prefs.profile === profile ? "◉" : "○"} ${labels[profile]}`);
    const features = learningFeatures.map(feature => `${prefs.features[feature] ? "☑" : "☐"} ${featureLabels[feature]}`);
    const options = [...profiles, ...features, `Feedback: ${prefs.feedback}`, `${prefs.review_before_advance ? "☑" : "☐"} Review before automatic advancement`, "Specific learning parameters", "Start with these settings", "Cancel"];
    const choice = await ctx.ui.select("Sage learning preview · profile and features", options);
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "Start with these settings") return prefs;
    const profileIndex = profiles.indexOf(choice), featureIndex = features.indexOf(choice);
    if (profileIndex >= 0) {
      const profile = learningProfiles[profileIndex]!;
      prefs = profile === "custom" ? { ...prefs, profile } : { ...profilePreferences(profile), parameters: prefs.parameters };
    } else if (featureIndex >= 0) {
      const feature = learningFeatures[featureIndex]!;
      prefs.features[feature] = !prefs.features[feature];
    } else if (choice.startsWith("Feedback:")) prefs.feedback = prefs.feedback === "rigorous" ? "focused" : "rigorous";
    else if (choice.includes("Review before automatic")) prefs.review_before_advance = !prefs.review_before_advance;
    else if (choice === "Specific learning parameters") {
      const text = await ctx.ui.editor("Learning parameters: scope, available time, deadline, format, allowed aids, desired feedback. Esc keeps the current value.", prefs.parameters);
      if (text !== undefined) {
        if (text.length > 2000) ctx.ui.notify("Keep parameters within 2000 characters; add longer material as a source.", "warning");
        else prefs.parameters = text;
      }
    }
  }
}
