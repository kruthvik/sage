// Tutor context packet (SPEC §12, F11). Ported in spirit from v3 runtime/src/context.ts: hard char cap, explicit omissions,
// stable cacheable prefix, then the volatile part. Never raw history, never keys or rubrics.
import type { EngineState } from "../../engine/src/state.ts";
import { publicItem } from "../../engine/src/state.ts";
import { sessionState } from "../../engine/src/loop.ts";
import type { Candidate } from "../../core/src/types.ts";

export const PACKET_MAX_CHARS = 12_000;
export const BRAIN_DIGEST_MAX = 1_800;
export interface Packet { prefix: string; dynamic: string; chars: number; omitted: string[] }

const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export function buildPacket(s: EngineState, candidates: Candidate[], task: string, maxChars = PACKET_MAX_CHARS): Packet {
  const omitted: string[] = [];
  const g = s.goal;
  const node = s.plan?.nodes.find(n => n.id === s.activeNodeId);

  const mode = `## Session\nmode ${g.mode}, pace ${g.pace}${g.timeBudgetMin ? `, budget ${g.timeBudgetMin} min` : ""}; feedback ${g.preview.feedbackRigor}; hints ${g.preview.toggles.hints ? "on" : "off"}\nobjective: ${clip(g.objective, 300)}${g.learnerParams ? `\nlearner: ${clip(g.learnerParams, 300)}` : ""}${g.accommodations ? `\naccommodations: ${clip(g.accommodations, 200)}` : ""}`;
  let digest = (s.plan?.nodes ?? []).filter(n => n.digest).map(n => `- ${n.title}: ${n.digest}`).join("\n");
  if (digest.length > BRAIN_DIGEST_MAX) { digest = clip(digest, BRAIN_DIGEST_MAX); omitted.push("older node digests (truncated)"); }
  const outline = `## Plan\n${(s.plan?.nodes ?? []).map(n => `${n.id} ${n.status}: ${clip(n.title, 80)}`).join("\n")}`;
  const prefix = [mode, digest ? `## What the learner has shown\n${digest}` : "", outline].filter(Boolean).join("\n\n");

  const st = sessionState(s);
  const card = node ? `## Active node ${node.id}: ${node.title}\n${node.subskills.slice(0, 4).map(x => `- ${x.id} (${x.kind}${x.selectionRelevant ? ", choose-the-method" : ""}): ${clip(x.statement, 200)}${x.proxyFor ? ` [text proxy: ${clip(x.proxyFor, 120)}]` : ""}`).join("\n")}${node.subskills.length > 4 ? `\n(${node.subskills.length - 4} more subskills omitted; use context("${node.id}"))` : ""}${node.misconceptionsToProbe.length ? `\nmisconceptions to probe: ${node.misconceptionsToProbe.join("; ")}` : ""}` : "";
  const now = `## Now\nphase ${st.loopPhase}; time ${st.timeUsedMin}${st.timeBudgetMin ? `/${st.timeBudgetMin}` : ""} min; nodes ${st.nodesPassed}/${st.nodesTotal}${st.coverageDebt.length ? `\nstill missing: ${st.coverageDebt.slice(0, 8).join(", ")}` : ""}${s.nextIntendedMove ? `\nyou intended next: ${clip(s.nextIntendedMove, 200)}` : ""}`;
  const nodeItems = new Set([...s.items.values()].filter(i => i.nodeId === node?.id).map(i => i.id));
  const recent = s.attempts.filter(a => nodeItems.has(a.itemId)).slice(-6);
  const evidence = recent.length ? `## Recent attempts (newest last)\n${recent.map(a => `- ${a.id} on ${a.itemId}: ${a.grade ? `${a.grade.score0to100}` : "ungraded"}${a.independent ? "" : " (helped)"}${a.grade?.flaws.filter(f => f.severity !== "polish").slice(0, 2).map(f => `; "${clip(f.quote, 60)}" ${clip(f.problem, 80)}`).join("") ?? ""}`).join("\n")}` : "";
  const hyps = [...s.hypotheses.values()].filter(h => h.status === "open");
  const hyp = hyps.length ? `## Open hypotheses\n${hyps.slice(0, 3).map(h => `- ${h.id} ${h.category} (${h.confidence}): ${clip(h.statement, 160)}`).join("\n")}` : "";
  if (hyps.length > 3) omitted.push(`${hyps.length - 3} hypotheses`);
  const cands = candidates.length ? `## Candidate moves (choose one with select_move)\n${candidates.slice(0, 5).map(c => `- ${c.id} ${c.kind} → ${c.targetSubskillIds.join(",")} [${c.reasonCodes.join(",")}]`).join("\n")}` : "";
  if (candidates.length > 5) omitted.push(`${candidates.length - 5} candidates`);
  const unused = [...s.items.values()].filter(i => i.nodeId === node?.id && !s.deliveredAt.has(i.id) && i.partition !== "assessment");
  const pool = (n: number) => unused.length ? `## Unused bank items (present by id)\n${unused.slice(0, n).map(i => { const p = publicItem(i); return `- ${p.id} ${i.partition} ${p.activityType} d${p.difficulty} → ${i.subskillIds.join(",")}: ${clip(p.stem, 140)}`; }).join("\n")}${unused.length > n ? `\n(${unused.length - n} more)` : ""}` : "";
  const sources = [...s.packs.values()].filter(p => p.status !== "pending" && p.status !== "declined" && (!p.nodeId || p.nodeId === node?.id))
    .flatMap(p => p.items.filter(i => p.acceptedItemIds.includes(i.id))).map(i => `- ${i.id} ${clip(i.title, 80)}: ${i.spans.slice(0, 2).map(x => `"${clip(x, 160)}"`).join(" ")}`).join("\n");
  const src = sources ? `## Accepted sources (cite by id)\n${sources}` : "";

  // Under pressure drop lowest priority first: bank list shrinks, then sources, then evidence detail.
  const assemble = (n: number, withSrc: boolean, withEv: boolean) => [card, now, withEv ? evidence : "", hyp, cands, pool(n), withSrc ? src : "", `## Task\n${task}`].filter(Boolean).join("\n\n");
  let dynamic = assemble(10, true, true);
  for (const [n, withSrc, withEv, note] of [[5, true, true, "bank list shortened"], [3, false, true, "sources (use context)"], [2, false, false, "attempt detail (use context)"]] as const) {
    if (prefix.length + dynamic.length <= maxChars) break;
    dynamic = assemble(n, withSrc, withEv); omitted.push(note);
  }
  if (omitted.length) dynamic += `\n\nOmitted for space: ${omitted.join("; ")}.`;
  if (prefix.length + dynamic.length > maxChars) dynamic = clip(dynamic, Math.max(500, maxChars - prefix.length));
  return { prefix, dynamic, chars: prefix.length + dynamic.length, omitted };
}

