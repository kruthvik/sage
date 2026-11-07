// Role host: turns an engine `call_role` effect into model calls and returns the events to feed back (SPEC §12).
// Stateless apart from what it reads from the engine state; every reply is still re-validated by the reducer.
import type { EngineEvent, EngineState, Effect } from "../../engine/src/state.ts";
import type { Item, PlanNode, Partition } from "../../core/src/types.ts";
import type { RoleCallInput, RoleCallResult } from "../../pi-adapter/src/runtime.ts";
import { GRADER_SYSTEM, graderUser, parseGrade } from "./grader.ts";
import { validateGrade } from "../../engine/src/evidence.ts";
import { CHECKER_SYSTEM, KEY_DISPUTE_SYSTEM, checkable, checkerUser, compareKey, keyDisputeUser, parseChecker, parseKeyDispute } from "./keycheck.ts";
import { PLANNER_SYSTEM, plannerUser, parsePlan, GENERATOR_SYSTEM, generatorUser, parseItems, SUMMARIZER_SYSTEM, summarizerUser, parseSummary, researcherSystem, researcherUser, parsePack } from "./roles.ts";

export type RoleName = "planner" | "tutor" | "grader" | "generator" | "feynman" | "summarizer" | "researcher" | "checker";
export interface RoleModel { provider: string; model: string; reasoning?: RoleCallInput["reasoning"] }
export type RoleModels = Record<RoleName, RoleModel>;
export interface HostDeps {
  models: RoleModels;
  roleCall(i: RoleCallInput): Promise<RoleCallResult>;
  researchCall(i: RoleCallInput & { limits: { maxSearches: number; maxFetches: number } }): Promise<RoleCallResult>;
  signal?: AbortSignal;
}
export interface HostEvent { event: EngineEvent; actor: "role" | "host" }
type CallRole = Extract<Effect, { kind: "call_role" }>;

// Bank batches by partition: each call fits the 4,096-token output cap, and partitions can't overlap (ED-18 total 12).
const BANK_SPLIT: [Partition, number][] = [["teaching", 3], ["practice", 5], ["assessment", 4]];

