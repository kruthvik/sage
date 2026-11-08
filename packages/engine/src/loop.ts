// The node loop (SPEC §9) as a pure reducer: (state, event, now, actor) → { state, effects }. No I/O, no clock, no randomness.
import type { Attempt, Candidate, Grade, Item, ItemKey, Plan, PlanNode, ResponseInput, SessionState, SourcePack } from "../../core/src/types.ts";
import { activeNode, gates, nextCandidates, subskill, view } from "./candidates.ts";
import { gate, validateGrade, coverageDebt } from "./evidence.ts";
import { fingerprint, gradeDeterministic, leaksKey, passed, validateItem } from "./items.ts";
import { accrue, gateMinutes, paceNotice, planFit, usedMin } from "./pacing.ts";
import {
  BANK_SIZE, CHUNK_WORDS, RESEARCH, DIAGNOSTIC, DIGEST_TOKENS, MAX_CUE_LEVEL, NODE_CHECK_SIZE, NODE_CHECK_SIZE_SPEED_UP, NODE_CHECK_THIS_NODE_SHARE,
  HYPOTHESIS_RESOLVE_AFTER, MAX_PROBES, POLICY_VERSION, REPAIR_MICRO_MIN, STRUGGLE_FAILURES, STRUGGLE_LATENCY_FACTOR, STRUGGLE_LATENCY_MIN_MS, primeFor, requiredDimensions,
} from "./pedagogy.config.ts";
import { addDays, nextIntervalDays } from "./scheduler.ts";
import { EVENT_ACTOR, TOOLS_BY_PHASE, initialState, publicItem, type Effect, type EngineEvent, type EngineState } from "./state.ts";

export class EngineError extends Error {}
const fail = (msg: string): never => { throw new EngineError(msg); };
const DONE = new Set(["passed", "tested_out", "left_with_gaps"]);
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const textOf = (i: ResponseInput) => i.kind === "text" || i.kind === "audio_transcript" ? i.text : i.kind === "fields" ? Object.entries(i.fields).map(([k, v]) => `${k}: ${v}`).join("\n") : i.kind === "choice" ? `choice ${i.index}` : i.kind === "indices" ? `indices ${i.indices.join(",")}` : "";

export type Actor = "learner" | "role" | "tutor" | "host";
export interface Step { state: EngineState; effects: Effect[] }

export function reduce(prev: EngineState, ev: EngineEvent, now: string, actor: Actor): Step {
  if (EVENT_ACTOR[ev.type] !== actor) fail(`${actor} may not emit ${ev.type}`);
  if (ev.type !== "session_created" && !prev.sessionId) fail("no session");
  if (prev.phase === "ended" && ev.type !== "role_call_logged" && ev.type !== "digest_written" && ev.type !== "reviews_consented" && !ev.type.startsWith("research_pack")) fail("session ended");
  const s = structuredClone(prev);
  const fx: Effect[] = [];
  accrue(s, now);
  if (s.stopped && actor !== "host" && !(ev.type === "control" && ev.action === "resume") && ev.type !== "role_call_logged" && ev.type !== "research_pack_received") fail("session is stopped; resume first");
  handle(s, ev, now, fx);
  return { state: s, effects: fx };
}

export const replay = (events: { event: EngineEvent; now: string; actor: Actor }[]) => events.reduce((st, e) => reduce(st, e.event, e.now, e.actor).state, initialState());

