import { Value } from "typebox/value";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CallSchema, ContextSchema, CramSelectionSchema, DefineSchema, LearningDefineSchema, RecordSchema, SourceSchema, validate, validTime, type Artifact, type Component, type Goal, type Revision, type TaskDefinition, type TaskInstance } from "../../core/src/contracts.ts";
import { canonical, hash, LearningStore } from "../../storage/src/store.ts";
import { createCapabilityRegistry, validateDrawing } from "../../integrations/src/registry.ts";
import { SourceService } from "../../sources/src/service.ts";
import { compileContext, publicRevision } from "./context.ts";
import type { SagePaths } from "./paths.ts";
import { NativeActivitySchema, TeachingActivitySchema, type TeachingActivityRequest, type TeachingActivityOffer } from "../../core/src/interactions.ts";
import { prepareActivity } from "./interactions.ts";
import { assertCanAdvance, feedbackState } from "./feedback.ts";
import { UiRegistry, type UiJson } from "./ui/server.ts";
import { compileUI } from "./ui/compiler.ts";
import { currentDisclosure, type DisclosurePermit } from "./disclosure.ts";
import { proposeReviews, reviewQueue } from "./reviews.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { assertLearningTransition, skipLearningTask } from "./learning-controller.ts";
import { projectLearningState } from "./learning-state.ts";
import { examFormats } from "./practice-policy.ts";
import { createDrillRound, currentDrillRound, type selectDrillTask } from "./drill.ts";
import { cramProgress, type CramProgress } from "./cram.ts";
import { teachingSupport } from "./candidates.ts";
import type { NativeInputAdmission } from "./submissions.ts";
import { assertReviewComponent } from "../../storage/src/review-validation.ts";
import { publishAutomaticContent } from "./artifacts.ts";
import { prepareLesson } from "./lesson-preparation.ts";
import { prepareLearnStep } from "./learn-step.ts";
import { controlLearnFlow, type LearnControlReceipt } from "./learn-controls.ts";
import { assertInstructionDiagramReadable } from "./diagram.ts";

export type StudioApproval = (offer: { task_prompt?: string; field_labels: string[]; custom_javascript: boolean }) => Promise<{ use: "necessary" | "supplementary"; reason?: string } | undefined>;

