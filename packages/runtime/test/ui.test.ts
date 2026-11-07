import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { MessageProcessor, A2uiMessageSchema, ComponentContext, GenericBinder } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/lit/v0_9";
import { compileUI } from "../src/ui/compiler.ts";
import { UiRegistry } from "../src/ui/server.ts";

const source = `page "Practice"
  h1 "Explain"
  card
    col
      input answer "Your answer"
      text $feedback
  row
    button "Check" -> check($answer, "hint", 2)
---js
export function check({ answer, arg1, arg2 }, ui) { ui.feedback = answer + arg1 + arg2; }`;

test("compiler expands hierarchy, bindings, action context and browser-only JS to official v0.9.1", async () => {
  const ui = compileUI(source);
  expect(ui.title).toBe("Practice");
  expect(ui.state).toEqual({ answer: "", feedback: "" });
  expect(ui.script).toContain("export function check");
  const components = ui.messages[1]!.updateComponents!.components;
  expect(components[0]).toMatchObject({ id: "root", component: "Column", children: ["c1", "c2", "c6"] });
  expect(components.find(c => c.component === "Card")).toMatchObject({ child: "c3" });
  expect(components.find(c => c.component === "TextField")).toMatchObject({ value: { path: "/answer" } });
  expect(components.find(c => c.component === "Button")).toMatchObject({ action: { event: { name: "check", context: { answer: { path: "/answer" }, arg1: "hint", arg2: 2 } } } });
  for (const message of ui.messages) expect(A2uiMessageSchema.safeParse(message).success).toBe(true);
  for (const { id: _id, component, ...props } of components) expect(basicCatalog.components.get(component)!.schema.safeParse(props).success).toBe(true);
  const processor = new MessageProcessor([basicCatalog]);
  processor.processMessages(ui.messages);
  const surface = processor.getSurface("main")!;
  expect(surface.componentsModel.get("root")).toBeDefined();
  expect(() => surface.componentsModel.validateTopology({ allowOrphanComponents: false, allowDanglingReferences: false, allowMissingRoot: false })).not.toThrow();
  expect(surface.dataModel.get<string>("/answer")).toBe("");
  surface.dataModel.set("/answer", "work");
  let action: unknown;
  surface.onAction.subscribe(a => { action = a; });
  const button = components.find(c => c.component === "Button")!;
  const binder = new GenericBinder<{ action: () => Promise<void> }>(new ComponentContext(surface, button.id), basicCatalog.components.get("Button")!.schema);
  await binder.snapshot.action();
  binder.dispose();
  expect(action).toMatchObject({ name: "check", context: { answer: "work", arg1: "hint", arg2: 2 } });
  processor.dispose();
});

test("compiler maps text/math/headings and wraps multi-child cards without nested default cards", () => {
  const ui = compileUI('page\n  card\n    h2 "Meaning"\n    math "∫ x dx = x²/2"\n  h3 "Try"\n  text "Hello"');
  const components = ui.messages[1]!.updateComponents!.components;
  expect(components.filter(c => c.component === "Card")).toHaveLength(1);
  expect(components.filter(c => c.component === "Column")).toHaveLength(2);
  const processor = new MessageProcessor([basicCatalog]);
  expect(() => processor.processMessages(ui.messages)).not.toThrow();
  processor.dispose();
});

test("compiler rejects malformed syntax, dangerous names, bad children and bounded payloads", () => {
  for (const key of ["toString", "hasOwnProperty", "valueOf", "__defineGetter__", "get", "set"]) expect(() => compileUI(`page\n  input ${key} "bad"`)).toThrow();
  for (const bad of ["", "page\n  unknown", "page\n   text \"bad\"", "page\n  text \"leaf\"\n    text \"child\"", "page\n  col", "page\npage", "page\n\ttext \"tab\"", "page\n  input __proto__ \"bad\"", "page\n  text $constructor", "page\n  button \"X\" -> prototype()", "page\n  button \"X\" -> go(answer + 1)", "page\n  input x \"X\"\n  input x \"Again\"", "page\n---js\n---js", 'page\n---js\nexport function bad( {', "page\n" + "x".repeat(32768), "page\n" + Array.from({ length: 129 }, () => '  text "x"').join("\n"), "page\n" + Array.from({ length: 13 }, (_, i) => "  ".repeat(i + 1) + "col").join("\n")]) expect(() => compileUI(bad)).toThrow();
});