function handle(s: EngineState, ev: EngineEvent, now: string, fx: Effect[]): void {
  switch (ev.type) {
    case "session_created": {
      if (s.sessionId) fail("session already created");
      if (!ev.goal?.objective?.trim()) fail("objective required");
      if ((ev.goal.learnerParams?.length ?? 0) > 2000) fail("learning parameters over 2000 chars");
      s.sessionId = ev.sessionId; s.goal = ev.goal;
      fx.push({ kind: "call_role", role: "planner", purpose: "plan", input: { goal: ev.goal } });
      if (!ev.goal.sourceIds?.length) research(s, "intake", "intake", { objective: ev.goal.objective }, fx);
      if (ev.goal.exam?.name) research(s, `exam:${ev.goal.exam.name}`, "exam", { exam: ev.goal.exam }, fx);
      for (const v of ev.goal.videoSources ?? []) research(s, `video:${v.url}`, "video_transcript", { video: v,
        question: "Look for an official transcript of this video on the publisher's own website (the channel owner's site). YouTube itself and third-party transcript sites don't count. If there isn't one, return a single unsourced item saying so." }, fx);
      return;
    }
    case "plan_proposed": case "plan_edited": {
      if (s.phase !== "intake" && s.phase !== "plan_review") fail("plan can only change before approval; propose a plan edit instead");
      s.plan = acceptPlan(ev.plan, s, s.plan ? s.plan.rev + 1 : 1);
      s.phase = "plan_review";
      fx.push({ kind: "notice", code: "plan_ready", text: `Plan with ${s.plan.nodes.length} nodes ready for review.` });
      return fitNotice(s, fx);
    }
    case "plan_nodes_merged": {
      if (s.phase !== "plan_review" || !s.plan) fail("nodes can only be merged before approval");
      s.plan = acceptPlan(mergeNodes(s.plan!, ev.nodeIds), s, s.plan!.rev + 1);
      log(s, now, "plan", `merged ${ev.nodeIds.join("+")}`);
      fx.push({ kind: "notice", code: "plan_ready", text: `Plan with ${s.plan.nodes.length} nodes ready for review.` });
      return fitNotice(s, fx);
    }
    case "plan_approved": {
      if (s.phase !== "plan_review" || !s.plan) fail("no plan to approve");
      s.plan!.approvedAt = now;
      const cap = DIAGNOSTIC[s.goal.mode];
      if (s.goal.preview.toggles.diagnostic && cap) {
        s.diagnostic = { status: "pending" }; s.phase = "bank";
        fx.push({ kind: "call_role", role: "generator", purpose: "diagnostic", input: { plan: outline(s.plan!), maxItems: cap.maxItems, exam: s.goal.exam } });
      } else startNextNode(s, now, fx);
      return;
    }
    case "bank_generated": return acceptBank(s, ev, now, fx);
    case "chunk_presented": {
      if (s.phase !== "teach") fail("a chunk can only be presented in the teach phase; every chunk must be followed by a check");
      const node = activeNode(s) ?? fail("no active node");
      if (!ev.subskillIds.length || ev.subskillIds.some(id => !node.subskills.some(x => x.id === id))) fail("chunk subskills must belong to the active node");
      const cap = CHUNK_WORDS[s.goal.mode];
      // shortcut: a worked-example chunk may run to 2× the cap; upgrade to a structured worked-example type if that's abused.
      if (words(ev.text) > (ev.exampleItemId ? cap * 2 : cap)) fail(`chunk over ${cap} words`);
      if (ev.exampleItemId) {
        const ex = s.items.get(ev.exampleItemId) ?? fail("unknown example item");
        if (ex.partition !== "teaching") fail("worked examples must come from the teaching partition");
        markDelivered(s, ex, now); expose(s, ex.familyId, now);
      }
      s.chunk = { text: ev.text, nodeId: node.id, subskillIds: ev.subskillIds, exampleItemId: ev.exampleItemId, at: now };
      s.chunkCollapsed = false; s.phase = "check";
      log(s, now, "chunk", ev.text.slice(0, 80));
      fx.push({ kind: "present_chunk", text: ev.text }, turn(s));
      return;
    }
    case "item_presented": {
      if (!["check", "prime", "diagnostic"].includes(s.phase)) fail(`items can't be presented in phase ${s.phase}`);
      if (s.current) fail("an item is already awaiting a response");
      let item = s.items.get(ev.itemId);
      if (ev.adhoc) {
        if (item) fail("ad hoc item id already exists");
        item = { ...ev.adhoc, partition: "practice", fingerprint: fingerprint(ev.adhoc.stem) };
        const probs = validateItem(item, { deliveredItemIds: new Set(s.deliveredAt.keys()) });
        if (probs.length) fail(`ad hoc item rejected: ${probs.join(", ")}`);
        item.validated = true; aliasFamily(s, item); s.items.set(item.id, item);
      }
      if (!item) return void fail("unknown item");
      if (!item.validated) fail("item not validated");
      if (item.partition !== "practice") fail("tutor may only present practice items; assessment items are held back for node checks and teaching items belong in chunks");
      if (s.phase !== "diagnostic" && item.nodeId !== s.activeNodeId) fail("item belongs to another node");
      if (s.deliveredAt.has(item.id)) fail("never repeat an item; cued retries are run by the engine");
      for (const id of item.subskillIds) {
        const ladder = s.cue.get(id);
        if (ladder && s.items.get(ladder.itemId)?.familyId === item.familyId) fail("after a failure, the uncued retry must use a fresh item from a new family");
      }
      const chunk = s.phase === "check" && s.chunk && item.subskillIds.some(id => s.chunk!.subskillIds.includes(id)) ? s.chunk.text : undefined;
      const probs = validateItem(item, { chunk, deliveredItemIds: new Set(s.deliveredAt.keys()) });
      if (probs.length) fail(`item fails validation: ${probs.join(", ")}`);
      present(s, item, 0, s.phase === "diagnostic" ? "diagnostic" : "loop", now, fx);
      return;
    }
    case "hint_requested": {
      const cur = s.current ?? fail("no item to hint");
      if (!s.goal.preview.toggles.hints) fail("hints are turned off");
      if (cur.mode === "node_check" || cur.mode === "final") fail("no hints during checks");
      const item = s.items.get(cur.itemId)!;
      const text = item.hints?.[ev.level - 1] ?? fail("this item has no hint at that level");
      const answerBearing = ev.level >= 2;
      // Record before reveal (v3): the exposure is logged even if the client never shows it.
      cur.assistance.push({ kind: (["nudge", "strategy", "worked_step"] as const)[ev.level - 1]!, stage: "possibly_exposed", answerBearing, itemId: item.id, at: now });
      if (answerBearing) expose(s, item.familyId, now);
      log(s, now, "hint", `level ${ev.level}`);
      fx.push({ kind: "reveal_hint", level: ev.level, text });
      return;
    }
    case "chunk_peeked": {
      const cur = s.current ?? fail("nothing to peek during");
      if (!s.chunk) fail("no chunk to peek");
      if (cur.mode === "node_check" || cur.mode === "final") fail("no peeking during checks");
      const item = s.items.get(cur.itemId)!;
      const answerBearing = leaksKey(s.chunk!.text, item);
      cur.assistance.push({ kind: "chunk_peek", stage: "exposed", answerBearing, itemId: item.id, at: now });
      fx.push({ kind: "show_chunk", text: s.chunk!.text });
      return;
    }
    case "response_submitted": return submit(s, ev, now, fx);
    case "grade_received": {
      if (ev.attemptId !== s.pendingAttemptId) fail("no grade pending for that attempt");
      const a = s.attempts.find(x => x.id === ev.attemptId)!;
      applyGrade(s, a, ev.grade, now, fx, s.disputed.has(a.id) && !!a.grade);
      return;
    }
    case "feedback_acked": return ack(s, ev.attemptId, now, fx);
    case "grade_disputed": {
      const a = s.attempts.find(x => x.id === ev.attemptId) ?? fail("unknown attempt");
      const item = s.items.get(a.itemId)!;
      // Answer-key items (owner, M3 review): the learner can dispute the key itself; a model re-checks key against their working.
      const keyDispute = a.grade?.grader === "deterministic" && !!item.key && item.key.kind !== "reference";
      if (!a.grade || (a.grade.grader !== "model" && !keyDispute)) fail("only model-graded responses and answer-key items can be disputed");
      if (keyDispute && s.feedbackAttemptId !== a.id) fail("dispute an answer key while its feedback is showing");
      if (item.voided) fail("this item was already voided");
      if (s.disputed.has(a.id)) fail("one dispute per item");
      if (s.pendingAttemptId) fail("a grade is already pending");
      if (!ev.argument.trim()) fail("say why the grade is wrong");
      s.disputed.add(a.id); s.pendingAttemptId = a.id; s.phase = "grading";
      fx.push(keyDispute
        ? { kind: "call_role", role: "grader", purpose: "key_dispute", input: { attemptId: a.id, item, response: a.response, argument: ev.argument } }
        : { kind: "call_role", role: "grader", purpose: "dispute", input: { attemptId: a.id, item, response: a.response, previous: a.grade, argument: ev.argument } });
      return;
    }
    case "key_dispute_resolved": {
      if (ev.attemptId !== s.pendingAttemptId || !s.disputed.has(ev.attemptId)) fail("no key dispute pending for that attempt");
      const a = s.attempts.find(x => x.id === ev.attemptId)!;
      const item = s.items.get(a.itemId)!;
      if (!item.key || item.key.kind === "reference" || a.grade?.grader !== "deterministic") fail("not an answer-key dispute");
      if (ev.correctedKey && ev.correctedKey.kind !== item.key!.kind) fail("the corrected key must keep the item's key kind");
      s.pendingAttemptId = undefined; s.phase = "feedback";
      if (!ev.keyWrong) { fx.push({ kind: "notice", code: "dispute_rejected", text: `The answer key stands: ${ev.reason}` }); return; }
      return voidItem(s, item, ev.reason, ev.correctedKey, now, fx);
    }
    case "move_selected": {
      if (s.phase !== "adapt") fail("moves are selected in the adapt phase");
      const c = s.candidates.find(x => x.id === ev.candidateId) ?? fail("not one of the offered candidates");
      if (!ev.reasonCodes.length) fail("reason codes required");
      if (words(ev.nextIntendedMove) > 30) fail("nextIntendedMove over 30 words");
      s.decisions.push({ policyVersion: POLICY_VERSION, candidateIds: s.candidates.map(x => x.id), selectedId: c.id, reasonCodes: ev.reasonCodes, targetSubskillIds: c.targetSubskillIds, evidenceIds: c.evidenceIds, at: now });
      s.nextIntendedMove = ev.nextIntendedMove;
      log(s, now, "decision", `${c.kind} (${ev.reasonCodes.join(", ")})`);
      return applyMove(s, c, now, fx);
    }
    case "hypothesis_proposed": {
      const h = ev.hypothesis;
      if (!s.plan?.approvedAt) fail("no approved plan");
      if (!subskill(s, h.subskillId)) fail("unknown subskill");
      const ids = [...h.supportingAttemptIds, ...h.contradictingAttemptIds];
      for (const id of ids) {
        const a = s.attempts.find(x => x.id === id) ?? fail(`unknown attempt ${id}`);
        if (!s.items.get(a.itemId)?.subskillIds.includes(h.subskillId)) fail(`attempt ${id} is not about ${h.subskillId}`);
      }
      if (h.supportingAttemptIds.some(id => h.contradictingAttemptIds.includes(id))) fail("an attempt can't both support and contradict");
      if (h.status === "resolved" && !h.contradictingAttemptIds.length) fail("resolving a hypothesis needs contradicting evidence");
      if (!h.supportingAttemptIds.length && h.status === "open" && h.confidence !== "low") fail("unsupported hypotheses start at low confidence");
      s.hypotheses.set(h.id, { ...h, rev: (s.hypotheses.get(h.id)?.rev ?? 0) + 1 });
      fx.push({ kind: "notice", code: "hypothesis_changed", text: h.statement });
      if (s.phase === "adapt") { s.candidates = nextCandidates(s); fx.push(turn(s)); }
      return;
    }
    case "control": return control(s, ev, now, fx);
    case "pace_set": {
      s.goal.pace = ev.pace; // K and teaching compress; nodes, subskills and required dimensions are untouched (SPEC §11).
      for (const n of s.plan?.nodes ?? []) if (!DONE.has(n.status)) n.estMinutes = gateMinutes(n, s.goal.mode, ev.pace);
      log(s, now, "pace", ev.pace);
      if (s.phase === "plan_review") fitNotice(s, fx);
      fx.push({ kind: "notice", code: "pace", text: ev.pace === "speed_up" ? "Speed up: one independent check per subskill, no prime step, shorter node checks. No topics are skipped." : "Normal pace." });
      return;
    }
    case "time_extended": {
      if (!(ev.minutes > 0)) fail("minutes must be positive");
      s.goal.timeBudgetMin = (s.goal.timeBudgetMin ?? Math.ceil(usedMin(s))) + ev.minutes;
      log(s, now, "pace", `extended +${ev.minutes} min`);
      if (s.phase === "plan_review") fitNotice(s, fx);
      return;
    }
    case "reviews_consented": {
      for (const id of ev.subskillIds) {
        const card = s.reviews.find(r => r.subskillId === id) ?? fail(`no review card for ${id}`);
        card.consented = true;
      }
      return;
    }
    case "digest_written": {
      const n = s.plan?.nodes.find(x => x.id === ev.nodeId) ?? fail("unknown node");
      if (ev.digest.length > DIGEST_TOKENS * 5) fail("digest over budget");
      n.digest = ev.digest;
      if (ev.cheatSheet) n.cheatSheet = ev.cheatSheet.map(String).slice(0, 8);
      return;
    }
    case "role_call_logged": {
      s.spend.calls++; s.spend.inputTokens += ev.inputTokens; s.spend.outputTokens += ev.outputTokens;
      s.spend.costUsd = ev.costUsd === undefined || s.spend.costUsd === "unknown" ? "unknown" : s.spend.costUsd + ev.costUsd;
      return;
    }
    case "research_requested": {
      const q = ev.question.trim();
      if (!q || q.length > 300) fail("research question must be 1–300 chars");
      research(s, `q:${s.activeNodeId}:${q.toLowerCase()}`, "tutor_request", { question: q, nodeId: s.activeNodeId }, fx); // queued, never blocks the lesson
      return;
    }
    case "research_pack_received": return acceptPack(s, ev, fx);
    case "research_pack_accepted": {
      const p = s.packs.get(ev.packId) ?? fail("unknown pack");
      const ids = ev.itemIds ?? p.items.map(i => i.id);
      if (ids.some(id => !p.items.some(i => i.id === id))) fail("unknown pack item");
      p.acceptedItemIds = [...new Set([...p.acceptedItemIds, ...ids])];
      p.status = p.acceptedItemIds.length === p.items.length ? "accepted" : "partially_accepted";
      return;
    }
    case "image_consented": {
      const cur = s.current ?? fail("no item to attach working to");
      if (s.pendingAttemptId || s.feedbackAttemptId) fail("finish the previous item first");
      if (!ev.blobHashes.length || ev.blobHashes.length > 4 || !ev.blobHashes.every(h => /^[a-f0-9]{64}$/.test(h))) fail("1–4 stored images are required");
      s.scrap = { itemId: cur.itemId, blobHashes: [...ev.blobHashes], status: "reading" };
      log(s, now, "consent", `${ev.blobHashes.length} photo(s) sent to ${ev.provider}/${ev.model} with the learner's consent, to read their working`);
      fx.push({ kind: "call_role", role: "transcriber", purpose: "transcribe", input: { itemId: cur.itemId, blobHashes: ev.blobHashes, stem: s.items.get(cur.itemId)?.stem ?? "" } });
      return;
    }
    case "transcription_proposed": {
      const sc = s.scrap;
      if (!sc || sc.status !== "reading" || s.current?.itemId !== sc.itemId) return fail("no photo is being read");
      sc.status = "review"; sc.text = ev.text.slice(0, 24000);
      fx.push({ kind: "transcription_review", itemId: sc.itemId, text: sc.text });
      return;
    }
    case "transcription_confirmed": {
      const sc = s.scrap;
      if (sc?.status !== "review" || s.current?.itemId !== sc.itemId) fail("no transcription awaiting confirmation");
      s.scrap = undefined;
      submit(s, { type: "response_submitted", input: { kind: "text", text: ev.text }, responseEventId: ev.responseEventId, latencyMs: ev.latencyMs }, now, fx);
      s.attempts.at(-1)!.fromImages = sc!.blobHashes; // the learner confirmed (or edited) this text; the model only proposed it
      return;
    }
    case "tick": return;
  }
}

