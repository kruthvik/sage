import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SourceFolder } from "../../sources/src/service.ts";
import { SourceSizeError, type ConfirmLargeSource } from "../../sources/src/limits.ts";

export type NativeSourceControl = (args: string, confirmLarge?: ConfirmLargeSource) => Promise<unknown>;
const visible = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export async function confirmLargeSource(ctx: ExtensionContext, file: { path: string; size: number }, assertCurrent: () => void): Promise<boolean> {
  assertCurrent();
  const approved = await ctx.ui.confirm("Source exceeds 50 MiB. Import this file?", `${visible(file.path)}\nSize: ${(file.size / (1024 * 1024)).toFixed(1)} MiB. Large imports may use substantial memory and take longer. The safety ceiling is 200 MiB; extraction/page/decompression limits still apply. This permits a local copy only, not source acceptance or model sharing. No/Esc skips this file.`);
  assertCurrent();
  return approved;
}

/** Local admission is separate from the final per-lesson provider-sharing consent. */
export async function chooseFolderSources(ctx: ExtensionContext, control: NativeSourceControl, assertCurrent: () => void): Promise<string[] | undefined> {
  const wait = async <T>(pending: Promise<T>): Promise<T> => { const result = await pending; assertCurrent(); return result; };
  const run = async (args: string, confirmLarge?: ConfirmLargeSource) => { assertCurrent(); return wait(control(args, confirmLarge)); };
  const decide: ConfirmLargeSource = file => confirmLargeSource(ctx, file, assertCurrent);
  assertCurrent();
  const directory = await wait(ctx.ui.input("Which sources folder would you like to use?", "Folder path; only immediate supported files are listed"));
  if (!directory?.trim()) return;
  const listing = await run(`folder ${directory.trim()}`) as SourceFolder;
  if (!listing || !Array.isArray(listing.files) || listing.files.length > 500 || !listing.files.every(file => typeof file.name === "string" && typeof file.path === "string" && Number.isFinite(file.size))) throw new Error("Folder listing is unavailable; no files were imported");
  if (!listing.files.length) { ctx.ui.notify("No supported nonhidden nonempty regular files were found. Subfolders and links are not scanned.", "info"); return []; }
  ctx.ui.notify("Only selected files will be imported locally. Local imports remain if setup is canceled; nothing is shared with your model until the lesson confirmation.", "info");
  const selected = new Set<number>();
  for (;;) {
    const labels = listing.files.map((file, index) => `${index + 1}. ${selected.has(index) ? "☑" : "☐"} ${visible(file.name)} · ${Math.ceil(file.size / 1024)} KiB`);
    const choice = await wait(ctx.ui.select("Choose files from this folder · toggle files, then review", [...labels, "Review selected files", "Cancel folder selection"]));
    if (!choice || choice === "Cancel folder selection") return;
    if (choice === "Review selected files") break;
    const index = labels.indexOf(choice);
    if (index < 0) throw new Error("Folder selection changed; choose the folder again");
    if (selected.has(index)) selected.delete(index);
    else if (selected.size < 40) selected.add(index);
    else ctx.ui.notify("Select at most 40 source files for a lesson.", "warning");
  }
  if (!selected.size) return [];
  if (!await wait(ctx.ui.confirm("Import selected files locally?", `${selected.size} selected file(s) will be copied into Sage's local source storage. Each requires a separate preview/acceptance. Canceling later does not erase local copies. No content is sent to your model by this step.`))) return;
  const accepted: string[] = [];
  for (const index of selected) {
    const file = listing.files[index]!;
    try {
      let imported: { source_id?: unknown };
      try { imported = await run(`add ${file.path}`, decide) as { source_id?: unknown }; }
      catch (error) {
        if (!file.name.toLowerCase().endsWith(".pdf") || error instanceof SourceSizeError) throw error;
        if (!await wait(ctx.ui.confirm(`Try local OCR for ${visible(file.name)}?`, "Text extraction failed. Use installed Windows PDF rendering and Tesseract locally, never a hosted OCR service? This can take up to 45 seconds and supports at most 12 pages. OCR can be wrong or omit diagrams; review against the original before accepting. Passwords and access restrictions are not bypassed."))) continue;
        imported = await run(`ocr ${file.path}`, decide) as { source_id?: unknown };
      }
      if (!imported || typeof imported.source_id !== "string") throw new Error("Import did not return a source receipt");
      const preview = await run(`preview ${imported.source_id}`) as Array<{ locator: string; text: string }>;
      if (!Array.isArray(preview) || !preview.length || !preview.every(span => typeof span.locator === "string" && typeof span.text === "string")) throw new Error("No usable extracted preview; source remains unaccepted");
      const excerpt = visible(preview.map(span => `${span.locator}\n${span.text}`).join("\n\n")).slice(0, 6000);
      const approve = await wait(ctx.ui.confirm(`Accept ${visible(file.name)} as a source?`, `Extracted excerpt, at most 6000 characters; this is not the full document or expert validation:\n\n${excerpt}\n\nAccept only if extraction is usable and you have permission to use this file. OCR is an unverified transcription; check it against the original. Selecting a PNG/JPEG for the lesson can share its original image, not only this excerpt. No/Esc keeps it unaccepted locally. Sharing still requires the final lesson confirmation.`));
      if (!approve) continue;
      const receipt = await run(`accept ${imported.source_id}`) as { source_id?: unknown; status?: unknown };
      if (receipt?.source_id !== imported.source_id || receipt.status !== "indexed") throw new Error("Source acceptance was not confirmed; refresh local source status");
      accepted.push(imported.source_id);
    } catch (error) {
      assertCurrent();
      ctx.ui.notify(`Could not use ${visible(file.name)}: ${visible(error instanceof Error ? error.message : "Import failed").slice(0, 300)}. Any saved copy remains local; this file was not added to the lesson selection.`, "warning");
    }
  }
  return accepted;
}
