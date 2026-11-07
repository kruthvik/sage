import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoalSchema, validate, type Goal } from "../../core/src/contracts.ts";
import { hash } from "../../storage/src/store.ts";
import type { LearningService } from "./service.ts";
import { projectLearningState } from "./learning-state.ts";

export interface ResearchSource { url: string; title: string; content: string }
export interface ResearchReceipt { source_id: string; duplicate: boolean }
export interface ResearchDraft {
  topic: string;
  knows(url: string, content?: string): boolean;
  offer(source: ResearchSource): { preview: string; save(confirmed: boolean): Promise<ResearchReceipt> };
}
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
export function researchUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2000 || controls.test(value)) throw new Error("Invalid research source URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid research source URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Research sources need public HTTP(S) URLs without credentials");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

/** Native capability: import/accept only a complete, confirmed preview; never a model tool. */
export function prepareResearch(service: LearningService, body: Goal, sessionId: string): ResearchDraft {
  validate(GoalSchema, body);
  const goal = { ...body, source_ids: [...body.source_ids] }, topic = goal.objective.trim();
  if (!goal.provider_sharing || !["learn", "accelerate"].includes(goal.mode) || !topic || topic.length > 500 || controls.test(topic)) throw new Error("Research needs a sharing-authorized learn/accelerate topic within 500 characters");
  const admission = service.inputAdmission(sessionId);
  const check = () => {
    admission.assertCurrent();
    const state = projectLearningState(service.store, sessionId);
    if (state.phase === "stopped" || state.pending_count > 0) throw new Error("Finish or stop the current work before researching a new lesson");
    if (goal.source_ids.some(id => service.store.sourceStatus(id) !== "indexed")) throw new Error("A selected research source is no longer accepted");
  };
  const known = (url: string, content?: string) => {
    const identity = researchUrl(url), digest = content === undefined ? undefined : hash(Buffer.from(content, "utf8"));
    return service.store.revisions("source").find(source => {
      const purpose = typeof source.body.purpose === "string" ? source.body.purpose.split("\n") : [];
      let sameUrl = false;
      try { sameUrl = purpose[0]?.startsWith("web:") === true && researchUrl(purpose[0].slice(4)) === identity; } catch { sameUrl = false; }
      return sameUrl || digest !== undefined && (source.body.original_hash === digest || purpose.includes(`content-sha256:${digest}`));
    });
  };
  check();
  return {
    topic,
    knows(url, content) { check(); return known(url, content) !== undefined; },
    offer(input) {
      check();
      const url = researchUrl(input.url), title = input.title?.trim(), content = input.content;
      if (typeof title !== "string" || !title || title.length > 200 || controls.test(title) || typeof content !== "string" || !content.trim() || content.length > 18000 || controls.test(content)) throw new Error("Research needs a complete source title and 1–18000 characters of readable text without terminal controls");
      const preview = `# ${title}\n\nOriginal URL: ${url}\n\nRetrieved by pi-web-access. External source text; acceptance is not factual verification.\n\n${content}`;
      let saved: Promise<ResearchReceipt> | undefined;
      return { preview, async save(confirmed) {
        if (confirmed !== true) throw new Error("Research source requires explicit native confirmation");
        check();
        if (saved) return saved;
        saved = (async () => {
          const existing = known(url, content);
          if (existing) {
            const digest = hash(Buffer.from(content, "utf8"));
            if (existing.body.original_hash !== digest && !(typeof existing.body.purpose === "string" && existing.body.purpose.split("\n").includes(`content-sha256:${digest}`))) throw new Error("Source changed while reviewing; use the existing source controls to preview its different text");
            if (service.store.sourceStatus(existing.revision_id) !== "indexed") throw new Error("Source already added; use /source preview and /source accept on its existing copy");
            return { source_id: existing.revision_id, duplicate: true };
          }
          await mkdir(service.paths.cache, { recursive: true });
          const directory = await mkdtemp(join(service.paths.cache, "research-"));
          const filename = join(directory, `${title.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 80) || "Web source"}.md`);
          await writeFile(filename, preview, { flag: "wx", mode: 0o600 });
          check();
          const imported = await service.sources.importFile(filename, `web:${url}\ncontent-sha256:${hash(Buffer.from(content, "utf8"))}`);
          check();
          service.sources.preview(imported.revision_id);
          service.sources.accept(imported.revision_id);
          return { source_id: imported.revision_id, duplicate: imported.duplicate };
        })();
        return saved;
      } };
    },
  };
}
