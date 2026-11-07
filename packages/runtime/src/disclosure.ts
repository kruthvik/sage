import type { LearningStore } from "../../storage/src/store.ts";

export interface DisclosureState { allowed: boolean; reason: "authorized" | "no_lesson" | "sharing_disabled" | "source_scope_changed" | "legacy_provenance_unknown" }
export interface DisclosurePermit { session_id: string; revision: string; packet: Record<string, unknown>; images?: Array<{ type: "image"; data: string; mimeType: string }> }

/** Conservative disclosure scope, NOT a substring sanitizer or a historical deletion.
 * Text may have influenced later reasoning without an explicit reference. If an earlier
 * source scope is no longer authorized, quarantine the lesson, including copied goal text.
 * The learner can explicitly reselect still-accepted sources or start a fresh lesson.
 */
export function currentDisclosure(store: LearningStore, sessionId: string): DisclosureState {
  const goal = store.lessonGoal(sessionId);
  if (!goal) return { allowed: false, reason: "no_lesson" };
  if (!goal.body.provider_sharing) return { allowed: false, reason: "sharing_disabled" };
  const events = store.events(), revisions = store.revisions();
  const owned = new Set(events.filter(e => e.session_id === sessionId).map(e => e.seq));
  const byRevision = new Map(revisions.map(r => [r.revision_id, r]));
  const byEvent = new Map(events.map(e => [e.event_id, e]));
  const bySeq = new Map(events.map(e => [e.seq, e]));
  const spans = new Map(store.db.query<{ span_id: string; source_revision_id: string }, []>("SELECT span_id,source_revision_id FROM source_span").all().map(s => [s.span_id, s.source_revision_id]));
  const required = new Set<string>(), seen = new Set<string>();
  let unknown = false;
  const scan = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(scan); return; }
    for (const [key, item] of Object.entries(value)) {
      const ids = typeof item === "string" ? [item] : Array.isArray(item) ? item.filter((v): v is string => typeof v === "string") : [];
      for (const id of ids) {
        if (key === "source_ids" || key === "source_revision_id") required.add(id);
        else if (/^source_span_ids?$/.test(key)) { const source = spans.get(id); if (source) required.add(source); else unknown = true; }
        else if (/_revision_ids?$/.test(key)) visitRevision(id);
        else if (/_event_ids?$/.test(key)) visitEvent(id);
      }
      scan(item);
    }
  };
  const visitEvent = (id: string): void => {
    if (seen.has(`e:${id}`)) return;
    seen.add(`e:${id}`);
    const event = byEvent.get(id);
    if (!event) { unknown = true; return; }
    if (event.actor === "pi" && !event.payload.disclosure_scope) unknown = true;
    scan(event.payload);
  };
  const visitRevision = (id: string): void => {
    if (seen.has(`r:${id}`)) return;
    seen.add(`r:${id}`);
    const revision = byRevision.get(id);
    if (!revision) { unknown = true; return; }
    if (revision.kind === "source") { required.add(id); return; }
    const author = bySeq.get(revision.created_seq);
    if (author?.actor === "pi" && !author.payload.disclosure_scope) unknown = true;
    // Source-free static fixture metadata can be reused. Other shared revisions
    // retain the creating conversation's possible source influence.
    if (author && author.session_id !== sessionId && author.actor !== "curated_fixture") {
      for (const original of revisions.filter(r => r.kind === "goal" && bySeq.get(r.created_seq)?.session_id === author.session_id)) scan(original.body);
    }
    scan(revision.body);
    if (revision.parent_revision_id) visitRevision(revision.parent_revision_id);
  };
  revisions.filter(r => owned.has(r.created_seq)).forEach(r => visitRevision(r.revision_id));
  events.filter(e => e.session_id === sessionId).forEach(e => visitEvent(e.event_id));
  if (store.lessonGoals(sessionId).length > 1 && events.some(e => e.session_id === sessionId && e.kind === "learner_response" && !e.payload.goal_revision_id)) unknown = true;
  if (unknown) return { allowed: false, reason: "legacy_provenance_unknown" };
  if ([...required].some(id => !goal.body.source_ids.includes(id) || store.sourceStatus(id) !== "indexed")) return { allowed: false, reason: "source_scope_changed" };
  return { allowed: true, reason: "authorized" };
}
