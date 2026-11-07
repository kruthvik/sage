import { A2uiSurface, basicCatalog } from "@a2ui/lit/v0_9";
import { MessageProcessor } from "@a2ui/web_core/v0_9";

const MAX_TEXT = 8000;
const forbiddenNames = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype", "get", "set"]);
const safeName = name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !forbiddenNames.has(name);
function safeState(state) {
  return state && typeof state === "object" && !Array.isArray(state) && Object.keys(state).length <= 128 && Object.entries(state).every(([key, value]) => safeName(key) && (typeof value === "string" && value.length <= MAX_TEXT || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || value === null)) && JSON.stringify(state).length <= MAX_TEXT;
}

function inner() {
  const { ui } = globalThis.__sageInit;
  delete globalThis.__sageInit;
  // Custom exports are deliberately not imported on load or on a generated action.
  let actions = null, running = false;
  const processor = new MessageProcessor([basicCatalog]);
  processor.processMessages(ui.messages);
  const model = processor.getSurface("main");
  if (!customElements.get("a2ui-surface")) customElements.define("a2ui-surface", A2uiSurface);
  const surface = document.createElement("a2ui-surface");
  surface.surface = model;
  document.body.append(surface);
  // The official basic TextField currently renders a visible but unassociated label.
  // Keep the renderer; add accessible names after its nested Lit elements settle.
  const labelControls = async root => {
    if (!root?.children) return;
    for (const node of root.children) {
      if (node.updateComplete) await node.updateComplete;
      if (node.matches?.("input,textarea") && !node.hasAttribute("aria-label")) {
        const label = node.parentElement?.querySelector("label");
        if (label) node.setAttribute("aria-label", label.textContent.trim());
      }
      await labelControls(node);
      if (node.shadowRoot) await labelControls(node.shadowRoot);
    }
  };
  Promise.resolve(surface.updateComplete).then(() => labelControls(surface.renderRoot ?? surface.shadowRoot ?? surface)).catch(() => {});
  const send = message => parent.postMessage(message, "*");
  const report = () => {
    const state = model.dataModel.get("/");
    if (safeState(state)) send({ type: "state", state });
  };
  model.dataModel.subscribe("/", report);
  report();
  const get = name => { if (!safeName(name)) throw new Error("Invalid state name"); return model.dataModel.get(`/${name}`); };
  const set = (name, value) => {
    if (!safeName(name) || !safeState({ ...model.dataModel.get("/"), [name]: value })) throw new Error("State exceeds UI limits");
    model.dataModel.set(`/${name}`, value);
  };
  const state = new Proxy(Object.create(null), {
    get: (_, key) => key === "get" ? get : key === "set" ? set : typeof key === "string" ? get(key) : undefined,
    set: (_, key, value) => { set(key, value); return true; },
  });
  model.onAction.subscribe(async action => {
    if (!actions) { send({ type: "status", text: "Custom code is off. You can still enter and send your response." }); return; }
    try {
      if (!safeName(action.name) || typeof actions[action.name] !== "function") throw new Error("Missing exported action");
      await actions[action.name](action.context ?? {}, state);
      report();
    } catch { send({ type: "status", text: "Custom action failed. Your raw response remains available." }); }
  });
  addEventListener("message", async event => {
    if (event.source !== parent || !event.data || Object.keys(event.data).length !== 1 || event.data.type !== "run-code" || running || !ui.script) return;
    running = true;
    const url = URL.createObjectURL(new Blob([ui.script], { type: "text/javascript" }));
    try { actions = await import(/* @vite-ignore */ url); send({ type: "status", text: "Custom code enabled. Browser feedback is not an authoritative grade." }); }
    catch { send({ type: "status", text: "Custom module could not load." }); }
    finally { URL.revokeObjectURL(url); }
  });
}

