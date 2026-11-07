import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../../core/src/contracts.ts";
import { chooseFolderSources, type NativeSourceControl } from "./source-folder.ts";

interface IntakeSource { source_id: string; title: string; status: string; mime?: string; original_size_bytes?: number }

/** Native learner answers, not a diagnostic or a model-written profile. */
export async function collectLessonIntake(
  ctx: ExtensionContext,
  initial: Goal,
  sourceControl: NativeSourceControl,
  assertCurrent: () => void,
): Promise<Goal | undefined> {
  assertCurrent();
  if (!ctx.hasUI) return initial;
  const wait = async <T>(pending: Promise<T>): Promise<T> => { const value = await pending; assertCurrent(); return value; };
  const text = async (title: string, hint?: string): Promise<string | undefined> => {
    for (;;) {
      const value = await wait(ctx.ui.input(title, hint));
      if (value === undefined) return;
      if (value.trim().length <= 500) return value.trim();
      ctx.ui.notify("Keep this answer within 500 characters; longer material can be added as a source.", "warning");
    }
  };
  const scope = await text("What specifically would you like to learn?", initial.objective);
  if (scope === undefined) return;
  const objective = scope || initial.objective.trim();
  if (!objective) return;
  const background = await text("What do you already know, and what is difficult? (optional)");
  if (background === undefined) return;
  const outcome = await text("What should you be able to do by the end? (optional)");
  if (outcome === undefined) return;
  let minutes: number;
  for (;;) {
    const answer = await text("How many minutes do you have for this session? (optional; default 30)");
    if (answer === undefined) return;
    minutes = answer ? Number(answer) : initial.budget_minutes ?? 30;
    if ((!answer || /^\d+$/.test(answer)) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) break;
    ctx.ui.notify("Enter a whole number from 1 to 1440, or leave this blank to keep the default.", "warning");
  }
  const constraints = await text("Any preferences or constraints? (optional)");
  if (constraints === undefined) return;
  const inventory = async (): Promise<IntakeSource[]> => {
    const value = await wait(sourceControl("list"));
    if (!Array.isArray(value) || !value.every(item => item && typeof item === "object" && typeof item.source_id === "string" && typeof item.title === "string" && typeof item.status === "string")) throw new Error("Source inventory is unavailable; no lesson was started");
    return value.filter((item: IntakeSource) => item.status === "indexed");
  };
  let available = await inventory();
  const selected = new Set(initial.source_ids.filter(id => available.some(source => source.source_id === id)));
  for (;;) {
    const labels = available.map((source, index) => `${index + 1}. ${selected.has(source.source_id) ? "☑" : "☐"} ${source.title.slice(0, 120)}`);
    const choice = await wait(ctx.ui.select("Sources to share for this lesson · only previewed and accepted material", [...labels, "Use selected sources", "Continue without sources", "Choose files from a folder", "Add sources first", "Cancel setup"]));
    if (!choice || choice === "Cancel setup") return;
    if (choice === "Choose files from a folder") {
      try {
        const imported = await chooseFolderSources(ctx, sourceControl, assertCurrent);
        if (!imported) return;
        available = await inventory();
        const combined = new Set([...selected, ...imported]);
        if (combined.size > 40) ctx.ui.notify("Select at most 40 sources; imported copies remain local and can be selected individually.", "warning");
        else for (const id of imported) selected.add(id);
      } catch (error) {
        assertCurrent();
        ctx.ui.notify(`Folder selection failed: ${error instanceof Error ? error.message.slice(0, 300) : "Choose another folder or continue without sources."}`, "warning");
      }
      continue;
    }
    if (choice === "Add sources first") { ctx.ui.notify("Use /source add PATH, /source preview ID and /source accept ID, then start the lesson again. No file is imported or shared by this setup.", "info"); return; }
    if (choice === "Continue without sources") { selected.clear(); break; }
    if (choice === "Use selected sources") break;
    const source = available[labels.indexOf(choice)];
    if (!source) throw new Error("Source selection changed; start setup again");
    if (selected.has(source.source_id)) selected.delete(source.source_id);
    else if (selected.size < 40) selected.add(source.source_id);
    else ctx.ui.notify("Select at most 40 sources for one lesson.", "warning");
  }
  const imageSources = available.filter(source => selected.has(source.source_id) && ["image/png", "image/jpeg"].includes(source.mime ?? ""));
  if (imageSources.length > 4 || imageSources.some(source => !Number.isInteger(source.original_size_bytes) || source.original_size_bytes! < 1 || source.original_size_bytes! > 4 * 1024 * 1024) || imageSources.reduce((sum, source) => sum + (source.original_size_bytes ?? 0), 0) > 8 * 1024 * 1024) {
    ctx.ui.notify("Source images are limited to four originals, 4 MiB each and 8 MiB combined. Start setup again with fewer images; local copies remain unshared.", "warning"); return;
  }
  const sourceUse = selected.size ? await text("How should we use the selected sources? (optional)", "Main material, supporting references, or specific sections to focus on") : "";
  if (sourceUse === undefined) return;
  const sharing = await wait(ctx.ui.confirm("Start this lesson and share its selected content?", `Scope: ${objective}\nOutcome: ${outcome || initial.target_format}\nSession: ${minutes} minutes\nSources: ${available.filter(source => selected.has(source.source_id)).map(source => source.title).join(", ") || "none"}\n${imageSources.length ? "The selected original PNG/JPEG images (not just OCR) may be sent to a compatible model. Check originals for unrelated private content; text-only models or disabled image reading receive OCR text only.\n" : ""}Your answers and selected source content will be available to ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "your selected model"}. Enter skips optional text; Esc cancels setup.`));
  if (!sharing) return;
  if (selected.size) {
    const current = new Set((await inventory()).map(source => source.source_id));
    if ([...selected].some(id => !current.has(id))) throw new Error("A selected source is no longer accepted; review the source selection before starting");
  }
  return { ...initial, objective, prior_experience: background || "unsure", target_format: outcome || initial.target_format, budget_minutes: minutes,
    constraints: constraints ? [constraints] : [], ...(sourceUse ? { learner_notes: `Source use: ${sourceUse}` } : {}), source_ids: [...selected], provider_sharing: true };
}
