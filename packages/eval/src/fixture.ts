// Offline fixture: a small two-node unit, a stub generator, a stub tutor that always takes the first sensible candidate,
// and a stub grader. No models. Used by scripted personas (SPEC §18.2).
import type { Goal, Grade, Item, Plan, ResponseInput } from "../../core/src/types.ts";
import { reduce, initialState, sessionState, type Actor, type Effect, type EngineEvent, type EngineState } from "../../engine/src/index.ts";

export const goal = (over: Partial<Goal> = {}): Goal => ({
  objective: "Derivatives: power rule and chain rule", mode: "cram", pace: "normal", timeBudgetMin: 60, allowedAids: [],
  preview: { profile: "cram", toggles: { diagnostic: false, hints: true, studio: false, diagrams: false, pdfCheatsheets: false, obsidianExport: false, reviewBeforeAdvance: true }, feedbackRigor: "rigorous" },
  ...over,
});

export const plan: Plan = {
  rev: 0, edges: [],
  nodes: [
    { id: "n1", title: "Power rule", order: 0, prerequisites: [], examWeight: "high", misconceptionsToProbe: ["forgets to lower exponent"], estMinutes: 20, status: "locked",
      subskills: [{ id: "s1", nodeId: "n1", statement: "Differentiate x^n", kind: "procedural", selectionRelevant: false, requiredDimensions: [] }] },
    { id: "n2", title: "Chain rule", order: 1, prerequisites: ["n1"], examWeight: "medium", misconceptionsToProbe: ["drops inner derivative"], estMinutes: 20, status: "locked",
      subskills: [{ id: "s2", nodeId: "n2", statement: "Differentiate f(g(x))", kind: "procedural", selectionRelevant: false, requiredDimensions: [] }] },
  ],
};

const hints = (ans: string): [string, string, string] => ["Think about what happens to the exponent.", "Bring the exponent down, then reduce it by one.", `Worked: the result is ${ans}.`];
/** Per subskill: teaching example, practice items (families f1..), explain-why items with a rubric, varied application items, assessment items. */
export function bank(nodeId: string, sub: string): Item[] {
  const base = { nodeId, subskillIds: [sub], difficulty: 3 as const };
  const num = (id: string, fam: string, part: Item["partition"], stem: string, value: number, extra: Partial<Item> = {}): Item =>
    ({ ...base, id, familyId: fam, partition: part, activityType: "apply_problem", evidences: ["execution"], stem, key: { kind: "numeric", value, tolerance: 0.001 }, hints: hints(String(value)), ...extra });
  return [
    num(`${sub}-ex`, `${sub}-fam0`, "teaching", `Worked example: find the slope of the curve at the point where the input equals 2 for the ${sub} case`, 12),
    num(`${sub}-p1`, `${sub}-fam1`, "practice", `Evaluate the derivative at the input 3 for the first ${sub} function`, 27),
    num(`${sub}-p2`, `${sub}-fam2`, "practice", `Evaluate the derivative at the input 1 for a second family ${sub} function`, 5),
    num(`${sub}-p3`, `${sub}-fam3`, "practice", `Evaluate the derivative at the input 2 for a third family ${sub} function`, 32),
    num(`${sub}-v1`, `${sub}-fam4`, "practice", `A particle's height in a new physical context: evaluate its rate of change at time 2 for ${sub}`, 12,
      { evidences: ["execution", "changed_application"], variation: { baselineItemId: `${sub}-p1`, changedDimensions: ["context", "representation"], invariant: "same differentiation rule" } }),
    num(`${sub}-v2`, `${sub}-fam5`, "practice", `In a table representation, estimate the rate of change at the second row for ${sub}`, 6,
      { evidences: ["execution", "changed_application"], variation: { baselineItemId: `${sub}-p2`, changedDimensions: ["representation"], invariant: "same differentiation rule" } }),
    { ...base, id: `${sub}-w1`, familyId: `${sub}-fam6`, partition: "practice", activityType: "explain_why", evidences: ["explanation"], stem: `Explain in your own words why the rule for ${sub} works`, rubric: ["names the rule", "justifies each step"], hints: ["Think about where the factor comes from.", "Use the limit definition.", "Worked: expand (x+h)^n and keep the h term."], key: { kind: "reference", text: "reference explanation" } },
    { ...base, id: `${sub}-w2`, familyId: `${sub}-fam7`, partition: "practice", activityType: "explain_why", evidences: ["explanation"], stem: `Explain why a common shortcut for ${sub} gives the wrong answer`, rubric: ["identifies the error", "states the correct rule"], hints: ["Compare it with the rule.", "Check what happens to the exponent.", "Worked: the shortcut skips lowering the exponent."], key: { kind: "reference", text: "reference explanation" } },
    num(`${sub}-a1`, `${sub}-fam8`, "assessment", `Exam-style: compute the derivative value at input 4 for the ${sub} assessment function`, 48, { difficulty: 5 }),
    num(`${sub}-a2`, `${sub}-fam9`, "assessment", `Exam-style: compute the derivative value at input 5 for another ${sub} assessment function`, 75, { difficulty: 4 }),
    num(`${sub}-a3`, `${sub}-fam10`, "assessment", `Exam-style: compute the derivative value at input 6 for a third ${sub} assessment function`, 108, { difficulty: 4 }),
  ];
}