/** ID drill-down for the `context` tool. Public views only; never keys, rubrics or raw transcripts. */
export function drill(s: EngineState, id: string, maxChars = 2_000): string {
  const item = s.items.get(id);
  if (item) return clip(JSON.stringify({ ...publicItem(item), partition: item.partition, subskillIds: item.subskillIds, delivered: s.deliveredAt.has(id), hints: item.hints ? "available via hint ladder" : "none" }), maxChars);
  const a = s.attempts.find(x => x.id === id);
  if (a) return clip(JSON.stringify({ id: a.id, itemId: a.itemId, response: a.response, independent: a.independent, cueLevel: a.cueLevel, score: a.grade?.score0to100, flaws: a.grade?.flaws, feedback: a.grade?.feedback }), maxChars);
  const h = s.hypotheses.get(id);
  if (h) return clip(JSON.stringify(h), maxChars);
  const n = s.plan?.nodes.find(x => x.id === id);
  if (n) return clip(JSON.stringify({ id: n.id, title: n.title, status: n.status, subskills: n.subskills.map(x => ({ id: x.id, statement: x.statement, kind: x.kind, proxyFor: x.proxyFor })), misconceptions: n.misconceptionsToProbe, digest: n.digest }), maxChars);
  for (const p of s.packs.values()) { const i = p.items.find(x => x.id === id); if (i && p.acceptedItemIds.includes(i.id)) return clip(JSON.stringify(i), maxChars); }
  return `no context for id "${id}"`;
}
