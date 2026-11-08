// Session driver (M3): the one place that owns live state. Every event goes reducer → ledger (in that order: a rejected
// event is never stored), effects are drained in order, roles and tutor turns run through the host, and learner-facing
// effects are emitted to the client. The researcher runs in the background and never blocks the drain.
import { readImage } from "../../storage/src/blobs.ts";
import type { Effect, EngineEvent, EngineState } from "../../engine/src/state.ts";
import { EVENT_ACTOR, initialState } from "../../engine/src/state.ts";
import { reduce, EngineError, sessionState, type Actor } from "../../engine/src/loop.ts";
import { planFit } from "../../engine/src/pacing.ts";
import type { Ledger } from "../../storage/src/ledger.ts";
import { writeExports, type ExportResult, type ExportWhat } from "../../exports/src/writer.ts";
import type { Goal } from "../../core/src/types.ts";
import type { RoleCallInput, RoleCallResult, TutorTurnResult, TutorTool } from "../../pi-adapter/src/runtime.ts";
import { runRole, type HostDeps, type RoleModels } from "./host.ts";
import { runTutorTurn } from "./tutor.ts";

export interface DriverRuntime {
  roleCall(i: RoleCallInput): Promise<RoleCallResult>;
  researchCall(i: RoleCallInput & { limits: { maxSearches: number; maxFetches: number } }): Promise<RoleCallResult>;
  tutorTurn(i: Omit<RoleCallInput, "system"> & { system: string; tools: TutorTool[]; active: readonly string[] }): Promise<TutorTurnResult>;
}
/** What the client sees (API v1 events). */
export type ServerEvent = { event: string; sessionId: string; data: unknown };

export class SessionDriver {
  state: EngineState = initialState();
  private queue: Effect[] = [];
  private draining: Promise<void> | undefined;
  private seq = 0;
  private background = new Set<Promise<void>>();
  readonly abort = new AbortController();
  /** SAGE_HOME for session folders (SPEC §14); unset = no files written (tests, evals). */
  exportsHome?: string;
  /** Owner-supplied TTF/OTF for PDF exports (settings.exportFontPath); built-in Helvetica when unset. */
  exportFontPath?: string;
  /** SAGE_HOME/data/blobs: learner photos for scrap_work (read by the transcriber role after consent). */
  blobsDir?: string;
  sources?: HostDeps["sources"];
  /** Exports go into an Obsidian vault: add frontmatter and [[wikilinks]]. */
  obsidian?: boolean;

  constructor(readonly sessionId: string, private ledger: Ledger, private rt: DriverRuntime, public models: RoleModels,
    private emit: (e: ServerEvent) => void, private now: () => string = () => new Date().toISOString()) {}

  static create(goal: Goal, sessionId: string, ledger: Ledger, rt: DriverRuntime, models: RoleModels, emit: (e: ServerEvent) => void, now?: () => string) {
    const d = new SessionDriver(sessionId, ledger, rt, models, emit, now);
    const err = d.apply({ type: "session_created", sessionId, goal }, "learner");
    if (err) throw new EngineError(err);
    return d;
  }
  /** Rebuild from the ledger. Effects from the past are not re-run; the client re-reads state and the next action resumes the loop. */
  static resume(sessionId: string, ledger: Ledger, rt: DriverRuntime, models: RoleModels, emit: (e: ServerEvent) => void, now?: () => string) {
    const d = new SessionDriver(sessionId, ledger, rt, models, emit, now);
    for (const e of ledger.engineLog(sessionId)) d.state = reduce(d.state, e.event, e.now, e.actor).state;
    d.seq = d.state.spend.calls;
    return d;
  }

  /** Reduce, then store. Returns the engine's rejection message instead of throwing. */
  apply(ev: EngineEvent, actor: Actor): string | undefined {
    const now = this.now();
    let step;
    try { step = reduce(this.state, ev, now, actor); }
    catch (e) { if (e instanceof EngineError) return e.message; throw e; }
    this.ledger.appendEngine(this.sessionId, ev, actor, now);
    if (ev.type === "role_call_logged") {
      const call_id = `${this.sessionId}:${++this.seq}`;
      this.ledger.logCall({ call_id, phase: "started", role: ev.role }); // shortcut: start is recorded at completion; log at request time if timing per call matters
      this.ledger.logCall({ call_id, phase: "completed", role: ev.role, input_tokens: ev.inputTokens, output_tokens: ev.outputTokens, ...(ev.costUsd !== undefined ? { cost_usd: ev.costUsd } : {}) });
      this.out("cost.update", step.state.spend);
    }
    this.state = step.state;
    this.queue.push(...step.effects);
    return undefined;
  }

  /** A learner action from the client. Only learner-owned events are accepted here (F10). */
  async learner(ev: EngineEvent): Promise<void> {
    if (EVENT_ACTOR[ev.type] !== "learner") throw new EngineError(`${ev.type} is not a learner action`);
    const err = this.apply(ev, "learner");
    if (err) throw new EngineError(err);
    await this.drain();
  }

