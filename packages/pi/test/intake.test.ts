import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../../core/src/contracts.ts";
import { profilePreferences } from "../../core/src/experience.ts";
import { createTutorExtension, type TutorBridge, type TutorExtensionOptions } from "../src/tutor.ts";

async function harness(options: { previous?: Goal; cancel?: string; sources?: boolean; sourceRemoved?: boolean; stale?: boolean; hasUI?: boolean; startup?: boolean; badTime?: boolean; blank?: boolean; custom?: boolean; previewStale?: boolean; imageSource?: boolean; oversizedImage?: boolean } = {}) {
  const commands = new Map<string, RegisteredCommand>(), handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const questions: string[] = [], menus: string[][] = [], saved: Goal[] = [], sent: string[] = [], forwarded: string[] = [], notices: string[] = [], confirmations: string[] = [], sourceActions: string[] = [];
  let owner = "intake-owner", packet = { goal: options.previous ? { body: options.previous, revision_id: "existing-goal" } : null as { body: Goal; revision_id: string } | null, learning_state: { current_task: null } }, sourceCalls = 0, picked = false, timeTurn = 0, profileTurn = 0;
  const answers = (title: string) => {
    questions.push(title);
    if (options.cancel && title.includes(options.cancel)) return undefined;
    if (title.startsWith("What specifically")) return "Python functions for a small data-cleaning project";
    if (options.blank) return "";
    if (title.includes("already know")) { if (options.stale) owner = "changed-owner"; return "I know variables and loops; function arguments confuse me."; }
    if (title.includes("by the end")) return "Write and explain a reusable cleaning function";
    if (title.includes("minutes")) return options.badTime ? ["banana", "0", "1441", "45"][timeTurn++] : "45";
    if (title.includes("preferences")) return "Use short examples and explain why each step works.";
    if (title.includes("selected sources")) return "Use the attached notes as the main material; focus on functions.";
    return "";
  };
  const ctx = { hasUI: options.hasUI !== false, mode: "tui", model: { provider: "owned-fixture", id: "offline" }, isIdle: () => true,
    sessionManager: { getSessionId: () => owner, getHeader: () => ({}) },
    ui: { input: async (title: string) => answers(title), select: async (title: string, choices: string[]) => {
      questions.push(title); menus.push(choices);
      if (options.cancel === "sources" && title.toLowerCase().includes("sources")) return undefined;
      if (title.includes("profile and features")) {
        const label = options.custom ? ["Thorough", "MCQ", "Feedback:", "Review before automatic", "Start with these settings"][profileTurn++]! : "Start with these settings";
        if (options.previewStale && label === "Start with these settings") owner = "changed-owner";
        return choices.find(c => c.includes(label));
      }
      if (options.sources && !picked) { picked = true; return choices.find(c => c.includes("Accepted notes")); }
      return choices.find(c => c === (options.sources ? "Use selected sources" : "Continue without sources"));
    }, confirm: async (title: string, message: string) => { questions.push(title); confirmations.push(message); return options.cancel !== "sharing"; }, notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {} },
  } as unknown as ExtensionCommandContext;
  const bridge: TutorBridge = {
    inputAdmission: () => { const original = owner; return { assertCurrent() { if (owner !== original) throw new Error("Session changed"); }, assertScopeCurrent() {}, goalCreated() {} }; },
    operation: async () => packet,
    input: async text => { forwarded.push(text); },
    goal: async body => { saved.push(body); packet = { ...packet, goal: { revision_id: "saved-goal", body } }; return { revision_id: "saved-goal" }; },
    activate: async () => ({ lessons: options.previous ? [{ entity_id: "existing", objective: options.previous.objective }] : [] }),
    source: async args => { sourceCalls++; sourceActions.push(args); if (options.imageSource && args.startsWith("status ")) return { mime: "image/png" }; return [{ source_id: "accepted-notes", title: "Accepted notes", status: options.sourceRemoved && sourceCalls > 1 ? "removed" : "indexed", ...(options.imageSource ? { mime: "image/png", original_size_bytes: options.oversizedImage ? 9 * 1024 * 1024 : 1024 } : {}) }, { source_id: "unaccepted-notes", title: "Unaccepted private draft", status: "needs_review" }]; },
    approve: async () => ({}), calls: async () => {}, stop: async () => ({}), shutdown: async () => {},
  };
  const api = { registerTool() {}, registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command), on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), sendUserMessage: (text: string) => sent.push(text) } as unknown as ExtensionAPI;
  const extensionOptions = { startup: options.startup ? { mode: "learn", goal: "Python" } : {} };
  createTutorExtension(bridge, extensionOptions as TutorExtensionOptions)(api);
  return { commands, handlers, ctx, saved, sent, forwarded, questions, menus, notices, confirmations, sourceActions, sourceCalls: () => sourceCalls, newSession: () => { owner = "next-intake-owner"; packet = { ...packet, goal: null }; } };
}