function acceptPlan(plan: Plan, s: EngineState, rev: number): Plan {
  const nodes = plan.nodes ?? [];
  if (!nodes.length) fail("plan has no nodes");
  const ids = new Set<string>(), subIds = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) fail(`duplicate node ${n.id}`); ids.add(n.id);
    if (!n.subskills?.length) fail(`node ${n.id} has no subskills`);
    for (const x of n.subskills) { if (subIds.has(x.id)) fail(`duplicate subskill ${x.id}`); subIds.add(x.id); }
  }
  const edges: [string, string][] = [...(plan.edges ?? []), ...nodes.flatMap(n => (n.prerequisites ?? []).map(p => [p, n.id] as [string, string]))];
  for (const [a, b] of edges) if (!ids.has(a) || !ids.has(b)) fail(`edge ${a}→${b} references an unknown node`);
  // Kahn's algorithm: the plan must be a DAG.
  const indeg = new Map([...ids].map(id => [id, 0])); for (const [, b] of edges) indeg.set(b, indeg.get(b)! + 1);
  const queue = [...ids].filter(id => indeg.get(id) === 0); let seen = 0;
  while (queue.length) { const id = queue.pop()!; seen++; for (const [a, b] of edges) if (a === id) { indeg.set(b, indeg.get(b)! - 1); if (indeg.get(b) === 0) queue.push(b); } }
  if (seen !== ids.size) fail("plan has a prerequisite cycle");
  const prereqs = (id: string) => [...new Set(edges.filter(([, b]) => b === id).map(([a]) => a))];
  return {
    rev, edges,
    nodes: nodes.map((n, i) => ({
      ...n, order: n.order ?? i, prerequisites: prereqs(n.id), status: prereqs(n.id).length ? "locked" : "ready", estMinutes: gateMinutes(n, s.goal.mode, s.goal.pace),
      subskills: n.subskills.map(x => ({ ...x, nodeId: n.id, requiredDimensions: requiredDimensions(s.goal.mode, x) })),
    })),
  };
}

