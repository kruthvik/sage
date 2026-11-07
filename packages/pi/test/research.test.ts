import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand, ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../../core/src/contracts.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { createTutorExtension, type TutorBridge, type TutorExtensionOptions } from "../src/tutor.ts";
import { collectLessonIntake } from "../src/intake.ts";
import { managedResearchTools, reviewResearch } from "../src/research.ts";
const goal: Goal = { mode: "learn", objective: "Understand motion", subject: "science", horizon_days: 7, target_format: "explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] };
const roots: string[] = [], services: LearningService[] = [], servers: ReturnType<typeof startLearningServer>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) s.stop(); for (const s of services.splice(0)) s.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
type Offer = { preview: string; save(confirmed: boolean): Promise<{ source_id: string; duplicate: boolean }> };
type Draft = { topic: string; knows(url: string, content?: string): boolean; offer(source: { url: string; title: string; content: string }): Offer };
type ResearchBridge = TutorBridge & { prepareResearch(body: Goal, sid: string): Promise<Draft> };
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "sage-research-")); roots.push(root);
 const paths = createSagePaths({ home: join(root, "home"), cwd: root }); await bootstrapSageHome(paths);
 const service = new LearningService(paths); services.push(service); service.activateSession("research");
 const defined = service.store.define({ operation_id: "goal", kind: "goal", body: goal }, "learner", "research");
 const server = startLearningServer(service); servers.push(server);
 return { root, service, defined, bridge: createTutorBridge(paths, service, server) as ResearchBridge };
}
function nativeContext(sources = false) {
 const inputs = ["Understand motion", "PRIVATE_BACKGROUND", "Explain motion", "30", "PRIVATE_CONSTRAINT", "Supporting references"];
 return { hasUI: true, isIdle: () => true, model: { provider: "fixture", id: "fixture" }, sessionManager: { getSessionId: () => "research" }, ui: { input: async () => inputs.shift(), select: async () => sources ? "Use selected sources" : "Continue without sources", confirm: async () => true, notify() {}, setWidget() {} } } as unknown as ExtensionCommandContext;
}
test("research startup runs the native research stage before saving the lesson", async () => {
 const commands = new Map<string, RegisteredCommand>(), saved: Goal[] = [], researched: Goal[] = [];
 const bridge = { operation: async () => ({}), source: async () => [], goal: async (g: Goal) => { saved.push(g); return { revision_id: "new-goal" }; } } as unknown as TutorBridge;
 const options = { startup: { mode: "learn" }, research: async (g: Goal, _ctx: ExtensionContext, check: () => void) => { check(); researched.push(g); return { ...g, source_ids: ["accepted-new-source"] }; } } as unknown as TutorExtensionOptions;
 const api = { registerTool() {}, registerCommand(n: string, c: RegisteredCommand) { commands.set(n, c); }, on() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
 createTutorExtension(bridge, options)(api); await commands.get("learn")!.handler("Understand motion", nativeContext());
 expect(researched).toHaveLength(1); expect(saved).toHaveLength(1); expect(saved[0]!.source_ids).toEqual(["accepted-new-source"]);
});
test("research intake retains already selected accepted sources without toggling them again", async () => {
 const result = await collectLessonIntake(nativeContext(true), { ...goal, source_ids: ["owned"] }, async () => [{ source_id: "owned", title: "Learner supplied", status: "indexed" }], () => {});
 expect(result?.source_ids).toEqual(["owned"]);
});
test("research draft accepts a fully previewed source once without creating learner work", async () => {
 const f = await fixture(); expect(typeof f.bridge.prepareResearch).toBe("function");
 const draft = await f.bridge.prepareResearch(goal, "research"); expect(draft.topic).toBe(goal.objective);
 const input = { url: "https://example.org/motion?utm_source=fixture#section", title: "Motion reference", content: "A synthetic excerpt for the source preview." };
 expect(draft.knows(input.url)).toBe(false);
 const offer = draft.offer(input); expect(offer.preview).toContain(input.content); expect(offer.preview).toContain("https://example.org/motion");
 await expect(offer.save(false)).rejects.toThrow(/confirmation/i); expect(f.service.sources.list()).toHaveLength(0);
 const receipt = await offer.save(true); expect(f.service.store.sourceStatus(receipt.source_id)).toBe("indexed"); expect(await offer.save(true)).toEqual(receipt);
 expect(f.service.sources.list()).toHaveLength(1); expect(draft.knows("https://example.org/motion")).toBe(true);
 expect(f.service.store.lessonGoal("research")!.body.source_ids).toEqual([]);
 expect(f.service.store.events().filter(e => ["learner_response", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
});
test("research duplicate filtering covers user-added URL identities and identical local text", async () => {
 const f = await fixture(), filename = join(f.root, "manual.md"); await writeFile(filename, "Already supplied text");
 const existing = await f.service.sources.importFile(filename, "web:https://example.org/already"); f.service.sources.preview(existing.revision_id); f.service.sources.accept(existing.revision_id);
 expect(typeof f.bridge.prepareResearch).toBe("function"); const draft = await f.bridge.prepareResearch(goal, "research");
 expect(draft.knows("https://example.org/already?utm_medium=search#top")).toBe(true);
 expect(draft.knows("https://example.org/other", "Already supplied text")).toBe(true);
});
test("research draft refuses a stale goal and malformed or unconfirmed input", async () => {
 const f = await fixture(); expect(typeof f.bridge.prepareResearch).toBe("function"); const draft = await f.bridge.prepareResearch(goal, "research");
 expect(() => draft.offer({ url: "file:///private.md", title: "Private", content: "No" })).toThrow();
 expect(() => draft.offer({ url: "https://user:password@example.org/", title: "Credentials", content: "No" })).toThrow();
 const offer = draft.offer({ url: "https://example.org/new", title: "New", content: "Provisional source" });
 f.service.store.define({ operation_id: "changed", kind: "goal", parent_revision_id: f.defined.revision_id, expected_goal_revision_id: f.defined.revision_id, body: { ...goal, objective: "Changed" } }, "learner", "research");
 await expect(offer.save(true)).rejects.toThrow(/goal|changed|stale/i); expect(f.service.sources.list()).toHaveLength(0);
});
async function webHarness(options: { declineSearch?: boolean; declineSource?: boolean; fail?: boolean; stale?: boolean; oversize?: boolean } = {}) {
 const f = await fixture(), filename = join(f.root, "supplied.md"); await writeFile(filename, "PRIVATE_SUPPLIED_TEXT");
 const existing = await f.service.sources.importFile(filename, "web:https://example.org/already"); f.service.sources.preview(existing.revision_id); f.service.sources.accept(existing.revision_id);
 f.service.store.define({ operation_id: "selected", kind: "goal", parent_revision_id: f.defined.revision_id, expected_goal_revision_id: f.defined.revision_id, body: { ...goal, source_ids: [existing.revision_id], learner_notes: "PRIVATE_JOURNAL_OR_NOTE", prior_experience: "PRIVATE_BACKGROUND" } }, "learner", "research");
 const queries: unknown[] = [], fetched: string[] = [], menus: string[][] = [], previews: string[] = [], notices: string[] = [], sent: string[] = [], commands = new Map<string, RegisteredCommand>(), events = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
 const search = { execute: async (_id: string, params: unknown) => { queries.push(params); return options.fail ? { content: [], details: {}, isError: true } : { content: [], details: {}, structuredContent: { queries: [{ results: [{ title: "Already supplied URL", url: "https://example.org/already?utm_source=search" }, { title: "Duplicate text", url: "https://example.org/copy" }, { title: "New public source", url: "https://example.org/new" }] }] } }; } };
 const fetch = { execute: async (_id: string, params: { url: string }) => { fetched.push(params.url); if (options.stale) f.service.activateSession("elsewhere"); return { content: [], details: {}, structuredContent: { urls: [{ url: params.url, title: "Fetched title", content: params.url.endsWith("copy") ? "PRIVATE_SUPPLIED_TEXT" : options.oversize ? "x".repeat(18001) : "NEW_PUBLIC_EXCERPT", error: null }] } }; } };
 const ctx = { ...nativeContext(), ui: { input: async () => "", select: async (_title: string, choices: string[]) => { menus.push(choices); return choices[0]; }, confirm: async (title: string, body: string) => { previews.push(body); return title.includes("Accept") ? !options.declineSource : !options.declineSearch; }, notify: (text: string) => notices.push(text), setWidget() {} } } as unknown as ExtensionCommandContext;
 const api = { registerTool() {}, registerCommand(n: string, c: RegisteredCommand) { commands.set(n, c); }, on(n: string, fn: (event: any, ctx: ExtensionContext) => any) { events.set(n, [...events.get(n) ?? [], fn]); }, sendUserMessage(text: string) { sent.push(text); } } as unknown as ExtensionAPI;
 createTutorExtension(f.bridge, { researchTools: () => ({ search, fetch, names: ["web_search", "fetch_content"] }) } as unknown as TutorExtensionOptions)(api);
 return { ...f, existing, queries, fetched, menus, previews, notices, sent, events, ctx, async run() { await commands.get("learn")!.handler(goal.objective, ctx); } };
}
test("automatic extension research lists only new sources, then accepts and selects their full preview", async () => {
 const f = await webHarness(); await f.run(); expect(f.queries).toHaveLength(1);
 expect(JSON.stringify(f.queries)).toContain(goal.objective); expect(JSON.stringify(f.queries)).not.toMatch(/PRIVATE_|prior_experience|source_ids|learner_notes/);
 expect(f.fetched).toEqual(["https://example.org/copy", "https://example.org/new"]);
 expect(f.menus.flat().join("\n")).toContain("New public source"); expect(f.menus.flat().join("\n")).not.toMatch(/Already supplied|Duplicate text/);
 expect(f.previews.some(text => text.includes("NEW_PUBLIC_EXCERPT") && text.includes("https://example.org/new"))).toBe(true);
 const current = f.service.store.lessonGoal("research")!; expect(current.body.source_ids).toHaveLength(2); expect(current.body.source_ids).toContain(f.existing.revision_id);
 expect(f.service.sources.list()).toHaveLength(2); expect(f.sent.join("\n")).not.toContain("NEW_PUBLIC_EXCERPT");
});
for (const setting of ["declineSearch", "declineSource", "fail", "oversize", "stale"] as const) test(`automatic research ${setting} never admits a new source`, async () => {
 const f = await webHarness({ [setting]: true }); await f.run(); expect(f.service.sources.list()).toHaveLength(1);
 if (setting === "declineSearch") expect(f.queries).toEqual([]);
 else expect(f.queries).toHaveLength(1);
 if (setting === "stale") expect(f.sent).toEqual([]);
 if (setting === "fail") expect(f.notices.join(" ")).toMatch(/research.*unavailable|search.*failed/i);
});
test("model-direct extension search cannot bypass the native source review", async () => {
 const f = await webHarness(); const handlers = f.events.get("tool_call") ?? [];
 const replies = await Promise.all(handlers.map(handler => handler({ toolName: "web_search", input: { query: "private text" } }, f.ctx)));
 expect(replies.some(reply => reply?.block === true)).toBe(true); expect(f.queries).toEqual([]);
});
test("first-message startup also invokes extension research before goal creation", async () => {
 const events = new Map<string, (event: any, ctx: ExtensionContext) => any>(), saved: Goal[] = []; let searches = 0;
 const bridge = { operation: async () => ({}), inputAdmission: () => ({ assertCurrent() {}, assertScopeCurrent() {}, goalCreated() {} }), source: async () => [], goal: async (g: Goal) => { saved.push(g); return { revision_id: "new-goal" }; }, input: async () => ({}), prepareResearch: async (g: Goal) => ({ topic: g.objective, knows: () => false, offer: () => { throw new Error("No search results"); } }) } as unknown as TutorBridge;
 const search = { execute: async () => { searches++; return { content: [], details: {}, structuredContent: { queries: [{ results: [] }] } }; } }, fetch = { execute: async () => { throw new Error("No page fetch expected"); } };
 const api = { registerTool() {}, registerCommand() {}, on(name: string, handler: (event: any, ctx: ExtensionContext) => any) { events.set(name, handler); }, sendUserMessage() {} } as unknown as ExtensionAPI;
 createTutorExtension(bridge, { startup: { mode: "learn" }, researchTools: () => ({ search, fetch, names: ["web_search", "fetch_content"] }) })(api);
 await events.get("input")!({ source: "interactive", text: "Understand motion" }, nativeContext());
 expect(searches).toBe(1); expect(saved).toHaveLength(1); expect(saved[0]!.objective).toBe("Understand motion");
});
test("research refuses a concurrent same-URL replacement instead of selecting text that was not previewed", async () => {
 const f = await fixture(), draft = await f.bridge.prepareResearch(goal, "research");
 const offer = draft.offer({ url: "https://example.org/race", title: "New version", content: "This is the previewed text" });
 const filename = join(f.root, "different.md"); await writeFile(filename, "A different version never previewed here");
 const concurrent = await f.service.sources.importFile(filename, "web:https://example.org/race"); f.service.sources.preview(concurrent.revision_id); f.service.sources.accept(concurrent.revision_id);
 await expect(offer.save(true)).rejects.toThrow(/changed|already added|different/i); expect(f.service.sources.list()).toHaveLength(1);
});
test("unavailable research preparation leaves ordinary lesson setup usable", async () => {
 const f = await webHarness(); f.bridge.prepareResearch = async () => { throw new Error("Research setup unavailable"); }; await f.run();
 expect(f.queries).toEqual([]); expect(f.sent).toHaveLength(1); expect(f.service.store.lessonGoal("research")!.body.source_ids).toEqual([f.existing.revision_id]);
});
test("research searches the exact topic shown for consent even if its draft is later mutated", async () => {
 const f = await webHarness(), prepare = f.bridge.prepareResearch.bind(f.bridge); let draft: Draft | undefined;
 f.bridge.prepareResearch = async (...args) => { draft = await prepare(...args); return draft; };
 const confirm = f.ctx.ui.confirm.bind(f.ctx.ui);
 f.ctx.ui.confirm = async (title, text) => { const result = await confirm(title, text); if (title.startsWith("Research") && draft) draft.topic = "PRIVATE_CHANGED_AFTER_PREVIEW"; return result; };
 await f.run(); expect(f.queries).toHaveLength(1); expect(JSON.stringify(f.queries)).toContain(goal.objective); expect(JSON.stringify(f.queries)).not.toContain("PRIVATE_CHANGED_AFTER_PREVIEW");
});
test("a partially enabled managed extension does not reopen model-direct web search", async () => {
 const f = await fixture(), handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
 const loader = { getExtensions: () => ({ extensions: [{ path: join(f.service.paths.agent, "npm", "node_modules", "pi-web-access", "dist", "index.js"), tools: new Map([["web_search", { definition: { name: "web_search", execute: async () => { throw new Error("No direct request allowed"); } } }]]) }] }) } as unknown as ResourceLoader;
 const selected = managedResearchTools(f.service.paths, loader); expect(selected?.names).toContain("web_search");
 const api = { registerTool() {}, registerCommand() {}, on(n: string, fn: (event: any, ctx: ExtensionContext) => any) { handlers.set(n, fn); }, sendUserMessage() {} } as unknown as ExtensionAPI;
 createTutorExtension(f.bridge, { researchTools: () => selected })(api);
 expect(await handlers.get("tool_call")!({ toolName: "web_search" }, nativeContext())).toMatchObject({ block: true });
});
function reviewTools() {
 return { names: ["web_search", "fetch_content"], search: { execute: async () => ({ content: [], details: {}, structuredContent: { queries: [{ results: [{ title: "Public fixture", url: "https://example.org/review" }] }] } }) }, fetch: { execute: async () => ({ content: [], details: {}, structuredContent: { urls: [{ url: "https://example.org/review", content: "Public fixture text", error: null }] } }) } };
}
test("research stops network scope polling while the native source menu waits for the learner", async () => {
 const f = await fixture(), admission = f.service.inputAdmission("research"), entered = Promise.withResolvers<void>(), selected = Promise.withResolvers<string | undefined>(); let checks = 0;
 const original = nativeContext(), ctx = { ...original, ui: { ...original.ui, select: async () => { entered.resolve(); return selected.promise; } } } as ExtensionContext;
 const work = reviewResearch(goal, ctx, reviewTools(), () => f.bridge.prepareResearch(goal, "research"), () => { checks++; admission.assertCurrent(); });
 try { await entered.promise; const before = checks; await new Promise(resolve => setTimeout(resolve, 260)); expect(checks).toBe(before); }
 finally { selected.resolve(undefined); await work; }
 expect(f.service.sources.list()).toHaveLength(0);
});
test("research still rejects a session change after native source confirmation without background polling", async () => {
 const f = await fixture(), admission = f.service.inputAdmission("research"), original = nativeContext();
 const ctx = { ...original, ui: { ...original.ui, select: async (_title: string, choices: string[]) => choices[0], confirm: async (title: string) => { if (title.startsWith("Accept")) f.service.activateSession("other"); return true; } } } as ExtensionContext;
 await expect(reviewResearch(goal, ctx, reviewTools(), () => f.bridge.prepareResearch(goal, "research"), () => admission.assertCurrent())).rejects.toThrow(/inactive|changed|stale/i);
 expect(f.service.sources.list()).toHaveLength(0);
});