const existing: Goal = { mode: "learn", objective: "My saved goal", subject: "computing", horizon_days: 7, budget_minutes: 50, target_format: "Explain an existing project", criteria: ["Saved criterion"], allowed_aids: ["My notes"], constraints: ["Keep my scope"], prior_experience: "Already know basic functions", learner_notes: "Use selected notes as references", probe: "offer", provider_sharing: true, source_ids: ["already-selected"], learning_preferences: profilePreferences("thorough") };

test("native intake: a new lesson asks scope, background, outcome, time and explicit source use before saving", async () => {
  const h = await harness({ sources: true }); await h.commands.get("learn")!.handler("Python", h.ctx);
  expect(h.saved).toHaveLength(1);
  expect(h.saved[0]).toMatchObject({ objective: "Python functions for a small data-cleaning project", prior_experience: "I know variables and loops; function arguments confuse me.", target_format: "Write and explain a reusable cleaning function", budget_minutes: 45, constraints: ["Use short examples and explain why each step works."], source_ids: ["accepted-notes"], provider_sharing: true });
  expect(h.saved[0]!.learner_notes).toContain("focus on functions");
  expect(h.menus.flat().some(choice => choice.includes("Unaccepted private draft"))).toBe(false);
  expect(h.sourceCalls()).toBe(2); expect(h.sent).toHaveLength(1);
});

test("native intake: original image sharing is explicit, cancelable and bounded before a goal is saved", async () => {
  const h = await harness({ sources: true, imageSource: true }); await h.commands.get("learn")!.handler("Images", h.ctx);
  expect(h.confirmations.join(" ")).toContain("original PNG/JPEG images"); expect(h.confirmations.join(" ")).toContain("not just OCR"); expect(h.saved).toHaveLength(1);
  const canceled = await harness({ sources: true, imageSource: true, cancel: "sharing" }); await canceled.commands.get("learn")!.handler("Images", canceled.ctx); expect(canceled.saved).toEqual([]); expect(canceled.sent).toEqual([]);
  const oversized = await harness({ sources: true, imageSource: true, oversizedImage: true }); await oversized.commands.get("learn")!.handler("Images", oversized.ctx); expect(oversized.saved).toEqual([]); expect(oversized.notices.join(" ")).toContain("8 MiB");
});

test("native source attach asks before sharing an original image and honors cancellation", async () => {
  for (const cancel of [undefined, "sharing"]) {
    const h = await harness({ previous: existing, imageSource: true, cancel }); await h.commands.get("source")!.handler("attach accepted-notes", h.ctx);
    expect(h.confirmations.join(" ")).toContain("original image"); expect(h.sourceActions).toEqual(cancel ? ["status accepted-notes"] : ["status accepted-notes", "attach accepted-notes"]);
  }
});

test("native intake: ordinary first input uses the same questions and forwards only after saving", async () => {
  const h = await harness();
  await h.handlers.get("input")!({ source: "interactive", text: "Help me learn Python" }, h.ctx);
  expect(h.saved).toHaveLength(1); expect(h.saved[0]!.budget_minutes).toBe(45);
  expect(h.questions.some(q => q.includes("already know"))).toBe(true);
  expect(h.forwarded).toEqual(["Help me learn Python"]);
});

