#!/usr/bin/env bun
// Sage CLI (M3): serve, setup, update, schema, models.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { sagePaths } from "../../../packages/core/src/paths.ts";
import { createSageRuntime } from "../../../packages/pi-adapter/src/runtime.ts";
import { updatePi, rollbackPi, resetPi, provisionWebAccess, WEB_ACCESS } from "../../../packages/pi-adapter/src/update.ts";
import { startServer } from "../../server/src/server.ts";
import { schemaDocument } from "../../server/src/schema.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? "") : undefined; };
const paths = sagePaths(process.env.SAGE_HOME ?? join(homedir(), ".sage"));
const PRIVILEGE = "Note: pi extensions run with your OS privileges. Sage's isolated home is not a sandbox.";

/** --pi-agent-dir is an explicit opt-in to use an existing pi agent dir (auth, providers) in place; nothing is copied. */
async function runtime() {
  const piDir = flag("pi-agent-dir")?.replace(/^~/, homedir());
  let packages: (string | { source: string; extensions?: string[] })[] = [WEB_ACCESS];
  if (piDir) {
    const { readFileSync } = await import("node:fs");
    try { packages = (JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8")).packages ?? []).filter((p: string | { source: string }) => /pi-web-access|pi-antigravity/.test(typeof p === "string" ? p : p.source)); } catch { /* none */ }
    console.log(`Using pi agent dir ${piDir} in place (credentials are read, never copied). Loaded: ${packages.map(p => typeof p === "string" ? p : p.source).join(", ") || "none"}. ${PRIVILEGE}`);
  }
  const rt = await createSageRuntime({ paths, ...(piDir ? { agentDir: piDir } : {}), packages });
  if (rt.piNotice) console.warn(rt.piNotice);
  return rt;
}

switch (cmd) {
  case "serve": {
    const rt = await runtime();
    const srv = startServer({ paths, rt, ...(flag("port") ? { port: Number(flag("port")) } : {}) });
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(join(paths.home, "serve.json"), JSON.stringify({ url: srv.url, ws: srv.ws, pid: process.pid }), { mode: 0o600 });
    console.log(`Sage API v1 on ${srv.ws.replace(/token=.*/, "token=…")}\nDev console: ${srv.url}\n(token also in ${join(paths.home, "serve.json")})`);
    break;
  }
  case "setup": {
    console.log(`Installing ${WEB_ACCESS} into ${paths.agent}. ${PRIVILEGE}`);
    console.log(`Installed at ${await provisionWebAccess(paths)}. Web search works without an API key (Exa MCP by default).`);
    break;
  }
  case "update": {
    if (args.includes("--rollback")) console.log(`pi rolled back to ${await rollbackPi(paths)}`);
    else if (args.includes("--reset")) { await resetPi(paths); console.log("pi reset to the bundled version"); }
    else {
      const version = args.find(a => !a.startsWith("--")) ?? "latest";
      const r = await updatePi(paths, version, { smoke: async () => { /* loadInstalledPi already validated exports; a runtime build follows on next start */ } });
      console.log(`pi ${r.from} → ${r.to}. Run \`bun run eval:smoke\` from the repo to re-check, or \`sage update --rollback\` to undo.`);
    }
    break;
  }
  case "schema": {
    const out = flag("out") ?? join(import.meta.dir, "..", "..", "..", "docs", "api", "v1.schema.json");
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(schemaDocument(), null, 2) + "\n"); console.log(`wrote ${out}`);
    break;
  }
  case "models": { const rt = await runtime(); console.log((await rt.available()).join("\n") || "no models with auth; log in with pi or pass --pi-agent-dir"); process.exit(0); }
  default:
    console.log("usage: sage serve [--port N] [--pi-agent-dir DIR] | setup | update [VERSION|--rollback|--reset] | schema [--out FILE] | models [--pi-agent-dir DIR]");
}
