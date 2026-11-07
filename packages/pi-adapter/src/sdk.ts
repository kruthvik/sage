// The ONLY module that imports pi (F13). Ported from v3 packages/pi/src/sdk.ts without the shared-runtime registration and TUI checks.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { sagePaths } from "../../core/src/paths.ts";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_PINNED = "1.5.0";
export type PiSdk = typeof import("@earendil-works/pi-coding-agent");
export type SagePaths = ReturnType<typeof sagePaths>;
export interface PiSelection { install: string; version: string; previous?: { install: string; version: string } }

/** What Sage actually calls. A pi release missing any of these is refused, and the previous runtime stays active. */
export const REQUIRED_EXPORTS = ["createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "SettingsManager", "SessionManager", "DefaultResourceLoader", "DefaultPackageManager"] as const;

export const piRuntimeRoot = (paths: SagePaths) => join(paths.home, "pi-runtime");
export const piSelectionPath = (paths: SagePaths) => join(piRuntimeRoot(paths), "active.json");

export function validateSelection(value: unknown): asserts value is PiSelection {
  const check = (entry: unknown) => {
    const { install, version } = (entry ?? {}) as PiSelection;
    if (typeof install !== "string" || !/^install-[a-f0-9-]{36}$/.test(install) || typeof version !== "string" || !/^1\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid pi runtime selection; run `sage update --reset` to use the bundled pi");
  };
  check(value);
  if ((value as PiSelection).previous !== undefined) check((value as PiSelection).previous);
}

export async function readPiSelection(paths: SagePaths): Promise<PiSelection | undefined> {
  let content: string;
  try { content = await readFile(piSelectionPath(paths), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let selection: unknown;
  try { selection = JSON.parse(content); } catch { throw new Error("Invalid pi runtime selection; run `sage update --reset`"); }
  validateSelection(selection);
  return selection;
}

export function validatePiSdk(sdk: PiSdk): void {
  // A breaking major needs an adapter review, not a silent cast.
  if (!/^1\./.test(sdk.VERSION ?? "")) throw new Error(`Unsupported pi ${sdk.VERSION ?? "unknown"}; Sage supports pi 1.x`);
  for (const name of REQUIRED_EXPORTS) if (typeof (sdk as Record<string, unknown>)[name] !== "function") throw new Error(`pi SDK is missing ${name}; previous runtime remains active`);
}

export async function loadInstalledPi(directory: string): Promise<PiSdk> {
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(await readFile(join(directory, "node_modules", PI_PACKAGE, "package.json"), "utf8")); }
  catch { throw new Error("Invalid pi package manifest; use `sage update --rollback` or `--reset`"); }
  if (manifest?.name !== PI_PACKAGE) throw new Error("Isolated install is not the pi package");
  // pi is ESM-only; resolve with import conditions (createRequire().resolve can't).
  const entry = import.meta.resolve(PI_PACKAGE, join(directory, "package.json"));
  const sdk = await import(entry.startsWith("file:") ? entry : pathToFileURL(entry).href) as PiSdk;
  validatePiSdk(sdk);
  if (manifest.version !== sdk.VERSION) throw new Error("Installed pi manifest and SDK versions disagree");
  return sdk;
}

/** The user-selected pi (after `sage update`), else the pinned dependency. */
export async function loadPi(paths: SagePaths): Promise<{ sdk: PiSdk; source: "bundled" | "selected"; selection?: PiSelection }> {
  const selection = await readPiSelection(paths);
  if (!selection) { const sdk = await import("@earendil-works/pi-coding-agent"); validatePiSdk(sdk); return { sdk, source: "bundled" }; }
  const sdk = await loadInstalledPi(join(piRuntimeRoot(paths), selection.install));
  if (sdk.VERSION !== selection.version) throw new Error("Selected pi version does not match its installed SDK; run `sage update --reset`");
  return { sdk, source: "selected", selection };
}