test("user-facing compact syntax accepts a title header, bare bound arguments and implicit roots", () => {
  const ui = compileUI(`page "Quadratic Practice"

col
  h2 "Solve the equation"
  math "x² - 5x + 6 = 0"
  input answer "Answer"
  button "Check" -> check(answer)
  text $result
---js
export function check({ answer }, ui) { ui.result = answer === "2" ? "Check both roots" : "Try again"; }`);
  expect(ui.title).toBe("Quadratic Practice");
  expect(ui.state).toEqual({ answer: "", result: "" });
  expect(ui.messages[1].updateComponents.components.find(c => c.component === "Button")).toMatchObject({ action: { event: { context: { answer: { path: "/answer" } } } } });
  const simple = compileUI('col\n  text "Hello"\n  text "World"');
  expect(simple.messages[1].updateComponents.components[0]).toMatchObject({ id: "root", component: "Column", children: expect.any(Array) });
  const field = compileUI('input answer\ntext $answer');
  expect(field.state).toEqual({ answer: "" });
});

const base = "http://127.0.0.1:43121";
const request = (path: string, method = "GET", body?: unknown, origin = base) => new Request(base + path, { method, headers: { Host: "127.0.0.1:43121", ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("registry compiles before storing; bounds TTL/count, disposal and capability lookup", async () => {
  let now = 1;
  const registry = new UiRegistry({ maxEntries: 2, ttlMs: 10, now: () => now });
  expect(() => registry.create("bad")).toThrow();
  const a = registry.create("page\n  text \"A\"");
  const b = registry.create("page\n  text \"B\"");
  expect(a.id).toMatch(/^[a-f0-9]{48}$/);
  registry.create("page\n  text \"C\"");
  expect((await registry.handle(request(`/api/ui/${a.id}`)))!.status).toBe(404);
  expect((await registry.handle(request(`/api/ui/${b.id}`)))!.status).toBe(200);
  now = 12;
  expect((await registry.handle(request(`/api/ui/${b.id}`)))!.status).toBe(404);
  registry.dispose();
  expect(await registry.handle(request("/health"))).toBeUndefined();
});

test("registry validates local Host/origin, raw submissions, callback receipts, cancellation and preview-only", async () => {
  const received: string[] = []; let cancelled = 0;
  const registry = new UiRegistry();
  const { id } = registry.create("page\n  input answer \"Work\"", { onSubmit: text => { received.push(text); return { response: "saved" }; }, onCancel: () => { cancelled++; } });
  const path = `/api/ui/${id}`;
  expect((await registry.handle(new Request(`http://evil.test${path}`)))!.status).toBe(403);
  expect((await registry.handle(new Request(base + path, { headers: { Host: "evil.test" } })))!.status).toBe(403);
  expect((await registry.handle(request(path, "POST", { type: "submit", text: "work" }, "null")))!.status).toBe(403);
  expect((await registry.handle(request(path, "POST", { type: "submit", text: "work" }, "http://evil.test")))!.status).toBe(403);
  for (const body of [{ type: "submit", text: "" }, { type: "submit", text: 1 }, { type: "submit", text: "x".repeat(8001) }, { type: "submit", text: "work", grade: 100 }, { type: "record", text: "work" }]) expect((await registry.handle(request(path, "POST", body)))!.status).toBe(400);
  const receipt = await registry.handle(request(path, "POST", { type: "submit", text: "raw work" }));
  expect(await receipt!.json()).toEqual({ ok: true, receipt: { response: "saved" } });
  expect(received).toEqual(["raw work"]);
  expect((await registry.handle(request(path, "POST", { type: "submit", text: "raw work" })))!.status).toBe(200);
  expect(received).toEqual(["raw work"]);
  expect((await registry.handle(request(path, "POST", { type: "cancel" })))!.status).toBe(409);
  const cancelUI = registry.create("page\n  text \"Cancel\"", { onCancel: () => { cancelled++; } });
  expect((await registry.handle(request(`/api/ui/${cancelUI.id}`, "POST", { type: "cancel" })))!.status).toBe(200);
  expect(cancelled).toBe(1);
  const preview = registry.create("page\n  text \"Preview\"");
  expect((await registry.handle(request(`/api/ui/${preview.id}`, "POST", { type: "submit", text: "work" })))!.status).toBe(403);
  expect((await registry.handle(new Request(base + path, { headers: { "Sec-Fetch-Site": "cross-site" } })))!.status).toBe(403);
  registry.dispose();
});

test("registry serves one CSP-protected shell and lazy local official browser bundle; no inline activity JS", async () => {
  const registry = new UiRegistry();
  const { id } = registry.create(source);
  const response = (await registry.handle(request(`/ui/${id}`)))!;
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-src 'self'");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const html = await response.text();
  expect(html).toContain("Send response to Sage");
  expect(html).toContain("Run custom code");
  expect(html).toContain("Custom code is off");
  expect(html).toContain("not a strict security sandbox");
  expect(html).not.toContain("export function check");
  const nonce = /id="ui-nonce" content="([a-f0-9]{36})"/.exec(html)?.[1];
  expect(nonce).toBeDefined();
  // srcdoc inherits the shell CSP; both policies must permit the trusted bootstrap/Blob and Lit styles.
  expect(response.headers.get("Content-Security-Policy")).toContain(`'nonce-${nonce}' blob:`);
  expect(response.headers.get("Content-Security-Policy")).toContain("style-src 'self' 'unsafe-inline'");
  const payload = await (await registry.handle(request(`/api/ui/${id}`)))!.json();
  expect(payload).toMatchObject({ ui: { title: "Practice" }, canSubmit: false, canCancel: false });
  const bundle = (await registry.handle(request("/ui-assets/client.js")))!;
  expect(bundle.status).toBe(200);
  const js = await bundle.text();
  expect(js).toContain("MessageProcessor");
  expect(js).toContain("allow-scripts");
  expect(js).not.toContain("allow-same-origin");
  expect(js).toContain("connect-src 'none'");
  expect(js).toContain("event.source");
  expect((await registry.handle(request("/ui-assets/design.css")))!.status).toBe(200);
  expect((await registry.handle(request(`/api/ui/${id}`, "DELETE")))!.status).toBe(405);
  registry.dispose();
});

// Execute only our trusted client in a tiny DOM/message harness, not generated source.
// This checks control flow; it is explicitly not visual or real-browser sandbox QA.
type ClientEvent = { source?: object; data?: Record<string, unknown>; isTrusted?: boolean };
type Listener = (event: ClientEvent) => void | Promise<void>;
function domHarness() {
  const posted: Record<string, unknown>[] = [];
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    return { content: "a".repeat(36), value: "", textContent: "", hidden: false, disabled: false, title: "", srcdoc: "", referrerPolicy: "", events: new Map<string, Listener>(),
      contentWindow: { postMessage: (message: Record<string, unknown>) => { posted.push(message); } },
      append: (..._children: object[]) => {}, setAttribute: (_name: string, _value: string) => {},
      addEventListener(type: string, listener: Listener) { this.events.set(type, listener); } };
  }
  const frame = element();
  return { frame, posted, document: { title: "", body: { append: () => {} }, createElement: () => frame,
    getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)!; } } };
}
async function trustedClient() {
  return (await Bun.file(new URL("../src/ui/client.js", import.meta.url)).text()).replace(/^import .*;\n/gm, "").replace('if (window.parent !== window) inner();\nelse host().catch(() => { document.getElementById("status").textContent = "UI unavailable or expired."; });', "").replace("await import(/* @vite-ignore */ url)", "await importModule(url)");
}

