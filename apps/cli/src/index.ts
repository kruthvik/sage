#!/usr/bin/env bun
import { createSagePaths, inspectSageResources } from "../../../packages/runtime/src/index.ts";
import { bootstrapSageHome } from "../../../packages/runtime/src/bootstrap.ts";
import { LearningService } from "../../../packages/runtime/src/service.ts";
import { launchTutor, readBrain, sourceControl } from "../../../packages/runtime/src/tutor-host.ts";
import { backup, restore } from "../../../packages/runtime/src/backup.ts";
import { runOfflineDemo } from "../../../packages/activities/src/demo.ts";
import { managePlugin } from "../../../packages/pi/src/plugins.ts";
import { piInfo } from "../../../packages/pi/src/sdk.ts";
import { resetPi, rollbackPi, sharePi, updatePi } from "../../../packages/pi/src/updates.ts";
import { manageResources, manageTheme } from "../../../packages/pi/src/resources.ts";
import { projectComponents } from "../../../packages/storage/src/projection.ts";
import { formatLearningStatus } from "../../../packages/core/src/status.ts";
import { evaluateLearning } from "../../../packages/runtime/src/evaluation.ts";
import { privacyInventory, purgePrivacyData } from "../../../packages/runtime/src/privacy.ts";
import { acquireTutorLock, unlockTutor } from "../../../packages/runtime/src/tutor-lock.ts";
import { configureVault, readVaultConfig, vaultOpenUri, writeVaultArtifact } from "../../../packages/runtime/src/vault.ts";
import type { Artifact, Goal } from "../../../packages/core/src/contracts.ts";
import { exportMarkdownPdf } from "../../../packages/runtime/src/markdown-pdf.ts";
import { artifactExportProjection, contentInventory, publishArtifactContent, rebuildContent } from "../../../packages/runtime/src/artifacts.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCustomization, executeCustomization, formatCustomization } from "./customization.ts";

const paths = createSagePaths({ home: process.env.SAGE_HOME ?? process.env.SATO_HOME });
// Pi's terminal helpers (keybindings, diagnostics and theme watcher) still use
// the native environment root. Override it in this process before loading Pi.
process.env.PI_CODING_AGENT_DIR = paths.agent;
process.env.PI_SKIP_VERSION_CHECK = "1";
let service: LearningService | undefined;

const usage = `Sage · one launcher, Pi's native learning terminal\n\nsage                    Open the tutor\nsage --version          Show the selected isolated Pi version\nsage --smoke            Check resources without a provider\nsage help --all         Compatibility/maintenance commands\n\nInside the tutor: /sage [learn|exam|cram|accelerate|drill] [goal], /learn, /exam, /cram, /accelerate, /drill, /mode, /refresh, /studio, /mcq, /feynman, /scrap, /skip, /continue, /status, /source, /usage, /sage-settings, /stop.\nLocal usage tracking is on by default: total sessions and open hours only; no uploads. /usage off stops counting, /sage-settings puts the toggle first.\nCustomization: /extensions list | add PATH | enable PATH | disable PATH | remove PATH; /theme list | set NAME; /packages list | install SOURCE | remove SOURCE | update [SOURCE]. Quote paths containing spaces. Executable code requires native trust confirmation. /settings and /reload remain native Pi commands.\nUse /login and /model for your provider. SAGE_HOME still defaults to ~/.learn; existing learner data and global Pi are unchanged.\n`;

const advancedUsage = `${usage}\nAdvanced commands (existing aliases remain supported):\nlearn init\nlearn source add PATH [--allow-large] | ocr PATH [--allow-large] | list | preview ID | accept ID | remove ID\nlearn brain show | edit\nlearn capabilities\nlearn artifact add TYPE FILE [INSTANCE_ID] | show ID | export ID [FILE] | rebuild [--confirm PLAN_HASH] | pdf ID FILE [--font LOCAL.ttf]\nlearn vault configure DIRECTORY | info | export ID RELATIVE.md | uri RELATIVE.md\nlearn evaluate\nlearn pi info | update [VERSION] | share INSTALLED_ROOT --trust | rollback | reset\nlearn plugin list | add SOURCE --trust | remove SOURCE | update [SOURCE] --trust\nlearn resource list | add|remove|enable|disable KIND PATH [--trust]\nlearn extensions add PATH --trust | remove PATH\nlearn export FILE | backup FILE | restore FILE\nlearn --smoke [--debug]\n\nCustomization commands accept --json for scripting.\nPDF export renders bounded attributed Markdown/plain text; images are omitted, links inert, HTML/math literal. Optional local fonts require embedding rights. OCR, live audio and backend code execution are deferred. Browser custom code requires explicit learner opt-in.\n`.replaceAll("\nlearn", "\nsage");

