import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileUI, UI_LIMITS, type CompiledUI } from "./compiler.ts";

export type UiJson = null | boolean | number | string | UiJson[] | { [key: string]: UiJson };
export interface UiCallbacks {
  /** Current host permission/scope check on every payload/control request. */
  authorize?: () => boolean;
  /** Pinned public task/criteria, separate from generated explanatory UI. */
  activity?: { prompt: string; criteria: string[] };
  /** Raw learner work, never a browser-supplied grade. Parent owns scope/review/persistence. */
  onSubmit?: (text: string) => UiJson | void | Promise<UiJson | void>;
  onCancel?: () => UiJson | void | Promise<UiJson | void>;
}
export interface UiRegistryOptions { ttlMs?: number; maxEntries?: number; now?: () => number }
interface Entry { ui: CompiledUI; callbacks: UiCallbacks; expires: number; pending?: boolean; completed?: { type: string; text?: string; body: string } }
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };
const shell = `<!doctype html><html lang="en"><meta charset="utf-8"><meta id="ui-nonce" content="__UI_NONCE__"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage practice</title><link rel="stylesheet" href="/ui-assets/design.css"><main><header><h1>Sage practice</h1><p>Browser feedback and scores are not authoritative grades.</p></header><section id="task" hidden></section><section id="custom" hidden><p id="warning">Custom code is off. It may navigate its own iframe and transmit entered UI data or consume CPU. This is not a strict security sandbox.</p><button id="run-code" type="button">Run custom code</button></section><div id="activity"></div><section aria-label="Response to Sage"><label for="response">Your response (raw learner work)</label><textarea id="response" maxlength="8000" rows="5"></textarea><pre id="preview" aria-label="Response preview"></pre><div class="controls"><button id="submit" type="button" disabled>Send response to Sage</button><button id="cancel" type="button" disabled>Cancel</button></div><p id="status" role="status"></p></section></main><script type="module" src="/ui-assets/client.js"></script></html>`;
let assets: Promise<{ js: string; css: string }> | undefined;
async function browserAssets() {
  return assets ??= (async () => {
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./client.js", import.meta.url))], target: "browser", format: "esm", minify: false });
    if (!build.success || build.outputs.length !== 1) throw new Error("UI browser build failed");
    return { js: await build.outputs[0]!.text(), css: await Bun.file(new URL("./design.css", import.meta.url)).text() };
  })().catch(error => { assets = undefined; throw error; });
}
function response(body: string, status = 200, type = "application/json") { return new Response(body, { status, headers: { ...headers, "Content-Type": `${type}; charset=utf-8` } }); }
function error(status: number, message: string) { return response(JSON.stringify({ error: message }), status); }
async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("Content-Length")) > 65536) throw new Error("Body too large");
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const item = await reader.read(); if (item.done) break; total += item.value.length; if (total > 65536) throw new Error("Body too large"); chunks.push(item.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Capability-only temporary UI storage. Mount before the service's authenticated handler; starts no server. */
export class UiRegistry {
  private entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(options: UiRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 32;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 86400000 || !Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 128) throw new Error("Invalid UI registry limits");
  }
  private prune() { for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id); }
  create(source: string, callbacks: UiCallbacks = {}): { id: string; path: string; title: string; expiresAt: number } {
    const ui = compileUI(source);
    this.prune();
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    const id = randomBytes(24).toString("hex"), expiresAt = this.now() + this.ttlMs;
    this.entries.set(id, { ui, callbacks, expires: expiresAt });
    return { id, path: `/ui/${id}`, title: ui.title, expiresAt };
  }
  remove(id: string): void { this.entries.delete(id); }
  dispose(): void { this.entries.clear(); }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url), path = url.pathname;
    if (!/^\/(?:ui(?:\/|$)|api\/ui(?:\/|$)|ui-assets(?:\/|$))/.test(path)) return undefined;
    const host = request.headers.get("Host"), origin = request.headers.get("Origin"), site = request.headers.get("Sec-Fetch-Site");
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || (host !== null && host !== url.host) || (origin !== null && origin !== url.origin) || (site !== null && !["same-origin", "none"].includes(site))) return error(403, "Local same-origin UI only");
    if (request.method !== "GET" && request.method !== "POST") return error(405, "Method not allowed");
    if (request.method === "POST" && (origin !== url.origin || request.headers.get("Content-Type") !== "application/json")) return error(403, "Same-origin JSON required");
    try {
      if (path === "/ui-assets/client.js" || path === "/ui-assets/design.css") {
        if (request.method !== "GET") return error(405, "Method not allowed");
        const bundle = await browserAssets();
        return path.endsWith(".js") ? response(bundle.js, 200, "text/javascript") : response(bundle.css, 200, "text/css");
      }
      this.prune();
      const match = /^\/(ui|api\/ui)\/([a-f0-9]{48})$/.exec(path);
      const entry = match ? this.entries.get(match[2]!) : undefined;
      if (!entry) return error(404, "UI unavailable or expired");
      if (entry.callbacks.authorize && !entry.callbacks.authorize()) return error(403, "UI scope or sharing permission changed");
      if (match![1] === "ui") {
        if (request.method !== "GET") return error(405, "Method not allowed");
        const nonce = randomBytes(18).toString("hex");
        const page = response(shell.replace("__UI_NONCE__", nonce), 200, "text/html");
        // srcdoc inherits this policy. Permit only its nonce bootstrap/Blob modules and Lit's inline styles.
        page.headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self' 'nonce-${nonce}' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`);
        return page;
      }
      if (request.method === "GET") return response(JSON.stringify({ ui: entry.ui, activity: entry.callbacks.activity ?? null, canSubmit: !!entry.callbacks.onSubmit, canCancel: !!entry.callbacks.onCancel }));
      let body: { type?: unknown; text?: unknown };
      try {
        body = JSON.parse(await boundedBody(request));
        if (!body || typeof body !== "object" || Array.isArray(body) || !["submit", "cancel"].includes(body.type as string) || Object.keys(body).some(k => !(body.type === "submit" ? ["type", "text"] : ["type"]).includes(k)) || (body.type === "submit" && (typeof body.text !== "string" || !body.text.trim() || body.text.length > UI_LIMITS.responseChars))) throw new Error("Invalid response");
      } catch { return error(400, "Invalid bounded raw learner response"); }
      const type = body.type as "submit" | "cancel", text = body.text as string | undefined;
      const callback = type === "submit" ? entry.callbacks.onSubmit : entry.callbacks.onCancel;
      if (!callback) return error(403, "Preview only or control unavailable");
      if (entry.pending) return error(409, "UI control already in progress");
      if (entry.completed) return entry.completed.type === type && entry.completed.text === text ? response(entry.completed.body) : error(409, "UI already completed");
      entry.pending = true;
      try {
        const receipt = type === "submit" ? await entry.callbacks.onSubmit!(text!) : await entry.callbacks.onCancel!();
        const result = JSON.stringify({ ok: true, receipt: receipt ?? null });
        if (Buffer.byteLength(result) > 16000) throw new Error("Receipt too large");
        entry.completed = { type, text, body: result };
        return response(result);
      } finally { entry.pending = false; }
    } catch { return error(500, "UI operation failed"); }
  }
}
