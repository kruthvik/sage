// Session folder writer (SPEC §14): SAGE_HOME/sessions/<YYYY-MM-DD>-<topic-slug>/. Never overwrites a file the user edited:
// `.sage-export.json` records the hash of what Sage last wrote; a file whose current hash differs is left alone and reported.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EngineState } from "../../engine/src/state.ts";
import { cheatsheetMd, itemsMd, lessonMd, planMd, sessionCheatsheetMd, sessionMd, slug, type ExportMeta, type LogEntry } from "./render.ts";
import { exportMarkdownPdf } from "./pdf.ts";

export type ExportWhat = "session" | "node" | "final";
export interface ExportResult { dir: string; written: string[]; unchanged: string[]; userEdited: string[]; pdfs: string[]; errors: string[] }
interface Manifest { sessionId: string; files: Record<string, string> }

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

export function sessionDir(home: string, s: EngineState, log: LogEntry[]): string {
  const day = (log[0]?.now ?? s.timeline[0]?.at ?? new Date(0).toISOString()).slice(0, 10);
  const base = join(home, "sessions", `${day}-${slug(s.goal.objective)}`);
  const owner = (dir: string) => { try { return (JSON.parse(readFileSync(join(dir, ".sage-export.json"), "utf8")) as Manifest).sessionId; } catch { return undefined; } };
  const o = owner(base);
  return !existsSync(base) || o === s.sessionId ? base : `${base}-${s.sessionId.slice(0, 8)}`; // another session already owns the plain name
}

/** Writes the Markdown set (and PDFs for node/final). Markdown is cheap and regenerated each time; PDFs only at node close and session end. */
export async function writeExports(home: string, s: EngineState, log: LogEntry[], what: ExportWhat, meta: ExportMeta = {}, nodeId?: string): Promise<ExportResult> {
  const dir = sessionDir(home, s, log), mPath = join(dir, ".sage-export.json");
  mkdirSync(dir, { recursive: true });
  let man: Manifest = { sessionId: s.sessionId, files: {} };
  try { man = JSON.parse(readFileSync(mPath, "utf8")); } catch { /* first write */ }
  const res: ExportResult = { dir, written: [], unchanged: [], userEdited: [], pdfs: [], errors: [] };

  /** True when Sage may replace `rel`: missing, or exactly what Sage wrote last time. */
  const ours = (rel: string) => { const p = join(dir, rel); if (!existsSync(p)) return true; const h = sha(readFileSync(p)); return man.files[rel] === h; };
  const put = (rel: string, content: string) => {
    const p = join(dir, rel);
    if (!ours(rel)) { res.userEdited.push(rel); return false; }
    if (existsSync(p) && man.files[rel] === sha(content)) { res.unchanged.push(rel); return false; }
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = `${p}.sage-tmp`; writeFileSync(tmp, content); renameSync(tmp, p);
    man.files[rel] = sha(content); res.written.push(rel); return true;
  };
  const pdf = async (rel: string, content: string, id: string) => {
    const p = join(dir, rel);
    if (!ours(rel)) { res.userEdited.push(rel); return; }
    if (existsSync(p)) rmSync(p); // ours: replace the previous Sage-written PDF
    try {
      const r = await exportMarkdownPdf({ content, outputPath: p, artifactRevisionId: id, origin: "tutor", provenance: `Sage session ${s.sessionId}; regenerated from the session ledger` });
      man.files[rel] = r.fileHash; res.pdfs.push(rel);
      if (r.replacedChars) res.errors.push(`${rel}: ${r.replacedChars} character(s) shown as "?" (built-in PDF font)`);
    } catch (e) { delete man.files[rel]; res.errors.push(`${rel}: ${(e as Error).message}`); }
  };

  put("session.md", sessionMd(s, meta));
  put("plan.md", planMd(s));
  const nodes = [...(s.plan?.nodes ?? [])].sort((a, b) => a.order - b.order);
  for (const n of nodes) {
    if (!s.attempts.some(a => s.items.get(a.itemId)?.nodeId === n.id) && n.status !== "passed") continue; // nothing to show yet
    const nd = `nodes/${String(n.order + 1).padStart(2, "0")}-${slug(n.title)}`;
    put(`${nd}/lesson.md`, lessonMd(log, n));
    put(`${nd}/items.md`, itemsMd(s, n));
    const sheet = cheatsheetMd(s, n);
    const changed = put(`${nd}/cheatsheet.md`, sheet);
    if ((what === "node" && (nodeId === undefined || nodeId === n.id) || what === "final") && n.status === "passed" && (changed || !existsSync(join(dir, `${nd}/cheatsheet.pdf`))))
      await pdf(`${nd}/cheatsheet.pdf`, sheet, `${s.sessionId}.${n.id}.cheatsheet`.replace(/[^A-Za-z0-9_.:-]/g, "-"));
  }
  if (what === "final") {
    const sheet = sessionCheatsheetMd(s);
    if (put("cheatsheet.md", sheet) || !existsSync(join(dir, "cheatsheet.pdf"))) await pdf("cheatsheet.pdf", sheet, `${s.sessionId}.cheatsheet`.replace(/[^A-Za-z0-9_.:-]/g, "-"));
  }
  const tmp = `${mPath}.sage-tmp`; writeFileSync(tmp, JSON.stringify(man, null, 1)); renameSync(tmp, mPath);
  return res;
}