test("inner renders/state works with JS off; only a parent-shaped opt-in imports once and retains input state", async () => {
  const dom = domHarness(), parent = {}, posted: Record<string, unknown>[] = [];
  let listener: Listener = () => {}, imports = 0, processor: MessageProcessor;
  const ui = compileUI(source);
  const context = { __sageInit: { ui }, document: dom.document, parent,
    customElements: { get: () => true }, A2uiSurface: {}, basicCatalog,
    MessageProcessor: class extends MessageProcessor { constructor(catalogs: ConstructorParameters<typeof MessageProcessor>[0]) { super(catalogs); processor = this; } },
    addEventListener: (_type: string, fn: Listener) => { listener = fn; },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} }, Blob,
    importModule: async () => { imports++; return { check: ({ answer }: { answer: string }, state: { get: (name: string) => string; set: (name: string, value: string) => void; feedback: string }) => { state.feedback = answer; state.set("feedback", state.get("feedback") + " checked"); } }; } };
  Object.assign(parent, { postMessage: (message: Record<string, unknown>) => { posted.push(message); } });
  const client = runInNewContext(await trustedClient() + "\n({ inner })", context) as { inner: () => void };
  client.inner();
  const model = processor!.getSurface("main")!;
  model.dataModel.set("/answer", "retained work");
  const button = ui.messages[1].updateComponents.components.find(c => c.component === "Button")!;
  const binder = new GenericBinder<{ action: () => Promise<void> }>(new ComponentContext(model, button.id), basicCatalog.components.get("Button")!.schema);
  await binder.snapshot.action();
  expect(imports).toBe(0);
  expect(posted.some(message => message.type === "state")).toBe(true);
  await listener({ source: {}, data: { type: "run-code" } });
  await listener({ source: parent, data: { type: "run-code", extra: true } });
  expect(imports).toBe(0);
  await listener({ source: parent, data: { type: "run-code" } });
  await listener({ source: parent, data: { type: "run-code" } });
  expect(imports).toBe(1);
  expect(model.dataModel.get<string>("/answer")).toBe("retained work");
  await binder.snapshot.action();
  expect(model.dataModel.get<string>("/feedback")).toBe("retained work checked");
  binder.dispose(); processor!.dispose();
});

