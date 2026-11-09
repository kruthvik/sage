// Dev-only soak test: the real `sage serve` server in-process, on a virtual clock, with a simulated learner speaking JSON-RPC
// over the WebSocket like the console does. Logs RSS and live heap (after a full GC) every 30 s, and at the end the object types
// that grew most, to show whether memory stays flat over a long session.
// Usage: [EVAL_MODEL=provider/model] [SOAK_MIN=60] [SOAK_UNIT=calc] bun packages/eval/src/serve-soak.ts <mem-log.tsv>
// Ledger and settings go to a temp SAGE home; models and auth come from Sage's own agent dir (never ~/.pi).
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { heapStats } from "bun:jsc";
import { startServer } from "../../../apps/server/src/server.ts";
import { evalRuntime } from "./eval-runtime.ts";
import { sagePaths } from "../../core/src/paths.ts";
import { DEFAULT_ROLE_MODELS } from "../../agent/src/host.ts";
import { extractJson } from "../../agent/src/json.ts";
import { UNITS } from "./units.ts";
import type { Item } from "../../core/src/types.ts";

const memLog = process.argv[2] ?? join(tmpdir(), "sage-soak.tsv");
const minutes = Number(process.env.SOAK_MIN ?? 60), unit = UNITS.find(u => u.id === (process.env.SOAK_UNIT ?? "calc"))!;
const [provider, model] = (process.env.EVAL_MODEL ?? "antigravity/gemini-3.8-flash").split("/") as [string, string];

const home = await mkdtemp(join(tmpdir(), "sage-soak-")), paths = { ...sagePaths(home), agent: sagePaths().agent };
mkdirSync(join(home, "data"), { recursive: true });
writeFileSync(join(home, "settings.json"), JSON.stringify({ roleModels: Object.fromEntries(Object.keys(DEFAULT_ROLE_MODELS).map(r => [r, { provider, model }])) }));
const rt = await evalRuntime();
const t0 = Date.now() - 2 * 86_400_000; let clock = t0; // in the past: the ledger refuses events dated after its real clock
const srv = startServer({ paths, rt, now: () => new Date(clock).toISOString() });
const vmin = () => (clock - t0) / 60_000;

const wall0 = Date.now(), mb = (n: number) => (n / 2 ** 20).toFixed(1);
const counts = () => { Bun.gc(true); return heapStats().objectTypeCounts as Record<string, number>; };
const first = counts();
writeFileSync(memLog, "wall_s\tvirtual_min\trss_mb\theap_live_mb\n");
const sample = () => { Bun.gc(true); const m = process.memoryUsage(); const line = `${Math.round((Date.now() - wall0) / 1000)}	${vmin().toFixed(1)}	${mb(m.rss)}	${mb(m.heapUsed)}
`; appendFileSync(memLog, line); process.stdout.write(`mem ${line}`); };
sample(); const timer = setInterval(sample, 30_000);

