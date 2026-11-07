import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../../core/src/contracts.ts";
import { LearningStore } from "../../storage/src/store.ts";
import { SourceService } from "../../sources/src/service.ts";
import { sourceControl } from "../../runtime/src/tutor-host.ts";
import type { LearningService } from "../../runtime/src/service.ts";
import { collectLessonIntake } from "../src/intake.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const initial: Goal = { mode: "learn", objective: "Understand functions", subject: "computing", horizon_days: 7, target_format: "Explain and write a function", criteria: [], allowed_aids: [], constraints: [], probe: "offer", provider_sharing: true, source_ids: [] };

async function fixture(options: { cancelFolder?: boolean; rejectPreview?: boolean; cancelSharing?: boolean; stalePreview?: boolean; rejectOCR?: boolean; files?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sage-folder-")), folder = join(root, "selected"); await mkdir(folder);
  const store = new LearningStore(":memory:"), sources = new SourceService(store, join(root, "blobs"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = { sources, assertActiveSession: (id: string) => { if (id !== "folder-owner") throw new Error("Foreign source session"); } } as unknown as LearningService;
  const calls: string[] = [], notices: string[] = [], confirmations: string[] = [];
  let opened = false, selected = 0, stale = false;
  const control = async (args = "list") => { calls.push(args); const result = await sourceControl(service, args, "folder-owner"); if (options.stalePreview && args.startsWith("preview ")) stale = true; return result; };
  const ctx = { hasUI: true, model: { provider: "offline", id: "synthetic" }, ui: {
    input: async (title: string) => title.toLowerCase().includes("folder") ? options.cancelFolder ? undefined : folder : title.startsWith("What specifically") ? "Understand functions" : "",
    select: async (title: string, choices: string[]) => {
      if (title.startsWith("Sources to share")) {
        if (!opened) { opened = true; expect(choices).toContain("Choose files from a folder"); return "Choose files from a folder"; }
        return "Use selected sources";
      }
      const wanted = (options.files ?? ["notes.md"])[selected++];
      return wanted ? choices.find(choice => choice.includes(wanted)) : "Review selected files";
    },
    confirm: async (title: string, message: string) => { confirmations.push(`${title}\n${message}`); return title.includes("local OCR") ? !options.rejectOCR : title.startsWith("Accept ") ? !options.rejectPreview : title.startsWith("Start this lesson") ? !options.cancelSharing : true; },
    notify: (message: string) => notices.push(message),
  } } as unknown as ExtensionContext;
  const run = () => collectLessonIntake(ctx, initial, control, () => { if (stale) throw new Error("Original scope changed"); });
  return { root, folder, store, sources, service, control, run, calls, notices, confirmations };
}

test("source folder: list immediate supported regular files without importing or accepting contents", async () => {
  const f = await fixture();
  await writeFile(join(f.folder, "notes.md"), new Uint8Array([255, 254]));
  await writeFile(join(f.folder, "other.PDF"), "synthetic not-a-PDF; listing must not parse it");
  await writeFile(join(f.folder, ".private.md"), "hidden"); await writeFile(join(f.folder, "program.exe"), "unsupported");
  await mkdir(join(f.folder, "nested")); await writeFile(join(f.folder, "nested", "hidden.md"), "not recursive");
  await writeFile(join(f.root, "outside.md"), "outside"); await symlink(join(f.root, "outside.md"), join(f.folder, "linked.md"), "file");
  const listing = await f.control(`folder ${f.folder}`) as { directory: string; files: Array<{ name: string; path: string; size: number }> };
  expect(listing.files.map(file => file.name)).toEqual(["notes.md", "other.PDF"]);
  expect(listing.files.every(file => file.size > 0 && file.path.startsWith(listing.directory))).toBe(true);
  expect(f.sources.list()).toEqual([]); expect(f.store.revisions("source")).toEqual([]);
});

test("source folder: invalid directories and excessive entries fail clearly without source writes", async () => {
  const f = await fixture(); await writeFile(join(f.folder, "notes.md"), "text");
  await expect(f.control(`folder ${join(f.folder, "missing")}`)).rejects.toThrow();
  await expect(f.control(`folder ${join(f.folder, "notes.md")}`)).rejects.toThrow();
  for (let i = 0; i < 501; i++) await writeFile(join(f.folder, `ignored-${i}.bin`), "x");
  await expect(f.control(`folder ${f.folder}`)).rejects.toThrow("500"); expect(f.sources.list()).toEqual([]);
});

test("source folder: intake imports only selected files and previews before native acceptance and sharing", async () => {
  const f = await fixture(); await writeFile(join(f.folder, "notes.md"), "A named function takes arguments."); await writeFile(join(f.folder, "unselected.md"), "Never import me");
  const goal = await f.run(); expect(goal?.source_ids).toHaveLength(1);
  expect(f.sources.list()).toHaveLength(1); expect(f.sources.list()[0]!.title).toBe("notes.md");
  expect(f.sources.list()[0]!.status).toBe("indexed"); expect(f.store.revisions("goal")).toEqual([]);
  expect(f.confirmations.find(text => text.startsWith("Accept notes.md"))).toContain("A named function takes arguments.");
  const actions = f.calls.map(call => call.split(" ")[0]); expect(actions.indexOf("preview")).toBeLessThan(actions.indexOf("accept"));
  expect(f.calls.some(call => call.startsWith("add ") && call.includes("unselected.md"))).toBe(false);
});

test("source folder: failed PDF text extraction offers local OCR only after native confirmation", async () => {
  for (const approve of [true, false]) {
    const f = await fixture({ files: ["scan.pdf"], rejectOCR: !approve });
    await writeFile(join(f.folder, "scan.pdf"), "synthetic routing fixture"); const text = join(f.root, "local-ocr.txt"); await writeFile(text, "Synthetic local OCR result");
    const nativeImport = f.sources.importFile.bind(f.sources), modes: string[] = [];
    f.sources.importFile = async (_path, purpose, rights, signal, mode) => { modes.push(mode ?? "default"); if (mode !== "local_ocr") throw new Error("Synthetic PDF text extraction failed"); return nativeImport(text, purpose, rights, signal); };
    const goal = await f.run();
    expect(f.confirmations.some(message => message.includes("Try local OCR"))).toBe(true);
    expect(modes).toEqual(approve ? ["default", "local_ocr"] : ["default"]);
    expect(goal?.source_ids).toHaveLength(approve ? 1 : 0);
    if (approve) expect(f.confirmations.find(message => message.startsWith("Accept scan.pdf"))).toContain("Synthetic local OCR result");
    else expect(f.sources.list()).toEqual([]);
  }
});

test("source folder: canceled folder input does not scan or import", async () => {
  const f = await fixture({ cancelFolder: true }); expect(await f.run()).toBeUndefined();
  expect(f.calls).toEqual(["list"]); expect(f.sources.list()).toEqual([]);
});

test("source folder: rejected extraction remains local and unaccepted, never selected for the lesson", async () => {
  const f = await fixture({ rejectPreview: true }); await writeFile(join(f.folder, "notes.md"), "Synthetic notes");
  expect((await f.run())?.source_ids).toEqual([]); expect(f.sources.list()[0]!.status).toBe("needs_review");
  expect(f.calls.some(call => call.startsWith("accept "))).toBe(false);
});

test("source folder: canceling final sharing saves no goal and does not erase local source receipts", async () => {
  const f = await fixture({ cancelSharing: true }); await writeFile(join(f.folder, "notes.md"), "Synthetic notes");
  expect(await f.run()).toBeUndefined(); expect(f.store.revisions("goal")).toEqual([]);
  expect(f.sources.list()[0]!.status).toBe("indexed"); expect(f.notices.join(" ")).toContain("local");
});

test("source folder: changed native scope during preview cannot accept or share the imported file", async () => {
  const f = await fixture({ stalePreview: true }); await writeFile(join(f.folder, "notes.md"), "Synthetic notes");
  await expect(f.run()).rejects.toThrow("Original scope changed"); expect(f.sources.list()[0]!.status).toBe("needs_review");
  expect(f.calls.some(call => call.startsWith("accept "))).toBe(false); expect(f.store.revisions("goal")).toEqual([]);
});

test("source folder: a failed file does not discard successful local imports or claim it was admitted", async () => {
  const f = await fixture({ files: ["broken.txt", "notes.md"] }); await writeFile(join(f.folder, "broken.txt"), new Uint8Array([255, 254])); await writeFile(join(f.folder, "notes.md"), "Synthetic notes");
  expect((await f.run())?.source_ids).toHaveLength(1); expect(f.sources.list()).toHaveLength(1);
  expect(f.sources.list()[0]!.title).toBe("notes.md"); expect(f.notices.join(" ")).toContain("broken.txt");
});
