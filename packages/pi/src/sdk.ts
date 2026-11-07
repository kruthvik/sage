import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SagePaths } from "../../runtime/src/paths.ts";
import { resolveSharedPi } from "./shared-runtime.ts";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export type PiSdk = typeof import("@earendil-works/pi-coding-agent");
export interface PiSelection { install: string; version: string; previous?: { install: string; version: string } }

export function piRuntimeRoot(paths: SagePaths): string { return join(paths.home, "pi-runtime"); }
export function piSelectionPath(paths: SagePaths): string { return join(piRuntimeRoot(paths), "active.json"); }

// Selections name Sage-owned installs or explicit fingerprinted shared registrations.
export function validateSelection(value: unknown): asserts value is PiSelection {
  const check = (entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid Pi runtime selection");
    const { install, version } = entry as PiSelection;
    if (typeof install !== "string" || !/^install-[a-f0-9-]{36}$/.test(install) || typeof version !== "string" || !/^1\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid Pi runtime selection; run learn pi reset to use bundled Pi");
  };
  check(value);
  const previous = (value as PiSelection).previous;
  if (previous !== undefined) check(previous);
}

export async function readPiSelection(paths: SagePaths): Promise<PiSelection | undefined> {
  let content: string;
  try { content = await readFile(piSelectionPath(paths), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let selection: unknown;
  try { selection = JSON.parse(content); }
  catch { throw new Error("Invalid Pi runtime selection; run sage pi reset to use bundled Pi"); }
  validateSelection(selection);
  return selection;
}

export function validatePiSdk(sdk: PiSdk): void {
  // Breaking major upgrades require an adapter review, not a silent cast to compatibility.
  if (!/^1\./.test(sdk.VERSION ?? "")) throw new Error(`Unsupported Pi ${sdk.VERSION ?? "unknown"}; Sage currently supports Pi 1.x`);
  for (const name of ["createAgentSession", "createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "SettingsManager", "SessionManager", "DefaultResourceLoader", "DefaultPackageManager", "InteractiveMode", "BorderedLoader", "loadSkills"] as const) {
    if (typeof sdk[name] !== "function") throw new Error(`Pi SDK is missing ${name}; previous runtime remains active`);
  }
}

async function installedPi(directory: string) {
  const shared = await resolveSharedPi(directory), root = shared ?? directory;
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(await readFile(join(root, "node_modules", PI_PACKAGE, "package.json"), "utf8")); }
  catch { throw new Error("Invalid Pi package manifest; use sage pi rollback or sage pi reset"); }
  if (!manifest || manifest.name !== PI_PACKAGE) throw new Error("Isolated install is not the Pi package");
  // Resolve using import conditions. Pi intentionally has an ESM-only export;
  // createRequire().resolve() cannot resolve that export on Bun/Node.
  const entry = import.meta.resolve(PI_PACKAGE, join(root, "package.json"));
  const sdk = await import(entry.startsWith("file:") ? entry : pathToFileURL(entry).href) as PiSdk;
  validatePiSdk(sdk);
  if (manifest.version !== sdk.VERSION) throw new Error("Installed Pi manifest and SDK versions disagree");
  return { sdk, shared };
}

export async function loadInstalledPi(directory: string): Promise<PiSdk> {
  return (await installedPi(directory)).sdk;
}

async function selectedPi(paths: SagePaths) {
  const selection = await readPiSelection(paths);
  if (!selection) {
    const sdk = await import("@earendil-works/pi-coding-agent");
    validatePiSdk(sdk);
    return { sdk, selection, shared: undefined };
  }
  const result = await installedPi(join(piRuntimeRoot(paths), selection.install));
  if (result.sdk.VERSION !== selection.version) throw new Error("Selected Pi version does not match its installed SDK; run learn pi reset or update");
  return { ...result, selection };
}

export async function loadPi(paths: SagePaths): Promise<PiSdk> {
  return (await selectedPi(paths)).sdk;
}

export async function piInfo(paths: SagePaths) {
  const { sdk, selection, shared } = await selectedPi(paths);
  return { version: sdk.VERSION, source: shared ? "shared" : selection ? "isolated" : "bundled", supported: "1.x", runtime: shared ?? (selection ? join(piRuntimeRoot(paths), selection.install) : "Sage package dependency"), previous: selection?.previous ?? null, agent: paths.agent, sessions: paths.sessions, global_pi: "not modified" };
}
