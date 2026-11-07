import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runTutor, type TutorBridge } from "../../pi/src/tutor.ts";
import type { Assessment, Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { LearningService, requestLearning, startLearningServer } from "./service.ts";
import type { SagePaths } from "./paths.ts";
import { commitPlannedGoal, commitDelegatedOutline, delegatedPlanResult } from "./planning.ts";
import { captureInput } from "./submissions.ts";
import { submitActivity, readFeynmanReview, saveFeynmanReview } from "./interactions.ts";
import { feedbackState, feedbackText, presentFeedback } from "./feedback.ts";
import { assertLearningTransition } from "./learning-controller.ts";
import { manageResources, manageTheme } from "../../pi/src/resources.ts";
import { managePlugin } from "../../pi/src/plugins.ts";
import { projectLearningState } from "./learning-state.ts";
import { currentDrillRound, stopDrill, drillGapTeachingEnabled, setDrillGapTeaching, continueDrillGapTeaching } from "./drill.ts";
import { publishAutomaticContent } from "./artifacts.ts";
import type { ConfirmLargeSource } from "../../sources/src/limits.ts";
import { prepareJournal } from "./journal.ts";
import { createInstructionDiagram } from "./diagram.ts";
import { prepareResearch } from "./research.ts";

export async function sourceControl(service: LearningService, args: string, sessionId = "cli", confirmLarge?: ConfirmLargeSource): Promise<unknown> {
  service.assertActiveSession(sessionId);
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const action = match?.[1] ?? "list";
  const target = (match?.[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  if (action === "list") return service.sources.list();
  if (action === "folder") {
    if (!target) throw new Error("Usage: source folder DIRECTORY");
    return service.sources.listFolder(target);
  }
  if (action === "add" || action === "ocr") {
    if (!target) throw new Error(`Usage: source ${action} PATH`);
    const result = await service.sources.importFile(target, "reference", "unknown", undefined, action === "ocr" ? "local_ocr" : "default", confirmLarge);
    return { source_id: result.revision_id, status: result.status, duplicate: result.duplicate, title: result.body.title, next: `source preview ${result.revision_id}, then source accept ${result.revision_id}` };
  }
  if (!target) throw new Error("Source ID required");
  if (action === "preview") return service.sources.preview(target);
  if (action === "status") return service.sources.list().find(s => s.source_id === target) ?? { error: "Source not found" };
  if (action === "accept") { service.sources.accept(target); return { source_id: target, status: "indexed", next: `Use /source attach ${target} to select it for a tutoring goal` }; }
  if (action === "remove") { service.sources.remove(target); return { source_id: target, status: "removed", retained: "Original and historical evidence remain local for provenance; future use is blocked" }; }
  if (action === "attach") {
    const goal = service.store.lessonGoal(sessionId);
    if (!goal) throw new Error("Start or resume a lesson first");
    if (!goal.body.provider_sharing) throw new Error("Provider-sharing consent is required to attach a source");
    if (service.store.sourceStatus(target) !== "indexed") throw new Error("Preview and accept the source first");
    const selected = [...new Set([...goal.body.source_ids, target])];
    const source = service.store.revision(target, "source");
    if (source.body.mime === "image/png" || source.body.mime === "image/jpeg") {
      await service.sources.originalImages(selected);
      service.assertActiveSession(sessionId);
      if (service.store.lessonGoal(sessionId)?.revision_id !== goal.revision_id || service.store.sourceStatus(target) !== "indexed") throw new Error("Source/goal changed during image attachment; refresh before sharing");
    }
    return service.store.define({ operation_id: randomUUID(), kind: "goal", entity_id: goal.entity_id, parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, source_ids: selected } }, "learner", sessionId);
  }
  throw new Error("Usage: source folder DIRECTORY | add PATH | ocr PDF_PATH | list | preview ID | status ID | accept ID | attach ID | remove ID");
}

export async function nativeCustomization(paths: SagePaths, name: "extensions" | "theme" | "packages", args: string[], trusted = false): Promise<unknown> {
  if (args.length > 2) throw new Error("Use one action and one quoted path/name/source; trust is confirmed by the native interface");
  const [action = "list", target] = args;
  if (name === "theme") return manageTheme(paths, action, target);
  if (name === "extensions") return manageResources(paths, action, "extensions", target, trusted);
  return managePlugin(paths, action === "install" ? "add" : action, target, trusted);
}

export function createTutorBridge(paths: SagePaths, service: LearningService, server: ReturnType<typeof startLearningServer>): TutorBridge {
  return {
    async activate(sessionId) { return service.activateSession(sessionId); },
    async bindLesson(entityId, sessionId) { service.assertActiveSession(sessionId); return service.store.bindLesson(sessionId, entityId); },
    operation: (name, body, sessionId, signal) => requestLearning(server, name, body, sessionId, signal),
    inputAdmission: sessionId => service.inputAdmission(sessionId),
    async prepareResearch(goal, sessionId) { return prepareResearch(service, goal, sessionId); },
    async prepareJournal(sessionId) {
      const admission = service.inputAdmission(sessionId);
      return prepareJournal(paths, service.store, sessionId, () => { service.assertActiveSession(sessionId); admission.assertCurrent(); });
    },
    async instructionDiagram(request, sessionId, propose, signal) {
      const admission = service.inputAdmission(sessionId);
      await service.authorizeDisclosure(sessionId);
      return createInstructionDiagram(paths, service.store, request, sessionId, propose, () => { service.assertActiveSession(sessionId); admission.assertCurrent(); }, signal);
    },
    async input(text, sessionId, images, instanceId, admission) {
      const origin = service.inputAdmission(sessionId), arrived = admission ?? origin;
      const checkSaved = (scope?: typeof origin) => {
        try { origin.assertScopeCurrent(); scope?.assertCurrent(); }
        catch (cause) { throw new Error("Input is saved in its original lesson; scope changed during capture/publication. Refresh that lesson before forwarding/retrying.", { cause }); }
      };
      if (service.store.lessonGoal(sessionId)?.body.mode === "drill" && projectLearningState(service.store, sessionId).phase === "stopped") throw new Error("Drill is stopped; explicitly resume the saved work first");
      const captured = await captureInput(service.store, paths, text, sessionId, images, instanceId, undefined, () => { service.assertActiveSession(sessionId); arrived.assertCurrent(); });
      checkSaved();
      const savedScope = service.inputAdmission(sessionId);
      for (const id of captured.artifact_revision_ids) await publishAutomaticContent(paths, service.store, id);
      // New filesystem awaits must not forward saved work into a changed native scope.
      checkSaved(savedScope);
      return captured;
    },
    teachingOffer: (request, sessionId) => service.offerTeaching(request, sessionId),
    async activitySubmit(request, submission, sessionId) { service.assertActiveSession(sessionId); return submitActivity(service.store, request, submission, sessionId); },
    async learnControl(request, sessionId) { return service.learnControl(request, sessionId); },
    renderUi: (source, sessionId, resume, approve) => service.renderUi(source, sessionId, server.url, receipt => resume(receipt as Record<string, unknown>), approve),
    async feedback(sessionId, displayed) {
      service.assertActiveSession(sessionId);
      const state = feedbackState(service.store, sessionId);
      if (!("assessment_event_id" in state)) {
        const learning = projectLearningState(service.store, sessionId), task = learning.current_task;
        if (learning.phase !== "feedback" || !task?.assessment_event_id || learning.teaching?.instance_revision_id !== task.instance_revision_id) return { state };
        const event = service.store.events().find(e => e.event_id === task.assessment_event_id)!;
        if (!displayed) return { state: learning, text: feedbackText(event.payload as Assessment) };
        if (!service.store.events().some(e => e.operation_id === `feedback-presented:${event.event_id}`)) {
          assertLearningTransition(service.store, sessionId, learning.state_revision, false);
          service.store.append("decision", { action: "response_feedback_presented", reason: "Native interface queued guided criterion feedback; no reading or agreement inferred", evidence_event_ids: [event.event_id] }, `feedback-presented:${event.event_id}`, "host", sessionId);
          service.store.rebuild();
        }
        return { state: projectLearningState(service.store, sessionId) };
      }
      if (displayed) { presentFeedback(service.store, state.assessment_event_id, sessionId); return { state: feedbackState(service.store, sessionId) }; }
      if (state.phase !== "awaiting_feedback") return { state };
      const event = service.store.events().find(e => e.event_id === state.assessment_event_id)!;
      let text = feedbackText(event.payload as Assessment);
      if (service.store.lessonGoal(sessionId)?.body.mode === "drill") {
        const assessment = event.payload as Assessment;
        const rubric = service.store.revision<{ dimensions: Array<{ name: string; criterion: string; max_score: number }> }>(assessment.rubric_revision_id, "rubric");
        const gaps = rubric.body.dimensions.filter(d => !assessment.scores.some(s => s.dimension === d.name && s.score === d.max_score));
        if (gaps.length) text += `\n\nUnmet pinned criteria / narrow repair:\n${gaps.map(d => `${d.name}: ${d.criterion}. Reattempt this criterion on fresh work; no unseen reasoning credit.`).join("\n")}`;
      }
      return { state, text };
    },
    async continue(sessionId) {
      service.assertActiveSession(sessionId);
      const state = projectLearningState(service.store, sessionId);
      const drill = service.store.lessonGoal(sessionId)?.body.mode === "drill" ? currentDrillRound(service.store, sessionId) : undefined;
      if (drill && state.phase !== "stopped") return { phase: state.phase, overridden: false, gap_recheck_requested: continueDrillGapTeaching(service.store, sessionId) };
      if (!drill && state.pending_count && state.current_task && state.goal_revision_id) return service.skipTask({ operation_id: randomUUID(), expected_goal_revision_id: state.goal_revision_id, expected_state_revision: state.state_revision, instance_revision_id: state.current_task.instance_revision_id }, sessionId);
      if (state.phase !== "stopped" || !state.goal_revision_id) return { phase: state.phase, overridden: false };
      const previous = service.store.events().filter(e => e.kind === "checkpoint" && e.branch === "real" && e.session_id === sessionId && e.payload.goal_revision_id === state.goal_revision_id).at(-1);
      const receipt = service.store.db.transaction(() => {
        const receipt = service.store.append("checkpoint", { goal_revision_id: state.goal_revision_id, summary: "Learner explicitly resumed the saved lesson; no performance is inferred", ...(drill ? { round_revision_id: drill.revision_id } : {}), next_action: previous?.payload.next_action ?? "Resume the saved task and plan", gaps: previous?.payload.gaps ?? [], stopped: false }, randomUUID(), "learner", sessionId);
        service.store.rebuild(); return receipt;
      })();
      service.ui.dispose(); return receipt;
    },
    control: (name, args, trusted) => nativeCustomization(paths, name, args, trusted),
    async feynmanResult(request, sessionId) { service.assertActiveSession(sessionId); return readFeynmanReview(service.store, request, sessionId); },
    async saveFeynman(request, review, sessionId) { service.assertActiveSession(sessionId); return saveFeynmanReview(service.store, request, review, sessionId); },
    requestRefresher: (expectedState, instanceId, sessionId) => service.requestRefresher(expectedState, instanceId, sessionId),
    async drillTeaching(enabled, expectedState, sessionId) {
      service.assertActiveSession(sessionId);
      const state = projectLearningState(service.store, sessionId);
      if (state.state_revision !== expectedState) throw new Error("Stale learning state; refresh before changing drill teaching");
      if (state.mode !== "drill") throw new Error("Start a drill lesson first");
      return enabled === undefined ? { enabled: drillGapTeachingEnabled(service.store, sessionId) } : setDrillGapTeaching(service.store, sessionId, enabled, expectedState);
    },
    async goal(body: Goal, sessionId, planning) {
      service.assertActiveSession(sessionId);
      if (planning) return commitPlannedGoal(service.store, body, sessionId, planning);
      const previous = service.store.lessonGoal(sessionId);
      const created = service.store.define({ operation_id: randomUUID(), kind: "goal", ...(previous ? { entity_id: previous.entity_id, parent_revision_id: previous.revision_id, expected_goal_revision_id: previous.revision_id } : {}), body }, "learner", sessionId);
      const goal = service.store.revision<Goal>(created.revision_id, "goal");
      return goal;
    },
    async plan(draft, sessionId, expectedGoalRevisionId, request) { service.assertActiveSession(sessionId); return commitDelegatedOutline(service.store, draft, sessionId, expectedGoalRevisionId, request); },
    async planResult(request, sessionId) { service.assertActiveSession(sessionId); return delegatedPlanResult(service.store, request, sessionId); },
    authorize: (sessionId: string) => service.authorizeDisclosure(sessionId),
    reviewControl: async (action: string, args: Record<string, unknown>, sessionId: string) => service.reviewControl(action, args, sessionId),
    source: (args, sessionId, confirmLarge) => sourceControl(service, args, sessionId, confirmLarge),
    async approvalChoices(sessionId) {
      service.assertActiveSession(sessionId);
      const goal = service.store.lessonGoal(sessionId);
      if (!goal) return [];
      const state = projectLearningState(service.store, sessionId);
      if (state.phase === "stopped" || state.pending_count > 0) throw new Error("Resume or finish current saved work before approving a new practice activity");
      const owned = new Set(service.store.events().filter(event => {
        const scope = event.payload.disclosure_scope as { goal_revision_id?: string } | undefined;
        return event.session_id === sessionId && event.branch === "real" && scope?.goal_revision_id === goal.revision_id;
      }).map(event => event.seq));
      const latest = new Map(service.store.revisions("task_definition").map(task => [task.entity_id, task]));
      return [...latest.values()].filter(task => owned.has(task.created_seq) &&
        ["candidate", "needs_review"].includes(task.body.status as string) && task.body.partition === "practice" && task.body.stakes === "low")
        .map(task => ({ revision_id: task.revision_id, title: task.body.title as string }));
    },
    async approve(id, confirm, sessionId) {
      if (!sessionId) throw new Error("Select a lesson before approving a task");
      service.assertActiveSession(sessionId);
      const task = service.store.revision<TaskDefinition>(id, "task_definition");
      const owner = service.store.events().find(e => e.seq === task.created_seq)?.session_id;
      if (owner !== sessionId || !service.store.lessonGoal(sessionId)) throw new Error("Task review belongs to another lesson conversation");
      if (task.body.status !== "candidate" && task.body.status !== "needs_review") throw new Error("Only candidate tasks need approval");
      if (confirm) return service.approveTask(id, "Learner explicitly reviewed the task/key or public rubric with /approve confirm", sessionId);
      if (task.body.answer) service.store.append("decision", { action: "task_solution_reviewed", task_entity_id: task.entity_id, reason: "Learner viewed candidate answer key", evidence_event_ids: [] }, randomUUID(), "learner", sessionId);
      return { review_required: true, review_scope: "learner_acceptance_only", expert_validation: false, task_revision_id: id, prompt: task.body.prompt, ...(task.body.choices ? { choices: task.body.choices } : {}), rubric: service.store.revision(task.body.rubric_revision_id).body, answer: task.body.answer ?? "Open-ended task: inspect public rubric", instruction: "Review these criteria/key, then confirm in the native /approve dialog (no ID needed), or use /approve ID confirm for learner acceptance of low-stakes practice, not expert validation. Viewing a key makes this item supported evidence." };
    },
    calls: async (body, sessionId) => { await requestLearning(server, "telemetry", body, sessionId); },
    async stop(sessionId) {
      service.assertActiveSession(sessionId);
      const state = projectLearningState(service.store, sessionId);
      const goal = service.store.lessonGoal(sessionId);
      if (!goal) return { stopped: true, message: "No active goal" };
      const drill = goal.body.mode === "drill" ? currentDrillRound(service.store, sessionId) : undefined;
      if (drill) { const receipt = stopDrill(service.store, drill.revision_id, sessionId); service.ui.dispose(); return receipt; }
      const context = await service.context({}, sessionId);
      const previous = context.checkpoint as { payload?: { summary?: string; next_action?: string; gaps?: string[] } } | null;
      const receipt = service.store.db.transaction(() => {
        service.assertActiveSession(sessionId);
        assertLearningTransition(service.store, sessionId, state.state_revision, false);
        const receipt = service.store.append("checkpoint", { goal_revision_id: goal.revision_id, summary: previous?.payload?.summary ?? "Stopped at learner request; inspect recorded task and evidence when resuming", next_action: previous?.payload?.next_action ?? "Resume the current component with a fresh independent task or change the goal", gaps: previous?.payload?.gaps ?? ["Current ability is unverified until the next independent observation"], stopped: true }, randomUUID(), "learner", sessionId);
        service.store.rebuild(); return receipt;
      })();
      service.ui.dispose(); return receipt;
    },
    async shutdown() { server.stop(); },
  };
}

export async function launchTutor(paths: SagePaths, service: LearningService, launchOptions: { mode?: Goal["mode"]; goal?: string } = {}): Promise<void> {
  const server = startLearningServer(service);
  const bridge = createTutorBridge(paths, service, server);
  const release = () => { server.stop(); service.close(); };
  process.once("exit", release);
  try { await runTutor(paths, bridge, undefined, launchOptions); }
  finally { process.off("exit", release); server.stop(); }
}

export async function readBrain(paths: SagePaths): Promise<string> { return readFile(paths.brain, "utf8"); }
