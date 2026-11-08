/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose around it). Throws if none parses. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  for (const cand of [fenced, text]) {
    if (!cand) continue;
    const start = cand.indexOf("{"), end = cand.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    const body = cand.slice(start, end + 1);
    try { return JSON.parse(body); } catch { /* repair below */ }
    // Flash writes LaTeX (`\(`, `\sqrt`) inside strings; double any backslash that doesn't start a valid JSON escape.
    try { return JSON.parse(body.replace(/\\(["\\/bfnrtu])|\\/g, (m, ok) => ok ? m : "\\\\")); } catch { /* try next */ }
  }
  throw new Error("model reply contained no parseable JSON object");
}
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