export type Persona = (item: Item, ctx: { chunk?: string; attempt: number; cue: number }) => { input: ResponseInput; quality?: "good" | "imprecise" | "wrong_reasoning" | "wrong"; hint?: 1 | 2 | 3 };
const keyText = (i: Item) => (i.key?.kind === "numeric" ? String(i.key.value) : "");

/** Stub grader: honours the persona's declared quality, quoting the response like a real grader must. */
export function stubGrade(item: Item, response: string, quality: string): Grade {
  const q = response.slice(0, 40);
  const crit = (item.rubric ?? ["answer"]).map(c => ({ criterion: c, satisfied: quality === "good" || quality === "imprecise", quote: q }));
  if (quality === "good") return { score0to100: 92, criterionEvidence: crit, flaws: [], dimensionsObserved: item.evidences, feedback: "Clear and correct.", grader: "model" };
  if (quality === "imprecise") return { score0to100: 82, criterionEvidence: crit, flaws: [{ quote: q, problem: "Imprecise wording", suggestion: "Name the quantity exactly", severity: "precision" }], dimensionsObserved: item.evidences, feedback: "Right idea; wording imprecise.", grader: "model" };
  return { score0to100: 35, criterionEvidence: crit.map(c => ({ ...c, satisfied: false })), flaws: [{ quote: q, problem: quality === "wrong_reasoning" ? "Reasoning doesn't support the answer" : "Wrong idea", suggestion: "Revisit the rule", severity: "blocking" }], dimensionsObserved: [], feedback: "The reasoning is wrong; see the flagged step.", grader: "model" };
}

export interface RunResult { state: EngineState; effects: Effect[]; log: { event: EngineEvent; actor: Actor; now: string }[]; errors: string[] }

/** Drives a whole session: stub planner/generator/tutor/grader, persona answers. */
export function runSession(persona: Persona, opts: { goal?: Goal; maxSteps?: number; stepMs?: number; onStep?: (s: EngineState, fx: Effect[]) => EngineEvent[] | void; bank?: typeof bank } = {}): RunResult {
  let state = initialState();
  let t = Date.parse("2026-11-07T09:00:00.000Z");
  const log: RunResult["log"] = [], all: Effect[] = [], errors: string[] = [];
  const queue: { event: EngineEvent; actor: Actor }[] = [{ event: { type: "session_created", sessionId: "s", goal: opts.goal ?? goal() }, actor: "learner" }];
  const quality = new Map<string, string>();
  let attempts = 0;
  for (let step = 0; queue.length && step < (opts.maxSteps ?? 2000); step++) {
    const { event, actor } = queue.shift()!;
    const now = new Date((t += opts.stepMs ?? 20_000)).toISOString();
    let fx: Effect[];
    try { const r = reduce(state, event, now, actor); state = r.state; fx = r.effects; log.push({ event, actor, now }); }
    catch (e) { errors.push(`${event.type}: ${(e as Error).message}`); continue; }
    all.push(...fx);
    const extra = opts.onStep?.(state, fx);
    if (extra) for (const e of extra) queue.push({ event: e, actor: e.type === "tick" ? "host" : "learner" });
    for (const f of fx) {
      if (f.kind === "call_role" && f.role === "planner") queue.push({ event: { type: "plan_proposed", plan }, actor: "role" }, { event: { type: "plan_approved" }, actor: "learner" });
      if (f.kind === "call_role" && f.role === "generator" && f.purpose === "node") { const n = f.input.node as { id: string; subskills: { id: string }[] }; queue.push({ event: { type: "bank_generated", purpose: "node", nodeId: n.id, items: n.subskills.flatMap(x => (opts.bank ?? bank)(n.id, x.id)) }, actor: "role" }); }
      if (f.kind === "call_role" && f.role === "generator" && f.purpose === "topup") queue.push({ event: { type: "bank_generated", purpose: "topup", items: [] }, actor: "role" });
      if (f.kind === "call_role" && f.role === "grader") {
        const a = state.attempts.find(x => x.id === state.pendingAttemptId)!;
        const item = state.items.get(a.itemId)!;
        const g = stubGrade(item, a.response, f.purpose === "repair" ? "good" : quality.get(a.responseEventId) ?? "good");
        queue.push({ event: { type: "grade_received", attemptId: a.id, grade: f.purpose === "repair" ? { ...g, dimensionsObserved: [] } : g }, actor: "role" });
      }
      if (f.kind === "present_feedback") queue.push({ event: { type: "feedback_acked", attemptId: f.attemptId }, actor: "learner" });
      if (f.kind === "repair_required") queue.push({ event: { type: "response_submitted", input: { kind: "text", text: "Repair: the correct rule is to bring the exponent down and reduce it by one." }, responseEventId: `r${step}`, latencyMs: 20_000 }, actor: "learner" });
      if (f.kind === "notice" && f.code === "stopping_point") queue.push({ event: { type: "control", action: "advance" }, actor: "learner" });
      if (f.kind === "present_item") {
        const item = state.items.get(f.item.id)!;
        const ans = persona(item, { chunk: state.chunk?.text, attempt: ++attempts, cue: state.current?.cueLevel ?? 0 });
        if (ans.hint) queue.push({ event: { type: "hint_requested", level: ans.hint }, actor: "learner" });
        const rid = `r${attempts}`;
        quality.set(rid, ans.quality ?? "good");
        queue.push({ event: { type: "response_submitted", input: ans.input, responseEventId: rid, latencyMs: 30_000 }, actor: "learner" });
      }
      if (f.kind === "tutor_turn") queue.push(...tutor(state, f).map(event => ({ event, actor: "tutor" as Actor })));
    }
  }
  return { state, effects: all, log, errors };
}

