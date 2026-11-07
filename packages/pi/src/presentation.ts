import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import { nativeInstructionDiagram } from "../../core/src/diagram.ts";

export interface RenderContext {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface ThemeColors {
  fg(color: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

export class CompactTextComponent {
  constructor(readonly lines: string[]) {}
  render(_width: number): string[] {
    return this.lines;
  }
}

export function formatCompactCall(toolName: string, summary: string, theme?: ThemeColors): CompactTextComponent {
  const prefix = theme ? theme.bold(theme.fg("toolTitle", toolName)) : toolName;
  const desc = theme ? theme.fg("dim", summary) : summary;
  return new CompactTextComponent([`${prefix} · ${desc}`]);
}

function detailsHint(): string {
  const keys = getKeybindings().getKeys("app.tools.expand").join("/");
  return keys ? `(${keys} for details)` : "(Tool details: /hotkeys)";
}

export function formatCompactResult(
  summary: string,
  fullText: string,
  options: RenderContext = {},
  theme?: ThemeColors,
): CompactTextComponent {
  if (options.isPartial) {
    const loading = theme ? theme.fg("warning", "Working...") : "Working...";
    return new CompactTextComponent([loading]);
  }
  if (!options.expanded) {
    const label = theme ? theme.fg("success", "✓ ") + theme.fg("accent", summary) : `✓ ${summary}`;
    const hint = theme ? theme.dim(` ${detailsHint()}`) : ` ${detailsHint()}`;
    return new CompactTextComponent([`${label}${hint}`]);
  }
  // Expanded view: full readable lines
  const lines = fullText.split("\n");
  const header = theme ? theme.bold(theme.fg("success", `✓ ${summary}`)) : `✓ ${summary}`;
  return new CompactTextComponent([header, ...lines.map(l => (theme ? theme.dim(l) : l))]);
}

// Renderers for Sage tools
export const presentationRenderers = {
  learning_context: {
    call: (args: Record<string, unknown>, theme?: ThemeColors) =>
      formatCompactCall("learning_context", args.component_revision_ids ? `components: ${(args.component_revision_ids as string[]).join(", ")}` : "current lesson facts", theme),
    result: (result: { content: Array<{ text: string }> }, options: RenderContext, theme?: ThemeColors) => {
      const text = result.content[0]?.text ?? "";
      const parsed = parseSummary(text);
      const summary = parsed.objective ? `Context: ${terminalSafe(parsed.objective).slice(0, 40)}` : "Educational context loaded";
      return formatCompactResult(summary, text, options, theme);
    },
  },
  learning_define: {
    call: (args: Record<string, unknown>, theme?: ThemeColors) =>
      formatCompactCall("learning_define", `propose ${String(args.kind ?? "object")}`, theme),
    result: (result: { content: Array<{ text: string }> }, options: RenderContext, theme?: ThemeColors) => {
      const text = result.content[0]?.text ?? "";
      const parsed = parseSummary(text);
      const summary = `Defined ${parsed.kind ?? "object"}: ${terminalSafe(parsed.title ?? parsed.revisionId?.slice(0, 8) ?? "ok")}`;
      return formatCompactResult(summary, text, options, theme);
    },
  },
  learning_record: {
    call: (args: Record<string, unknown>, theme?: ThemeColors) =>
      formatCompactCall("learning_record", `record ${String(args.kind ?? "evidence")}`, theme),
    result: (result: { content: Array<{ text: string }> }, options: RenderContext, theme?: ThemeColors) => {
      const text = result.content[0]?.text ?? "";
      const parsed = parseSummary(text);
      const summary = `Recorded ${parsed.kind ?? "event"}${parsed.outcome ? ` (${parsed.outcome})` : ""}`;
      return formatCompactResult(summary, text, options, theme);
    },
  },
  learning_source: {
    call: (args: Record<string, unknown>, theme?: ThemeColors) =>
      formatCompactCall("learning_source", `${String(args.action ?? "query")}`, theme),
    result: (result: { content: Array<{ text: string }> }, options: RenderContext, theme?: ThemeColors) => {
      const text = result.content[0]?.text ?? "";
      return formatCompactResult("Source action completed", text, options, theme);
    },
  },
  render_ui: {
    call: (_args: Record<string, unknown>, theme?: ThemeColors) =>
      formatCompactCall("render_ui", "Activity Studio DSL compiler", theme),
    result: (result: { content: Array<{ text: string }> }, options: RenderContext, theme?: ThemeColors) => {
      const text = result.content[0]?.text ?? "";
      const parsed = parseSummary(text);
      const summary = parsed.url ? `Activity ready at ${terminalSafe(parsed.url)}` : "Activity details available";
      return formatCompactResult(summary, text, options, theme);
    },
  },
};

const terminalSafe = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
interface ToolSummary { kind?: string; title?: string; revisionId?: string; outcome?: string; assessor?: string; earned?: number; maximum?: number; url?: string; objective?: string; cancelled?: boolean; waiting?: boolean; awaitingContinuation?: boolean }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringField = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function parseSummary(text: string): ToolSummary {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return {}; /* Plain instructions have no structured summary; full text remains expandable. */ }
  if (!isRecord(value)) return {};
  const body: Record<string, unknown> = isRecord(value.body) ? value.body : {};
  const payload: Record<string, unknown> = isRecord(value.payload) ? value.payload : {};
  const mark: Record<string, unknown> = isRecord(payload.marking_summary) ? payload.marking_summary : {};
  const goal: Record<string, unknown> = isRecord(value.goal) ? value.goal : {};
  const goalBody: Record<string, unknown> = isRecord(goal.body) ? goal.body : {};
  return { kind: stringField(value.kind), title: stringField(body.title), revisionId: stringField(value.revision_id), outcome: stringField(payload.outcome), assessor: stringField(payload.assessor),
    earned: typeof mark.earned === "number" && Number.isFinite(mark.earned) ? mark.earned : undefined, maximum: typeof mark.maximum === "number" && Number.isFinite(mark.maximum) ? mark.maximum : undefined,
    url: stringField(value.url), objective: stringField(goalBody.objective), cancelled: value.cancelled === true, waiting: value.awaiting_submission === true, awaitingContinuation: value.awaiting_continuation === true };
}
function resultSummary(name: string, data: ToolSummary): string {
  if (data.awaitingContinuation) return "Waiting for explicit continuation.";
  if (data.cancelled) return "Cancelled; no learner evidence recorded";
  if (data.waiting) return "Waiting for learner work";
  if (name === "learning_record") {
    const authority = data.assessor === "pi_rubric_proposal" ? "rubric proposal" : data.assessor === "deterministic" ? "objective answer match" : "recorded assessment";
    if (data.kind === "assessment" && data.earned !== undefined && data.maximum !== undefined) return `${data.earned}/${data.maximum} · ${authority} · ${data.outcome ?? "unknown"}`;
    return `Recorded ${data.kind ?? "event"}`;
  }
  if (name === "learning_define") return `Defined ${data.kind ?? "object"}: ${data.title ?? data.revisionId ?? "saved"}`;
  if (name === "learning_context") return "Current lesson facts loaded";
  if (name === "learning_skill") return "Selected skill guidance loaded";
  if (name === "render_ui") return data.url ? "Activity Studio ready" : "UI guidance loaded";
  if (name === "learning_activity") return "Activity receipt saved; assessment is separate";
  return "Source action completed";
}

interface NativePlot { label: string; points: Array<[number, number]> }
function parseNativePlot(text: string): NativePlot | undefined {
  if (text.length > 32768) return;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  if (!isRecord(value) || value.native_preview !== true || value.available !== true || value.capability !== "graph" || value.author !== "tutor" || value.evidence_kind !== "artifact_only" || value.media_type !== "image/svg+xml" || value.provenance !== "Sage local function plotter v1, not connected Desmos" || typeof value.artifact_revision_id !== "string" || !value.artifact_revision_id || typeof value.output !== "string" || value.output.length > 12000) return;
  // Recognize only Sage's fixed plot template; never render general SVG or evaluate its labels.
  const svg = value.output;
  const start = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 330"><title>Local graph of ';
  const titleEnd = '; sampled on [-10,10], not a symbolic proof</title>';
  if (!svg.startsWith(start)) return;
  const label = svg.slice(start.length, svg.indexOf(titleEnd, start.length));
  if (!/^[\da-z\s.+*\/^()-]{1,500}$/i.test(label)) return;
  const prefix = `${start}${label}${titleEnd}<rect width="480" height="330" fill="white"/><path d="M0 150H480 M240 0V300" stroke="gray"/><g fill="none" stroke="#2563eb" stroke-width="2">`;
  const suffix = `</g><text x="8" y="320" font-size="12">y=${label}; x,y range [-10,10]. Discontinuities may be missed.</text></svg>`;
  if (!svg.startsWith(prefix) || !svg.endsWith(suffix)) return;
  const paths = svg.slice(prefix.length, -suffix.length), points: Array<[number, number]> = [];
  let consumed = 0;
  for (const path of paths.matchAll(/<path d="([^"]+)"\/>/g)) {
    if (path.index !== consumed || !/^M\d{1,3}\.\d,\d{1,3}\.\d (?:L\d{1,3}\.\d,\d{1,3}\.\d ){0,160}$/.test(path[1]!)) return;
    consumed += path[0].length;
    for (const point of path[1]!.matchAll(/[ML](\d{1,3}\.\d),(\d{1,3}\.\d)/g)) {
      const x = Number(point[1]), y = Number(point[2]);
      if (x > 480 || y > 300 || points.length >= 161) return;
      points.push([x, y]);
    }
  }
  if (consumed !== paths.length) return;
  return { label: label.replace(/\s+/g, " ").trim(), points };
}
class NativePlotComponent {
  constructor(readonly plot: NativePlot, readonly details?: string) {}
  invalidate(): void { /* Geometry is recomputed for each terminal width. */ }
  render(width: number): string[] {
    if (width <= 0) return [];
    const output = [`Native plot: y=${this.plot.label}`, "Tutor-created aid, not learner performance.", "x,y range [-10,10]"];
    if (width < 24) output.push("Widen the terminal to view the sampled plot.");
    else {
      let columns = Math.min(61, Math.floor(width) - 4);
      if (columns % 2 === 0) columns--;
      const middle = (columns - 1) / 2;
      const grid: string[][] = Array.from({ length: 17 }, (_, row) => Array.from({ length: columns }, (_, col) => row === 8 ? (col === middle ? "+" : "-") : col === middle ? "|" : " "));
      for (const [x, y] of this.plot.points) grid[Math.round(y / 300 * 16)]![Math.round(x / 480 * (columns - 1))] = "*";
      output.push(...grid.map((row, index) => `${index === 0 ? "+10 " : index === 8 ? "  0 " : index === 16 ? "-10 " : "    "}${row.join("")}`));
      output.push(`    -10${" ".repeat(middle - 3)}0${" ".repeat(columns - middle - 4)}+10`);
      if (!this.plot.points.length) output.push("No sampled points lie in this window.");
    }
    output.push("Approximate samples; discontinuities may be missed. Not a symbolic proof.");
    if (this.details !== undefined) output.push(this.details);
    return new Text(output.join("\n"), 0, 0).render(width);
  }
}

/** Public Pi render hooks only. Execution, tool identity, model content and pairing stay unchanged. */
export function nativeToolPresentation(name: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme) {
      const input: unknown = args;
      const label = isRecord(input) ? stringField(input.kind) ?? stringField(input.action) ?? "learning operation" : "learning operation";
      return new Text(`${theme.fg("toolTitle", name)} · ${theme.fg("dim", terminalSafe(String(label)).slice(0, 120))}`, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      if (name === "learning_source" && !context.isError && !options.isPartial && isRecord(result.details) && result.details.sage_instruction_diagram) {
        try { return new Text(`${nativeInstructionDiagram(result.details.sage_instruction_diagram)}${options.expanded ? `\n${terminalSafe(text)}` : ""}`, 0, 0); }
        catch { /* Invalid custom details retain the ordinary readable result. */ }
      }
      const plot = name === "learning_source" && !context.isError && !options.isPartial ? parseNativePlot(text) : undefined;
      if (plot) return new NativePlotComponent(plot, options.expanded ? terminalSafe(text) : undefined);
      const data = parseSummary(text);
      const cause = context.isError ? terminalSafe(text).split("\n").find(line => line.trim())?.slice(0, 140) : undefined;
      const summary = context.isError ? `${name} failed${cause ? `: ${cause}` : ""}` : options.isPartial ? "Working…" : resultSummary(name, data);
      const color = context.isError ? "error" : options.isPartial ? "warning" : "dim";
      const header = theme.fg(color, terminalSafe(summary).slice(0, 180));
      return new Text(options.expanded ? `${header}\n${terminalSafe(text)}` : `${header} ${theme.fg("dim", detailsHint())}`, 0, 0);
    },
  };
}