function fitNotice(s: EngineState, fx: Effect[]) { const fit = planFit(s); if (fit) fx.push({ kind: "plan_fit", fit }); }

/** Merge nodes into the first listed (learner choice at plan review): subskills concatenated, edges redirected, self-edges dropped. */
function mergeNodes(p: Plan, ids: string[]): Plan {
  const set = new Set(ids);
  if (set.size < 2 || ids.some(id => !p.nodes.some(n => n.id === id))) fail("merge needs two or more known nodes");
  const keep = ids[0]!;
  const to = (id: string) => set.has(id) ? keep : id;
  const parts = ids.map(id => p.nodes.find(n => n.id === id)!);
  const merged: PlanNode = { ...parts[0]!, title: parts.map(n => n.title).join(" + "), subskills: parts.flatMap(n => n.subskills),
    misconceptionsToProbe: parts.flatMap(n => n.misconceptionsToProbe).slice(0, 3), examWeight: parts.some(n => n.examWeight === "high") ? "high" : parts[0]!.examWeight,
    knowledgeConfidence: parts.some(n => n.knowledgeConfidence === "low") ? "low" : parts[0]!.knowledgeConfidence, prerequisites: parts.flatMap(n => n.prerequisites) };
  const nodes = p.nodes.filter(n => !set.has(n.id) || n.id === keep).map(n => n.id === keep ? merged : n)
    .map(n => ({ ...n, prerequisites: [...new Set(n.prerequisites.map(to))].filter(x => x !== n.id) }));
  const edges = [...new Map(p.edges.map(([a, b]) => [to(a), to(b)] as [string, string]).filter(([a, b]) => a !== b).map(e => [e.join(">"), e] as const)).values()];
  return { ...p, nodes, edges };
}

function inputOf(a: Attempt, key: ItemKey): ResponseInput {
  if (key.kind === "order" || key.kind === "match") return { kind: "indices", indices: (/^indices ([\d,]*)/.exec(a.response)?.[1] ?? "").split(",").filter(Boolean).map(Number) };
  return key.kind === "choice" ? { kind: "choice", index: Number(/choice (\d+)/.exec(a.response)?.[1] ?? -1) } : { kind: "text", text: a.response };
}

/** A successful key dispute: the item is voided (never evidence, never shown again), every attempt on it is re-scored
 * against the corrected key (kept for the record, not as evidence), cue ladders on it are dropped, and a replacement is generated. */
function voidItem(s: EngineState, item: Item, reason: string, corrected: ItemKey | undefined, now: string, fx: Effect[]) {
  item.voided = reason; item.validated = false;
  for (const [id, l] of s.cue) if (l.itemId === item.id) s.cue.delete(id);
  for (const a of s.attempts.filter(x => x.itemId === item.id && x.grade)) {
    if (!corrected) continue;
    const g = gradeDeterministic({ ...item, key: corrected }, inputOf(a, corrected))!;
    a.supersededGrades = [...(a.supersededGrades ?? []), a.grade!];
    a.grade = { ...g, disputed: true, dimensionsObserved: [] };
    if (a.id === s.feedbackAttemptId) fx.push({ kind: "present_feedback", attemptId: a.id, grade: a.grade });
  }
  log(s, now, "item", `${item.id} voided: ${reason}`);
  fx.push({ kind: "notice", code: "item_voided", text: `You were right: this item's answer key was wrong (${reason}). It is re-scored for the record, removed, and replaced; it counts neither for nor against you.` });
  const node = s.plan?.nodes.find(n => n.id === item.nodeId);
  if (node) for (const x of node.subskills.filter(x => item.subskillIds.includes(x.id))) {
    const r = gate(x, s.goal.mode, s.goal.pace, view(s));
    fx.push({ kind: "gate_update", nodeId: node.id, subskillId: x.id, passed: r.passed, stm: r.stm, missing: r.missing });
  }
  fx.push({ kind: "call_role", role: "generator", purpose: "replace", input: { nodeId: item.nodeId, partition: item.partition, count: 1, subskillIds: item.subskillIds, activityType: item.activityType } });
}

const outline = (p: Plan) => p.nodes.map(n => ({ id: n.id, title: n.title, subskills: n.subskills.map(x => ({ id: x.id, statement: x.statement, kind: x.kind })) }));

