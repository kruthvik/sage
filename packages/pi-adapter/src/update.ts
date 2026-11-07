// `sage update` (owner M2: pin pi 1.5.0, user-triggered updates). Network only when the user runs update; startup is offline.
// Flow: install into a fresh install-<uuid> dir → validate exports → smoke → atomic switch of active.json (keeps `previous` for rollback).
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadInstalledPi, loadPi, piRuntimeRoot, piSelectionPath, readPiSelection, PI_PACKAGE, type PiSdk, type PiSelection, type SagePaths } from "./sdk.ts";

export interface UpdateOptions {
  /** Installs `PI_PACKAGE@version` into `dir`. Default: `bun add` (Sage runs on Bun). Injected in tests. */
  install?: (dir: string, version: string) => Promise<void>;
  /** Post-install check against the new SDK (e.g. build an isolated runtime); throwing aborts the switch. */
  smoke?: (sdk: PiSdk) => Promise<void>;
}

async function bunAdd(dir: string, version: string) {
  const p = Bun.spawn(["bun", "add", "--exact", `${PI_PACKAGE}@${version}`], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_TELEMETRY: "0" } });
  if (await p.exited !== 0) throw new Error(`installing pi ${version} failed: ${(await new Response(p.stderr).text()).slice(-400)}`);
}

async function writeSelection(paths: SagePaths, sel: PiSelection | undefined) {
  const file = piSelectionPath(paths);
  if (!sel) { await rm(file, { force: true }); return; }
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(sel, null, 2));
  await rename(tmp, file); // atomic on the same volume: a crash leaves the old or the new selection, never half of one
}

export async function updatePi(paths: SagePaths, version = "latest", opts: UpdateOptions = {}): Promise<{ from: string; to: string }> {
  const current = await readPiSelection(paths).catch(() => undefined);
  const from = current?.version ?? "bundled";
  const install = `install-${randomUUID()}`, dir = join(piRuntimeRoot(paths), install);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "sage-pi-runtime", private: true, type: "module" }));
    await (opts.install ?? bunAdd)(dir, version);
    const sdk = await loadInstalledPi(dir); // validates manifest, exports and version
    await opts.smoke?.(sdk);
    await writeSelection(paths, { install, version: sdk.VERSION, ...(current ? { previous: { install: current.install, version: current.version } } : {}) });
    return { from, to: sdk.VERSION };
  } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; } // previous runtime stays active
}

/** Back to the previous selection, or to the bundled pin if there was none. */
export async function rollbackPi(paths: SagePaths): Promise<string> {
  const cur = await readPiSelection(paths);
  await writeSelection(paths, cur?.previous ? { ...cur.previous } : undefined);
  return cur?.previous?.version ?? "bundled";
}
export const resetPi = (paths: SagePaths) => writeSelection(paths, undefined);

/** Startup (offline): load the selected pi; if it no longer loads, fall back to previous, then bundled, and say so. */
export async function loadPiWithFallback(paths: SagePaths): Promise<{ sdk: PiSdk; notice?: string }> {
  try { return { sdk: (await loadPi(paths)).sdk }; }
  catch (e) {
    const why = (e as Error).message;
    const to = await rollbackPi(paths).catch(async () => { await resetPi(paths); return "bundled"; });
    try { return { sdk: (await loadPi(paths)).sdk, notice: `Selected pi failed to load (${why}); switched to ${to}.` }; }
    catch { await resetPi(paths); return { sdk: (await loadPi(paths)).sdk, notice: `Selected pi failed to load (${why}); switched to the bundled pi.` }; }
  }
}

/** The one extension bundled for everyone (owner M2). Extensions run with OS privileges; an isolated home is not a sandbox. */
export const WEB_ACCESS = "npm:pi-web-access@0.44.0";
export async function provisionWebAccess(paths: SagePaths): Promise<string | undefined> {
  const { sdk } = await loadPiWithFallback(paths);
  await mkdir(paths.agent, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory({ enableInstallTelemetry: false, packages: [WEB_ACCESS] } as never, { projectTrusted: false } as never);
  const pm = new sdk.DefaultPackageManager({ cwd: paths.home, agentDir: paths.agent, settingsManager });
  await pm.install(WEB_ACCESS);
  return pm.getInstalledPath(WEB_ACCESS, "user");
}
