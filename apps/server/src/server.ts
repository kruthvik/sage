// `sage serve` (SPEC §17, M3): WebSocket JSON-RPC 2.0 on loopback, launch token, one learner lease per session.
// Security: binds 127.0.0.1 only; Host and Origin must be loopback on this port (blocks DNS rebinding and cross-site pages);
// the launch token is compared in constant time. Only learner-owned engine events can come from a client (F10, via the driver).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Ledger } from "../../../packages/storage/src/ledger.ts";
import { SessionDriver, type DriverRuntime, type ServerEvent } from "../../../packages/agent/src/driver.ts";
import { DEFAULT_ROLE_MODELS, GRADER_CALIBRATION, type RoleModels } from "../../../packages/agent/src/host.ts";
import { buildPacket } from "../../../packages/agent/src/packet.ts";
import { EngineError } from "../../../packages/engine/src/loop.ts";
import type { EngineEvent } from "../../../packages/engine/src/state.ts";
import type { Goal, ResponseInput } from "../../../packages/core/src/types.ts";
import type { SagePaths } from "../../../packages/pi-adapter/src/sdk.ts";
import { METHODS, API_VERSION, check, schemaDocument } from "./schema.ts";
import { CONSOLE_HTML } from "./console.ts";

export const ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, engine: 1001, lease: 1002, notImplemented: 1003, unknownSession: 1004 } as const;
class RpcError extends Error { constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); } }

interface Conn { id: string; sessions: Set<string> }
export interface ServeOptions { paths: SagePaths; rt: DriverRuntime; port?: number; token?: string; now?: () => string }

const defaultsFor = (g: Partial<Goal>): Goal => ({
  mode: "cram", pace: "normal", allowedAids: [], ...g,
  preview: { profile: "cram", feedbackRigor: "rigorous", ...(g.preview ?? {}), toggles: { diagnostic: false, hints: true, studio: false, diagrams: false, pdfCheatsheets: false, obsidianExport: false, reviewBeforeAdvance: true, ...(g.preview?.toggles ?? {}) } },
} as Goal);

