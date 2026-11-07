import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JournalDraft } from "../../runtime/src/journal.ts";

/** Explicit local command: editor text never enters a model message or response capture. */
export function registerJournalControls(pi: ExtensionAPI, prepare?: (sessionId: string) => Promise<JournalDraft>): void {
  pi.registerCommand("journal", { description: "Write, preview and confirm a private Sage-managed study note (not assessed)", handler: async (args, ctx) => {
    if (args.trim()) { ctx.ui.notify("Use /journal; exports use the explicit artifact/vault commands", "warning"); return; }
    if (!ctx.hasUI || !ctx.isIdle()) { ctx.ui.notify("Open /journal in an idle native session; no note was recorded", "warning"); return; }
    if (!prepare) { ctx.ui.notify("Private journal controls are unavailable in this host", "warning"); return; }
    const owner = ctx.sessionManager.getSessionId();
    const assertOwner = () => { if (ctx.sessionManager.getSessionId() !== owner) throw new Error("Journal conversation changed; nothing was saved"); };
    let note: string | undefined, savedId: string | undefined;
    try {
      const draft = await prepare(owner);
      assertOwner();
      note = await ctx.ui.editor("Private journal note — unassessed, not sent to the model", "");
      if (note === undefined) return;
      assertOwner();
      const preview = draft.preview(note);
      const confirmed = await ctx.ui.confirm("Save this private journal entry?", `Destination: ${draft.destination}\nOriginals are included in educational backups. Export only when you explicitly choose to.\n\n${preview}`);
      if (!confirmed) return;
      assertOwner();
      const receipt = await draft.save(note, true);
      savedId = receipt.artifact_revision_id;
      if (receipt.publication_error) ctx.ui.notify(receipt.publication_error, "warning");
      else ctx.ui.notify(`Private journal saved: ${receipt.fullPath}. Not learner performance. Optional explicit export: sage artifact export ${receipt.artifact_revision_id} FILE.md; configured vault: sage vault export ${receipt.artifact_revision_id} RELATIVE.md`);
    } catch (error) {
      if (savedId) {
        try { ctx.ui.notify(`Journal original saved as ${savedId}; its native notice failed. Do not repeat the save; use explicit artifact export if needed.`, "warning"); } catch { /* A closed UI cannot undo the confirmed original. */ }
        return;
      }
      ctx.ui.notify(`Journal save canceled: ${error instanceof Error ? error.message : "local save failed"}. Existing notes were preserved.`, "warning");
      if (note !== undefined) await ctx.ui.editor("Unsaved journal — copy your draft before closing (not submitted)", note);
    }
  } });
}