  /** Process queued effects until the engine waits for the learner (or a background job). Re-entrant calls join the running drain. */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    // The first await matters: with an empty queue a synchronous body would clear `draining` before it is assigned,
    // leaving a resolved promise that makes every later drain() a no-op.
    let p: Promise<void> | undefined = undefined;
    p = (async () => {
      await null;
      try { while (this.queue.length) await this.handle(this.queue.shift()!); }
      finally { if (this.draining === p) this.draining = undefined; }
    })();
    this.draining = p;
    return p;
  }

  /** Resolves when background research has landed (eval/tests). */
  async idle(): Promise<void> { while (this.queue.length || this.background.size || this.draining) { await this.drain(); await Promise.all([...this.background]); } }

  /** The foreground effect that failed after its automatic retry; the session waits on it until retry(). */
  failed: Effect | undefined;
  async retry(): Promise<boolean> {
    const fx = this.failed;
    if (!fx) return false;
    this.failed = undefined; this.queue.unshift(fx);
    await this.drain();
    return true;
  }

  /** Regenerate the session folder from the ledger now (export.get, node close, session end). Never overwrites files the learner edited. */
  async exportNow(what: ExportWhat = "session"): Promise<ExportResult> {
    if (!this.exportsHome) throw new Error("no SAGE_HOME set for exports");
    return writeExports(this.exportsHome, this.state, this.ledger.engineLog(this.sessionId), what, { models: this.models, fontPath: this.exportFontPath, obsidian: this.obsidian });
  }
  private out(event: string, data: unknown) { this.emit({ event, sessionId: this.sessionId, data }); }

  private async handle(fx: Effect): Promise<void> {
    switch (fx.kind) {
      case "call_role": {
        const run = async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              const evs = await runRole(fx, this.state, { models: this.models, roleCall: this.rt.roleCall, researchCall: this.rt.researchCall, signal: this.abort.signal, ...(this.blobsDir ? { readImage: (h: string) => readImage(this.blobsDir!, h) } : {}), ...(this.sources ? { sources: this.sources } : {}) }, ++this.seq);
              const rejected = evs.map(e => this.apply(e.event, e.actor)).filter((x): x is string => !!x);
              if (rejected.length) throw new Error(`role output rejected: ${rejected.join("; ")}`); // same retry-then-park path as a failed call
              return;
            } catch (e) {
              // One automatic retry for transient failures (timeouts, provider errors); then park the effect for session.retry.
              if (attempt === 0 && !this.abort.signal.aborted) continue;
              if (!fx.background) this.failed = fx;
              this.out("error", { code: "role_failed", role: fx.role, purpose: fx.purpose, message: (e as Error).message, retry: !fx.background });
              return;
            }
          }
        };
        if (fx.background) {
          this.out("research.started", { trigger: fx.purpose, nodeId: (fx.input.node as { id?: string } | undefined)?.id ?? fx.input.nodeId });
          const p = run().then(() => this.drain()).finally(() => this.background.delete(p));
          this.background.add(p);
        } else await run();
        return;
      }
      case "tutor_turn": {
        try {
          const r = await runTutorTurn(fx, { model: this.models.tutor, tutorTurn: this.rt.tutorTurn, state: () => this.state, apply: (ev, actor) => this.apply(ev, actor), signal: this.abort.signal });
          if (r.message) this.out("tutor.done", { text: r.message });
          if (r.fallback) this.out("error", { code: "tutor_fallback", message: `tutor model did not act; Sage ${r.fallback}` });
          if (!r.acted) { this.failed = fx; this.out("error", { code: "tutor_failed", phase: fx.phase, message: "the tutor could not complete this step; retry or change the tutor model", retry: true }); }
        } catch (e) { this.failed = fx; this.out("error", { code: "tutor_failed", phase: fx.phase, message: (e as Error).message, retry: true }); }
        return;
      }
      case "present_chunk": { const citations = fx.sourceSpans?.length ? this.sources?.cite?.(fx.sourceSpans) ?? [] : []; return this.out("tutor.done", { text: fx.text, kind: "chunk", ...(citations.length ? { citations } : {}) }); }
      case "transcription_review": return this.out("transcription.review", { itemId: fx.itemId, text: fx.text });
      case "present_item": return this.out("item.present", { item: fx.item, ...(fx.cueText ? { cueText: fx.cueText } : {}) });
      case "present_feedback": {
        this.out("grade.result", { attemptId: fx.attemptId, score: fx.grade.score0to100 });
        const a = this.state.attempts.find(x => x.id === fx.attemptId), spans = (a && this.state.items.get(a.itemId)?.sourceSpans) || [];
        const citations = spans.length ? this.sources?.cite?.(spans) ?? [] : []; // after the answer, so a check stays independent
        return this.out("feedback.present", citations.length ? { ...fx, citations } : fx);
      }
      case "repair_required": return this.out("repair.required", fx);
      case "reveal_hint": case "offer_hint": case "show_chunk": return this.out("hint.reveal", fx);
      case "gate_update": return this.out("gate.update", fx);
      case "node_status": return this.out("node.status", fx);
      case "pace_notice": return this.out("pace.notice", fx);
      case "confirm_required": return this.out("confirm.required", fx);
      case "notice": return this.out(fx.code === "research_ready" ? "research.ready" : fx.code === "plan_ready" ? "plan.changed" : "notice", fx);
      case "write_export": {
        if (!this.exportsHome) return this.out("export.ready", { what: fx.what, available: false, note: "no SAGE_HOME set for exports" });
        try { const r = await this.exportNow(fx.what); this.out("export.ready", { what: fx.what, available: true, ...r }); }
        catch (e) { this.out("error", { code: "export_failed", message: (e as Error).message }); }
        return;
      }
      case "checkpoint": return this.out("checkpoint", {});
      case "item_rejected": return this.out("dev.item_rejected", fx);
      case "plan_fit": return this.out("plan.fit", fx.fit);
    }
  }

  view() { return { session: sessionState(this.state), phase: this.state.phase, plan: this.state.plan, fit: planFit(this.state), spend: this.state.spend, packs: [...this.state.packs.values()].map(p => ({ id: p.id, trigger: p.trigger, nodeId: p.nodeId, status: p.status, items: p.items.length, conflicts: p.items.filter(i => i.conflictsWithSourceId).length })) }; }
}