export function startServer(opts: ServeOptions) {
  const token = opts.token ?? randomBytes(24).toString("hex");
  mkdirSync(dirname(opts.paths.db), { recursive: true });
  const ledger = new Ledger(opts.paths.db);
  const settingsFile = join(opts.paths.home, "settings.json");
  const readModels = (): RoleModels => { try { return { ...DEFAULT_ROLE_MODELS, ...JSON.parse(readFileSync(settingsFile, "utf8")).roleModels }; } catch { return { ...DEFAULT_ROLE_MODELS }; } };
  const drivers = new Map<string, SessionDriver>();
  const leases = new Map<string, string>(); // sessionId → conn id
  const sockets = new Map<string, ServerWebSocket<Conn>>();

  const broadcast = (e: ServerEvent) => { for (const ws of sockets.values()) if (ws.data.sessions.has(e.sessionId)) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: e })); };
  const driver = (id: string) => {
    let d = drivers.get(id);
    if (!d) {
      if (!ledger.sessions().includes(id)) throw new RpcError(ERR.unknownSession, `unknown session ${id}`);
      d = SessionDriver.resume(id, ledger, opts.rt, readModels(), broadcast, opts.now); drivers.set(id, d);
    }
    return d;
  };
  const lease = (c: Conn, id: string, take = false) => {
    const holder = leases.get(id);
    if (holder && holder !== c.id && sockets.has(holder) && !take) throw new RpcError(ERR.lease, "another client holds this session; resume with takeLease to take over");
    leases.set(id, c.id); c.sessions.add(id);
  };

  async function dispatch(c: Conn, method: string, p: Record<string, unknown>): Promise<unknown> {
    const spec = METHODS[method];
    if (!spec) throw new RpcError(ERR.method, `unknown method ${method}`);
    const problems = check(spec.params, p);
    if (problems.length) throw new RpcError(ERR.params, problems.join("; "));
    if (spec.impl === false) throw new RpcError(ERR.notImplemented, `${method} is reserved in API v${API_VERSION} and not implemented yet${spec.note ? ` (${spec.note})` : ""}`);
    const id = p.sessionId as string | undefined;
    if (spec.learner && id && method !== "session.create") { driver(id); if (leases.get(id) !== c.id) throw new RpcError(ERR.lease, "this client does not hold the session lease; call session.resume"); }
    const act = async (ev: EngineEvent) => { const d = driver(id!); try { await d.learner(ev); } catch (e) { if (e instanceof EngineError) throw new RpcError(ERR.engine, e.message); throw e; } return d.view(); };

    switch (method) {
      case "session.create": {
        const sessionId = randomUUID();
        const d = SessionDriver.create(defaultsFor(p.goal as Partial<Goal>), sessionId, ledger, opts.rt, readModels(), broadcast, opts.now);
        drivers.set(sessionId, d); lease(c, sessionId);
        void d.drain(); // planning runs while the client subscribes; events arrive as notifications
        return { sessionId };
      }
      case "session.list": return ledger.sessions().map(s => { const first = ledger.engineLog(s)[0]?.event as Extract<EngineEvent, { type: "session_created" }> | undefined; return { sessionId: s, objective: first?.goal.objective, phase: drivers.get(s)?.state.phase }; });
      case "session.resume": { const d = driver(id!); lease(c, id!, p.takeLease === true); return d.view(); }
      case "session.retry": { const d = driver(id!); const retried = await d.retry(); return { retried, ...d.view() }; }
      case "session.end": { const v = await act({ type: "control", action: "stop" }); leases.delete(id!); return v; }
      case "plan.get": return driver(id!).state.plan ?? null;
      case "plan.edit": return act({ type: "plan_edited", plan: p.plan as never });
      case "plan.approve": return act({ type: "plan_approved" });
      case "plan.merge": return act({ type: "plan_nodes_merged", nodeIds: p.nodeIds as string[] });
      case "diagnostic.skip": case "control.teach": return act({ type: "control", action: "teach" });
      case "control.morePractice": return act({ type: "control", action: "morePractice" });
      case "control.advance": return act({ type: "control", action: "advance" });
      case "control.leaveWithGaps": return act({ type: "control", action: "leaveWithGaps", ...(p.confirmToken ? { confirmToken: p.confirmToken as string } : {}) });
      case "control.stop": return act({ type: "control", action: "stop" });
      case "control.resume": return act({ type: "control", action: "resume" });
      case "item.submit": {
        const d = driver(id!), cur = d.state.current;
        const input: ResponseInput | undefined = typeof p.choice === "number" ? { kind: "choice", index: p.choice } : typeof p.text === "string" ? { kind: "text", text: p.text } : p.fields ? { kind: "fields", fields: p.fields as Record<string, string> } : undefined;
        if (!input) throw new RpcError(ERR.params, "give text, choice or fields");
        const latencyMs = typeof p.latencyMs === "number" ? p.latencyMs : cur ? Date.now() - Date.parse(cur.presentedAt) : 0;
        return act({ type: "response_submitted", input, responseEventId: randomUUID(), latencyMs: Math.max(0, latencyMs) });
      }
      case "hint.request": return act({ type: "hint_requested", level: p.level as 1 | 2 | 3 });
      case "chunk.peek": return act({ type: "chunk_peeked" });
      case "feedback.ack": return act({ type: "feedback_acked", attemptId: p.attemptId as string });
      case "grade.dispute": return act({ type: "grade_disputed", attemptId: p.attemptId as string, argument: p.argument as string });
      case "pace.set": return act({ type: "pace_set", pace: p.pace as "normal" | "speed_up" });
      case "time.extend": return act({ type: "time_extended", minutes: p.minutes as number });
      case "reviews.consent": return act({ type: "reviews_consented", subskillIds: p.subskillIds as string[] });
      case "state.get": { const d = driver(id!); c.sessions.add(id!); return { ...d.view(), current: d.state.current ? { itemId: d.state.current.itemId } : null, feedbackAttemptId: d.state.feedbackAttemptId ?? null, timeline: d.state.timeline.slice(-30) }; }
      case "context.inspect": { const d = driver(id!); return buildPacket(d.state, d.state.candidates, "(inspection)"); }
      case "research.status": return { packs: driver(id!).view().packs, searchAvailable: true };
      case "research.pack": { const pk = driver(id!).state.packs.get(p.packId as string); if (!pk) throw new RpcError(ERR.params, "unknown pack"); return pk; }
      case "sources.acceptPack": return act({ type: "research_pack_accepted", packId: p.packId as string, ...(p.itemIds ? { itemIds: p.itemIds as string[] } : {}) });
      case "settings.get": return { roleModels: readModels(), graderCalibration: GRADER_CALIBRATION, apiVersion: API_VERSION };
      case "settings.set": {
        const rm = p.roleModels as Record<string, { provider?: unknown; model?: unknown }> | undefined;
        for (const [role, m] of Object.entries(rm ?? {})) if (!(role in DEFAULT_ROLE_MODELS) || typeof m?.provider !== "string" || typeof m?.model !== "string") throw new RpcError(ERR.params, `roleModels.${role} needs a known role with provider and model`);
        const next = { ...readModels(), ...rm } as RoleModels;
        writeFileSync(settingsFile, JSON.stringify({ roleModels: next }, null, 2));
        for (const d of drivers.values()) d.models = next;
        return { roleModels: next };
      }
      case "usage.get": return id ? driver(id).state.spend : { calls: ledger.calls().filter(x => x.phase === "completed").length };
    }
    throw new RpcError(ERR.method, `unhandled method ${method}`);
  }

  const server = Bun.serve<Conn>({
    hostname: "127.0.0.1", port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url), port = srv.port, host = req.headers.get("host") ?? "", origin = req.headers.get("origin");
      const loopback = (h: string) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
      if (!loopback(host) || (origin && !loopback(origin.replace(/^https?:\/\//, "")))) return new Response("forbidden", { status: 403 });
      const given = Buffer.from(url.searchParams.get("token") ?? ""), want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/ws") return srv.upgrade(req, { data: { id: randomUUID(), sessions: new Set() } }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/schema.json") return Response.json(schemaDocument());
      if (url.pathname === "/") return new Response(CONSOLE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://127.0.0.1:* ws://localhost:*" } });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { sockets.set(ws.data.id, ws); },
      close(ws) { sockets.delete(ws.data.id); for (const [s, h] of leases) if (h === ws.data.id) leases.delete(s); },
      async message(ws, raw): Promise<void> {
        let req: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
        try { req = JSON.parse(String(raw)); } catch { return void ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "parse error" } })); }
        const id = req.id ?? null;
        if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return void ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ERR.invalid, message: "invalid request" } }));
        try { const result = await dispatch(ws.data, req.method, (req.params ?? {}) as Record<string, unknown>); ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null })); }
        catch (e) {
          const err = e instanceof RpcError ? { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } : { code: -32603, message: (e as Error).message };
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: err }));
        }
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}/?token=${token}`;
  return { url, ws: `ws://127.0.0.1:${server.port}/ws?token=${token}`, token, port: server.port, stop: () => { server.stop(true); ledger.close(); }, drivers };
}