async function host() {
  const id = location.pathname.split("/").at(-1);
  if (!/^[a-f0-9]{48}$/.test(id)) throw new Error("Invalid UI capability");
  const api = `/api/ui/${id}`;
  const [payload, bundle, css] = await Promise.all([
    fetch(api).then(async r => { if (!r.ok) throw new Error("UI unavailable or expired"); return r.json(); }),
    fetch("/ui-assets/client.js").then(r => r.text()),
    fetch("/ui-assets/design.css").then(r => r.text()),
  ]);
  const inputNames = payload.ui.messages[1].updateComponents.components.filter(component => component.component === "TextField").map(component => component.value.path.slice(1));
  const element = id => document.getElementById(id);
  if (payload.activity) {
    const task = element("task");
    task.hidden = false;
    const title = document.createElement("h2"), prompt = document.createElement("p"), criteria = document.createElement("ul");
    title.textContent = "Recorded task · reviewed against these criteria";
    prompt.textContent = payload.activity.prompt;
    for (const criterion of payload.activity.criteria) { const item = document.createElement("li"); item.textContent = criterion; criteria.append(item); }
    task.append(title, prompt, criteria);
  }
  const status = element("status"), response = element("response"), preview = element("preview"), submit = element("submit"), cancel = element("cancel"), run = element("run-code");
  document.title = `Sage — ${payload.ui.title}`;
  const frame = document.createElement("iframe");
  frame.title = payload.ui.title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  const nonce = element("ui-nonce").content;
  if (!/^[a-f0-9]{36}$/.test(nonce)) throw new Error("Missing UI bootstrap nonce");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' blob:; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  // The bootstrap only imports the trusted local renderer bundle, passed by the outer shell.
  frame.srcdoc = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script nonce="${nonce}">addEventListener('message',function init(event){if(event.source!==parent||!event.data||event.data.type!=='init')return;removeEventListener('message',init);const d=event.data;const style=document.createElement('style');style.textContent=d.css;document.head.append(style);globalThis.__sageInit={ui:d.ui};const url=URL.createObjectURL(new Blob([d.bundle],{type:'text/javascript'}));import(url).catch(()=>parent.postMessage({type:'status',text:'Renderer failed to load.'},'*')).finally(()=>URL.revokeObjectURL(url));});parent.postMessage({type:'ready'},'*');</script></body></html>`;
  let initialized = false, dirty = false, completed = false, pending = false;
  response.addEventListener("input", () => { dirty = true; preview.textContent = response.value.slice(0, MAX_TEXT); });
  addEventListener("message", event => {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data;
    if (data.type === "ready" && Object.keys(data).length === 1 && !initialized) {
      initialized = true;
      frame.contentWindow.postMessage({ type: "init", ui: payload.ui, bundle, css }, "*");
    } else if (initialized && data.type === "state" && Object.keys(data).length === 2 && safeState(data.state)) {
      if (!dirty && !completed) {
        const fields = Object.fromEntries(inputNames.filter(name => Object.hasOwn(data.state, name)).map(name => [name, data.state[name]]));
        const values = Object.values(fields), pretty = JSON.stringify(fields, null, 2);
        response.value = values.length === 1 ? String(values[0] ?? "") : values.length ? (pretty.length <= MAX_TEXT ? pretty : JSON.stringify(fields)) : "";
      }
      preview.textContent = response.value.slice(0, MAX_TEXT);
    } else if (initialized && data.type === "status" && Object.keys(data).length === 2 && typeof data.text === "string" && data.text.length <= 300) {
      // Fixed text only: never HTML, DOM commands, or callback/control requests from the iframe.
      status.textContent = data.text;
    }
  });
  element("activity").append(frame);
  element("custom").hidden = !payload.ui.script;
  run.addEventListener("click", event => {
    if (!event.isTrusted || !initialized || run.disabled) return;
    run.disabled = true;
    element("warning").textContent = "Custom code permission granted. It may navigate its own iframe and transmit entered UI data or consume CPU. This is not a strict security sandbox.";
    // No remount: entered official processor state is deliberately retained.
    frame.contentWindow.postMessage({ type: "run-code" }, "*");
  });
  submit.disabled = !payload.canSubmit;
  cancel.disabled = !payload.canCancel;
  const control = async (event, type) => {
    if (!event.isTrusted || pending || completed || (type === "submit" ? !payload.canSubmit : !payload.canCancel)) return;
    const text = response.value;
    if (type === "submit" && (!text.trim() || text.length > MAX_TEXT)) { status.textContent = "Enter a response of at most 8000 characters."; return; }
    pending = true; submit.disabled = true; cancel.disabled = true;
    try {
      const result = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(type === "submit" ? { type, text } : { type }) });
      if (!result.ok) throw new Error("Response unavailable; retry or return to Sage.");
      const receipt = await result.json();
      completed = true;
      status.textContent = `Sage receipt: ${JSON.stringify(receipt).slice(0, 16000)}`;
      run.disabled = true;
    } catch { status.textContent = "Response unavailable; retry or return to Sage."; }
    finally { pending = false; submit.disabled = completed || !payload.canSubmit; cancel.disabled = completed || !payload.canCancel; }
  };
  submit.addEventListener("click", event => control(event, "submit"));
  cancel.addEventListener("click", event => control(event, "cancel"));
}
if (window.parent !== window) inner();
else host().catch(() => { document.getElementById("status").textContent = "UI unavailable or expired."; });