test("outer shell requires trusted clicks for opt-in/submission and ignores foreign/oversized/control messages", async () => {
  const dom = domHarness(); let listener: Listener = () => {};
  const requests: { url: string; method: string }[] = [];
  const ui = compileUI(source);
  const client = runInNewContext(await trustedClient() + "\n({ host })", {
    document: dom.document, location: { pathname: "/ui/" + "a".repeat(48) }, crypto: globalThis.crypto,
    addEventListener: (_type: string, fn: Listener) => { listener = fn; },
    fetch: async (url: string, options?: { method: string }) => { requests.push({ url, method: options?.method ?? "GET" }); return options ? Response.json({ ok: true, receipt: "saved" }) : url.startsWith("/api/") ? Response.json({ ui, canSubmit: true, canCancel: true }) : new Response("trusted asset"); },
  }) as { host: () => Promise<void> };
  await client.host();
  const get = dom.document.getElementById;
  expect(dom.posted).toEqual([]);
  await listener({ source: {}, data: { type: "ready" } });
  expect(dom.posted).toEqual([]);
  await listener({ source: dom.frame.contentWindow, data: { type: "ready" } });
  expect(dom.posted.map(message => message.type)).toEqual(["init"]);
  await get("run-code").events.get("click")!({ isTrusted: false });
  await listener({ source: dom.frame.contentWindow, data: { type: "run-code" } });
  expect(dom.posted.map(message => message.type)).toEqual(["init"]);
  await listener({ source: {}, data: { type: "state", state: { answer: "foreign" } } });
  await listener({ source: dom.frame.contentWindow, data: { type: "state", state: { answer: "x".repeat(8001) } } });
  expect(get("response").value).toBe("");
  await listener({ source: dom.frame.contentWindow, data: { type: "state", state: { answer: "raw work", feedback: "MODEL-GENERATED FEEDBACK" } } });
  expect(get("response").value).toBe("raw work");
  expect(get("response").value).not.toContain("MODEL-GENERATED");
  await get("run-code").events.get("click")!({ isTrusted: true });
  expect(dom.posted.map(message => message.type)).toEqual(["init", "run-code"]);
  expect(get("response").value).toContain("raw work");
  await listener({ source: dom.frame.contentWindow, data: { type: "submit", text: "forged" } });
  await listener({ source: dom.frame.contentWindow, data: { type: "cancel" } });
  await get("submit").events.get("click")!({ isTrusted: false });
  expect(requests.filter(request => request.method === "POST")).toEqual([]);
  await get("submit").events.get("click")!({ isTrusted: true });
  await get("submit").events.get("click")!({ isTrusted: true });
  expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  expect(get("status").textContent).toContain("Sage receipt");
});