export class LearningService {
  readonly store: LearningStore;
  readonly sources: SourceService;
  readonly capabilities = createCapabilityRegistry();
  readonly ui = new UiRegistry();
  private activeSessionId?: string;
  private sessionEpoch = 0;
  private teachingOffers = new Map<string, object>();
  activateSession(sessionId: string): { lessons: Array<{ entity_id: string; objective: string }> } {
    if (this.activeSessionId !== sessionId) { this.sessionEpoch++; this.teachingOffers.clear(); this.ui.dispose(); }
    this.activeSessionId = sessionId;
    const lessons = this.store.lessonGoals(sessionId);
    return { lessons: lessons.map(g => ({ entity_id: g.entity_id, objective: g.body.objective })) };
  }
  assertActiveSession(sessionId: string): void {
    if (this.activeSessionId && this.activeSessionId !== sessionId) throw new Error("Operation belongs to an inactive lesson conversation");
  }
  private nativeGraphPreview(sessionId: string, goalRevisionId: string): boolean {
    if (this.activeSessionId && this.activeSessionId !== sessionId) return false;
    const goal = this.store.lessonGoal(sessionId);
    if (goal?.revision_id !== goalRevisionId || !goal.body.provider_sharing || goal.body.mode !== "learn") return false;
    const state = projectLearningState(this.store, sessionId);
    const instruction = state.phase === "instruction_pending" || state.phase === "question_pending" && state.teaching?.instance_revision_id === null;
    return state.phase !== "stopped" && (state.pending_count === 0 || instruction);
  }
  constructor(readonly paths: SagePaths) {
    this.store = new LearningStore(join(paths.data, "learning.sqlite"));
    this.sources = new SourceService(this.store, join(paths.data, "blobs"));
  }
  inputAdmission(sessionId: string): NativeInputAdmission {
    this.assertActiveSession(sessionId);
    const epoch = this.sessionEpoch, throughSeq = this.store.throughSeq;
    let goalRevisionId = this.store.lessonGoal(sessionId)?.revision_id;
    const workBoundary = () => {
      const state = projectLearningState(this.store, sessionId), task = state.current_task;
      return task ? canonical({ instance_revision_id: task.instance_revision_id, definition_revision_id: task.definition_revision_id, rubric_revision_id: task.rubric_revision_id, response_event_id: task.response_event_id, attempt_id: task.attempt_id, assessment_event_id: task.assessment_event_id, overridden: task.overridden, phase: state.phase, resume_phase: state.resume_phase ?? null, pending: state.pending_count > 0 }) : "unbound";
    };
    const originalWork = workBoundary();
    const assertArrival = () => {
      this.assertActiveSession(sessionId);
      if (workBoundary() !== originalWork) throw new Error("Original task or work changed after native input arrived; resubmit for the current task");
      if (epoch !== this.sessionEpoch || this.store.events().some(e => e.seq > throughSeq && e.session_id === sessionId && e.branch === "real" && (e.kind === "checkpoint" && e.payload.stopped === true || e.kind === "learner_response" && e.actor === "learner" && !["control", "message"].includes(e.payload.input_kind as string)))) throw new Error("Native input arrival is stale; resubmit after the learner control or newer work");
    };
    return {
      assertCurrent: () => {
        assertArrival();
        if (this.store.lessonGoal(sessionId)?.revision_id !== goalRevisionId) throw new Error("Goal changed after native input arrived; resubmit");
      },
      assertScopeCurrent: () => {
        this.assertActiveSession(sessionId);
        // Capturing work may reopen its task; only the new response/artifact receipts are permitted.
        if (epoch !== this.sessionEpoch || this.store.lessonGoal(sessionId)?.revision_id !== goalRevisionId || this.store.events().some(e => e.seq > throughSeq && e.session_id === sessionId && e.branch === "real" && e.kind !== "learner_response" && !(e.kind === "decision" && e.payload.action === "revision_defined" && e.payload.kind === "artifact"))) throw new Error("Original native scope changed after input capture");
      },
      goalCreated: revisionId => {
        assertArrival();
        if (goalRevisionId !== undefined || !revisionId || this.store.lessonGoal(sessionId)?.revision_id !== revisionId) throw new Error("Native intake must bind its own newly created goal");
        goalRevisionId = revisionId;
      },
    };
  }
  async context(input: unknown, sessionId: string): Promise<Record<string, unknown>> {
    this.assertActiveSession(sessionId);
    const brain = await readFile(this.paths.brain, "utf8").catch(() => "");
    return compileContext(this.store, input, brain, sessionId);
  }
  learnControl(input: unknown, sessionId: string): LearnControlReceipt {
    this.assertActiveSession(sessionId);
    return controlLearnFlow(this.store, input, sessionId);
  }
  ensureLessonGoal(sessionId: string, objective = "General learning", mode: Goal["mode"] = "learn"): Revision<Goal> {
    const existing = this.store.lessonGoal(sessionId);
    // An existing denial is a learner control, never implicit permission to revise it.
    if (existing) return existing;
    const defined = this.store.define({
      operation_id: randomUUID(),
      kind: "goal",
      body: {
        mode,
        objective,
        subject: "practical",
        horizon_days: 7,
        budget_minutes: 30,
        target_format: "Goal-appropriate independent work",
        criteria: ["Demonstrate understanding and application"],
        allowed_aids: [],
        constraints: [],
        prior_experience: "unsure",
        probe: "offer",
        provider_sharing: true,
        source_ids: [],
      },
    }, "learner", sessionId);
    return this.store.revision<Goal>(defined.revision_id, "goal");
  }
  /** Trusted transport authorization, deliberately not a model tool. */
  async authorizeDisclosure(sessionId: string): Promise<DisclosurePermit> {
    this.assertActiveSession(sessionId);
    const goal = this.store.lessonGoal(sessionId);
    const state = currentDisclosure(this.store, sessionId);
    if (!goal || !state.allowed) throw new Error(`Current disclosure authorization denied: ${state.reason}`);
    const seq = this.store.throughSeq;
    const packet = await this.context({}, sessionId);
    const images = await this.sources.originalImages(goal.body.source_ids);
    this.assertActiveSession(sessionId);
    if (this.store.throughSeq !== seq || this.store.lessonGoal(sessionId)?.revision_id !== goal.revision_id) throw new Error("Current disclosure authorization changed while compiling context");
    return { session_id: sessionId, revision: `${sessionId}:${goal.revision_id}:${seq}`, packet, ...(images.length ? { images } : {}) };
  }
  reviewControl(action: string, args: Record<string, unknown>, sessionId: string): Record<string, unknown> {
    this.assertActiveSession(sessionId);
    return this.store.db.transaction(() => {
    const goal = this.store.lessonGoal(sessionId);
    const queue = reviewQueue(this.store, sessionId);
    if (action === "list" || action === "inspect") {
      const components = this.store.revisions("component").map(r => this.store.revision<Component>(r.revision_id, "component"));
      const views = projectComponents(this.store, this.store.throughSeq, this.store.now(), sessionId);
      const proposals = goal ? proposeReviews(goal.body, views, components, this.store.now()) : [];
      return { queue, proposals };
    }
    if (!goal) throw new Error("Select a lesson before managing reviews");
    if (action === "accept") {
      const compId = args.component_revision_id as string;
      if (!compId) throw new Error("Provide component_revision_id to accept a review offer");
      assertReviewComponent(this.store, compId, sessionId, goal);
      const dueAt = args.due_at ? validTime(args.due_at as string) : new Date(Date.parse(this.store.now()) + 2 * 86400000).toISOString();
      if (Date.parse(dueAt) <= Date.parse(this.store.now())) throw new Error("Review offer date must be in the future");
      if (goal.body.deadline && Date.parse(dueAt) > Date.parse(goal.body.deadline)) {
        throw new Error("Review date cannot be scheduled beyond the active lesson deadline");
      }
      const existing = queue.find(r => r.component_revision_id === compId && r.status !== "unresolved" && r.due_at === dueAt);
      if (existing) return { scheduled: existing.status === "pending", duplicate: true, status: existing.status, schedule_event_id: existing.schedule_event_id, due_at: dueAt };
      const auth = this.store.append("decision", {
        action: "review_offer_authorized",
        lesson_goal_entity_id: goal.entity_id,
        goal_revision_id: goal.revision_id,
        component_revision_id: compId,
        due_at: dueAt,
        offer_action: "accept",
        reason: (args.reason as string) || "Learner accepted review offer",
        evidence_event_ids: [],
      }, randomUUID(), "host", sessionId);
      const consent = this.store.append("learner_response", { text: `Accept review for ${compId} at ${dueAt}`, input_kind: "control", review_authorization_event_id: auth.event_id }, randomUUID(), "learner", sessionId);
      const scheduled = this.store.record({
        operation_id: randomUUID(),
        kind: "review_scheduled",
        expected_goal_revision_id: goal.revision_id,
        payload: {
          component_revision_id: compId,
          due_at: dueAt,
          consent: true,
          consent_response_event_id: consent.event_id,
          authorization_event_id: auth.event_id,
          reason: (args.reason as string) || "Learner accepted review offer",
        },
      }, sessionId);
      return { scheduled: true, schedule_event_id: scheduled.event_id, due_at: dueAt, component_revision_id: compId };
    }
    if (action === "decline") {
      const compId = args.component_revision_id as string;
      if (!compId) throw new Error("Provide component_revision_id to decline");
      assertReviewComponent(this.store, compId, sessionId, goal);
      this.store.append("decision", {
        action: "review_declined",
        lesson_goal_entity_id: goal.entity_id,
        goal_revision_id: goal.revision_id,
        component_revision_id: compId,
        reason: (args.reason as string) || "Learner declined review offer",
        evidence_event_ids: [],
      }, randomUUID(), "host", sessionId);
      return { declined: true, component_revision_id: compId };
    }
    if (action === "cancel") {
      const schedId = args.schedule_event_id as string;
      if (!schedId) throw new Error("Provide schedule_event_id to cancel");
      const item = queue.find(r => r.schedule_event_id === schedId);
      if (!item || item.status !== "pending") throw new Error("Scheduled review not found or not pending");
      this.store.append("decision", {
        action: "review_cancelled",
        lesson_goal_entity_id: goal.entity_id,
        goal_revision_id: goal.revision_id,
        schedule_event_id: schedId,
        reason: (args.reason as string) || "Learner cancelled scheduled review",
        evidence_event_ids: [],
      }, randomUUID(), "host", sessionId);
      return { cancelled: true, schedule_event_id: schedId };
    }
    if (action === "reschedule") {
      const schedId = args.schedule_event_id as string;
      const newDueAt = validTime(args.due_at as string);
      if (!schedId || !newDueAt) throw new Error("Provide schedule_event_id and due_at to reschedule");
      if (Date.parse(newDueAt) <= Date.parse(this.store.now())) throw new Error("New review date must be in the future");
      if (goal.body.deadline && Date.parse(newDueAt) > Date.parse(goal.body.deadline)) {
        throw new Error("Review date cannot be scheduled beyond the active lesson deadline");
      }
      const item = queue.find(r => r.schedule_event_id === schedId);
      if (!item || item.status !== "pending") throw new Error("Scheduled review not found or not pending");
      assertReviewComponent(this.store, item.component_revision_id, sessionId, goal);
      const auth = this.store.append("decision", {
        action: "review_offer_authorized",
        lesson_goal_entity_id: goal.entity_id,
        goal_revision_id: goal.revision_id,
        component_revision_id: item.component_revision_id,
        due_at: newDueAt,
        offer_action: "reschedule",
        schedule_event_id: schedId,
        reason: "Learner rescheduled review",
        evidence_event_ids: [],
      }, randomUUID(), "host", sessionId);
      const consent = this.store.append("learner_response", { text: `Reschedule review for ${item.component_revision_id} to ${newDueAt}`, input_kind: "control", review_authorization_event_id: auth.event_id }, randomUUID(), "learner", sessionId);
      const scheduled = this.store.record({
        operation_id: randomUUID(),
        kind: "review_scheduled",
        expected_goal_revision_id: goal.revision_id,
        payload: {
          component_revision_id: item.component_revision_id,
          due_at: newDueAt,
          consent: true,
          consent_response_event_id: consent.event_id,
          authorization_event_id: auth.event_id,
          reason: "Rescheduled review",
        },
      }, sessionId);
      this.store.append("decision", { action: "review_rescheduled", lesson_goal_entity_id: goal.entity_id, goal_revision_id: goal.revision_id, schedule_event_id: schedId, replacement_schedule_event_id: scheduled.event_id, new_due_at: newDueAt, reason: (args.reason as string) || "Learner rescheduled review", evidence_event_ids: [] }, randomUUID(), "host", sessionId);
      return { rescheduled: true, schedule_event_id: scheduled.event_id, due_at: newDueAt };
    }
    throw new Error(`Unknown review control action: ${action}`);
    })();
  }
  approveTask(revisionId: string, reason: string, selectedSession?: string): Record<string, unknown> {
    const task = this.store.revision<TaskDefinition>(revisionId, "task_definition");
    const owner = this.store.events().find(e => e.seq === task.created_seq)?.session_id;
    const sessionId = selectedSession ?? owner;
    if (!sessionId || owner !== sessionId) throw new Error("Task belongs to another lesson conversation");
    this.assertActiveSession(sessionId);
    const approved = this.store.define({ operation_id: randomUUID(), kind: "task_definition", entity_id: task.entity_id, parent_revision_id: task.revision_id, expected_goal_revision_id: this.store.lessonGoal(sessionId)?.revision_id, body: { ...task.body, status: "practice_ready", review: { method: "human", reviewer_role: "learner", reason } } }, "learner", sessionId);
    return { ...publicRevision(approved) };
  }
  /** Explicit learner control, never callable by a model. Text/file existence is not semantic proof. */
  async importArtifact(capability: string, filename: string, instanceId?: string, selectedSession?: string): Promise<Revision> {
    if (!["drawing", "code", "voice_transcript", "graph_state"].includes(capability)) throw new Error("Supported artifact types: drawing, code, voice_transcript, graph_state");
    const file = Bun.file(filename);
    if (file.size > 12000) throw new Error("Artifact import is limited to 12000 UTF-8 characters; large binary adapters are deferred");
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 12000 || !text.trim() || text.includes("\0")) throw new Error("Expected a nonempty bounded text artifact");
    const content = capability === "drawing" ? validateDrawing(text) : text;
    const instance = instanceId ? this.store.revision(instanceId, "task_instance") : undefined;
    const sessionId = selectedSession ?? (instance && this.store.events().find(e => e.seq === instance.created_seq)?.session_id);
    if (!sessionId) throw new Error("Select a lesson conversation or task instance before importing learner work");
    this.assertActiveSession(sessionId);
    const goal = this.store.lessonGoal(sessionId);
    if (!goal) throw new Error("Set a goal before importing learner work");
    if (instanceId && this.store.revision<TaskInstance>(instanceId, "task_instance").body.goal_revision_id !== goal.revision_id) throw new Error("Artifact task is not in the current goal");
    const operation = `artifact-import:${hash(canonical({ capability, content, instanceId, goal: goal.revision_id }))}`;
    const artifact = this.store.db.transaction(() => {
      const response = this.store.learnerResponse(text, sessionId, `${operation}:response`, { goal_revision_id: goal.revision_id, ...(instanceId ? { instance_revision_id: instanceId } : {}) });
      return this.store.define({ operation_id: operation, kind: "artifact", expected_goal_revision_id: goal.revision_id, body: {
        capability, goal_revision_id: goal.revision_id, ...(instanceId ? { instance_revision_id: instanceId } : {}), author: "learner", provenance: "Explicit local-file submission by learner; authorship self-declared, external help may be unobserved",
        media_type: capability === "drawing" ? "application/vnd.excalidraw+json" : "text/plain", content, evidence_kind: "artifact_only", interpretation_uncertainty: "File submitted, not proof of graphical relations, code execution, pronunciation or understanding", response_event_id: response.event_id, assistance_event_ids: [],
      } }, "learner", sessionId);
    })();
    await publishAutomaticContent(this.paths, this.store, artifact.revision_id);
    return artifact;
  }
  async renderUi(source: string, sessionId: string, baseUrl: string, resume: (receipt: UiJson) => void, approve?: StudioApproval) {
    this.assertActiveSession(sessionId);
    const goal = this.store.lessonGoal(sessionId);
    if (!goal?.body.provider_sharing) throw new Error("Start a sharing-authorized /learn or /exam goal first");
    if (goal.body.source_ids.some(id => this.store.sourceStatus(id) !== "indexed")) throw new Error("A selected source is no longer eligible for this browser UI");
    if (goal.body.learning_preferences?.features.browser_ui === false) throw new Error("Browser activities are disabled in this learning preview");
    const instance = this.store.revisions("task_instance").filter(r => r.body.goal_revision_id === goal.revision_id).at(-1);
    const request = instance ? { action: "scrap_work" as const, operation_id: randomUUID(), expected_goal_revision_id: goal.revision_id, instance_revision_id: instance.revision_id } : undefined;
    const prepared = request ? prepareActivity(this.store, request, sessionId) : undefined;
    const review = feedbackState(this.store, sessionId);
    if (request && "instance_revision_id" in review && review.instance_revision_id !== request.instance_revision_id) assertCanAdvance(this.store, sessionId);
    const compiled = compileUI(source);
    const createdSeq = this.store.throughSeq, epoch = this.sessionEpoch;
    const stateRevision = projectLearningState(this.store, sessionId).state_revision;
    const scope = { goal_revision_id: goal.revision_id, instance_revision_id: instance?.revision_id ?? null,
      definition_revision_id: instance?.body.definition_revision_id ?? null, source_hash: hash(source) };
    const lastStop = this.store.events().filter(e => e.branch === "real" && e.session_id === sessionId && e.kind === "checkpoint" && e.payload.stopped).at(-1)?.seq ?? 0;
    const approved = request && this.store.events().some(e => e.seq > lastStop && e.branch === "real" && e.actor === "host" && e.session_id === sessionId && e.kind === "decision" && e.payload.action === "studio_approval" && e.payload.use === "necessary" && canonical(e.payload.scope) === canonical(scope));
    let closed = false, id = "", receipt: UiJson | undefined, resumed = false;
    const authorize = () => {
      if (closed || this.sessionEpoch !== epoch || projectLearningState(this.store, sessionId).phase === "stopped" || (this.activeSessionId && this.activeSessionId !== sessionId) || goal.body.source_ids.some(id => this.store.sourceStatus(id) !== "indexed") || this.store.lessonGoal(sessionId)?.revision_id !== goal.revision_id || !this.store.lessonGoal(sessionId)?.body.provider_sharing || this.store.events().some(e => e.seq > createdSeq && e.session_id === sessionId && e.kind === "checkpoint" && e.payload.stopped)) return false;
      try { if (request) prepareActivity(this.store, request, sessionId); return true; } catch { return false; }
    };
    if (!authorize()) throw new Error("Studio scope changed; refresh the current task");
    if (!approved) {
      if (!approve) throw new Error("Studio requires explicit native approval; prefer native/open-ended work");
      const decision = await approve({ ...(prepared ? { task_prompt: prepared.prompt } : {}),
        field_labels: compiled.messages[1].updateComponents.components.filter(c => c.component === "TextField").map(c => String(c.label)), custom_javascript: !!compiled.script });
      if (!authorize() || projectLearningState(this.store, sessionId).state_revision !== stateRevision) throw new Error("Studio scope changed during native review; refresh the current task");
      if (!decision || !["necessary", "supplementary"].includes(decision.use) || (decision.use === "necessary" && (!request || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000))) throw new Error("Studio was not approved; continue in the native view");
      this.store.append("decision", { action: "studio_approval", use: decision.use, ...scope, scope,
        reason: decision.use === "necessary" ? decision.reason!.trim() : "Learner approved this supplementary opening only",
        evidence_event_ids: [], policy_version: "studio-admission-1" }, `studio-approval:${randomUUID()}`, "host", sessionId);
    }
    const created = this.ui.create(source, { authorize, ...(prepared ? { activity: { prompt: prepared.prompt, criteria: prepared.criteria } } : {}), ...(request ? { onSubmit: (text: string) => {
      if (!authorize()) throw new Error("Activity scope changed");
      if (!receipt) receipt = this.store.db.transaction(() => {
        const response = this.store.learnerResponse(text, sessionId, `studio-response:${id}`, { goal_revision_id: goal.revision_id, instance_revision_id: request.instance_revision_id });
        const attemptId = `studio-attempt:${id}`;
        this.store.record({ operation_id: attemptId, kind: "attempt_submitted", expected_goal_revision_id: goal.revision_id, payload: { attempt_id: attemptId, instance_revision_id: request.instance_revision_id, response_event_id: response.event_id, declared_aids: [] } }, sessionId);
        return { response_event_id: response.event_id, attempt_id: attemptId, instance_revision_id: request.instance_revision_id, review_required: !!goal.body.learning_preferences?.review_before_advance };
      })();
      if (!resumed) { resume(receipt); resumed = true; }
      return receipt;
    } } : {}), onCancel: () => { closed = true; return { cancelled: true, evidence_recorded: false }; } });
    id = created.id;
    if (request && /^---js\s*$/m.test(source)) {
      const task = this.store.revision<TaskDefinition>(instance!.body.definition_revision_id as string).body;
      this.store.record({ operation_id: `studio-help:${id}`, kind: "assistance", expected_goal_revision_id: goal.revision_id, payload: { assistance_id: `studio:${id}`, instance_revision_id: request.instance_revision_id, component_revision_ids: task.component_revision_ids, stage: "possibly_exposed", kind: "external", content: "Custom browser code was available; opt-in/use and resulting help are unobserved by the scorer", answer_bearing: true } }, sessionId);
    }
    return { ...created, url: `${baseUrl}${created.path}`, awaiting_submission: !!request, preview_only: !request, custom_javascript: "off until explicit trusted browser opt-in" };
  }
  skipTask(input: unknown, sessionId: string) {
    this.assertActiveSession(sessionId);
    const before = this.store.throughSeq;
    const receipt = skipLearningTask(this.store, input, sessionId);
    if (this.store.throughSeq !== before) this.ui.dispose();
    return receipt;
  }
  async requestRefresher(expectedState: string, instanceId: string, sessionId: string) {
    await this.authorizeDisclosure(sessionId);
    return this.store.db.transaction(() => {
      this.assertActiveSession(sessionId);
      const state = projectLearningState(this.store, sessionId), goal = this.store.lessonGoal(sessionId)!;
      if (state.state_revision !== expectedState || state.current_task?.instance_revision_id !== instanceId || !state.pending_count || state.phase === "stopped") throw new Error("Refresher request is stale or has no pending current task");
      const task = this.store.revision<TaskDefinition>(state.current_task.definition_revision_id, "task_definition").body;
      const instance = this.store.revision<TaskInstance>(instanceId, "task_instance");
      const frozenGoal = this.store.revision<Goal>(instance.body.goal_revision_id, "goal");
      const events = this.store.events().filter(e => e.branch === "real" && e.session_id === sessionId);
      const delivery = events.find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instanceId);
      const annotation = events.find(e => e.actor === "host" && e.payload.action === "cram_task_selected" && e.payload.lesson_goal_entity_id === frozenGoal.entity_id && Value.Check(CramSelectionSchema, e.payload.cram_selection) && e.payload.cram_selection.instance_revision_id === instanceId && (e.payload.evidence_event_ids as string[]).includes(delivery?.event_id ?? ""))?.payload.cram_selection;
      const stage = Value.Check(CramSelectionSchema, annotation) ? annotation.stage : undefined;
      const measurement = instance.body.purpose === "exam" || frozenGoal.body.mode === "exam" || frozenGoal.body.mode === "cram" && stage !== "repair" && stage !== "intervening";
      if (measurement && (!task.allowed_aids.includes("tutor refresher") || !goal.body.allowed_aids.includes("tutor refresher"))) throw new Error("Frozen exam/measurement aids forbid refreshers unless 'tutor refresher' is explicit in both the frozen task and current declared aids. Start fresh permitted practice; do not rewrite frozen aids.");
      if (!task.refresher || task.status !== "practice_ready" || task.review.method === "unreviewed" || !task.source_span_ids.every(id => goal.body.source_ids.includes(this.store.acceptedSpan(id).source_revision_id))) throw new Error("No authorized reviewed concise refresher is available for this task");
      const assistanceId = randomUUID(), payload = { assistance_id: assistanceId, instance_revision_id: instanceId, component_revision_ids: task.component_revision_ids, kind: "cue", content: task.refresher, answer_bearing: true, stage: "requested" };
      validate(RecordSchema, { operation_id: assistanceId, kind: "assistance", expected_goal_revision_id: goal.revision_id, payload });
      this.store.append("assistance", payload, `${assistanceId}:requested`, "learner", sessionId);
      this.store.append("assistance", { ...payload, stage: "exposed" }, `${assistanceId}:exposed`, "host", sessionId);
      this.store.rebuild();
      return { text: task.refresher, assistance_id: assistanceId, limitation: "Requested reviewed refresher queued for display, not proof of reading; recorded as answer-bearing assistance." };
    })();
  }
  private currentCramProgress(sessionId: string, goal: Revision<Goal>): CramProgress {
    const owned = new Set(this.store.events().filter(e => e.session_id === sessionId && e.branch === "real").map(e => e.seq));
    const revisions = this.store.revisions();
    const components = revisions.filter(r => r.kind === "component" && owned.has(r.created_seq)).map(r => this.store.revision<Component>(r.revision_id, "component"));
    const tasks = revisions.filter(r => r.kind === "task_definition" && owned.has(r.created_seq)).map(r => this.store.revision<TaskDefinition>(r.revision_id, "task_definition"));
    const rubrics = revisions.filter(r => r.kind === "rubric").map(r => this.store.revision<import("../../core/src/contracts.ts").Rubric>(r.revision_id, "rubric"));
    const views = projectComponents(this.store, this.store.throughSeq, this.store.now(), sessionId).filter(v => components.some(c => c.revision_id === v.component_revision_id));
    return cramProgress(this.store, sessionId, goal, views, components, tasks, rubrics, this.store.now());
  }
  private recordCramSelection(selection: NonNullable<CramProgress["selection"]>, instance: { revision_id: string }, operationId: string, goal: Revision<Goal>, sessionId: string): void {
    const annotation = { ...selection.cram, instance_revision_id: instance.revision_id };
    validate(CramSelectionSchema, annotation);
    const delivery = this.store.events().find(e => e.kind === "task_delivered" && e.payload.instance_revision_id === instance.revision_id)!;
    this.store.append("decision", { action: "cram_task_selected", lesson_goal_entity_id: goal.entity_id, goal_revision_id: goal.revision_id, cram_selection: annotation, reason: "Host frozen engineering allocation/stage; only subsequent owned work and feedback establish observations", evidence_event_ids: [delivery.event_id] }, operationId, "host", sessionId);
    this.store.rebuild();
  }
  /** Native bridge only: explicit continuation authorizes release, not delivery or understanding. */
  async offerTeaching(input: TeachingActivityRequest, sessionId: string): Promise<TeachingActivityOffer> {
    validate<TeachingActivityRequest>(TeachingActivitySchema, input);
    this.assertActiveSession(sessionId);
    const pins = { schema_version: 1 as const, unit_id: input.unit_id, goal_revision_id: input.expected_goal_revision_id, component_revision_id: input.component_revision_id, instruction_revision_id: input.instruction_revision_id, definition_revision_id: input.definition_revision_id };
    let cramSelection: CramProgress["selection"] = null;
    const checkScope = () => {
      this.assertActiveSession(sessionId);
      const goal = this.store.lessonGoal(sessionId);
      if (goal?.revision_id !== pins.goal_revision_id || !currentDisclosure(this.store, sessionId).allowed) throw new Error("Teaching goal or disclosure permission changed");
      // Constrained modes require their governed selection and delivery bookkeeping, not just continuation.
      if (goal.body.mode === "cram") {
        const progress = this.currentCramProgress(sessionId, goal);
        const selection = progress.selection;
        const task = this.store.revision<TaskDefinition>(pins.definition_revision_id, "task_definition").body;
        if (progress.status !== "ready" || !selection || !["repair", "intervening"].includes(selection.cram.stage) || selection.purpose !== "practice" || selection.definition_revision_id !== pins.definition_revision_id || !task.component_revision_ids.includes(pins.component_revision_id) || !selection.teaching_support || task.allowed_aids.some(a => !goal.body.allowed_aids.includes(a)) || (examFormats(goal.body).length && !examFormats(goal.body).includes(task.format))) throw new Error("Native teaching is not supported outside the current eligible governed cram repair/intervening selection");
        cramSelection = selection;
      } else if (["exam", "drill"].includes(goal.body.mode)) throw new Error("Native teaching is not supported in exam or drill mode; use the governed mode delivery path");
      const definition = this.store.revision<TaskDefinition>(pins.definition_revision_id, "task_definition");
      if (this.store.revisions("task_definition").filter(r => r.entity_id === definition.entity_id).at(-1)?.revision_id !== definition.revision_id) throw new Error("Teaching question was superseded");
      if (definition.body.partition !== "practice") throw new Error("Guided teaching cannot release an evaluation or protected question");
      const state = projectLearningState(this.store, sessionId);
      const flow = state.learn_flow, draft = flow?.draft;
      if (flow?.component_revision_id && flow.component_revision_id !== pins.component_revision_id) throw new Error("Host learn flow requires the current component; changing targets needs a separate native choice");
      if (flow?.protocol_active && (draft ? draft.review_required || draft.unit_id !== pins.unit_id || draft.definition_revision_id !== pins.definition_revision_id || draft.instruction_revision_id !== pins.instruction_revision_id : state.teaching?.unit_id !== pins.unit_id)) throw new Error("Host learn flow binding is stale or is not the exact reviewed instruction/question binding");
      if (state.phase === "stopped" || state.current_task && state.pending_count > 0 || state.teaching && !["unit_complete", "checkpoint"].includes(state.teaching.stage) && state.teaching.unit_id !== pins.unit_id) throw new Error("Current owned work is pending or stopped");
      return state;
    };
    let state = checkScope();
    const prepared = this.store.events().find(e => e.kind === "decision" && e.actor === "host" && e.session_id === sessionId && e.payload.action === "teaching_stage" && (e.payload.teaching as { unit_id?: string; stage?: string } | undefined)?.unit_id === pins.unit_id && (e.payload.teaching as { stage?: string }).stage === "prepared");
    if (this.store.events().some(e => e.operation_id === `teaching:${input.operation_id}:authorized`)) throw new Error("Teaching continuation operation was already consumed");
    const instruction = this.store.revision<Artifact>(pins.instruction_revision_id, "artifact");
    if (!instruction.body.media_type.startsWith("text/") || instruction.body.content.length > 4000 || !instruction.body.content.trim()) throw new Error("Teaching instruction must be bounded text");
    let preparedId: string;
    if (prepared) {
      preparedId = prepared.event_id;
      this.store.validateTeachingAnnotation({ ...pins, stage: "presented", prepared_event_id: preparedId }, sessionId, pins.goal_revision_id, this.store.throughSeq, this.store.now());
    } else {
      if (state.pending_count) throw new Error("Current owned work is pending");
      const annotation = this.store.validateTeachingAnnotation({ ...pins, stage: "prepared" }, sessionId, pins.goal_revision_id, this.store.throughSeq, this.store.now());
      preparedId = this.store.append("decision", { action: "teaching_stage", teaching: annotation, reason: "Pinned bounded instruction and reviewed guided question; no learner performance inferred", evidence_event_ids: [] }, `teaching:${input.operation_id}:prepared`, "host", sessionId).event_id;
      this.store.rebuild();
    }
    state = checkScope();
    const boundary = state.state_revision, epoch = this.sessionEpoch, contentHash = instruction.content_hash;
    const governedSelection = cramSelection ? canonical(cramSelection) : null;
    const producer = {}, key = `${sessionId}:${pins.unit_id}`;
    this.teachingOffers.set(key, producer);
    let consumed = false;
    return { instruction: instruction.body.content, content_hash: contentHash, continue: async () => {
      if (consumed) throw new Error("Teaching continuation callback was already consumed");
      consumed = true;
      return this.store.db.transaction(() => {
        const current = checkScope();
        if ((cramSelection ? canonical(cramSelection) : null) !== governedSelection) throw new Error("Teaching selection or frozen allocation changed; refresh the governed offer");
        if (this.teachingOffers.get(key) !== producer || epoch !== this.sessionEpoch || current.state_revision !== boundary || current.phase !== "instruction_pending" || current.teaching?.prepared_event_id !== preparedId || this.store.revision(pins.instruction_revision_id, "artifact").content_hash !== contentHash) throw new Error("Teaching continuation is stale or foreign");
        const annotation = this.store.validateTeachingAnnotation({ ...pins, stage: "presented", prepared_event_id: preparedId }, sessionId, pins.goal_revision_id, this.store.throughSeq, this.store.now());
        this.store.append("decision", { action: "teaching_stage", teaching: annotation, reason: "Explicit native continuation authorized this pinned question only; not delivery, reading, understanding, consent or competence", evidence_event_ids: [preparedId] }, `teaching:${input.operation_id}:authorized`, "host", sessionId);
        const instance = this.store.define({ operation_id: `teaching:${input.operation_id}:question`, kind: "task_instance", expected_goal_revision_id: pins.goal_revision_id, body: { definition_revision_id: pins.definition_revision_id, goal_revision_id: pins.goal_revision_id, purpose: "practice", conditions: ["Guided teaching check; answer-bearing instruction may have been exposed"] } }, "host", sessionId);
        if (cramSelection) this.recordCramSelection(cramSelection, instance, `cram-selection:${instance.revision_id}`, this.store.lessonGoal(sessionId)!, sessionId);
        const definition = this.store.revision<TaskDefinition>(pins.definition_revision_id, "task_definition");
        // define records pinned tutor artifacts as possibly-exposed answer-bearing assistance before return.
        const linked = this.store.validateTeachingAnnotation({ ...pins, stage: "linked", prepared_event_id: preparedId, instance_revision_id: instance.revision_id }, sessionId, pins.goal_revision_id, this.store.throughSeq, this.store.now());
        this.store.append("decision", { action: "teaching_stage", teaching: linked, reason: "Released the authorized guided question with frozen rubric and aids", evidence_event_ids: [preparedId] }, `teaching:${input.operation_id}:linked`, "host", sessionId);
        this.store.rebuild();
        return { instance_revision_id: instance.revision_id, prompt: definition.body.prompt };
      })();
    } };
  }
  async operation(name: string, body: unknown, sessionId: string): Promise<unknown> {
    this.assertActiveSession(sessionId);
    switch (name) {
      case "learning_context": return this.context(body, sessionId);
      case "learning_activity": {
        validate<import("../../core/src/interactions.ts").NativeActivityRequest>(NativeActivitySchema, body);
        if (body.action === "teaching") return { awaiting_continuation: true, unit_id: body.unit_id, instruction: "Only the registered native activity can authorize this pinned question; model/chat markers do not release it." };
        const packet = prepareActivity(this.store, body, sessionId);
        const state = feedbackState(this.store, sessionId);
        if ("instance_revision_id" in state && state.instance_revision_id !== packet.request.instance_revision_id) assertCanAdvance(this.store, sessionId);
        const prefs = this.store.lessonGoal(sessionId)?.body.learning_preferences;
        const feature = packet.request.action === "open_response" ? undefined : packet.request.action === "mcq" ? "mcq" : packet.request.action === "feynman" ? "teach_back" : "scrap_work";
        if (feature && prefs?.features[feature] === false) throw new Error("This activity is disabled in the learner's selected preview");
        return packet;
      }
      case "learning_define": {
        if (body !== null && typeof body === "object" && "kind" in body && body.kind === "learn_step") {
          const prepared = prepareLearnStep(this.store, body, sessionId);
          if (prepared.instruction_revision_id) await publishAutomaticContent(this.paths, this.store, prepared.instruction_revision_id);
          return prepared;
        }
        if (body !== null && typeof body === "object" && "kind" in body && body.kind === "lesson_preparation") {
          const replay = "operation_id" in body && typeof body.operation_id === "string" && this.store.events().some(event => event.operation_id === `lesson-preparation:${body.operation_id}` && event.session_id === sessionId && event.actor === "host");
          const goal = this.store.lessonGoal(sessionId);
          const controlled = goal?.body.mode === "learn" && this.store.events().some(event => event.actor === "host" && event.session_id === sessionId && event.payload.action === "learn_step_prepared" && event.payload.goal_revision_id === goal.revision_id);
          if (controlled && !replay) throw new Error("Host learn flow requires learning_define kind=learn_step; use the current contract and native Continue, not legacy lesson setup");
          const prepared = prepareLesson(this.store, body, sessionId);
          await publishAutomaticContent(this.paths, this.store, prepared.instruction_revision_id);
          return prepared;
        }
        validate<{ operation_id: string; kind: string; expected_state_revision?: string; body: Record<string, unknown> }>(DefineSchema, body);
        if (body.kind === "artifact" && body.body.capability === "study_journal") throw new Error("Study journals require the native /journal preview and confirmation");
        if (body.kind === "artifact" && body.body.capability === "instruction_diagram") throw new Error("Instruction diagrams require the protected current-instruction drawing helper");
        const result = this.store.db.transaction(() => {
          // Replays use the store's content/session-checked immutable definition receipt.
          const existing = this.store.db.query("SELECT revision_id FROM object_revision WHERE operation_id=?").get(body.operation_id);
          if (!existing) {
            if (body.kind === "task_instance" || body.kind === "goal") assertCanAdvance(this.store, sessionId);
            assertLearningTransition(this.store, sessionId, body.expected_state_revision, body.kind === "task_instance");
          }
          const goal = this.store.lessonGoal(sessionId);
          const controlled = goal?.body.mode === "learn" && this.store.events().some(event => event.actor === "host" && event.session_id === sessionId && event.payload.action === "learn_step_prepared" && event.payload.goal_revision_id === goal.revision_id);
          const protectedImport = body.kind === "task_definition" && body.body.partition === "protected";
          // Legacy library proposals do not advance learning; delivery and goal changes stay native-only.
          if (!existing && goal?.body.mode === "learn" && (body.kind === "task_instance" || body.kind === "goal" || controlled && body.kind !== "artifact" && !protectedImport)) throw new Error("Host learn flow requires learning_define kind=learn_step for authored learning objects and native Continue for question release");
          if (!existing && body.kind === "task_instance" && goal && ["learn", "accelerate"].includes(goal.body.mode) && body.body.purpose === "practice") {
            const task = this.store.revision<TaskDefinition>(body.body.definition_revision_id as string, "task_definition").body;
            const views = projectComponents(this.store, this.store.throughSeq, this.store.now(), sessionId);
            if (task.component_revision_ids.some(id => teachingSupport(views.find(v => v.component_revision_id === id), this.store.revision<Component>(id, "component").body, views).support !== "light")) throw new Error("Supported practice requires paced instruction through the native teaching unit; frozen independent measurement remains separate");
          }
          if (!existing && body.kind === "goal" && goal?.body.mode === "drill" && (body.body.mode !== "drill" || body.body.objective !== goal.body.objective || body.body.subject !== goal.body.subject)) throw new Error("Drill mode and objective changes require trusted learner controls");
          if (!existing && body.kind === "drill_round" && goal?.body.mode === "drill") throw new Error("Owned drill rounds are created from the current drill selection and task delivery");
          const drill = !existing && body.kind === "task_instance" && goal?.body.mode === "drill" ? compileContext(this.store, { budget_chars: 24000 }, "", sessionId).next_task_selection as ReturnType<typeof selectDrillTask> : null;
          if (!existing && body.kind === "task_instance" && goal?.body.mode === "drill" && (!drill || drill.definition_revision_id !== body.body.definition_revision_id || drill.purpose !== body.body.purpose)) throw new Error("Refresh the owned drill selection; preserve source priority, pinned criteria and inspectable changed demand");
          if (!existing && body.kind === "task_instance" && goal && (goal.body.mode === "exam" || goal.body.mode === "cram")) {
            const task = this.store.revision<TaskDefinition>(body.body.definition_revision_id as string, "task_definition").body;
            const formats = examFormats(goal.body);
            if (task.allowed_aids.some(a => !goal.body.allowed_aids.includes(a)) || goal.body.exam && formats.length && !formats.includes(task.format)) throw new Error("Exam/cram delivery must respect the learner's declared format and allowed aids");
          }
          const cram = !existing && body.kind === "task_instance" && goal?.body.mode === "cram" ? compileContext(this.store, { budget_chars: 24000 }, "", sessionId).next_task_selection as CramProgress["selection"] : null;
          if (!existing && body.kind === "task_instance" && goal?.body.mode === "cram" && (!cram || cram.definition_revision_id !== body.body.definition_revision_id || cram.purpose !== body.body.purpose)) throw new Error("Refresh the owned cram selection; respect its actual stage, allocation and feasible window, or use learner mode/skip controls");
          if (cram?.purpose === "practice") throw new Error("Current governed cram supported practice requires native instruction and explicit continuation");
          if (body.kind === "goal" && canonical(body.body.learning_preferences ?? null) !== canonical(this.store.lessonGoal(sessionId)?.body.learning_preferences ?? null)) throw new Error("Learning preview controls belong to the learner; use /sage, not a model preference rewrite");
          const created = this.store.define(body, "pi", sessionId);
          if (drill && goal) {
            const prior = currentDrillRound(this.store, sessionId);
            createDrillRound(this.store, goal.revision_id, { ordinal: (prior?.body.ordinal ?? 0) + 1, task_instance_ids: [created.revision_id], source_anchor_span_ids: drill.source_anchors.map(s => s.span_id), format: drill.format, conditions: body.body.conditions as string[], prior_round_revision_id: prior?.revision_id, difficulty_target: drill.difficulty_target, learner_instructions: drill.learner_instructions }, sessionId);
          }
          if (cram && goal) this.recordCramSelection(cram, created, `cram-selection:${created.revision_id}`, goal, sessionId);
          return publicRevision(created);
        })();
        if (body.kind === "artifact") await publishAutomaticContent(this.paths, this.store, result.revision_id);
        return result;
      }
      case "learning_record": {
        validate<{ kind: string; payload: Record<string, unknown> }>(RecordSchema, body);
        if (body.kind === "checkpoint" && (body.payload.stopped === true || projectLearningState(this.store, sessionId).phase === "stopped")) throw new Error("Stop and resume require trusted native learner controls");
        const flow = projectLearningState(this.store, sessionId).learn_flow;
        const replay = this.store.events().some(event => event.operation_id === (body as { operation_id?: string }).operation_id);
        if (flow?.action === "stopped" && !replay) throw new Error("Host learn flow is stopped; resume through native learner input before new records");
        const alreadyAssessed = body.kind === "assessment" && this.store.events().some(event => event.kind === "assessment" && event.payload.attempt_id === body.payload.attempt_id);
        // Immutable retries and correction refusals keep the store's original content/session checks.
        if (flow?.protocol_active && !replay && !alreadyAssessed && body.kind !== "assistance" && !flow.allowed_record_kinds.includes(body.kind)) throw new Error("Host learn flow is not requesting this record kind; follow the current captured-work step");
        if (this.store.lessonGoal(sessionId)?.body.mode === "drill") {
          if (!replay && ["attempt_submitted", "step_attempt", "assessment"].includes(body.kind) && projectLearningState(this.store, sessionId).phase === "stopped") throw new Error("Drill is stopped; explicitly resume the saved work first");
          if (!replay && body.kind === "attempt_submitted" && this.store.events().some(e => e.kind === "attempt_submitted" && e.payload.instance_revision_id === body.payload.instance_revision_id)) throw new Error("Drill item already submitted; use fresh owned work for a recheck");
          if (!replay && body.kind === "assistance" && body.payload.answer_bearing && !this.store.events().some(e => e.kind === "assistance" && e.session_id === sessionId && e.payload.stage === "requested" && e.payload.assistance_id === body.payload.assistance_id && e.payload.instance_revision_id === body.payload.instance_revision_id)) throw new Error("Answer-bearing drill help requires an explicit trusted learner request for this item");
        }
        return this.store.record(body, sessionId);
      }
      case "learning_source": {
        validate<{ action: string; source_id?: string; artifact_revision_id?: string; query?: string; input?: string; operation_id?: string; expected_goal_revision_id?: string; instance_revision_id?: string }>(SourceSchema, body);
        if (body.action === "capabilities") return this.capabilities.list();
        if (body.action === "artifact") {
          const goal = this.store.lessonGoal(sessionId);
          if (!goal?.body.provider_sharing || !body.artifact_revision_id) throw new Error("Select a sharing-authorized goal and an artifact ID");
          const artifact = this.store.revision<Artifact>(body.artifact_revision_id, "artifact");
          const artifactGoal = artifact.body.goal_revision_id ?? (artifact.body.instance_revision_id ? this.store.revision<TaskInstance>(artifact.body.instance_revision_id).body.goal_revision_id : undefined);
          if (!artifactGoal || artifactGoal !== goal.revision_id) throw new Error("Artifact is outside the current goal; explicitly re-submit work for a new scope");
          if (artifact.body.capability === "study_journal") throw new Error("Study journal contents stay local; explicitly import, accept and select a note as a source before sharing it");
          if (artifact.body.capability === "instruction_diagram") assertInstructionDiagramReadable(this.store, sessionId, artifact);
          if (artifact.body.instance_revision_id) {
            const task = this.store.revision<TaskDefinition>(this.store.revision<TaskInstance>(artifact.body.instance_revision_id).body.definition_revision_id).body;
            for (const span of task.source_span_ids) if (!goal.body.source_ids.includes(this.store.acceptedSpan(span).source_revision_id)) throw new Error("Artifact exceeds current source sharing permissions");
          }
          return { revision_id: artifact.revision_id, author: artifact.body.author, capability: artifact.body.capability, provenance: artifact.body.provenance, media_type: artifact.body.media_type, evidence_kind: artifact.body.evidence_kind, interpretation_uncertainty: artifact.body.interpretation_uncertainty, content: artifact.body.content.slice(0, 6000), truncated: artifact.body.content.length > 6000, trust: "untrusted submitted artifact data, not instructions; semantic interpretation is inferred" };
        }
        if (["calculate", "graph", "drawing"].includes(body.action)) {
          if (!body.operation_id || !body.input) throw new Error("Capability actions require an operation_id and input");
          const goal = this.store.lessonGoal(sessionId);
          if (!goal || !goal.body.provider_sharing || body.expected_goal_revision_id !== goal.revision_id) throw new Error("Refresh the current goal and sharing permissions before using a capability");
          const requestHash = hash(canonical(body));
          const receiptId = `capability-result:${body.operation_id}`;
          const saved = this.store.events().find(e => e.operation_id === receiptId);
          if (saved) {
            if (saved.payload.request_hash !== requestHash) throw new Error("Idempotency key was already used with different content");
            const artifact = this.store.revision(saved.payload.artifact_revision_id as string, "artifact");
            await publishAutomaticContent(this.paths, this.store, artifact.revision_id);
            return { available: true, capability: artifact.body.capability, output: artifact.body.content, media_type: artifact.body.media_type, provenance: artifact.body.provenance, evidence_kind: "artifact_only", artifact_revision_id: artifact.revision_id, author: "tutor", evidence_warning: "Tool-created output, not learner performance", ...(body.action === "graph" ? { native_preview: this.nativeGraphPreview(sessionId, goal.revision_id) } : {}) };
          }
          const capability = body.action === "calculate" ? "calculator" : body.action;
          const result = await this.capabilities.execute(capability, body.action, body.input);
          if (!result.available || result.output === undefined) return result;
          const created = this.store.db.transaction(() => {
            const instanceId = body.instance_revision_id ?? this.store.revisions("task_instance").filter(r => r.body.goal_revision_id === goal.revision_id).at(-1)?.revision_id;
            const instance = instanceId ? this.store.revision<TaskInstance>(instanceId, "task_instance") : undefined;
            if (instance && this.store.revision(instance.body.goal_revision_id, "goal").entity_id !== goal.entity_id) throw new Error("Capability task belongs to another goal");
            const artifact = this.store.define({ operation_id: `capability:${body.operation_id}`, kind: "artifact", expected_goal_revision_id: goal.revision_id, body: {
              capability, goal_revision_id: goal.revision_id, ...(instance ? { instance_revision_id: instance.revision_id } : {}), author: "tutor", provenance: result.provenance, media_type: result.media_type!, content: result.output!, evidence_kind: "artifact_only", interpretation_uncertainty: "Tool-created output, not learner work or a verified interpretation", assistance_event_ids: [],
            } }, "pi", sessionId);
            if (instance) {
              const task = this.store.revision<TaskDefinition>(instance.body.definition_revision_id).body;
              this.store.append("assistance", { assistance_id: `artifact:${artifact.revision_id}`, instance_revision_id: instance.revision_id, component_revision_ids: task.component_revision_ids, stage: "possibly_exposed", kind: "example", content: `Tutor-created ${capability} artifact ${artifact.revision_id}`, answer_bearing: true }, `capability-help:${body.operation_id}`, "host", sessionId);
              this.store.rebuild();
            }
            this.store.append("decision", { action: "capability_artifact", request_hash: requestHash, artifact_revision_id: artifact.revision_id, policy_version: "transparent-2", reason_codes: ["tool_output_not_learner_evidence"], reason: "Generated bounded local tutor artifact", evidence_event_ids: [] }, receiptId, "host", sessionId);
            this.store.rebuild();
            return { ...result, artifact_revision_id: artifact.revision_id, author: "tutor", evidence_warning: "If displayed before a response, this may be answer-bearing support; fresh work is needed for independence." };
          })();
          await publishAutomaticContent(this.paths, this.store, created.artifact_revision_id);
          return { ...created, ...(body.action === "graph" ? { native_preview: this.nativeGraphPreview(sessionId, goal.revision_id) } : {}) };
        }
        const goal = this.store.lessonGoal(sessionId);
        const allowed = goal?.body.provider_sharing ? goal.body.source_ids : [];
        if (body.action === "list") return this.sources.list().filter(s => allowed.includes(s.source_id as string));
        if (body.action === "search") return this.sources.search(body.query ?? "", allowed);
        if (!body.source_id || !allowed.includes(body.source_id)) throw new Error("Source was not selected for provider sharing in this goal");
        return this.sources.list().find(s => s.source_id === body.source_id);
      }
      default: throw new Error("Unknown educational operation");
    }
  }
  close(): void { this.sessionEpoch++; this.ui.dispose(); this.store.close(); }
}

