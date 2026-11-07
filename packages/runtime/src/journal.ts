import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TaskInstance } from "../../core/src/contracts.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import type { SagePaths } from "./paths.ts";
import { publishArtifactContent } from "./artifacts.ts";

export interface JournalReceipt { artifact_revision_id: string; fullPath?: string; publication_error?: string }
export interface JournalDraft {
  destination: string;
  preview(note: string): string;
  save(note: string, confirmed: boolean): Promise<JournalReceipt>;
}

/** Native opt-in only. No response/assessment events and no automatic model disclosure. */
export function prepareJournal(paths: SagePaths, store: LearningStore, sessionId: string, assertCurrent: () => void): JournalDraft {
  assertCurrent();
  const goal = store.lessonGoal(sessionId);
  if (!goal) throw new Error("Start or resume a lesson before opening its journal");
  const goalId = goal.revision_id;
  const attempts = store.events().filter(e => e.branch === "real" && e.session_id === sessionId && e.kind === "attempt_submitted" && store.revision<TaskInstance>(e.payload.instance_revision_id as string, "task_instance").body.goal_revision_id === goalId).slice(-3).map(e => e.event_id);
  const metadata = JSON.stringify({ goal_revision_id: goalId, goal: goal.body.objective.slice(0, 500), session_id: sessionId, goal_selected_source_reference_ids: goal.body.source_ids.slice(0, 20), omitted_source_references: Math.max(0, goal.body.source_ids.length - 20), actual_attempt_reference_ids: attempts }, null, 2);
  const preview = (note: string) => {
    if (!note.trim() || note.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(note)) throw new Error("Journal notes need 1–12000 characters without terminal controls");
    const longest = (character: string) => Math.max(0, ...(note.match(new RegExp(`${character}+`, "g")) ?? []).map(run => run.length));
    const marker = longest("~") < longest("`") ? "~" : "`";
    const fence = marker.repeat(Math.max(3, longest(marker) + 1));
    const text = `# Study journal\n\nPrivate local reflection, not learner performance or source-sharing permission. Host supplies scope metadata; note text was entered/pasted in the native editor. Authorship and outside assistance are unverified.\n\n## Captured scope references\n\n~~~json\n${metadata}\n~~~\n\n## Learner-entered note (unassessed)\n\n${fence}text\n${note}\n${fence}\n`;
    if (text.length > 24000) throw new Error("Journal document exceeds its safe bound; split it into smaller notes");
    return text;
  };
  let savedText: string | undefined, saved: Promise<JournalReceipt> | undefined;
  return {
    destination: join(paths.home, "content"), preview,
    save(note, confirmed) {
      assertCurrent();
      if (store.lessonGoal(sessionId)?.revision_id !== goalId) throw new Error("Journal goal changed; review a new draft");
      if (confirmed !== true) throw new Error("Journal publication requires explicit native confirmation");
      const content = preview(note);
      if (savedText !== undefined && savedText !== content) throw new Error("Journal draft already saved with different content; open a new entry");
      if (!saved) {
        const artifact = store.define({ operation_id: randomUUID(), kind: "artifact", expected_goal_revision_id: goalId, body: {
          capability: "study_journal", goal_revision_id: goalId, author: "tutor", provenance: "Host-compiled private journal; native editor text is self-declared and unassessed; no model generation",
          media_type: "text/markdown", content, evidence_kind: "artifact_only", interpretation_uncertainty: "Reflection only, not an attempt, a grade, verified authorship or a source permission", assistance_event_ids: [],
        } }, "host", sessionId);
        savedText = content;
        saved = publishArtifactContent(paths, store, artifact.revision_id).then(copy => ({ artifact_revision_id: artifact.revision_id, fullPath: copy.fullPath }), () => ({ artifact_revision_id: artifact.revision_id, publication_error: "Journal original saved in the learning database, but its Markdown copy was blocked. Existing files were preserved; retry explicit artifact export after reviewing the conflict." }));
      }
      return saved;
    },
  };
}
