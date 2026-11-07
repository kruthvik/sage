import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Artifact, Goal } from "../../core/src/contracts.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { createTutorExtension } from "../src/tutor.ts";
import { projectLearningState } from "../../runtime/src/learning-state.ts";
import { artifactExportProjection, publishArtifactContent } from "../../runtime/src/artifacts.ts";
import { backup, restore } from "../../runtime/src/backup.ts";

const roots: string[] = [], services: LearningService[] = [], servers: ReturnType<typeof startLearningServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(); for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const NOTE = "PRIVATE_JOURNAL_SENTINEL: my unassessed reflection, not an answer or source permission.";
async function fixture(sharing = true) {
  const root = await mkdtemp(join(tmpdir(), "sage-journal-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home"), cwd: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths); services.push(service); service.activateSession("journal");
  const defined = service.store.define({ operation_id: "goal", kind: "goal", body: { mode: "learn", objective: "Understand lines", subject: "math", horizon_days: 30, target_format: "explanation", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: sharing, source_ids: [] } }, "learner", "journal");
  const goal = service.store.revision<Goal>(defined.revision_id, "goal");
  const server = startLearningServer(service); servers.push(server);
  const bridge = createTutorBridge(paths, service, server), commands = new Map<string, RegisteredCommand>();
  const forwarded: string[] = [], notices: string[] = [], previews: string[] = [], editors: string[] = [];
  let note: string | undefined = NOTE, confirmed = true, owner = "journal", failSavedNotice = false, afterEdit: (() => void) | undefined;
  const ctx = { hasUI: true, mode: "rpc", isIdle: () => true, sessionManager: { getSessionId: () => owner }, ui: {
    notify: (text: string) => { notices.push(text); if (failSavedNotice && text.startsWith("Private journal saved:")) { failSavedNotice = false; throw new Error("Synthetic native notice failure"); } },
    editor: async (_title: string, initial: string) => { editors.push(initial); if (editors.length > 1) return undefined; afterEdit?.(); return note; },
    confirm: async (_title: string, text: string) => { previews.push(text); return confirmed; },
  } } as unknown as ExtensionCommandContext;
  const api = { registerTool() {}, registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); }, on() {}, sendUserMessage(text: string) { forwarded.push(text); } } as unknown as ExtensionAPI;
  createTutorExtension(bridge)(api);
  const run = async () => { expect(commands.has("journal")).toBe(true); await commands.get("journal")!.handler("", ctx); };
  return { root, paths, service, goal, bridge, ctx, forwarded, notices, previews, editors, run,
    cancelEditor() { note = undefined; }, decline() { confirmed = false; }, setNote(text: string) { note = text; },
    failNotice() { failSavedNotice = true; },
    onEdit(callback: () => void) { afterEdit = callback; }, changeOwner() { owner = "other"; service.activateSession(owner); },
    entries: () => service.store.revisions("artifact").filter(r => r.body.capability === "study_journal"),
  };
}

test("native journal requires edit/preview/confirmation and stays private without becoming learner performance", async () => {
  const f = await fixture(); const task = installFixtures(f.service.store, f.goal)[0]!;
  f.service.store.define({ operation_id: "task", kind: "task_instance", expected_goal_revision_id: f.goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: f.goal.revision_id, purpose: "independent", conditions: ["No aids"] } }, "human", "journal");
  const before = projectLearningState(f.service.store, "journal"), events = f.service.store.events().filter(e => e.kind !== "decision");
  await f.run(); expect(f.entries()).toHaveLength(1);
  const entry = f.service.store.revision<Artifact>(f.entries()[0]!.revision_id, "artifact");
  expect(entry.body.content).toContain(NOTE); expect(entry.body.evidence_kind).toBe("artifact_only");
  expect(entry.body.provenance).toContain("unassessed"); expect(entry.body.response_event_id).toBeUndefined();
  expect(f.previews).toHaveLength(1); expect(f.previews[0]).toContain(NOTE); expect(f.previews[0]).toContain("Understand lines");
  expect(f.forwarded).toEqual([]); expect(f.service.store.events().filter(e => e.kind !== "decision")).toEqual(events);
  const after = projectLearningState(f.service.store, "journal"); expect(after.phase).toBe(before.phase); expect(after.pending_count).toBe(before.pending_count);
  const copy = artifactExportProjection(f.service.store, entry.revision_id);
  expect(await readFile(join(f.paths.home, "content", copy.relativePath), "utf8")).toContain(NOTE);
  expect(JSON.stringify(await f.service.context({}, "journal"))).not.toContain(NOTE);
  const creator = f.service.store.events().find(e => e.seq === entry.created_seq)!;
  expect(JSON.stringify(await f.service.context({ evidence_event_ids: [creator.event_id] }, "journal"))).not.toContain(NOTE);
  await expect(f.service.operation("learning_source", { action: "artifact", artifact_revision_id: entry.revision_id }, "journal")).rejects.toThrow(/journal/i);
});

