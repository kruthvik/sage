export type Permission = "local_compute" | "network" | "execute_code" | "write_notes" | "microphone";
export interface Capability {
  name: string; actions: Array<{ name: string; input_type: string; output_type: string }>;
  permissions: Permission[]; status: "available" | "unavailable"; reliability: string;
  artifacts: string[]; provenance: string; evidence: "artifact_only" | "inferred";
  fallback: string;
}
export interface CapabilityResult { available: boolean; capability: string; output?: string; media_type?: string; provenance: string; evidence_kind: "artifact_only"; fallback?: string }
export interface CapabilityAdapter { capability: Capability; execute(action: string, input: string): CapabilityResult | Promise<CapabilityResult> }
/** Trusted host extensions may register adapters. Permissions never come from model/source text. */
export class CapabilityRegistry {
  private readonly adapters = new Map<string, CapabilityAdapter>();
  constructor(readonly permissions: ReadonlySet<Permission> = new Set(["local_compute"])) {}
  register(adapter: CapabilityAdapter): void {
    if (this.adapters.has(adapter.capability.name)) throw new Error("Capability is already registered");
    this.adapters.set(adapter.capability.name, adapter);
  }
  list(): Capability[] { return [...this.adapters.values()].map(a => ({ ...a.capability, status: a.capability.permissions.every(p => this.permissions.has(p)) ? a.capability.status : "unavailable" })); }
  async execute(name: string, action: string, input: string): Promise<CapabilityResult> {
    const adapter = this.adapters.get(name);
    if (!adapter || !adapter.capability.actions.some(a => a.name === action)) throw new Error("Unknown capability/action");
    if (input.length > 12000) throw new Error("Capability input exceeds its bound");
    const spec = adapter.capability;
    if (spec.status !== "available" || !spec.permissions.every(p => this.permissions.has(p))) return { available: false, capability: name, provenance: spec.provenance, evidence_kind: "artifact_only", fallback: spec.fallback };
    try { return await adapter.execute(action, input); }
    catch { return { available: false, capability: name, provenance: spec.provenance, evidence_kind: "artifact_only", fallback: `Input could not be verified. ${spec.fallback}` }; }
  }
}

// Bounded arithmetic/function grammar: no eval, JavaScript, assignments, file or network access.
export function calculate(expression: string, x?: number): number {
  if (expression.length > 500) throw new Error("Expression too long");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z]+|[()+\-*/^]/g) ?? [];
  if (tokens.length > 180 || tokens.join("") !== expression.replace(/\s/g, "")) throw new Error("Unsupported expression");
  let position = 0, depth = 0;
  const take = () => tokens[position++];
  const functions: Record<string, (n: number) => number> = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, log: Math.log, exp: Math.exp, abs: Math.abs };
  const expressionValue = (): number => {
    let value = term();
    while (tokens[position] === "+" || tokens[position] === "-") { const op = take(); const right = term(); value = op === "+" ? value + right : value - right; }
    return value;
  };
  const term = (): number => {
    let value = unary();
    while (tokens[position] === "*" || tokens[position] === "/") { const op = take(); const right = unary(); value = op === "*" ? value * right : value / right; }
    return value;
  };
  const unary = (): number => tokens[position] === "+" ? (take(), unary()) : tokens[position] === "-" ? (take(), -unary()) : power();
  const power = (): number => { let value = atom(); if (tokens[position] === "^") { take(); value = value ** unary(); } return value; };
  const atom = (): number => {
    if (++depth > 32) throw new Error("Expression nesting too deep");
    const token = take(); let value: number;
    if (token === "(") { value = expressionValue(); if (take() !== ")") throw new Error("Missing closing parenthesis"); }
    else if (token === "x" && x !== undefined) value = x;
    else if (token === "pi") value = Math.PI;
    else if (token === "e") value = Math.E;
    else if (token && functions[token]) { if (take() !== "(") throw new Error("Function requires parentheses"); value = functions[token]!(expressionValue()); if (take() !== ")") throw new Error("Missing closing parenthesis"); }
    else if (token && /^(?:\d|\.)/.test(token)) value = Number(token);
    else throw new Error("Expected a number or supported function");
    depth--; return value;
  };
  const value = expressionValue();
  if (position !== tokens.length || !Number.isFinite(value)) throw new Error("Expression has no finite value");
  return value;
}

export function graphSvg(expression: string): string {
  // Check syntax even if all plotted points are undefined.
  let valid = false;
  const paths: string[] = []; let path = "";
  for (let sample = 0; sample <= 160; sample++) {
    const x = -10 + sample / 8;
    try {
      const y = calculate(expression, x); valid = true;
      if (y < -10 || y > 10) { if (path) paths.push(path); path = ""; continue; }
      path += `${path ? "L" : "M"}${(sample * 3).toFixed(1)},${(150 - y * 15).toFixed(1)} `;
    } catch { if (path) paths.push(path); path = ""; }
  }
  if (!valid) throw new Error("No finite plotted values");
  if (path) paths.push(path);
  const label = expression.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 330"><title>Local graph of ${label}; sampled on [-10,10], not a symbolic proof</title><rect width="480" height="330" fill="white"/><path d="M0 150H480 M240 0V300" stroke="gray"/><g fill="none" stroke="#2563eb" stroke-width="2">${paths.map(p => `<path d="${p}"/>`).join("")}</g><text x="8" y="320" font-size="12">y=${label}; x,y range [-10,10]. Discontinuities may be missed.</text></svg>`;
}

