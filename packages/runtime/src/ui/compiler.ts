import type { CreateSurfaceMessage, UpdateComponentsMessage, UpdateDataModelMessage } from "@a2ui/web_core/v0_9";

export const UI_LIMITS = { sourceBytes: 32 * 1024, components: 128, depth: 12, responseChars: 8000 } as const;
export type UiComponent = { id: string; component: string; children?: string[]; child?: string; [key: string]: unknown };
export interface CompiledUI {
  title: string;
  messages: [CreateSurfaceMessage, UpdateComponentsMessage & { updateComponents: { surfaceId: string; components: UiComponent[] } }, UpdateDataModelMessage];
  state: Record<string, string>;
  script: string;
}
const catalogComponents: Record<string, string> = { page: "Column", col: "Column", row: "Row", card: "Card", h1: "Text", h2: "Text", h3: "Text", text: "Text", math: "Text", input: "TextField", button: "Button" };
const forbidden = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype", "get", "set"]);
export function validUiName(name: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !forbidden.has(name); }

/** Two-space indentation; direct expansion into the official v0.9.1 basic catalog. JS is parsed, never evaluated. */
export function compileUI(source: string): CompiledUI {
  if (typeof source !== "string" || Buffer.byteLength(source) > UI_LIMITS.sourceBytes || !source.trim()) throw new Error("UI source must be nonempty and at most 32KB");
  const sections = source.replace(/\r\n/g, "\n").split(/^---js\s*$/m);
  if (sections.length > 2) throw new Error("Repeated ---js delimiter");
  const script = sections[1]?.trim() ?? "";
  if (sections.length === 2 && !script) throw new Error("Empty JS module");
  if (script) {
    const parserOptions = { loader: "js" as const };
    // Bun 1.4.2 supports macro:false; its pinned type definitions omit false.
    // Explicit disable is essential: even scan() otherwise resolves/executes macros.
    Reflect.set(parserOptions, "macro", false);
    new Bun.Transpiler(parserOptions).scan(script);
  }
  const components: UiComponent[] = [];
  const state: Record<string, string> = {};
  const inputs = new Set<string>();
  const stack: UiComponent[] = [];
  let title = "Practice", serial = 0, primary = false;
  const fail = (line: number): never => { throw new Error(`Invalid UI syntax/indentation at line ${line}`); };
  const name = (value: string) => { if (!validUiName(value)) throw new Error(`Invalid UI identifier: ${value}`); return value; };
  const bound = (value: string) => { const key = name(value.slice(1)); state[key] ??= ""; return { path: `/${key}` }; };
  const literal = (value: string): string | number | boolean | null | { path: string } => {
    if (value.startsWith("$")) return bound(value);
    const parsed: unknown = JSON.parse(value);
    if ((typeof parsed === "number" && !Number.isFinite(parsed)) || (parsed !== null && !["string", "number", "boolean"].includes(typeof parsed))) throw new Error("Only scalar action arguments are allowed");
    return parsed as string | number | boolean | null;
  };
  const add = (component: string, props: Record<string, unknown> = {}): UiComponent => {
    if (components.length >= UI_LIMITS.components) throw new Error("UI exceeds 128 components");
    const result = { id: components.length ? `c${++serial}` : "root", component, ...props };
    components.push(result); return result;
  };
  let lines = sections[0]!.split("\n").filter(line => line.trim());
  if (!lines.length) throw new Error("Missing UI components");
  const commonIndent = Math.min(...lines.map(line => line.match(/^ */)![0].length));
  lines = lines.map(line => line.slice(commonIndent));
  // page is title metadata. Accept both a standalone header and the indented form.
  if (!/^page(?: |$)/.test(lines[0]!)) lines = ["page", ...lines.map(line => `  ${line}`)];
  else if (lines[1] && !lines[1].startsWith(" ")) lines = [lines[0]!, ...lines.slice(1).map(line => `  ${line}`)];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (line.includes("\t")) fail(index + 1);
    const spaces = line.match(/^ */)![0].length;
    const depth = spaces / 2;
    if (!Number.isInteger(depth) || depth > UI_LIMITS.depth || depth > stack.length) fail(index + 1);
    const body = line.slice(spaces);
    const match = /^([a-z][a-z0-9]*)(?: (.*))?$/.exec(body);
    if (!match || !Object.hasOwn(catalogComponents, match[1]!)) fail(index + 1);
    const kind = match![1]!, rest = match![2] ?? "";
    if (components.length === 0 ? kind !== "page" || depth !== 0 : kind === "page" || depth === 0) fail(index + 1);
    const parent = stack[depth - 1];
    if (depth && !parent?.children) fail(index + 1);
    let component: UiComponent;
    if (["Column", "Row", "Card"].includes(catalogComponents[kind]!)) {
      if (kind === "page" && rest) { const parsed = literal(rest); if (typeof parsed !== "string") fail(index + 1); title = parsed as string; }
      else if (rest) fail(index + 1);
      component = add(catalogComponents[kind]!, { children: [], ...(kind === "card" ? {} : { align: "stretch", justify: "start" }) });
    } else if (kind === "input") {
      const input = /^(\S+)(?: ("(?:[^"\\]|\\.)*"))?$/.exec(rest);
      if (!input) fail(index + 1);
      const key = name(input![1]!);
      if (inputs.has(key)) throw new Error(`Repeated input: ${key}`);
      inputs.add(key); state[key] ??= "";
      component = add(catalogComponents[kind]!, { label: input![2] ? JSON.parse(input![2]) : key, value: { path: `/${key}` }, variant: "longText" });
    } else if (kind === "button") {
      const button = /^("(?:[^"\\]|\\.)*") -> ([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(rest);
      if (!button) fail(index + 1);
      const context: Record<string, unknown> = {};
      const args = button![3]!;
      const tokens = args.match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [];
      if (tokens.join(",") !== args || tokens.length > 16) fail(index + 1);
      tokens.forEach((arg, i) => {
        const value = arg.trim();
        const key = value.replace(/^\$/, "");
        if (validUiName(key) && !["true", "false", "null"].includes(key)) context[name(key)] = bound(`$${key}`);
        else context[`arg${i}`] = literal(value);
      });
      component = add(catalogComponents[kind]!, { child: "", variant: primary ? "borderless" : "primary", action: { event: { name: name(button![2]!), context } } });
      primary = true;
      component.child = add("Text", { text: JSON.parse(button![1]!), variant: "body" }).id;
    } else {
      const text = literal(rest);
      if (typeof text !== "string" && !(text && typeof text === "object" && "path" in text)) fail(index + 1);
      component = add(catalogComponents[kind]!, { text, variant: kind.startsWith("h") ? kind : "body" });
    }
    parent?.children?.push(component.id);
    stack.length = depth; stack.push(component);
  }
  if (!components.length) throw new Error("Missing page");
  for (const component of [...components]) {
    if (!component.children) continue;
    if (!component.children.length) throw new Error("Containers require children");
    if (component.component === "Card") {
      component.child = component.children.length === 1 ? component.children[0]! : add("Column", { children: component.children, align: "stretch", justify: "start" }).id;
      delete component.children;
    }
  }
  const root = components[0]!;
  const onlyChild = root.children?.length === 1 ? components.find(c => c.id === root.children![0]) : undefined;
  if (onlyChild?.component === "Column") {
    root.children = onlyChild.children;
    components.splice(components.indexOf(onlyChild), 1);
  }
  const byId = new Map(components.map(component => [component.id, component]));
  const checkDepth = (id: string, depth: number) => {
    if (depth > UI_LIMITS.depth) throw new Error("Expanded UI exceeds depth 12");
    const component = byId.get(id)!;
    for (const child of component.children ?? (component.child ? [component.child] : [])) checkDepth(child, depth + 1);
  };
  checkDepth("root", 0);
  const surfaceId = "main";
  return { title, state, script, messages: [
    { version: "v0.9.1", createSurface: { surfaceId, catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json" } },
    { version: "v0.9.1", updateComponents: { surfaceId, components } },
    { version: "v0.9.1", updateDataModel: { surfaceId, path: "/", value: state } },
  ] };
}
