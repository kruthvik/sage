/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose around it). Throws if none parses. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  for (const cand of [fenced, text]) {
    if (!cand) continue;
    const start = cand.indexOf("{"), end = cand.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(cand.slice(start, end + 1)); } catch { /* try next */ }
  }
  throw new Error("model reply contained no parseable JSON object");
}
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
