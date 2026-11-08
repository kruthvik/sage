// No-network stand-in for the pi runtime: answers each role prompt with valid JSON and plays a simple tutor through the
// real Sage tools. Used by driver/server tests and as the eval's fixed (non-adaptive) baseline tutor.
import type { DriverRuntime } from "../../agent/src/driver.ts";
import type { RoleCallInput, RoleCallResult, TutorTurnResult } from "../../pi-adapter/src/runtime.ts";
import { PLANNER_SYSTEM, GENERATOR_SYSTEM, SUMMARIZER_SYSTEM, TRANSCRIBER_SYSTEM } from "../../agent/src/roles.ts";
import { CHECKER_SYSTEM } from "../../agent/src/keycheck.ts";
import { GRADER_SYSTEM } from "../../agent/src/grader.ts";

const res = (text: string): RoleCallResult => ({ text, stopReason: "stop", provider: "fake", model: "fake", ms: 0, usage: { input: Math.ceil(text.length / 4), output: 50, costUsd: 0.0001 } });
const word = (k: number) => { let s = ""; for (let x = k + 26; x > 0; x = Math.floor(x / 26)) s = "abcdefghijklmnopqrstuvwxyz"[x % 26] + s; return s; }; // fingerprints normalise digits, so stems differ by letters
const data = (user: string) => { const m = user.match(/<<<\n([\s\S]*?)\n>>>/); try { return JSON.parse(m?.[1] ?? "{}"); } catch { return {}; } };

export function fakeRuntime(opts: { nodes?: number } = {}): DriverRuntime {
  let n = 0;
  const roleCall = async (i: RoleCallInput): Promise<RoleCallResult> => {
    if (i.system === PLANNER_SYSTEM) return res(JSON.stringify({ nodes: Array.from({ length: opts.nodes ?? 1 }, (_, k) => ({ id: `n${k + 1}`, title: `Topic ${k + 1}`, prerequisites: k ? [`n${k}`] : [], examWeight: "high", estMinutes: 10,
      knowledgeConfidence: "high", misconceptionsToProbe: [], subskills: [{ id: `n${k + 1}.s1`, statement: "can recall the key term", kind: "declarative", selectionRelevant: false }] })) }));
    if (i.system === GENERATOR_SYSTEM) {
      const d = data(i.user), node = d.node ?? { id: d.nodeId }, sub = node.subskills?.[0]?.id ?? `${node.id}.s1`;
      const count = d.count ?? 4, partition = d.partition ?? "practice";
      // Cram needs recall + selection/explanation + changed application, so the fake bank cycles through all three.
      const items = Array.from({ length: count }, (_, j) => { const k = ++n, base = { id: `q${k}`, subskillIds: [sub], difficulty: 2, partition, familyId: `f${k}`, hints: ["Look at the definition.", "Recall the list.", "It is in the first unit."] };
        switch (j % 4) {
          case 0: return { ...base, activityType: "free_recall", evidences: ["recall"], stem: `State the term the course calls ${word(k)} when it is defined in the ${word(k * 7 + 3)} unit.`, key: { kind: "exact", values: [`term${k}`] } };
          case 1: return { ...base, activityType: "conceptual_mcq", evidences: ["selection"], stem: `Which option fits the ${word(k)} situation described in the ${word(k * 5 + 1)} notes?`,
            choices: [`opt${word(k)}`, `alt${word(k + 1)}`, `other${word(k + 2)}`], key: { kind: "choice", index: 0 }, distractorRationales: ["", "wrong context", "wrong scale"] };
          case 2: return { ...base, activityType: "apply_problem", evidences: ["execution"], stem: `Apply the ${word(k)} rule to the ${word(k * 3 + 2)} case and give the count.`, key: { kind: "numeric", value: k, tolerance: 0 } };
          default: return { ...base, activityType: "apply_problem", evidences: ["changed_application"], stem: `Use the same rule in a new ${word(k * 13 + 4)} setting about ${word(k + 77)} and give the count.`,
            key: { kind: "numeric", value: k, tolerance: 0 }, variation: { baselineItemId: `q${k - 1}`, changedDimensions: ["context"], invariant: "same rule" } };
        } });
      return res(JSON.stringify({ items }));
    }
    if (i.system === GRADER_SYSTEM) return res(JSON.stringify({ criteria: [{ index: 0, credit: 1, quote: i.user.split("<<<\n").at(-1)!.split("\n>>>")[0]!.slice(0, 20) }], flaws: [], feedback: "Good." }));
    if (i.system === CHECKER_SYSTEM) return res(JSON.stringify({ answers: [] })); // shortcut: the fake checker abstains (verdict unknown keeps items); host.test covers real verdicts
    if (i.system === SUMMARIZER_SYSTEM) return res(JSON.stringify({ digest: "Recalls the key terms reliably.", cheatSheet: ["term = definition"] }));
    if (i.system === TRANSCRIBER_SYSTEM) return res(JSON.stringify({ text: `x^2 + 2x = 8 (from ${i.images?.length ?? 0} photo)` }));
    return res(JSON.stringify({ items: [] }));
  };
  const tutorTurn = async (i: Parameters<DriverRuntime["tutorTurn"]>[0]): Promise<TutorTurnResult> => {
    const calls: TutorTurnResult["calls"] = [];
    const call = (name: string, params: Record<string, unknown>) => { const t = i.tools.find(x => x.name === name)!; const result = t.run(params); calls.push({ name, params, result }); return result.startsWith("ok"); };
    const sub = i.user.match(/^- (\S+) \((?:declarative|procedural)/m)?.[1];
    const items = [...i.user.matchAll(/^- (\S+) practice /gm)].map(m => m[1]!);
    const cand = i.user.match(/^- (\S+) (?!checkpoint)\w+ →/m)?.[1];
    let ended = false;
    if (i.active.includes("select_move") && cand) ended = call("select_move", { candidateId: cand, reasonCodes: ["baseline"], nextIntendedMove: "follow the first candidate" });
    else if (i.user.includes("## Task\nTeach") && sub) ended = call("present", { text: "Here is the idea in one sentence, with one example.", subskillIds: [sub] });
    else if (i.active.includes("present") && items.length) ended = items.some(id => call("present", { itemId: id })); // first one the engine accepts
    if (!ended && i.active.includes("activity") && sub && !i.active.includes("select_move")) { const k = ++n; ended = call("activity", { activityType: "free_recall", subskillIds: [sub], evidences: ["recall"], difficulty: 2,
      stem: `Name the idea filed under ${word(k + 500)} in the ${word(k * 11 + 9)} notes.`, key: { kind: "exact", values: [`term${k}`] } }); }
    return { ended, calls, text: i.active.includes("present") || i.active.includes("select_move") ? "" : "Fix the flagged part and try again.", usage: { input: Math.ceil(i.user.length / 4), output: 30, costUsd: 0.0001 }, ms: 0 };
  };
  return { roleCall, researchCall: async () => res(JSON.stringify({ items: [] })), tutorTurn };
}