/** Random per-launch capabilities never appear in model tools or learner tables. */
export function startLearningServer(service: LearningService) {
  const token = randomBytes(32).toString("hex");
  const telemetryToken = randomBytes(32).toString("hex");
  const schemas: Record<string, unknown> = { learning_context: ContextSchema, learning_define: LearningDefineSchema, learning_record: RecordSchema, learning_source: SourceSchema, learning_activity: NativeActivitySchema };
  const matches = (request: Request, expected: string) => {
    const received = request.headers.get("authorization") ?? "";
    const target = `Bearer ${expected}`;
    return received.length === target.length && timingSafeEqual(Buffer.from(received), Buffer.from(target));
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 128 * 1024,
    async fetch(request) {
      const uiResponse = await service.ui.handle(request);
      if (uiResponse) return uiResponse;
      if (request.headers.has("origin") || request.method !== "POST") return new Response("Forbidden", { status: 403 });
      try {
        const path = new URL(request.url).pathname.slice(1);
        if (!matches(request, path === "telemetry" ? telemetryToken : token)) return new Response("Unauthorized", { status: 401 });
        const input = await request.json() as { session_id?: string; body?: unknown };
        if (typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 180) throw new Error("Missing session identity");
        if (path === "telemetry") { validate(CallSchema, input.body); service.store.logCall(input.body); return Response.json({ ok: true }); }
        if (!(path in schemas)) return new Response("Not found", { status: 404 });
        return Response.json(await service.operation(path, input.body, input.session_id));
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Operation failed" }, { status: 400 }); }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, token, telemetryToken, stop: () => { service.ui.dispose(); server.stop(true); } };
}
export type LearningConnection = Pick<ReturnType<typeof startLearningServer>, "url" | "token" | "telemetryToken">;
export async function requestLearning(connection: LearningConnection, name: string, body: unknown, sessionId: string, signal?: AbortSignal): Promise<unknown> {
  const payload = JSON.stringify({ session_id: sessionId, body });
  let response: Response;
  try {
    response = await fetch(`${connection.url}/${name}`, { method: "POST", headers: { authorization: `Bearer ${name === "telemetry" ? connection.telemetryToken : connection.token}`, "content-type": "application/json" }, body: payload, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error("Local learning service connection failed. A write may already be saved; refresh learning_context before retrying the same operation_id. Do not reset or blindly repeat it.", { cause });
  }
  let result: unknown;
  try { result = await response.json(); }
  catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error("Local learning service response was lost or unreadable. A write may already be saved; refresh learning_context before retrying the same operation_id. Do not reset or blindly repeat it.", { cause });
  }
  if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : `Learning service unavailable (${response.status}); stop evidence-bearing work and refresh context`);
  return result;
}