function acceptBank(s: EngineState, ev: Extract<EngineEvent, { type: "bank_generated" }>, now: string, fx: Effect[]): void {
  const expecting = ev.purpose === "diagnostic" ? s.diagnostic.status === "pending" : ev.purpose === "node" ? s.phase === "bank" && ev.nodeId === s.activeNodeId
    : ev.purpose === "replace" ? !!s.plan?.approvedAt : s.phase === "node_check" && !s.check;
  if (!expecting) fail(`not expecting a ${ev.purpose} bank`);
  const subIds = new Set(s.plan!.nodes.flatMap(n => n.subskills.map(x => x.id)));
  for (const raw of ev.items) {
    if (s.items.has(raw.id)) { fx.push({ kind: "item_rejected", itemId: raw.id, problems: ["duplicate_id"] }); continue; }
    const item: Item = { ...raw, fingerprint: fingerprint(raw.stem), ...(ev.purpose === "diagnostic" ? { partition: "practice" as const } : {}) };
    const probs = validateItem(item);
    if (!s.plan!.nodes.some(n => n.id === item.nodeId)) probs.push("unknown_node");
    if (!item.subskillIds?.length || item.subskillIds.some(id => !subIds.has(id))) probs.push("unknown_subskill");
    if (probs.length) { fx.push({ kind: "item_rejected", itemId: item.id, problems: probs }); continue; }
    item.validated = true; aliasFamily(s, item); s.items.set(item.id, item);
  }
  if (ev.purpose === "diagnostic") { s.diagnostic = { status: "running", startedAt: now }; s.phase = "diagnostic"; fx.push(turn(s)); return; }
  if (ev.purpose === "replace") return; // fills the bank only; never changes the phase
  if (ev.purpose === "topup") return buildCheck(s, activeNode(s)!, false, now, fx);
  const node = activeNode(s)!;
  s.phase = node.subskills.some(x => primeFor(s.goal.mode, s.goal.pace, x)) ? "prime" : "teach";
  fx.push(turn(s));
}

/** Cosmetic variants (same fingerprint, same node) share a family even if the generator gave them different family IDs (v3). */
function aliasFamily(s: EngineState, item: Item): void {
  const twin = [...s.items.values()].find(x => x.nodeId === item.nodeId && x.fingerprint === item.fingerprint);
  if (twin) item.familyId = twin.familyId;
}

function markDelivered(s: EngineState, item: Item, now: string) { if (!s.deliveredAt.has(item.id)) s.deliveredAt.set(item.id, now); }
function expose(s: EngineState, familyId: string, now: string) { if (!s.exposedFamilies.has(familyId)) s.exposedFamilies.set(familyId, now); }
function log(s: EngineState, at: string, kind: string, text: string) { s.timeline.push({ at, kind, text }); }
function turn(s: EngineState): Effect { return { kind: "tutor_turn", phase: s.phase, tools: TOOLS_BY_PHASE[s.phase] ?? [], candidates: s.phase === "adapt" ? s.candidates : [] }; }

function present(s: EngineState, item: Item, cueLevel: 0 | 1 | 2 | 3, mode: NonNullable<EngineState["current"]>["mode"], now: string, fx: Effect[]) {
  const familyExposedBefore = s.exposedFamilies.has(item.familyId);
  s.current = { itemId: item.id, presentedAt: now, cueLevel, assistance: [], prime: s.phase === "prime", familyExposedBefore, mode };
  let cueText: string | undefined;
  if (cueLevel > 0) {
    cueText = item.hints?.[cueLevel - 1];
    s.current.assistance.push({ kind: (["nudge", "strategy", "worked_step"] as const)[cueLevel - 1]!, stage: "exposed", answerBearing: cueLevel >= 2, itemId: item.id, at: now });
  }
  markDelivered(s, item, now);
  s.chunkCollapsed = true;
  log(s, now, "item", `${item.id} (${item.activityType}, d${item.difficulty}${cueLevel ? `, cue ${cueLevel}` : ""})`);
  fx.push({ kind: "present_item", item: publicItem(item), cueText });
}

function submit(s: EngineState, ev: Extract<EngineEvent, { type: "response_submitted" }>, now: string, fx: Effect[]): void {
  const text = textOf(ev.input);
  if (ev.input.kind === "image") fail("image responses need a confirmed transcription (scrap-work intake, M5)");
  if (!text.trim() || text.length > 24000) fail("response must contain 1–24000 characters"); // blank input never becomes learner work
  let a: Attempt;
  if (s.phase === "repair") {
    const orig = s.attempts.find(x => x.id === s.repairAttemptId)!;
    a = { id: `a${s.attempts.length + 1}`, itemId: orig.itemId, responseEventId: ev.responseEventId, response: text, at: now, assistance: [], independent: false, isRepair: true, cueLevel: 0, latencyMs: ev.latencyMs };
  } else {
    const cur = s.current ?? fail("no item awaiting a response");
    if (s.pendingAttemptId || s.feedbackAttemptId) fail("finish the previous item first");
    const answerBearing = cur.assistance.some(x => x.answerBearing);
    a = {
      id: `a${s.attempts.length + 1}`, itemId: cur.itemId, responseEventId: ev.responseEventId, response: text, at: now,
      assistance: cur.assistance, isRepair: false, cueLevel: cur.cueLevel, latencyMs: ev.latencyMs, diagnostic: cur.mode === "diagnostic", check: cur.mode === "node_check" || cur.mode === "final" ? cur.mode : undefined,
      independent: !cur.prime && cur.cueLevel === 0 && !answerBearing && !cur.familyExposedBefore,
    };
  }
  s.attempts.push(a);
  const item = s.items.get(a.itemId)!;
  const g = a.isRepair ? undefined : gradeDeterministic(item, ev.input);
  if (g) return applyGrade(s, a, g, now, fx, false);
  s.pendingAttemptId = a.id; s.phase = "grading";
  fx.push({ kind: "call_role", role: "grader", purpose: a.isRepair ? "repair" : "grade", input: { attemptId: a.id, item, response: text, assistance: a.assistance.map(x => x.kind), cueLevel: a.cueLevel, rigor: s.goal.preview.feedbackRigor } });
}

