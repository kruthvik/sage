import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, ERR } from "../src/server.ts";
import { sagePaths } from "../../../packages/core/src/paths.ts";
import { fakeRuntime } from "../../../packages/eval/src/fake-runtime.ts";

const home = await mkdtemp(join(tmpdir(), "sage-home-"));
const srv = startServer({ paths: sagePaths(home), rt: fakeRuntime() });
afterAll(() => srv.stop());

function client() {
  const ws = new WebSocket(srv.ws);
  let n = 0; const pending = new Map<number, (v: { result?: unknown; error?: { code: number; message: string } }) => void>(); const events: { event: string; data: unknown }[] = [];
  ws.onmessage = m => { const x = JSON.parse(String(m.data)); if (x.id) { pending.get(x.id)?.(x); pending.delete(x.id); } else if (x.method === "event") events.push(x.params); };
  const open = new Promise<void>(r => ws.onopen = () => r());
  const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<{ result?: any; error?: { code: number; message: string } }>(r => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  const until = async (pred: () => boolean, ms = 3000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error("timeout; events: " + events.map(e => e.event).join(",")); await Bun.sleep(10); } };
  return { ws, open, rpc, events, until };
}

test("bad token, foreign origin and non-loopback host are refused", async () => {
  expect((await fetch(srv.url.replace(srv.token, "x".repeat(srv.token.length)))).status).toBe(401);
  expect((await fetch(srv.url, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(srv.url)).status).toBe(200);
  expect(((await (await fetch(srv.url.replace("/?", "/schema.json?"))).json()) as { version: string }).version).toBe("1.0.0");
});

test("params are validated, reserved methods answer not_implemented, unknown methods are refused", async () => {
  const c = client(); await c.open;
  expect((await c.rpc("session.create", { goal: { objective: 5 } })).error?.code).toBe(ERR.params);
  expect((await c.rpc("extensions.list", {})).error?.code).toBe(ERR.notImplemented);
  expect((await c.rpc("grade.receive", {})).error?.code).toBe(ERR.method);
  c.ws.close();
});

test("create → plan → approve → first item over the wire; a second client can't drive the session", async () => {
  const a = client(), b = client(); await Promise.all([a.open, b.open]);
  const { result } = await a.rpc("session.create", { goal: { objective: "Learn three terms", timeBudgetMin: 30 } });
  const sessionId = result.sessionId as string;
  await a.until(() => a.events.some(e => e.event === "plan.changed"));
  expect((await b.rpc("plan.approve", { sessionId })).error?.code).toBe(ERR.lease);
  const approved = await a.rpc("plan.approve", { sessionId });
  expect(approved.error).toBeUndefined();
  await a.until(() => a.events.some(e => e.event === "item.present" || e.event === "tutor.done"));
  const item = a.events.find(e => e.event === "item.present")?.data as { item: Record<string, unknown> } | undefined;
  if (item) { expect(item.item).not.toHaveProperty("key"); expect(item.item).not.toHaveProperty("rubric"); }
  expect((await b.rpc("session.resume", { sessionId, takeLease: true })).error).toBeUndefined();
  expect((await a.rpc("control.stop", { sessionId })).error?.code).toBe(ERR.lease);
  a.ws.close(); b.ws.close();
});

test("the dev console's inline script parses", async () => {
  const { CONSOLE_HTML } = await import("../src/console.ts");
  expect(() => new Function(CONSOLE_HTML.split("<script>")[1]!.split("</script>")[0]!)).not.toThrow();
});

test("usage counters are local, on by default, and can be switched off", async () => {
  const c = client(); await c.open;
  const on = (await c.rpc("usage.get")).result;
  expect(on.enabled).toBe(true); expect(typeof on.sessions).toBe("number"); expect(typeof on.hours).toBe("number");
  expect((await c.rpc("usage.set", { enabled: false })).result).toEqual({ enabled: false });
  expect((await c.rpc("usage.get")).result).toEqual({ enabled: false });
  expect((await c.rpc("usage.set", { enabled: "no" })).error?.code).toBe(ERR.params);
  await c.rpc("usage.set", { enabled: true });
  c.ws.close();
});

test("scrap_work photo: consent stores it, the transcriber proposes text, only the learner's confirmed text is graded", async () => {
  const a = client(); await a.open;
  const sessionId = (await a.rpc("session.create", { goal: { objective: "Solve quadratics", timeBudgetMin: 30 } })).result.sessionId as string;
  await a.until(() => a.events.some(e => e.event === "plan.changed"));
  await a.rpc("plan.approve", { sessionId });
  await a.until(() => a.events.some(e => e.event === "item.present"));
  expect((await a.rpc("transcription.confirm", { sessionId, text: "x = 2" })).error?.code).toBe(ERR.engine); // nothing to confirm yet
  expect((await a.rpc("image.consent", { sessionId, images: [{ dataBase64: Buffer.from("not an image at all, just text").toString("base64") }] })).error?.code).toBe(ERR.params);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  expect((await a.rpc("image.consent", { sessionId, images: [{ dataBase64: png.toString("base64") }] })).error).toBeUndefined();
  await a.until(() => a.events.some(e => e.event === "transcription.review"));
  expect((a.events.find(e => e.event === "transcription.review")!.data as { text: string }).text).toBe("x^2 + 2x = 8 (from 1 photo)");
  const hash = new Bun.CryptoHasher("sha256").update(png).digest("hex");
  expect(existsSync(join(home, "data", "blobs", `${hash}.png`))).toBe(true);
  expect((await a.rpc("transcription.confirm", { sessionId, text: "x^2 + 2x = 8, so x = 2" })).error).toBeUndefined();
  const st = (await a.rpc("state.get", { sessionId })).result as { timeline: { kind: string; text: string }[] };
  expect(st.timeline.some(t => t.kind === "consent" && t.text.includes("antigravity/gemini-3.8-flash"))).toBe(true);
  a.ws.close();
});
