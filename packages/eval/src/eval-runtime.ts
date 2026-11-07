// Shared dev-eval runtime. SAGE_EVAL_AGENT_DIR=<dir> is an explicit opt-in to read another pi agent dir (e.g. ~/.pi/agent)
// in place — nothing is copied. Only that dir's packages that provide the named providers are loaded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSageRuntime } from "../../pi-adapter/src/runtime.ts";
import { sagePaths } from "../../core/src/paths.ts";

export function evalRuntime(providers: string[]) {
  const agentDir = process.env.SAGE_EVAL_AGENT_DIR?.replace(/^~/, homedir());
  let packages: (string | { source: string; extensions?: string[] })[] = [];
  if (agentDir) {
    try {
      const all = (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).packages ?? []) as typeof packages;
      packages = all.filter(p => [...providers, "pi-web-access"].some(pr => (typeof p === "string" ? p : p.source).includes(pr))); // + the researcher's tools
    } catch { /* no settings: builtin providers only */ }
  }
  return createSageRuntime({ paths: sagePaths(process.env.SAGE_HOME ?? join(homedir(), ".sage")), agentDir, packages });
}