test("native intake: canceling a question, source choice or sharing saves nothing and starts no tutoring", async () => {
  for (const cancel of ["What specifically", "already know", "by the end", "minutes", "preferences", "sources", "How should we use", "sharing"]) {
    const h = await harness({ cancel, sources: cancel === "How should we use" }); await h.commands.get("learn")!.handler("Python", h.ctx);
    expect(h.saved).toEqual([]); expect(h.sent).toEqual([]); expect(h.forwarded).toEqual([]);
  }
});

test("native intake: source removal and a changed native session cannot commit stale questionnaire answers", async () => {
  for (const options of [{ sources: true, sourceRemoved: true }, { stale: true }]) {
    const h = await harness(options); await h.commands.get("learn")!.handler("Python", h.ctx);
    expect(h.saved).toEqual([]); expect(h.sent).toEqual([]); expect(h.notices.length).toBeGreaterThan(0);
  }
});

test("native intake: existing lessons keep their settings and do not repeat opening questions", async () => {
  const h = await harness({ previous: existing });
  await h.commands.get("learn")!.handler("", h.ctx);
  expect(h.questions).toEqual([]); expect(h.sourceCalls()).toBe(0); expect(h.saved[0]).toEqual(existing);
  await h.handlers.get("input")!({ source: "interactive", text: "Continue my lesson" }, h.ctx);
  expect(h.questions).toEqual([]); expect(h.saved).toHaveLength(1); expect(h.forwarded).toEqual(["Continue my lesson"]);
});

test("native intake: interactive startup begins questions once, while headless commands retain explicit defaults", async () => {
  const h = await harness({ startup: true }); await h.handlers.get("session_start")!({}, h.ctx);
  expect(h.saved).toHaveLength(1); expect(h.questions.some(q => q.includes("What specifically"))).toBe(true);
  await h.handlers.get("session_start")!({}, h.ctx); expect(h.saved).toHaveLength(1);
  const resumed = await harness({ startup: true, previous: { ...existing, mode: "exam" } }); await resumed.handlers.get("session_start")!({}, resumed.ctx); expect(resumed.questions).toEqual([]); expect(resumed.saved).toEqual([]);
  h.newSession(); await h.handlers.get("session_start")!({}, h.ctx); expect(h.saved).toHaveLength(2);
  const headless = await harness({ hasUI: false }); await headless.commands.get("learn")!.handler("Python", headless.ctx);
  expect(headless.questions).toEqual([]); expect(headless.sourceCalls()).toBe(0); expect(headless.saved[0]).toMatchObject({ objective: "Python", prior_experience: "unsure", budget_minutes: 30, source_ids: [] });
});

test("native intake: invalid session times are corrected rather than silently guessed", async () => {
  const h = await harness({ badTime: true }); await h.commands.get("learn")!.handler("Python", h.ctx);
  expect(h.saved[0]!.budget_minutes).toBe(45); expect(h.notices).toHaveLength(3);
});

test("native intake: optional blanks preserve honest unknowns without inventing learner evidence", async () => {
  const h = await harness({ blank: true }); await h.commands.get("learn")!.handler("Python", h.ctx);
  expect(h.saved).toHaveLength(1); expect(h.saved[0]).toMatchObject({ prior_experience: "unsure", budget_minutes: 30, constraints: [], source_ids: [] });
  expect(h.saved[0]!.learner_notes).toBeUndefined(); expect(h.saved[0]!.target_format).toContain("refine in conversation");
});

test("native intake: /sage retains the profile and switches chosen in its native preview", async () => {
  const h = await harness({ custom: true }); await h.commands.get("sage")!.handler("Python", h.ctx);
  expect(h.saved).toHaveLength(1); expect(h.saved[0]!.learning_preferences).toMatchObject({ profile: "thorough", features: { mcq: false, teach_back: true }, feedback: "focused", review_before_advance: false });
});

test("native intake: changing sessions during /sage preview cannot apply its choices to another lesson", async () => {
  const h = await harness({ previewStale: true }); await h.commands.get("sage")!.handler("Python", h.ctx);
  expect(h.saved).toEqual([]); expect(h.sent).toEqual([]); expect(h.notices.length).toBeGreaterThan(0);
});