test("compiler bounds include generated labels/wrappers/depth and never executes JS on Bun", () => {
  expect(compileUI("page\n" + '  text "x"\n'.repeat(127)).messages[1].updateComponents.components).toHaveLength(128);
  const deep = "page\n" + Array.from({ length: 12 }, (_, i) => "  ".repeat(i + 1) + "col").join("\n") + "\n" + "  ".repeat(13) + 'button "X" -> go()';
  expect(() => compileUI(deep)).toThrow();
  expect(() => compileUI('page\n  card\n' + '    text "x"\n'.repeat(126))).toThrow("128 components");
  expect(() => compileUI('page\n  button "X" -> go(1e999)')).toThrow();
  const ui = compileUI('page\n  text "Browser only"\n---js\nthrow new Error("Must never execute on Bun");');
  expect(ui.script).toContain("Must never execute");
  const registry = new UiRegistry();
  expect(() => registry.create('page\n  text "x"\n---js\nthrow new Error("No server eval");')).not.toThrow();
  registry.dispose();
});

test("generated module inspection never resolves or expands Bun compile-time macros", () => {
  const source = 'text "Browser only"\n---js\nimport { probe } from "sage-macro-package-that-does-not-exist" with { type: "macro" };\nexport const marker = probe();';
  expect(() => compileUI(source)).toThrow("Macros are disabled");
  const ordinary = source.replace(' with { type: "macro" }', "");
  expect(() => compileUI(ordinary)).not.toThrow();
  expect(compileUI(ordinary).script).toContain("sage-macro-package-that-does-not-exist");
  expect(() => compileUI('text "x"\n---js\nexport function check() { const = ; }')).toThrow();
});

test("registry bounds streamed bodies, rejects malformed JSON/missing Origin, and deduplicates pending/completed callbacks", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const registry = new UiRegistry();
  const { id } = registry.create('page\n  text "Raw work"', { onSubmit: async () => { calls++; await wait; return "saved"; } });
  const path = `/api/ui/${id}`;
  for (const body of ["{", "[]", "null"]) expect((await registry.handle(new Request(base + path, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body })))!.status).toBe(400);
  expect((await registry.handle(new Request(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"type":"submit","text":"work"}' })))!.status).toBe(403);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); controller.close(); } });
  expect((await registry.handle(new Request(base + path, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: stream })))!.status).toBe(400);
  const first = registry.handle(request(path, "POST", { type: "submit", text: "∫".repeat(8000) }));
  while (!calls) await Bun.sleep(1);
  expect((await registry.handle(request(path, "POST", { type: "submit", text: "other" })))!.status).toBe(409);
  release();
  expect((await first)!.status).toBe(200);
  expect((await registry.handle(request(path, "POST", { type: "submit", text: "∫".repeat(8000) })))!.status).toBe(200);
  expect(calls).toBe(1);
  registry.remove(id);
  expect((await registry.handle(request(path)))!.status).toBe(404);
  registry.dispose();
});
