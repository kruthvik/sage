import type { Component, Goal, Revision } from "../../core/src/contracts.ts";
import { POLICY_VERSION, type ReviewProposal } from "../../core/src/learning.ts";
import type { ComponentView } from "../../storage/src/projection.ts";

/** Transparent, replaceable baseline. Dates offer checks; they never fabricate forgetting. */
export function proposeReviews(goal: Goal, views: ComponentView[], components: Revision<Component>[], asOfTime: string): ReviewProposal[] {
  if (goal.horizon_days <= 0) return [];
  const metadata = new Map(components.map(c => [c.revision_id, c.body]));
  return views.flatMap(view => {
    const successful = view.independent.filter(o => o.outcome === "success").sort((a, b) => a.observed_at.localeCompare(b.observed_at)).at(-1);
    if (!successful) return [];
    const component = metadata.get(view.component_revision_id);
    const delayed = view.independent.filter(o => o.purpose === "retention" && o.delay_days !== null && o.delay_days >= view.retention_evidence.minimum_delay_days).sort((a, b) => a.observed_at.localeCompare(b.observed_at)).at(-1);
    const minimum = component?.retention_delay_days ?? 1;
    // 2 days is a convenient starting offer, not a scientifically optimal interval.
    const initial = Math.max(minimum, Math.min(2, Math.max(1, Math.floor(goal.horizon_days / 3))));
    let interval = delayed?.outcome === "success" ? Math.max(initial, Math.round(delayed.delay_days! * 2)) : initial;
    if (delayed?.outcome === "failure") interval = minimum;
    interval = Math.max(minimum, Math.min(interval, Math.max(minimum, Math.floor(goal.horizon_days / 2))));
    const anchor = view.last_relevant_practice_at ?? successful.observed_at;
    let due = Date.parse(anchor) + interval * 86400000;
    if (goal.deadline) {
      const lastUseful = Date.parse(goal.deadline) - 86400000;
      if (lastUseful < Date.parse(anchor) + minimum * 86400000) return [];
      due = Math.min(due, lastUseful);
      interval = (due - Date.parse(anchor)) / 86400000;
    }
    const kind = component?.knowledge_kind ?? "complex";
    return [{ component_revision_id: view.component_revision_id, due_at: new Date(due).toISOString(), due: due <= Date.parse(asOfTime), interval_days: interval,
      policy_version: POLICY_VERSION, reason_codes: ["independent_success_observed", delayed ? `previous_delayed_${delayed.outcome}` : "delayed_evidence_missing", "transparent_interval_offer_not_forgetting_prediction"],
      evidence_ids: [...new Set([successful.assessment_event_id, ...(delayed ? [delayed.assessment_event_id] : [])])], confidence: "low" as const, requires_consent: true as const,
      task_requirement: kind === "declarative" ? "Attempt meaningful recall without showing the answer; retain actual allowed aids." : "Use a fresh goal-relevant problem, distinction, explanation, code/debugging case or argument; not an automatic flashcard." }];
  }).sort((a, b) => a.due_at.localeCompare(b.due_at) || a.component_revision_id.localeCompare(b.component_revision_id));
}