export async function runRole(fx: CallRole, s: EngineState, deps: HostDeps, seq: number): Promise<HostEvent[]> {
  const out: HostEvent[] = [];
  /** One call, logged; one retry when the reply doesn't parse (malformed JSON is the common failure, not a judgement). */
  const call = async <T>(role: RoleName, system: string, user: string, parse: (text: string) => T, research?: { maxSearches: number; maxFetches: number }): Promise<T> => {
    const m = deps.models[role];
    for (let attempt = 0; ; attempt++) {
      const req = { provider: m.provider, model: m.model, system, user, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
      const r = research ? await deps.researchCall({ ...req, limits: research }) : await deps.roleCall(req);
      out.push({ actor: "host", event: { type: "role_call_logged", role, inputTokens: r.usage.input, outputTokens: r.usage.output, ...(r.usage.costUsd === "unknown" ? {} : { costUsd: r.usage.costUsd }) } });
      try { return parse(r.text); } catch (e) { if (attempt >= 1) throw e; }
    }
  };
  const node = (id: unknown) => s.plan?.nodes.find(n => n.id === id);
  const pfx = `${fx.role[0]}${seq}`;

  /** Blind key check, then one regeneration round for items whose key disagrees; items still disagreeing are dropped. */
  const verified = async (items: Item[], regen: (bad: Item[], round: string) => Promise<Item[]>): Promise<Item[]> => {
    const check = async (xs: Item[]) => {
      const todo = xs.filter(checkable);
      if (!todo.length) return { ok: xs, bad: [] as Item[] };
      const solved = await call("checker", CHECKER_SYSTEM, checkerUser(todo), parseChecker);
      const bad = todo.filter(i => compareKey(i, solved.get(i.id)).verdict === "disagree");
      return { ok: xs.filter(i => !bad.includes(i)), bad };
    };
    const first = await check(items);
    if (!first.bad.length) return first.ok;
    const second = await check(await regen(first.bad, "r"));
    return [...first.ok, ...second.ok];
  };
  const replaceNote = (bad: Item[]) => `Replace ${bad.length} item(s) whose answer key was wrong or ambiguous. Write exactly ${bad.length} new items for the same subskills, partitions and activity types; double-check every key.`;

  switch (fx.role) {
    case "planner": {
      const plan = await call("planner", PLANNER_SYSTEM, plannerUser(s.goal), parsePlan);
      out.push({ actor: "role", event: { type: "plan_proposed", plan } });
      break;
    }
    case "generator": {
      if (fx.purpose === "node") {
        const n = fx.input.node as PlanNode;
        const batches = await Promise.all(BANK_SPLIT.map(([partition, count], k) => call("generator", GENERATOR_SYSTEM,
          generatorUser({ ...fx.input, size: undefined, partition, count, note: `Write exactly ${count} ${partition} items.${partition !== "teaching" && ["cram", "accelerate", "learn"].includes(s.goal?.mode)
            ? ` This mode requires transfer: for each subskill, include one apply_problem with evidences ["changed_application"] and a variation whose baselineItemId is another item id in this same reply, changing context, representation, format or structure (not only surface).` : ""}` }),
          t => parseItems(t, n.id, `${pfx}${"tpa"[k]}`))));
        const items = await verified(batches.flat(), async (bad, r) => call("generator", GENERATOR_SYSTEM,
          generatorUser({ ...fx.input, size: undefined, replace: bad.map(i => ({ subskillIds: i.subskillIds, partition: i.partition, activityType: i.activityType })), avoidStems: bad.map(i => i.stem), note: replaceNote(bad) }),
          t => parseItems(t, n.id, `${pfx}${r}`)));
        out.push({ actor: "role", event: { type: "bank_generated", purpose: "node", nodeId: n.id, items } });
      } else if (fx.purpose === "diagnostic") {
        const raw = await call("generator", GENERATOR_SYSTEM, generatorUser({ ...fx.input, partition: "practice", note: "Diagnostic: one quick item per subskill that best separates knows from doesn't know; give each item its nodeId." }),
          t => parseItems(t, "", pfx));
        const items = await verified(raw, async (bad, r) => call("generator", GENERATOR_SYSTEM, generatorUser({ ...fx.input, partition: "practice", avoidStems: bad.map(i => i.stem), note: `Diagnostic. ${replaceNote(bad)} Give each item its nodeId.` }), t => parseItems(t, "", `${pfx}${r}`)));
        out.push({ actor: "role", event: { type: "bank_generated", purpose: "diagnostic", items } });
      } else {
        const n = node(fx.input.nodeId);
        const avoid = [...s.items.values()].filter(i => i.nodeId === n?.id).map(i => i.stem);
        const ask = (extra: Record<string, unknown>, p: string) => call("generator", GENERATOR_SYSTEM, generatorUser({ ...fx.input, node: n, mode: s.goal.mode, exam: s.goal.exam, ...extra }), t => parseItems(t, String(fx.input.nodeId), p));
        const items = await verified(await ask({ avoidStems: avoid }, pfx), (bad, r) => ask({ count: bad.length, avoidStems: [...avoid, ...bad.map(i => i.stem)], note: replaceNote(bad) }, `${pfx}${r}`));
        out.push({ actor: "role", event: { type: "bank_generated", purpose: fx.purpose as "topup" | "replace", items } });
      }
      break;
    }
    case "grader": {
      const item = fx.input.item as Item;
      if (fx.purpose === "key_dispute") {
        const r = await call("grader", KEY_DISPUTE_SYSTEM, keyDisputeUser(item, String(fx.input.response), String(fx.input.argument)), t => parseKeyDispute(t, item));
        out.push({ actor: "role", event: { type: "key_dispute_resolved", attemptId: String(fx.input.attemptId), ...r } });
        break;
      }
      const grade = await call("grader", GRADER_SYSTEM, graderUser(item, String(fx.input.response), {
        assistance: fx.input.assistance as string[] | undefined, ...(typeof fx.input.argument === "string" ? { argument: fx.input.argument } : {}) }), t => { const g = parseGrade(t, item); const probs = validateGrade(g, String(fx.input.response)); if (probs.length) throw new Error(`grade rejected: ${probs.join(", ")}`); return g; });
      // Repair attempts never count as evidence (the engine also enforces this).
      out.push({ actor: "role", event: { type: "grade_received", attemptId: String(fx.input.attemptId), grade: fx.purpose === "repair" ? { ...grade, dimensionsObserved: [] } : grade } });
      break;
    }
    case "summarizer": {
      if (fx.purpose !== "node_close") break; // shortcut: session-end summary is rendered by the export writer from state; add a model call if exports need prose
      const n = node(fx.input.nodeId);
      if (!n) break;
      const ids = new Set([...s.items.values()].filter(i => i.nodeId === n.id).map(i => i.id));
      const evidence = s.attempts.filter(a => ids.has(a.itemId)).map(a => ({ stem: s.items.get(a.itemId)?.stem.slice(0, 160), score: a.grade?.score0to100, independent: a.independent,
        flaws: a.grade?.flaws.filter(f => f.severity !== "polish").map(f => f.problem) }));
      const sum = await call("summarizer", SUMMARIZER_SYSTEM, summarizerUser({ node: { title: n.title, subskills: n.subskills.map(x => x.statement) }, attempts: evidence,
        hypotheses: [...s.hypotheses.values()].filter(h => n.subskills.some(x => x.id === h.subskillId)).map(h => ({ statement: h.statement, status: h.status })) }), parseSummary);
      out.push({ actor: "role", event: { type: "digest_written", nodeId: n.id, digest: sum.digest } });
      break;
    }
    case "researcher": {
      const limits = fx.input.limits as { maxSearches: number; maxFetches: number };
      const items = await call("researcher", researcherSystem(limits), researcherUser({ ...fx.input, limits: undefined, plan: s.plan ? s.plan.nodes.map(n => ({ id: n.id, title: n.title })) : undefined }),
        t => parsePack(t, pfx), limits);
      const nodeId = (fx.input.node as PlanNode | undefined)?.id ?? (fx.input.nodeId as string | undefined);
      out.push({ actor: "role", event: { type: "research_pack_received", pack: { id: pfx, trigger: fx.purpose as never, items,
        ...(nodeId ? { nodeId } : {}), ...(typeof fx.input.question === "string" ? { question: fx.input.question } : {}) } } });
      break;
    }
  }
  return out;
}

/** Owner defaults (2026-11-07, after calibration). User-selectable in settings; never a Claude model (owner M0). */
export const DEFAULT_ROLE_MODELS: RoleModels = {
  planner: { provider: "openai-codex", model: "gpt-6.1-sol", reasoning: "low" }, // default reasoning exceeded the 60 s deadline
  tutor: { provider: "openai-codex", model: "gpt-6.1-sol" },
  grader: { provider: "openai-codex", model: "gpt-6.1-sol" },                    // only model passing A1–A10 (MAE 5.5)
  generator: { provider: "antigravity", model: "gemini-3.8-flash" },
  feynman: { provider: "antigravity", model: "gemini-3.8-flash" },
  summarizer: { provider: "antigravity", model: "gemini-3.8-flash" },
  researcher: { provider: "antigravity", model: "gemini-3.8-flash" },
  checker: { provider: "antigravity", model: "gemini-3.8-flash" },                // blind key check (owner: cheap model where code can't calculate)
};