// JSON-RPC client
const ws = new WebSocket(srv.ws, { headers: { origin: `http://127.0.0.1:${srv.port}` } } as never);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let nextId = 1; const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
const items = new Map<string, Item>(); const memory: string[] = []; let repair: string | undefined, retry = false, events = 0;
ws.onmessage = m => {
  const msg = JSON.parse(String(m.data));
  if (msg.id !== undefined) { const w = waiting.get(msg.id); waiting.delete(msg.id); return msg.error ? w?.no(new Error(msg.error.message)) : w?.ok(msg.result); }
  const { event, data } = msg.params; events++;
  if (event === "item.present") items.set(data.item.id, data.item);
  if (event === "tutor.done") { memory.push(`Tutor taught: ${data.text}`); clock += Math.max(20, data.text.split(/\s+/).length / 200 * 60) * 1000; }
  if (event === "feedback.present") memory.push(`Feedback on your answer: ${data.grade?.feedback ?? ""}`);
  if (event === "repair.required") { repair = data.attemptId; memory.push(`You must fix: ${data.flaws.map((f: { problem: string }) => f.problem).join("; ")}`); }
  if (event === "error" && data.retry) retry = true;
};
const call = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((ok, no) => { const id = nextId++; waiting.set(id, { ok, no }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });

const LEARNER = `You are role-playing a real student studying for a test. Stay in character.\nWhat you know: ${unit.learner}\nRules: answer briefly (1-4 sentences or a short working), make this student's mistakes, learn from earlier feedback but not perfectly.\nReply with JSON only: {"choice": <0-based index>} for multiple choice, {"indices": [...]} for ordering/matching, otherwise {"text": "..."}.`;
async function answer(item: Item): Promise<Record<string, unknown>> {
  const r = await rt.roleCall({ provider, model, system: LEARNER, user: `${memory.slice(-6).join("\n")}\n\nQuestion (${item.activityType}):\n${item.stem}${item.choices ? `\nChoices:\n${item.choices.map((c, i) => `${i}. ${c}`).join("\n")}` : ""}${item.targets ? `\nTargets:\n${item.targets.map((c, i) => `${i}. ${c}`).join("\n")}` : ""}` });
  try { const j = extractJson(r.text) as { choice?: number; indices?: unknown[]; text?: string };
    if (Array.isArray(j.indices) && (item.activityType === "ordering" || item.activityType === "matching")) return { indices: j.indices.map(Number).filter(Number.isInteger) };
    return typeof j.choice === "number" && item.choices ? { choice: j.choice } : { text: String(j.text ?? r.text) }; } catch { return { text: r.text.slice(0, 500) }; }
}
const until = async (ok: () => Promise<boolean>, ms = 600_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await Bun.sleep(500); } return false; };

const { sessionId } = await call("session.create", { goal: { objective: unit.objective, timeBudgetMin: Math.max(minutes, unit.minutes), mode: "cram" } });
if (!await until(async () => (await call("state.get", { sessionId })).phase === "plan_review")) throw new Error("planning did not finish");
await call("plan.approve", { sessionId });
let steps = 0, idle = 0, errors = 0;
while (vmin() < minutes && steps++ < 2000) {
  const s = await call("state.get", { sessionId });
  if (s.phase === "ended") break;
  try {
    if (retry) { retry = false; await call("session.retry", { sessionId }); continue; }
    if (s.feedbackAttemptId) { clock += 15_000; await call("feedback.ack", { sessionId, attemptId: s.feedbackAttemptId }); idle = 0; continue; }
    if (repair && s.phase === "repair") { const a = repair; repair = undefined; const it = s.current && items.get(s.current.itemId); if (it) { clock += 60_000; await call("item.submit", { sessionId, ...await answer(it), latencyMs: 60_000 }); idle = 0; continue; } void a; }
    if (s.current && items.has(s.current.itemId)) { const it = items.get(s.current.itemId)!, think = it.choices ? 30_000 : 75_000; const input = await answer(it); clock += think;
      await call("item.submit", { sessionId, ...input, latencyMs: think }); items.delete(it.id); idle = 0; continue; }
    if (s.phase === "close") { clock += 5_000; await call("control.advance", { sessionId }); idle = 0; continue; }
  } catch (e) { errors++; console.log(`step ${steps} (${s.phase}): ${(e as Error).message.slice(0, 200)}`); }
  if (++idle > 240) { console.log(`waiting on nothing the learner can do in phase ${s.phase}`); break; } // ~2 min of 500 ms polls
  await Bun.sleep(500);
}
const end = await call("state.get", { sessionId }).catch(() => ({}));
const exp = await call("export.get", { sessionId }).then(r => `export ok (${String(r.sessionMd).length} chars)`, e => `export failed: ${e.message}`);
clearInterval(timer); sample();
const last = counts(), grew = Object.entries(last).map(([k, v]) => [k, v - (first[k] ?? 0)] as const).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`virtual ${vmin().toFixed(0)} min, wall ${Math.round((Date.now() - wall0) / 1000)} s, phase ${end.phase}, ${steps} steps, ${events} events, ${errors} client errors, calls ${end.spend?.calls}, ${exp}`);
console.log("object types that grew most (after full GC):", grew.map(([k, v]) => `${k} +${v}`).join(", "));
ws.close(); srv.stop(); process.exit(0);
