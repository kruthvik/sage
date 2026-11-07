import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext, ExtensionToolContext, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../../core/src/contracts.ts";
import type { SagePaths } from "../../runtime/src/paths.ts";
import { researchUrl, type ResearchDraft } from "../../runtime/src/research.ts";

export interface NativeResearchTools { search?: Pick<ToolDefinition, "execute">; fetch?: Pick<ToolDefinition, "execute">; names: string[]; cwd?: string }
export function managedResearchTools(paths: SagePaths, loader: ResourceLoader): NativeResearchTools | undefined {
  const root = join(paths.agent, "npm", "node_modules", "pi-web-access");
  const extensions = loader.getExtensions().extensions.filter(extension => {
    const child = relative(root, extension.path);
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  });
  const tools = extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
  const search = tools.find(tool => tool.name === "web_search"), fetch = tools.find(tool => tool.name === "fetch_content");
  return tools.length ? { search, fetch, names: tools.map(tool => tool.name), cwd: paths.cache } : undefined;
}
function structured(reply: unknown): Record<string, unknown> {
  if (!reply || typeof reply !== "object" || (reply as { isError?: boolean }).isError) throw new Error("Search extension failed");
  const value = (reply as { structuredContent?: unknown }).structuredContent;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Search extension did not return structured source data");
  return value as Record<string, unknown>;
}

/** Native lesson setup only. Search/extraction stay in the installed extension. */
export async function reviewResearch(goal: Goal, ctx: ExtensionContext, tools: NativeResearchTools | undefined, prepare: () => Promise<ResearchDraft>, assertCurrent: () => void): Promise<Goal> {
  if (!ctx.hasUI || !goal.provider_sharing || !["learn", "accelerate"].includes(goal.mode)) return goal;
  if (!tools?.search || !tools.fetch) { ctx.ui.notify("Automatic research unavailable: install pi-web-access in Sage and configure its search provider. Your existing sources remain usable.", "info"); return goal; }
  assertCurrent();
  let draft: ResearchDraft;
  try { draft = await prepare(); } catch { assertCurrent(); ctx.ui.notify("Automatic research unavailable for this setup. Continue with your existing sources; no web query was sent.", "info"); return goal; }
  const topic = draft.topic;
  const allowed = await ctx.ui.confirm("Research this lesson automatically?", `Public search query: ${topic}\nThe configured pi-web-access search provider receives this topic, not your private excerpts, notes, answers or transcript. New sources need preview and acceptance before use by ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "your selected model"}. Decline or Esc skips web research.`);
  assertCurrent();
  if (!allowed) return goal;
  const selected = new Set(goal.source_ids), pending: Array<{ title: string; url: string; offer: ReturnType<ResearchDraft["offer"]> }> = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Research time budget elapsed")), 45000);
  const watch = setInterval(() => { try { assertCurrent(); } catch (error) { controller.abort(error); } }, 100);
  const check = () => { assertCurrent(); controller.signal.throwIfAborted(); };
  const toolContext: ExtensionToolContext = { ...ctx, ...(tools.cwd ? { cwd: tools.cwd } : {}), tools: [], async executeTool() { throw new Error("Nested tools are unavailable during native source discovery"); } };
  try {
    const found = structured(await tools.search.execute(randomUUID(), { query: topic, numResults: 5, includeContent: false, workflow: "none" }, controller.signal, undefined, toolContext));
    check();
    if (!Array.isArray(found.queries) || found.queries.length !== 1 || !Array.isArray(found.queries[0]?.results)) throw new Error("Search extension returned an unsupported source list");
    const seen = new Set<string>();
    for (const raw of found.queries[0].results.slice(0, 5)) {
      check();
      if (!raw || typeof raw.url !== "string" || typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(raw.title)) continue;
      let url: string;
      try { url = researchUrl(raw.url); } catch { continue; }
      if (seen.has(url) || draft.knows(url)) continue;
      seen.add(url);
      const fetched = structured(await tools.fetch.execute(randomUUID(), { url: raw.url, mode: "readable", forceClone: false }, controller.signal, undefined, toolContext));
      check();
      const page = Array.isArray(fetched.urls) && fetched.urls.length === 1 ? fetched.urls[0] : undefined;
      if (!page || page.error || typeof page.url !== "string" || researchUrl(page.url) !== url || typeof page.content !== "string" || !page.content.trim()) continue;
      if (draft.knows(url, page.content)) continue;
      if (page.content.length > 18000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(page.content)) { ctx.ui.notify(`Source skipped: ${raw.title}. Its full text exceeds the preview bound or contains terminal controls; import a supported local copy if needed.`, "warning"); continue; }
      pending.push({ title: raw.title, url, offer: draft.offer({ url, title: raw.title, content: page.content }) });
    }
    clearTimeout(deadline);
    clearInterval(watch);
    if (!pending.length) ctx.ui.notify("No new readable sources to review. Already-added sources were excluded; existing lesson sources stay selected.", "info");
    while (pending.length) {
      check();
      const labels = pending.map((source, index) => `${index + 1}. ${source.title.slice(0, 100)} — ${source.url.slice(0, 120)}`);
      const choice = await ctx.ui.select("New sources only · review, accept or reject", [...labels, "Use accepted sources and start lesson"]);
      check();
      if (!choice || choice === "Use accepted sources and start lesson") break;
      const index = labels.indexOf(choice);
      if (index < 0) throw new Error("Research source selection changed");
      const [source] = pending.splice(index, 1);
      if (selected.size >= 40) { ctx.ui.notify("This lesson already has 40 sources. Remaining discoveries were not added.", "info"); break; }
      const confirmed = await ctx.ui.confirm("Accept and use this source in the lesson?", `${source!.offer.preview}\n\nThis full preview becomes an accepted external source and is selected for your model. Decline rejects this discovery; existing sources are unchanged.`);
      check();
      if (!confirmed) continue;
      const receipt = await source!.offer.save(true);
      selected.add(receipt.source_id);
    }
  } catch {
    assertCurrent();
    ctx.ui.notify("Automatic research unavailable or interrupted. Existing sources and any accepted copies remain local; unaccepted findings were not selected. Check the extension's provider setup and retry the lesson when ready.", "warning");
  } finally { clearTimeout(deadline); clearInterval(watch); }
  assertCurrent();
  return { ...goal, source_ids: [...selected] };
}