export function validateDrawing(input: string): string {
  const drawing = JSON.parse(input) as { type?: string; elements?: unknown[] };
  if (drawing.type !== "excalidraw" || !Array.isArray(drawing.elements) || drawing.elements.length > 80) throw new Error("Expected a bounded Excalidraw document");
  const elements = drawing.elements.map((raw, index) => {
    const element = raw as Record<string, unknown>;
    if (!element || !["rectangle", "ellipse", "diamond", "line", "arrow", "text"].includes(String(element.type))) throw new Error("Unsupported drawing element");
    for (const key of ["x", "y", "width", "height"]) if (typeof element[key] !== "number" || !Number.isFinite(element[key]) || Math.abs(element[key] as number) > 100000) throw new Error("Invalid drawing geometry");
    const points = element.points;
    if (points !== undefined && (!Array.isArray(points) || points.length > 100 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000)))) throw new Error("Invalid drawing points");
    return { id: `shape-${index}`, type: element.type, x: element.x, y: element.y, width: element.width, height: element.height, angle: 0,
      strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: index + 1, version: 1, versionNonce: index + 1, isDeleted: false, boundElements: null, created: typeof element.created === "number" && Number.isFinite(element.created) && element.created >= 0 ? element.created : null, updated: 0, link: null, locked: false,
      ...(element.type === "text" ? { text: String(element.text ?? "").slice(0, 500), originalText: String(element.text ?? "").slice(0, 500), fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 } : {}),
      ...(["line", "arrow"].includes(String(element.type)) ? { points: points ?? [[0, 0], [element.width, element.height]], startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: element.type === "arrow" ? "arrow" : null } : {}) };
  });
  const output = JSON.stringify({ type: "excalidraw", version: 2, source: "Sato local artifact adapter", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
  if (output.length > 24000) throw new Error("Drawing output exceeds artifact bound");
  return output;
}

const specs: Capability[] = [
  { name: "calculator", actions: [{ name: "calculate", input_type: "bounded arithmetic expression", output_type: "finite number" }], permissions: ["local_compute"], status: "available", reliability: "IEEE-754 arithmetic; not symbolic algebra or unit verification", artifacts: ["text result"], provenance: "Sato bounded grammar v1", evidence: "artifact_only", fallback: "Use text reasoning; do not claim verification." },
  { name: "graph", actions: [{ name: "graph", input_type: "single explicit y=f(x) expression", output_type: "sampled SVG" }], permissions: ["local_compute"], status: "available", reliability: "fixed range/sample; discontinuities and relations may be missed", artifacts: ["SVG"], provenance: "Sato local function plotter v1, not connected Desmos", evidence: "artifact_only", fallback: "Describe the graph in text or ask the learner to construct it." },
  { name: "drawing", actions: [{ name: "drawing", input_type: "bounded Excalidraw JSON", output_type: "normalized Excalidraw v2 JSON" }], permissions: ["local_compute"], status: "available", reliability: "geometry validation only; not visual or semantic interpretation", artifacts: ["Excalidraw JSON"], provenance: "Sato local drawing adapter v1, not a live whiteboard", evidence: "artifact_only", fallback: "Use a text diagram; no observed spatial evidence." },
  { name: "sources", actions: [{ name: "search", input_type: "lexical query", output_type: "accepted selected spans" }], permissions: [], status: "available", reliability: "UTF-8 text; extraction reviewed separately from factual validity", artifacts: ["source spans"], provenance: "Sato source receipts", evidence: "inferred", fallback: "Ask for an accepted source." },
  ...([
    ["code_execution", "execute_code", "Use learner-provided output or a trusted Pi extension with a real sandbox; do not pretend code ran."],
    ["symbolic_math", "local_compute", "Only bounded arithmetic and linear-key verification are installed; no symbolic proof."],
    ["voice", "microphone", "Use text; transcript alone cannot establish pronunciation or delivery quality."],
    ["web", "network", "Import and accept source text locally, or install a trusted source-provenance extension."],
    ["obsidian", "write_notes", "Import individual Markdown notes through source controls; vault synchronization/write-back is not installed."],
  ] as const).map(([name, permission, fallback]) => ({ name, actions: [{ name: "use", input_type: "adapter-specific", output_type: "adapter-specific" }], permissions: [permission], status: "unavailable" as const, reliability: "No verified adapter installed", artifacts: [], provenance: "capability interface only", evidence: "artifact_only" as const, fallback })),
];
export function capabilitySummaries(): Array<{ name: string; status: string; limit: string }> { return specs.map(s => ({ name: s.name, status: s.status, limit: s.reliability })); }
export function createCapabilityRegistry(permissions?: ReadonlySet<Permission>): CapabilityRegistry {
  const registry = new CapabilityRegistry(permissions);
  for (const spec of specs) registry.register({ capability: spec, execute: (_action, input) => {
    const output = spec.name === "calculator" ? String(calculate(input)) : spec.name === "graph" ? graphSvg(input) : spec.name === "drawing" ? validateDrawing(input) : undefined;
    if (output === undefined) throw new Error("Use the source service for accepted source retrieval");
    return { available: true, capability: spec.name, output, media_type: spec.name === "graph" ? "image/svg+xml" : spec.name === "drawing" ? "application/vnd.excalidraw+json" : "text/plain", provenance: spec.provenance, evidence_kind: "artifact_only" };
  } });
  return registry;
}
