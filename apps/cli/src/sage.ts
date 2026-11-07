#!/usr/bin/env bun
// Sage CLI (M3): serve, setup, update, schema, models.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { sagePaths } from "../../../packages/core/src/paths.ts";
import { createSageRuntime } from "../../../packages/pi-adapter/src/runtime.ts";
import { updatePi, rollbackPi, resetPi, provisionPackages, sagePackages, isolateProcess, WEB_ACCESS } from "../../../packages/pi-adapter/src/update.ts";
import { startServer } from "../../server/src/server.ts";
import { schemaDocument } from "../../server/src/schema.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? "") : undefined; };
const paths = sagePaths(process.env.SAGE_HOME ?? join(homedir(), ".sage"));
const PRIVILEGE = "Note: pi extensions run with your OS privileges. Sage's isolated home is not a sandbox.";

/** Sage's own agent dir only (owner, M3 review): packages are what `sage setup` installed there; global pi config is never read. */
async function runtime() {
  const packages = await sagePackages(paths);
  if (!packages.length) console.warn("No packages installed in Sage's agent dir; run `sage setup` (research needs pi-web-access).");
  const rt = await createSageRuntime({ paths, packages });
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
    // Provider packages (e.g. npm:pi-antigravity@0.11.0 for gemini models) are installed only when named; nothing is imported from ~/.pi.
    const providers = args.flatMap((a, i) => args[i - 1] === "--provider" ? [a] : []);
    console.log(`Installing ${[WEB_ACCESS, ...providers].join(", ")} into ${paths.agent}. ${PRIVILEGE}`);
    for (const p of await provisionPackages(paths, providers)) console.log(`  ${p.source} → ${p.path}`);
    console.log("Web search works without an API key (Exa MCP by default). Next: `sage login` to sign in to a model provider inside Sage's agent dir.");
    break;
  }
  case "login": {
    // pi's own login flow (/login), run by Sage's bundled pi against Sage's agent dir. Credentials land in SAGE_HOME/agent only.
    isolateProcess(paths);
    const cli = new URL("../../../packages/pi-adapter/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url);
    console.log(`Starting pi with agent dir ${paths.agent}. Type /login (e.g. /login antigravity), then /quit. ${PRIVILEGE}`);
    mkdirSync(paths.home, { recursive: true });
    const p = Bun.spawn(["bun", Bun.fileURLToPath(cli)], { cwd: paths.home, stdio: ["inherit", "inherit", "inherit"], env: process.env });
    process.exit(await p.exited);
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
  case "models": { const rt = await runtime(); console.log((await rt.available()).join("\n") || "no models with auth; run `sage login`"); process.exit(0); }
  default:
    console.log("usage: sage serve [--port N] | setup [--provider PKG]... | login | update [VERSION|--rollback|--reset] | schema [--out FILE] | models");
}