/** Stub tutor: teaches with the worked example, then picks the first candidate and the first unused practice item that fits it. */
function tutor(s: EngineState, f: Extract<Effect, { kind: "tutor_turn" }>): EngineEvent[] {
  const nodeId = s.activeNodeId;
  const fresh = (pred: (i: Item) => boolean) => [...s.items.values()].find(i => i.partition === "practice" && (s.phase === "diagnostic" || i.nodeId === nodeId) && !s.deliveredAt.has(i.id) && pred(i)
    && !i.subskillIds.some(id => { const l = s.cue.get(id); return l && s.items.get(l.itemId)?.familyId === i.familyId; })
    && (!i.variation || s.deliveredAt.has(i.variation.baselineItemId)));
  if (f.phase === "teach") {
    const sub = s.plan!.nodes.find(n => n.id === nodeId)!.subskills[0]!.id;
    return [{ type: "chunk_presented", text: `The rule: bring the exponent down as a coefficient and lower the exponent by one. Then substitute the input.`, subskillIds: [sub], exampleItemId: s.deliveredAt.has(`${sub}-ex`) ? undefined : `${sub}-ex` }];
  }
  if (f.phase === "prime" || f.phase === "check" || f.phase === "diagnostic") {
    const want = s.decisions.at(-1);
    const kind = want ? s.candidates.find(c => c.id === want.selectedId)?.kind : undefined;
    const pick = (kind === "vary_application" ? fresh(i => !!i.variation) : undefined)
      ?? (kind === "check" ? fresh(i => i.activityType === "explain_why") : undefined) ?? fresh(i => !i.variation && i.activityType !== "explain_why") ?? fresh(() => true);
    if (!pick) {
      const n = s.items.size; // unique per ad hoc item, so each gets a new family
      return [{ type: "item_presented", itemId: `adhoc-${n}`, adhoc: { id: `adhoc-${n}`, nodeId: nodeId!, subskillIds: [s.plan!.nodes.find(x => x.id === nodeId)!.subskills[0]!.id], activityType: "apply_problem", difficulty: 3, partition: "practice", familyId: `adhoc-fam-${n}`, evidences: ["execution"], stem: `Fresh practice item: evaluate the derivative of function ${"fghkmpqrstuvwxyz"[n % 16]}${"abcdefghij"[Math.floor(n / 16) % 10]} at the requested input`, key: { kind: "numeric", value: 4242, tolerance: 0.01 }, hints: hints("4242") } }];
    }
    return [{ type: "item_presented", itemId: pick.id }];
  }
  if (f.phase === "adapt") {
    const c = f.candidates.find(x => x.kind !== "checkpoint" && x.kind !== "teach") ?? f.candidates.find(x => x.kind === "teach");
    if (!c) return [];
    return [{ type: "move_selected", candidateId: c.id, reasonCodes: c.reasonCodes, nextIntendedMove: `${c.kind} on ${c.targetSubskillIds.join(", ")}` }];
  }
  return [];
}

export const answerFor = keyText;
export { sessionState };