export interface LaunchSelection {
  mode?: Goal["mode"];
  goal?: string;
}

export type ParsedCli =
  | { action: "tutor"; selection: LaunchSelection }
  | { action: "help"; all: boolean }
  | { action: "version" }
  | { action: "smoke" }
  | { action: "subcommand"; command: string; rest: string[] };

export function parseLaunchArgs(args: string[]): ParsedCli {
  const flags = new Set(args);
  if (flags.has("--help") || args[0] === "help" || flags.has("-h")) {
    return { action: "help", all: flags.has("--all") };
  }
  if (flags.has("--version") || flags.has("-v")) {
    if (args.length !== 1) throw new Error("Usage: sage --version");
    return { action: "version" };
  }
  if (flags.has("--smoke")) {
    if (args.some(a => !["--smoke", "--debug"].includes(a))) throw new Error(usage);
    return { action: "smoke" };
  }
  const filtered = args.filter(a => a !== "--debug" && a !== "--force");
  if (!filtered.length) {
    return { action: "tutor", selection: {} };
  }
  const modeIndex = filtered.indexOf("--mode");
  if (modeIndex !== -1) {
    const modeVal = filtered[modeIndex + 1];
    if (!modeVal || !["learn", "exam", "cram", "drill", "accelerate"].includes(modeVal)) {
      throw new Error("Usage: sage --mode [learn|exam|cram|drill|accelerate] [goal]");
    }
    const remaining = filtered.filter((_, i) => i !== modeIndex && i !== modeIndex + 1);
    return { action: "tutor", selection: { mode: modeVal as Goal["mode"], goal: remaining.join(" ").trim() || undefined } };
  }
  const [first, ...rest] = filtered;
  const launchModes = ["learn", "exam", "cram", "drill", "accelerate"] as const;
  const launchMode = launchModes.find(m => m === first);
  if (launchMode) {
    return { action: "tutor", selection: { mode: launchMode, goal: rest.join(" ").trim() || undefined } };
  }
  return { action: "subcommand", command: first!, rest };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  if (flags.has("--unlock")) {
    if (args.length !== 1) throw new Error("Usage: sage --unlock (stale metadata only; never terminates a process)");
    unlockTutor(paths.home);
    console.log(`Cleared stale tutor metadata at ${paths.home}. No process was terminated.`);
    return;
  }
  if (flags.has("--debug")) {
    console.log(`Application root: ${paths.applicationRoot}\nSage home: ${paths.home}\nInvocation directory: ${paths.cwd}\nPi agent root: ${paths.agent}\nSession root: ${paths.sessions}`);
  }
  const parsed = parseLaunchArgs(args);
  if (parsed.action === "help") { console.log(parsed.all ? advancedUsage : usage); return; }
  if (parsed.action === "version") {
    const info = await piInfo(paths); console.log(`Sage · Pi ${info.version} (${info.source})`); return;
  }
  if (parsed.action === "smoke") {
    const resources = await inspectSageResources(paths);
    if (resources.errors.length || resources.diagnostics.some(d => d.type === "error")) throw new Error(`Resource smoke check failed: ${JSON.stringify({ errors: resources.errors, diagnostics: resources.diagnostics })}`);
    console.log(`Sage resource smoke test passed (skills: ${resources.skills}, prompts: ${resources.prompts}, themes: ${resources.themes}).`);
    return;
  }
  if (parsed.action === "subcommand") {
    const { command, rest } = parsed;
    const customization = parseCustomization(command, rest);
    if (customization) {
      if (customization.kind === "engine") console.error("Updating Pi in Sage's home. Global Pi and learning records are unchanged.");
      console.log(formatCustomization(customization, await executeCustomization(paths, customization)));
      return;
    }
    if (command === "demo") {
      if (rest.length && (rest[0] !== "--answers" || !rest[1] || rest.length !== 2)) throw new Error("Usage: sage demo [--answers 5,7,9]");
      await runOfflineDemo(rest[0] === "--answers" ? rest[1]!.split(",") : undefined);
      return;
    }
    if (command === "restore") {
      if (rest.length !== 1) throw new Error("Usage: sage restore FILE (in a fresh SAGE_HOME)");
      await restore(paths, resolve(rest[0]!));
      console.log("Restored verified database and originals. Provider credentials and Pi transcripts are not part of educational backups.");
      return;
    }
    if (command === "pi") {
      const action = rest[0] ?? "info";
      if (action === "share") {
        if (!rest[1] || rest.length > 3 || (rest[2] !== undefined && rest[2] !== "--trust")) throw new Error("Usage: sage pi share INSTALLED_ROOT --trust");
        console.log(JSON.stringify(await sharePi(paths, resolve(rest[1]), rest[2] === "--trust"), null, 2));
        return;
      }
      if (!(["info", "update", "rollback", "reset"].includes(action)) || rest.length > (action === "update" ? 2 : 1)) throw new Error("Usage: sage pi info | update [latest|1.x.y] | rollback | reset");
      if (action === "update") console.error("Installing Pi in Sage's home and checking native tutor startup. Global Pi and learning records are unchanged.");
      console.log(JSON.stringify(action === "info" ? await piInfo(paths) : action === "update" ? await updatePi(paths, rest[1]) : action === "rollback" ? await rollbackPi(paths) : await resetPi(paths), null, 2));
      return;
    }
    if (command === "privacy") {
      const action = rest[0] ?? "inventory";
      const valid = (action === "inventory" && rest.length <= 1) || (action === "purge" && rest.slice(1).every(flag => ["--dry-run", "--confirm"].includes(flag)) && new Set(rest.slice(1)).size === rest.length - 1);
      if (!valid) throw new Error("Usage: sage privacy inventory | purge [--dry-run | --confirm]. Scoped flags are not implemented; no deletion was started.");
    }
    await bootstrapSageHome(paths);
    if (command === "plugin") {
      const positional = rest.filter(arg => arg !== "--trust");
      const action = positional[0] ?? "list";
      if (positional.length > 2 || (action === "list" && positional.length > 1)) throw new Error("Usage: sage plugin list | add SOURCE --trust | remove SOURCE | update [SOURCE] --trust");
      console.log(JSON.stringify(await managePlugin(paths, action, positional[1], rest.includes("--trust")), null, 2));
      return;
    }
    if (command === "resource") {
      const positional = rest.filter(arg => arg !== "--trust");
      if (positional.length > 3 || (positional[0] === "list" && positional.length > 1)) throw new Error("Usage: sage resource list | add|remove|enable|disable KIND PATH [--trust]");
      console.log(JSON.stringify(await manageResources(paths, positional[0] ?? "list", positional[1], positional[2], rest.includes("--trust")), null, 2));
      return;
    }
    if (command === "theme") {
      if (rest.length > 2 || (rest[0] === "list" && rest.length > 1)) throw new Error("Usage: sage theme list | set NAME");
      console.log(JSON.stringify(await manageTheme(paths, rest[0], rest[1]), null, 2));
      return;
    }
    if (command === "vault") {
      const action = rest[0] ?? "info";
      const valid = (action === "info" && rest.length <= 1) || (action === "configure" && rest.length === 2) || (action === "uri" && rest.length === 2) || (action === "export" && rest.length === 3);
      if (!valid) throw new Error("Usage: sage vault configure DIRECTORY | info | export ARTIFACT_ID RELATIVE.md | uri RELATIVE.md");
      if (action === "configure") { console.log(JSON.stringify(await configureVault(paths, rest[1]!), null, 2)); return; }
      const config = await readVaultConfig(paths);
      if (action === "info") { console.log(JSON.stringify(config ?? null, null, 2)); return; }
      if (!config) throw new Error("Choose a vault explicitly with 'sage vault configure DIRECTORY' first; no global vault is inferred.");
      if (action === "uri") { console.log(await vaultOpenUri(config.vaultRoot, rest[1]!)); return; }
      service = new LearningService(paths);
      const copy = artifactExportProjection(service.store, rest[1]!);
      if (!["text/markdown", "text/plain"].includes(copy.artifact.body.media_type)) throw new Error("Vault notes require Markdown/plain-text artifacts; export other original formats separately.");
      const origin = copy.artifact.body.author === "learner" ? "learner" : "tutor";
      console.log(JSON.stringify(await writeVaultArtifact({ vaultRoot: config.vaultRoot, relativePath: rest[2]!, content: copy.text, origin, artifactRevisionId: copy.artifact.revision_id, sourceSpanIds: copy.sourceSpanIds }), null, 2)); return;
    }
    service = new LearningService(paths);
    if (command === "init") { console.log(`Sage initialized at ${paths.home}. Run sage, then /login, /model, and /learn or /exam. Use sage demo for an offline lesson.`); return; }
    if (command === "doctor") {
      const resources = await inspectSageResources(paths);
      const integrity = service.store.integrity();
      const foreignKeyErrors = service.store.db.query("PRAGMA foreign_key_check").all();
      const missingBlobs: string[] = [];
      for (const blob of service.store.db.query<{ hash: string }, []>("SELECT hash FROM blob_manifest").all()) {
        const bytes = await readFile(join(paths.data, "blobs", blob.hash)).catch(() => undefined);
        if (!bytes || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== blob.hash) missingBlobs.push(blob.hash);
      }
      const authExists = await Bun.file(join(paths.agent, "auth.json")).exists();
      console.log(JSON.stringify({ bun: Bun.version, pi: await piInfo(paths), resources, sqlite: integrity, foreign_key_errors: foreignKeyErrors, missing_originals: missingBlobs, provider_auth_file: authExists ? "present (secrets not inspected)" : "not configured; use /login or provider environment variables", provider_logging: "Observed provider hooks; unobservable retry/compaction/stream correlation is reported as unknown", isolation: { agent: paths.agent, sessions: paths.sessions, invocation_context_discovery: "disabled" } }, null, 2));
      if (integrity.join() !== "ok" || missingBlobs.length || foreignKeyErrors.length) throw new Error("Doctor found a storage integrity problem");
      if (resources.errors.length || resources.diagnostics.some(d => d.type === "error")) throw new Error("Doctor found resource configuration errors; inspect the diagnostics above");
      return;
    }
    if (command === "status") { const context = await service.context({}, "cli"); console.log(rest[0] === "--json" ? JSON.stringify(context, null, 2) : formatLearningStatus(context)); return; }
    if (command === "evaluate") { if (rest.length && rest.join() !== "--json") throw new Error("Usage: sage evaluate [--json]"); console.log(JSON.stringify(evaluateLearning(service.store), null, 2)); return; }
    if (command === "capabilities") { if (rest.length) throw new Error("Usage: sage capabilities"); console.log(JSON.stringify(service.capabilities.list(), null, 2)); return; }
    if (command === "artifact") {
      if (rest[0] === "rebuild") {
        if (rest.length === 1) { console.log(JSON.stringify(contentInventory(paths, service.store), null, 2)); return; }
        if (rest.length !== 3 || rest[1] !== "--confirm") throw new Error("Usage: sage artifact rebuild [--confirm PLAN_HASH]; preview the copy-only plan first");
        console.log(JSON.stringify(await rebuildContent(paths, service.store, rest[2]!), null, 2)); return;
      }
      if (rest[0] === "pdf") {
        if (rest.length !== 3 && !(rest.length === 5 && rest[3] === "--font" && rest[4])) throw new Error("Usage: sage artifact pdf ARTIFACT_ID FILE.pdf [--font LOCAL.ttf]");
        const copy = artifactExportProjection(service.store, rest[1]!), artifact = copy.artifact;
        if (!["text/markdown", "text/plain"].includes(artifact.body.media_type)) throw new Error("PDF export requires a Markdown/plain-text artifact; other originals remain unchanged.");
        const origin = artifact.body.author === "learner" ? "learner" : "tutor";
        console.log(JSON.stringify(await exportMarkdownPdf({ content: copy.text, mediaType: "text/markdown", outputPath: rest[2]!, artifactRevisionId: artifact.revision_id, origin, provenance: artifact.body.provenance, fontPath: rest[4] }), null, 2)); return;
      }
      if (rest[0] === "add" && (rest.length === 3 || rest.length === 4)) { console.log(JSON.stringify(await service.importArtifact(rest[1]!, resolve(rest[2]!), rest[3]), null, 2)); return; }
      if (rest[0] === "show" && rest.length === 2) { console.log(JSON.stringify(service.store.revision(rest[1]!, "artifact"), null, 2)); return; }
      if (rest[0] === "export" && rest.length === 2) {
        console.log(JSON.stringify(await publishArtifactContent(paths, service.store, rest[1]!), null, 2)); return;
      }
      if (rest[0] === "export" && rest.length === 3) {
        const artifact = service.store.revision<Artifact>(rest[1]!, "artifact");
        await writeFile(resolve(rest[2]!), artifact.body.content, { flag: "wx", mode: 0o600 }); console.log("Artifact exported without overwriting existing files."); return; }
      throw new Error("Usage: sage artifact add drawing|code|voice_transcript|graph_state FILE [INSTANCE_ID] | show ID | export ID [FILE] | rebuild [--confirm PLAN_HASH] | pdf ID FILE.pdf [--font LOCAL.ttf]");
    }
    if (command === "source") {
      const allowLarge = rest.includes("--allow-large"), sourceArgs = rest.filter(arg => arg !== "--allow-large");
      if (allowLarge && !["add", "ocr"].includes(sourceArgs[0] ?? "")) throw new Error("--allow-large applies only to one source add/ocr invocation (maximum 200 MiB)");
      console.log(JSON.stringify(await sourceControl(service, sourceArgs.join(" "), "cli", allowLarge ? async () => true : undefined), null, 2)); return;
    }
    if (command === "brain") {
      if (rest[0] === "show") { console.log(await readBrain(paths)); return; }
      if (rest[0] === "edit") { const editor = process.env.EDITOR || (process.platform === "win32" ? "notepad.exe" : "vi"); const child = Bun.spawn([editor, paths.brain], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); if (await child.exited !== 0) throw new Error("Editor failed"); return; }
      throw new Error("Usage: sage brain show|edit");
    }
    if (command === "privacy") {
      const action = rest[0] ?? "inventory";
      if (action === "inventory") {
        const inventory = await privacyInventory(paths, service.store);
        console.log(JSON.stringify(inventory, null, 2));
        return;
      }
      if (action === "purge") {
        const isDryRun = rest.includes("--dry-run");
        const isConfirmed = rest.includes("--confirm");
        service.close();
        const result = await purgePrivacyData(paths, undefined, {
          scope: "all_learning_data",
          dryRun: isDryRun || !isConfirmed,
          confirm: isConfirmed,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      throw new Error("Usage: sage privacy [inventory | purge --dry-run | purge --confirm]");
    }
    if (command === "backup" || command === "export") {
      if (rest.length !== 1) throw new Error(`Usage: sage ${command} FILE`);
      if (command === "backup") await backup(service.store, paths, rest[0]!);
      else {
        const content = { format: "sage-private-export-v1", goal: service.store.currentGoal(), revisions: service.store.revisions(), events: service.store.events(), observations: projectComponents(service.store, service.store.throughSeq, service.store.now()), model_calls: service.store.db.query("SELECT * FROM model_call_log ORDER BY seq").all(), warning: "Private local export includes responses and keys. Unknown source rights do not authorize public sharing." };
        await writeFile(resolve(rest[0]!), JSON.stringify(content, null, 2), { flag: "wx", mode: 0o600 });
      }
      console.log(`${command === "backup" ? "Backup" : "Private export"} written to ${resolve(rest[0]!)}. No provider credentials included.`);
      return;
    }
    throw new Error(usage);
  }

  // Tutor launch (parsed.action === "tutor")
  await bootstrapSageHome(paths);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive tutor requires a terminal. Use sage demo --answers 5,7,9, sage status or sage doctor for noninteractive checks.");
  service = new LearningService(paths);
  const release = acquireTutorLock(paths.home, flags.has("--force"));
  process.once("exit", release);
  try { await launchTutor(paths, service, parsed.selection); }
  finally { process.off("exit", release); release(); }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`Sage: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.SAGE_DEBUG === "1" || process.env.SATO_DEBUG === "1") console.error(error);
    process.exitCode = 1;
  } finally {
    service?.close();
  }
}