function applyGrade(s: EngineState, a: Attempt, g: Grade, now: string, fx: Effect[], supersede: boolean): void {
  const probs = validateGrade(g, a.response);
  if (probs.length) fail(`grade rejected: ${probs.join(", ")}`);
  if (supersede && a.grade) { a.supersededGrades = [...(a.supersededGrades ?? []), a.grade]; g = { ...g, disputed: true }; }
  a.grade = g; s.pendingAttemptId = undefined;
  const item = s.items.get(a.itemId)!;
  expose(s, item.familyId, now); // feedback shows the answer, so later items in this family aren't fresh (v3 contamination rule)
  const loop = !a.isRepair && !a.diagnostic && s.current?.mode === "loop" && !s.current.prime;
  for (const id of item.subskillIds) {
    if (!loop) continue;
    const ladder = s.cue.get(id);
    if (!passed(g) && (!ladder || ladder.itemId !== item.id)) s.cue.set(id, { itemId: item.id, level: MAX_CUE_LEVEL });
    if (passed(g) && a.independent) s.cue.delete(id);
  }
  // Probes settle hypotheses in code (flash eval: the tutor never resolved them, and an open high-confidence one blocks the gate forever).
  const h = s.probing ? s.hypotheses.get(s.probing) : undefined;
  if (h && h.status === "open" && !supersede && !a.isRepair && item.subskillIds.includes(h.subskillId)) {
    s.probing = undefined;
    s.probes.set(h.id, (s.probes.get(h.id) ?? 0) + 1);
    const against = passed(g) && a.independent;
    const next = { ...h, rev: h.rev + 1, ...(against ? { contradictingAttemptIds: [...h.contradictingAttemptIds, a.id] } : { supportingAttemptIds: [...h.supportingAttemptIds, a.id] }) };
    if (next.contradictingAttemptIds.length >= HYPOTHESIS_RESOLVE_AFTER) next.status = "resolved";
    else if (s.probes.get(h.id)! >= MAX_PROBES) next.status = "uncertain"; // evidence stays on record; it stops blocking the gate
    s.hypotheses.set(h.id, next);
    if (next.status === "resolved") fx.push({ kind: "notice", code: "hypothesis_changed", text: `Resolved: ${h.statement}` });
  }
  s.feedbackAttemptId = a.id; s.phase = "feedback";
  log(s, now, "grade", `${a.itemId}: ${g.score0to100}${g.flaws.length ? ` · ${g.flaws.map(f => `${f.severity}: "${f.quote}"`).join("; ")}` : ""}`);
  fx.push({ kind: "present_feedback", attemptId: a.id, grade: g });
  const node = activeNode(s);
  if (node) for (const x of node.subskills.filter(x => item.subskillIds.includes(x.id))) {
    const r = gate(x, s.goal.mode, s.goal.pace, view(s));
    fx.push({ kind: "gate_update", nodeId: node.id, subskillId: x.id, passed: r.passed, stm: r.stm, missing: r.missing });
  }
}

function ack(s: EngineState, attemptId: string, now: string, fx: Effect[]): void {
  if (attemptId !== s.feedbackAttemptId) fail("no feedback awaiting acknowledgement for that attempt");
  s.feedbackAttemptId = undefined;
  const a = s.attempts.find(x => x.id === attemptId)!;
  const g = a.grade!;
  const cur = s.current;
  const blocking = g.flaws.some(f => f.severity === "blocking");
  if (a.isRepair) {
    if (blocking || !passed(g)) { s.phase = "repair"; fx.push({ kind: "repair_required", attemptId: s.repairAttemptId!, flaws: g.flaws }); return; }
    s.repairAttemptId = undefined; return toAdapt(s, now, fx);
  }
  s.current = undefined;
  if (cur?.mode === "node_check" || cur?.mode === "final") return advanceCheck(s, now, fx);
  if (blocking && g.grader === "model" && !cur?.prime) {
    s.repairAttemptId = a.id; s.phase = "repair";
    fx.push({ kind: "repair_required", attemptId: a.id, flaws: g.flaws.filter(f => f.severity === "blocking") });
    return;
  }
  if (g.flaws.some(f => f.severity === "precision") && s.goal.pace === "normal") fx.push({ kind: "notice", code: "precision_restatement_offered", text: "Optional: restate the flagged wording more precisely." });
  if (cur?.mode === "diagnostic") {
    const cap = DIAGNOSTIC[s.goal.mode]!;
    const n = s.attempts.filter(x => x.diagnostic).length;
    if (n >= cap.maxItems || Date.parse(now) - Date.parse(s.diagnostic.startedAt!) >= cap.maxMin * 60_000) return finishDiagnostic(s, false, now, fx);
    fx.push(turn(s)); return;
  }
  if (cur?.prime) { s.phase = "teach"; fx.push(turn(s)); return; }
  struggleOffer(s, a, fx);
  toAdapt(s, now, fx);
}

function struggleOffer(s: EngineState, a: Attempt, fx: Effect[]) {
  if (!s.goal.preview.toggles.hints || passed(a.grade)) return;
  const item = s.items.get(a.itemId)!;
  const fails = s.attempts.filter(x => !x.isRepair && x.grade && !passed(x.grade) && s.items.get(x.itemId)?.subskillIds.some(id => item.subskillIds.includes(id))).length;
  const lats = s.attempts.map(x => x.latencyMs).sort((p, q) => p - q);
  const median = lats[Math.floor(lats.length / 2)] ?? 0;
  if (fails >= STRUGGLE_FAILURES || a.latencyMs > Math.max(STRUGGLE_LATENCY_FACTOR * median, STRUGGLE_LATENCY_MIN_MS))
    fx.push({ kind: "offer_hint", text: "Hints are available on the next one if you want them (a nudge keeps it independent; strategy or worked step counts as supported)." });
}

function toAdapt(s: EngineState, now: string, fx: Effect[]) {
  s.phase = "adapt"; s.candidates = nextCandidates(s);
  const notice = paceNotice(s);
  if (notice) { log(s, now, "pace", notice.text); fx.push({ kind: "pace_notice", ...notice }); }
  fx.push(turn(s));
}

function applyMove(s: EngineState, c: Candidate, now: string, fx: Effect[]): void {
  switch (c.kind) {
    case "teach": case "represent_differently": s.phase = "teach"; fx.push(turn(s)); return;
    case "probe_hypothesis": s.probing = c.evidenceIds[0]; s.phase = "check"; fx.push(turn(s)); return;
    case "check": case "fresh_retry": case "vary_application": case "method_choice": s.phase = "check"; fx.push(turn(s)); return;
    case "cued_retry": {
      const ladder = s.cue.get(c.targetSubskillIds[0]!) ?? fail("no cue ladder");
      if (ladder.level === 0) fail("cue ladder exhausted; use a fresh item");
      const level = ladder.level; ladder.level = (level - 1) as 0 | 1 | 2;
      s.phase = "check";
      return present(s, s.items.get(ladder.itemId)!, level, "loop", now, fx);
    }
    case "node_check": return buildCheck(s, activeNode(s)!, false, now, fx);
    case "checkpoint": {
      // A pause point, not a move: save, then the tutor picks a real move (otherwise the session waits on nothing).
      s.candidates = s.candidates.filter(x => x.kind !== "checkpoint");
      fx.push({ kind: "checkpoint" }, { kind: "write_export", what: "session" }, turn(s));
      return;
    }
    case "advance": return;
  }
}

