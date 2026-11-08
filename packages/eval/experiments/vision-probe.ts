// One live transcriber call on a local PNG (owner M5: flash reads scrap_work photos). Usage: bun packages/eval/experiments/vision-probe.ts <png> [provider/model]
import { readFileSync } from "node:fs";
import { evalRuntime } from "../src/eval-runtime.ts";
import { TRANSCRIBER_SYSTEM, transcriberUser, parseTranscription } from "../../agent/src/roles.ts";
const [png, pm = "antigravity/gemini-3.8-flash"] = process.argv.slice(2) as [string, string?];
const [provider, model] = pm.split("/") as [string, string];
const rt = await evalRuntime([provider]);
const r = await rt.roleCall({ provider, model, system: TRANSCRIBER_SYSTEM, user: transcriberUser("Solve x^2 + 3x = 10."), images: [{ data: readFileSync(png).toString("base64"), mimeType: "image/png" }] });
console.log(JSON.stringify({ text: parseTranscription(r.text), usage: r.usage, ms: r.ms }, null, 1));
