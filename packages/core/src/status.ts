/** Human-facing status reports observations and uncertainty, never a global mastery score. */
export function formatLearningStatus(packet: Record<string, unknown>): string {
  const goal = packet.goal as { body: { mode: string; objective: string; target_format: string; horizon_days: number; budget_minutes?: number; constraints: string[] } } | null;
  if (!goal) return "Sato · no active learning goal\nStart /learn or /exam. Use /login and /model to configure your provider, or learn demo for an offline lesson.";
  const lines = [`${goal.body.mode === "exam" ? "Preparing" : "Learning"}: ${goal.body.objective}`, `Target: ${goal.body.target_format}`, `Horizon: ${goal.body.horizon_days} days${goal.body.budget_minutes ? ` · session budget ${goal.body.budget_minutes} minutes (you choose when to stop)` : ""}`];
  const names = new Map(((packet.available_objects ?? []) as Array<{ revision_id: string; title?: string }>).map(r => [r.revision_id, r.title ?? r.revision_id]));
  type Observation = { outcome: string; observed_at: string; delay_days: number | null; changes: string[] };
  type Summary = { success: number; partial: number; failure: number; not_observed: number; last_observed_at?: string };
  const components = (packet.components ?? []) as Array<{ component_revision_id: string; title?: string; independent: Observation[]; supported: Observation[]; retained: Observation[]; applied: Observation[]; supported_performance?: Summary; uncertain_performance?: Summary; retention_evidence?: Summary; transfer_evidence?: Summary; guidance_state?: string; coverage_debt?: string[] }>;
  lines.push("", "Observed evidence:");
  if (!components.some(c => c.independent.length || c.supported.length)) lines.push("No assessed attempts yet. Prior knowledge remains unknown.");
  for (const c of components) {
    if (!c.independent.length && !c.supported.length) continue;
    lines.push(`${c.title ?? names.get(c.component_revision_id) ?? "Current component"}:`);
    const independent = c.independent.at(-1);
    if (independent) lines.push(`  Independent: ${independent.outcome}, observed ${independent.observed_at.slice(0, 10)}`);
    if (c.supported.length) {
      const count = c.supported_performance && c.uncertain_performance ? c.supported_performance.success + c.supported_performance.partial + c.supported_performance.failure + c.uncertain_performance.success + c.uncertain_performance.partial + c.uncertain_performance.failure : c.supported.length;
      lines.push(`  With support or uncertain aid conditions: ${count} recorded observation(s)`);
    }
    const retained = c.retained.at(-1);
    lines.push(retained ? `  Retention: observed after ${retained.delay_days?.toFixed(1)} days` : c.retention_evidence?.failure ? `  Delayed retention: ${c.retention_evidence.failure} unsuccessful check(s), last ${c.retention_evidence.last_observed_at?.slice(0, 10)}` : "  Delayed retention: unverified");
    const applied = c.applied.at(-1);
    lines.push(applied ? `  Application: ${applied.changes.join(", ") || "documented changed conditions"} (task-specific, not broad transfer)` : c.transfer_evidence?.failure ? `  Changed application: ${c.transfer_evidence.failure} unsuccessful check(s)` : "  Changed-context application: unverified");
    if (c.guidance_state) lines.push(`  Guidance: ${c.guidance_state.replace(/_/g, " ")} (provisional)`);
  }
  const checkpoint = packet.checkpoint as { payload: { summary: string; next_action: string; gaps: string[] } } | null;
  if (checkpoint) {
    lines.push("", `Checkpoint: ${checkpoint.payload.summary}`, `Next: ${checkpoint.payload.next_action}`);
    if (checkpoint.payload.gaps.length) lines.push(`Open questions: ${checkpoint.payload.gaps.join("; ")}`);
  }
  const due = (packet.due_reviews ?? []) as Array<{ payload: { component_revision_id: string; due_at: string } }>;
  if (due.length) lines.push("", "Reviews you agreed to:", ...due.map(r => `  ${names.get(r.payload.component_revision_id) ?? "Component"} · ${r.payload.due_at.slice(0, 10)}`));
  if (goal.body.constraints.length) lines.push("", `Your constraints: ${goal.body.constraints.join("; ")}`);
  if ((packet.omissions as string[] | undefined)?.length) lines.push("", "Some history was omitted to keep this view short; request a specific component for more detail.");
  lines.push("", "These are dated observations. Current ability is unverified until tested again; missed reviews are missing evidence.");
  return lines.join("\n");
}