function buildCheck(s: EngineState, node: PlanNode, final: boolean, now: string, fx: Effect[]): void {
  const size = final ? 6 : s.goal.pace === "speed_up" ? NODE_CHECK_SIZE_SPEED_UP : NODE_CHECK_SIZE[s.goal.mode];
  const unseen = [...s.items.values()].filter(i => i.partition === "assessment" && !s.deliveredAt.has(i.id));
  const weight = { high: 0, medium: 1, low: 2 } as const;
  const nodeOf = (i: Item) => s.plan!.nodes.find(n => n.id === i.nodeId)!;
  const picked: Item[] = [];
  const take = (i: Item | undefined) => { if (i && !picked.includes(i) && picked.length < size) picked.push(i); };
  if (!final) {
    const mine = unseen.filter(i => i.nodeId === node.id).sort((a, b) => b.difficulty - a.difficulty);
    if (!mine.length) { s.phase = "node_check"; s.check = undefined; fx.push({ kind: "call_role", role: "generator", purpose: "topup", input: { nodeId: node.id, partition: "assessment", count: size } }); return; }
    // Every original gap gets an independent recheck on a fresh item (v3 cram).
    const gaps = node.subskills.filter(x => s.attempts.some(a => !a.isRepair && a.grade && !passed(a.grade) && s.items.get(a.itemId)?.subskillIds.includes(x.id)));
    for (const g of gaps) take(mine.find(i => i.subskillIds.includes(g.id)));
    const own = Math.ceil(size * NODE_CHECK_THIS_NODE_SHARE);
    for (const i of mine) if (picked.length < own) take(i);
    const earlier = unseen.filter(i => i.nodeId !== node.id && DONE.has(nodeOf(i).status)).sort((a, b) => weight[nodeOf(a).examWeight] - weight[nodeOf(b).examWeight]);
    for (const i of earlier) take(i);
    for (const i of mine) take(i);
  } else {
    const exam = s.goal.exam?.formats;
    const pool = unseen.filter(i => DONE.has(nodeOf(i).status)).sort((a, b) => Number(!!exam && !exam.includes(b.format!)) - Number(!!exam && !exam.includes(a.format!)));
    for (const i of pool) take(i);
    if (!picked.length) return endSession(s, now, fx);
  }
  s.check = { nodeId: node.id, itemIds: picked.map(i => i.id), idx: 0, final };
  s.phase = "node_check";
  log(s, now, final ? "final_set" : "node_check", `${picked.length} items`);
  present(s, picked[0]!, 0, final ? "final" : "node_check", now, fx);
}

function advanceCheck(s: EngineState, now: string, fx: Effect[]): void {
  const c = s.check!;
  if (++c.idx < c.itemIds.length) return present(s, s.items.get(c.itemIds[c.idx]!)!, 0, c.final ? "final" : "node_check", now, fx);
  s.check = undefined;
  if (c.final) return endSession(s, now, fx);
  const failed = c.itemIds.filter(id => !s.items.get(id)!.voided && !passed(s.attempts.filter(a => a.itemId === id).at(-1)?.grade)).map(id => s.items.get(id)!);
  for (const n of new Set(failed.filter(i => i.nodeId !== c.nodeId).map(i => i.nodeId))) {
    const earlier = s.plan!.nodes.find(x => x.id === n)!;
    earlier.status = "needs_repair";
    fx.push({ kind: "node_status", nodeId: n, status: "needs_repair" }, { kind: "notice", code: "repair_inserted", text: `"${earlier.title}" slipped in the check; a repair loop (≤${REPAIR_MICRO_MIN} min) comes after this node.` });
  }
  const node = s.plan!.nodes.find(x => x.id === c.nodeId)!;
  if (failed.some(i => i.nodeId === c.nodeId)) { log(s, now, "node_check", "failed; back to practice"); return toAdapt(s, now, fx); }
  node.status = "passed"; node.passedAtMin = usedMin(s);
  for (const x of node.subskills) if (!s.reviews.some(r => r.subskillId === x.id)) {
    const days = nextIntervalDays(undefined, undefined, s.goal.horizonDays);
    s.reviews.push({ subskillId: x.id, intervalDays: days, dueAt: addDays(now, days), consented: false });
  }
  log(s, now, "node", `${node.title} passed`);
  s.phase = "close";
  fx.push({ kind: "node_status", nodeId: node.id, status: "passed" }, { kind: "call_role", role: "summarizer", purpose: "node_close", input: { nodeId: node.id } },
    { kind: "write_export", what: "node" }, { kind: "notice", code: "stopping_point", text: `${node.title} done. Good place to stop, or continue.` });
}

function finishDiagnostic(s: EngineState, skipped: boolean, now: string, fx: Effect[]) {
  s.diagnostic.status = skipped ? "skipped" : "done"; s.current = undefined;
  if (s.goal.mode === "accelerate") {
    // Test-out needs independent evidence on changed-task items covering every required dimension; skipped or thin evidence stays unknown (F8).
    const diag = s.attempts.filter(a => a.diagnostic && s.items.get(a.itemId)?.variation?.changedDimensions.some(d => d !== "surface"));
    const v = { ...view(s), attempts: diag };
    for (const n of s.plan!.nodes) if (n.subskills.every(x => gate(x, s.goal.mode, s.goal.pace, v).passed)) { n.status = "tested_out"; fx.push({ kind: "node_status", nodeId: n.id, status: "tested_out" }); }
  }
  log(s, now, "diagnostic", skipped ? "skipped (knowledge stays unknown)" : "done");
  startNextNode(s, now, fx);
}

function startNextNode(s: EngineState, now: string, fx: Effect[]): void {
  const nodes = [...s.plan!.nodes].sort((a, b) => a.order - b.order);
  const doneIds = new Set(nodes.filter(n => DONE.has(n.status)).map(n => n.id));
  const next = nodes.find(n => n.status === "needs_repair") ?? nodes.find(n => (n.status === "ready" || n.status === "locked") && n.prerequisites.every(p => doneIds.has(p)));
  s.chunk = undefined; s.cue.clear(); s.current = undefined;
  if (!next) {
    if (["cram", "learn", "accelerate"].includes(s.goal.mode) && nodes.some(n => n.status === "passed")) return buildCheck(s, nodes[0]!, true, now, fx);
    return endSession(s, now, fx);
  }
  const repairing = next.status === "needs_repair";
  next.status = "active"; s.activeNodeId = next.id;
  fx.push({ kind: "node_status", nodeId: next.id, status: "active" });
  if (next.knowledgeConfidence === "low") research(s, `node:${next.id}:low`, "low_confidence", { node: next }, fx);
  else if (s.goal.sourceIds?.length && !next.sourceIds?.length) research(s, `node:${next.id}:uncovered`, "node_uncovered", { node: next }, fx);
  // A node bank always has an assessment partition; diagnostic items alone don't count as a bank.
  if (repairing || [...s.items.values()].some(i => i.nodeId === next.id && i.partition === "assessment")) return toAdapt(s, now, fx);
  s.phase = "bank";
  fx.push({ kind: "call_role", role: "generator", purpose: "node", input: { node: next, size: BANK_SIZE, exam: s.goal.exam, mode: s.goal.mode, sources: sourcesFor(s, next.id) } });
}