for (const cancel of ["editor", "confirmation"] as const) test(`journal ${cancel} cancellation writes nothing and never forwards to the model`, async () => {
  const f = await fixture(); const before = f.service.store.throughSeq;
  if (cancel === "editor") f.cancelEditor(); else f.decline();
  await f.run(); expect(f.entries()).toEqual([]); expect(f.service.store.throughSeq).toBe(before); expect(f.forwarded).toEqual([]);
});

test("a local journal works with provider sharing off and an edited copy is never overwritten", async () => {
  const f = await fixture(false); await f.run(); expect(f.entries()).toHaveLength(1);
  const id = f.entries()[0]!.revision_id, copy = artifactExportProjection(f.service.store, id), filename = join(f.paths.home, "content", copy.relativePath);
  const edited = (await readFile(filename, "utf8")) + "\nOUTSIDE_EDIT"; await writeFile(filename, edited);
  await expect(publishArtifactContent(f.paths, f.service.store, id)).rejects.toThrow(/conflict|modified|hash/i);
  expect(await readFile(filename, "utf8")).toBe(edited);
  expect(f.service.store.revision<Artifact>(id, "artifact").body.content).toContain(NOTE);
  expect(f.service.store.lessonGoal("journal")?.body.provider_sharing).toBe(false); expect(f.forwarded).toEqual([]);
});

for (const change of ["session", "goal"] as const) test(`journal refuses a changed ${change} and reopens unsaved text locally rather than submitting it`, async () => {
  const f = await fixture();
  f.onEdit(() => {
    if (change === "session") f.changeOwner();
    else f.service.store.define({ operation_id: "changed-goal", kind: "goal", parent_revision_id: f.goal.revision_id, expected_goal_revision_id: f.goal.revision_id, body: { ...f.goal.body, objective: "Different goal" } }, "learner", "journal");
  });
  await f.run(); expect(f.entries()).toEqual([]); expect(f.editors.at(-1)).toBe(NOTE); expect(f.editors).toHaveLength(2); expect(f.forwarded).toEqual([]);
});

test("model tools cannot create the private journal capability; malformed notes never publish", async () => {
  const f = await fixture();
  await expect(f.service.operation("learning_define", { operation_id: "forged-note", kind: "artifact", expected_goal_revision_id: f.goal.revision_id, body: { capability: "study_journal", goal_revision_id: f.goal.revision_id, author: "tutor", provenance: "model", media_type: "text/markdown", content: "not native consent", evidence_kind: "artifact_only", interpretation_uncertainty: "not assessed", assistance_event_ids: [] } }, "journal")).rejects.toThrow(/journal/i);
  f.setNote("x".repeat(12001)); await f.run(); expect(f.entries()).toEqual([]); expect(f.forwarded).toEqual([]);
});

test("a failed native notification after commit reports a saved original instead of falsely claiming cancellation", async () => {
  const f = await fixture(); f.failNotice(); await f.run();
  expect(f.entries()).toHaveLength(1); expect(f.editors).toHaveLength(1);
  expect(f.notices.at(-1)).toContain("original saved"); expect(f.notices.at(-1)).not.toContain("save canceled");
});

test("blocked Markdown publication preserves the journal original and never overwrites the blocking user file", async () => {
  const f = await fixture(); const blocker = join(f.paths.home, "content"); await writeFile(blocker, "OUTSIDE_FILE", { flag: "wx" });
  await f.run(); expect(f.entries()).toHaveLength(1);
  expect(f.service.store.revision<Artifact>(f.entries()[0]!.revision_id, "artifact").body.content).toContain(NOTE);
  expect(await readFile(blocker, "utf8")).toBe("OUTSIDE_FILE"); expect(f.notices.at(-1)).toContain("original saved"); expect(f.editors).toHaveLength(1);
});

test("native journal drafts require literal confirmation, save once and refuse changed-content replay", async () => {
  const f = await fixture(); const draft = await f.bridge.prepareJournal!("journal");
  expect(() => draft.save(NOTE, false)).toThrow(/confirmation/i); expect(f.entries()).toHaveLength(0);
  const first = await draft.save(NOTE, true), again = await draft.save(NOTE, true);
  expect(again.artifact_revision_id).toBe(first.artifact_revision_id); expect(f.entries()).toHaveLength(1);
  expect(() => draft.save("different note", true)).toThrow(/different content/i); expect(f.entries()).toHaveLength(1);
});

test("journal originals use normal educational backup and inert explicit export without another record store", async () => {
  const f = await fixture(); await f.run(); const id = f.entries()[0]!.revision_id;
  const copy = artifactExportProjection(f.service.store, id); expect(copy.text).toContain(NOTE); expect(copy.text).toContain("not learner performance");
  const filename = join(f.root, "backup.json"); await backup(f.service.store, f.paths, filename);
  const restoredPaths = createSagePaths({ home: join(f.root, "restored") }); await restore(restoredPaths, filename);
  const restored = new LearningService(restoredPaths); services.push(restored);
  expect(restored.store.revision<Artifact>(id, "artifact").body.content).toContain(NOTE);
  await expect(restored.operation("learning_source", { action: "artifact", artifact_revision_id: id }, "journal")).rejects.toThrow(/journal/i);
  expect(restored.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(7);
});