function endSession(s: EngineState, now: string, fx: Effect[]) {
  s.phase = "ended"; s.activeNodeId = undefined;
  log(s, now, "session", "ended");
  fx.push({ kind: "call_role", role: "summarizer", purpose: "session_end", input: {} }, { kind: "write_export", what: "final" });
}

function control(s: EngineState, ev: Extract<EngineEvent, { type: "control" }>, now: string, fx: Effect[]): void {
  if (s.phase === "grading") fail("wait for the grade");
  if (!s.plan?.approvedAt && ev.action !== "stop") fail("approve the plan first");
  switch (ev.action) {
    case "stop": s.stopped = true; log(s, now, "control", "stop"); fx.push({ kind: "checkpoint" }, { kind: "write_export", what: "session" }); return;
    case "resume": s.stopped = false; fx.push(turn(s)); return;
    case "teach":
      if (s.phase === "diagnostic" || s.diagnostic.status === "pending") return finishDiagnostic(s, true, now, fx);
      if (s.feedbackAttemptId || s.phase === "repair") fail("finish the feedback first");
      s.current = undefined; s.phase = "teach"; fx.push(turn(s)); return;
    case "morePractice":
      if (s.feedbackAttemptId) fail("acknowledge the feedback first");
      if (s.phase === "close") { const n = activeNode(s)!; n.status = "active"; }
      s.current = undefined; s.phase = "check"; fx.push(turn(s)); return;
    case "advance": {
      if (s.phase === "close") return startNextNode(s, now, fx);
      const node = activeNode(s) ?? fail("no active node");
      const g = gates(s, node);
      const missing = [...g.entries()].filter(([, r]) => !r.passed).map(([id, r]) => `${id}: ${r.missing.join(", ")}`);
      if (missing.length) { fx.push({ kind: "notice", code: "gate_not_passed", text: `Not yet: ${missing.join(" · ")}` }); return; }
      return buildCheck(s, node, false, now, fx);
    }
    case "leaveWithGaps": {
      const node = activeNode(s) ?? fail("no active node");
      if (!ev.confirmToken) {
        const token = `confirm-${++s.counter}`; s.confirm.set(token, node.id);
        fx.push({ kind: "confirm_required", action: "leaveWithGaps", token, text: `Leave "${node.title}" with gaps? Unmet requirements stay listed in your cheat sheet; grades don't change.` });
        return;
      }
      if (s.confirm.get(ev.confirmToken) !== node.id) fail("confirmation token doesn't match this node");
      s.confirm.delete(ev.confirmToken);
      const g = gates(s, node);
      s.leftWithGaps.set(node.id, [...g.entries()].filter(([, r]) => !r.passed).flatMap(([id, r]) => r.missing.map(m => `${id}: ${m}`)));
      node.status = "left_with_gaps";
      log(s, now, "control", `left ${node.title} with gaps`);
      fx.push({ kind: "node_status", nodeId: node.id, status: "left_with_gaps" });
      return startNextNode(s, now, fx);
    }
  }
}

/** The "Now" view (SPEC §6 SessionState). */
export function sessionState(s: EngineState): SessionState {
  const node = activeNode(s);
  const debt = node ? node.subskills.flatMap(x => coverageDebt(x, gate(x, s.goal.mode, s.goal.pace, view(s)), view(s))) : [];
  return {
    activeNodeId: s.activeNodeId, loopPhase: s.phase, currentItemId: s.current?.itemId,
    openHypothesisIds: [...s.hypotheses.values()].filter(h => h.status === "open").map(h => h.id), coverageDebt: debt,
    candidates: s.candidates, nextIntendedMove: s.nextIntendedMove, timeUsedMin: Math.round(usedMin(s)), timeBudgetMin: s.goal?.timeBudgetMin,
    nodesPassed: s.plan?.nodes.filter(n => DONE.has(n.status)).length ?? 0, nodesTotal: s.plan?.nodes.length ?? 0, spend: s.spend,
  };
}

/** Queue the researcher in the background, once per trigger key (results are cached per topic/node). Never changes the phase. */
function research(s: EngineState, key: string, trigger: SourcePack["trigger"], input: Record<string, unknown>, fx: Effect[]) {
  if (s.researchKeys.has(key)) return;
  s.researchKeys.add(key);
  fx.push({ kind: "call_role", role: "researcher", purpose: trigger, background: true, input: { ...input, trigger, learnerSourceIds: s.goal.sourceIds ?? [], limits: RESEARCH } });
}

function acceptPack(s: EngineState, ev: Extract<EngineEvent, { type: "research_pack_received" }>, fx: Effect[]) {
  const p = ev.pack;
  if (s.packs.has(p.id)) fail("duplicate pack");
  for (const i of p.items) {
    if (!i.id || !i.title?.trim() || !i.relevance?.trim() || !Array.isArray(i.spans) || !i.reliability?.trim()) fail(`pack item ${i.id ?? "?"} is incomplete`);
    if (!i.unsourced && !i.url && !i.citation) fail(`pack item ${i.id} has no URL or citation; mark it unsourced`);
    if (i.nodeId && !s.plan?.nodes.some(n => n.id === i.nodeId)) fail(`pack item ${i.id} names an unknown node`);
  }
  // Auto-accept is the learner's own preview toggle, so acceptance still traces to the learner (F10).
  const auto = !!s.goal.preview.toggles.autoAcceptResearch;
  s.packs.set(p.id, { ...p, status: auto ? "accepted" : "pending", acceptedItemIds: auto ? p.items.map(i => i.id) : [] });
  const conflicts = p.items.filter(i => i.conflictsWithSourceId).length;
  fx.push({ kind: "notice", code: "research_ready", text: `${p.items.length} sources found${conflicts ? `; ${conflicts} conflict with your material (yours stays primary)` : ""}${auto ? " and added" : ". Review to accept"}.` });
}

/** Sources for a node: the learner's own first, then accepted research for this node or the whole unit. */
function sourcesFor(s: EngineState, nodeId: string) {
  const node = s.plan?.nodes.find(n => n.id === nodeId);
  const research = [...s.packs.values()].flatMap(p => p.items.filter(i => p.acceptedItemIds.includes(i.id) && (!i.nodeId || i.nodeId === nodeId)));
  return { learner: [...new Set([...(s.goal.sourceIds ?? []), ...(node?.sourceIds ?? [])])], research };
}
