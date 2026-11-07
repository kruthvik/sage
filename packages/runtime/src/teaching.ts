import { projectComponents } from "../../storage/src/projection.ts";
import type { LearningStore } from "../../storage/src/store.ts";
import type { CurrentLearningTask, LearningPhase } from "./learning-state.ts";

export interface TeachingState {
  schema_version: 1;
  unit_id: string;
  prepared_event_id: string;
  goal_revision_id: string;
  component_revision_id: string;
  instruction_revision_id: string;
  definition_revision_id: string;
  instance_revision_id: string | null;
  stage: LearningPhase;
  criterion_evidence: "unknown" | "repair" | "observed";
}

/** Presentation is a protocol receipt, never learner work, consent or competence. */
export function projectTeachingState(store: LearningStore, sessionId: string, goalRevisionId: string, throughSeq: number, asOfTime: string, tasks: Array<{ task: CurrentLearningTask; phase: LearningPhase }>): TeachingState | null {
  const events = store.events(throughSeq).filter(e => e.branch === "real" && e.session_id === sessionId && e.occurred_at <= asOfTime);
  const receipts = events.flatMap(event => {
    if (event.kind !== "decision" || event.actor !== "host" || event.payload.action !== "teaching_stage") return [];
    try {
      const annotation = store.validateTeachingAnnotation(event.payload.teaching, sessionId, goalRevisionId, event.seq - 1, event.occurred_at);
      return [{ event, annotation }];
    } catch { return []; } // Invalid historical annotations cannot establish a transition.
  });
  if (!receipts.length) return null;
  const observations = projectComponents(store, throughSeq, asOfTime, sessionId);
  const units = receipts.filter(r => r.annotation.stage === "prepared").map(({ event, annotation }) => {
    const transitions = receipts.filter(r => r.annotation.prepared_event_id === event.event_id);
    const presented = transitions.find(r => r.annotation.stage === "presented");
    const linked = transitions.find(r => r.annotation.stage === "linked" && presented && r.event.seq > presented.event.seq);
    const instanceId = linked?.annotation.instance_revision_id ?? null;
    const current = tasks.find(t => t.task.instance_revision_id === instanceId);
    let stage: LearningPhase = presented ? "question_pending" : "instruction_pending";
    let evidence: TeachingState["criterion_evidence"] = "unknown";
    if (linked && current) {
      stage = current.phase;
      const assessmentId = current.task.assessment_event_id;
      const assessment = events.find(e => e.event_id === assessmentId && e.kind === "assessment");
      const feedback = assessment && events.find(e => e.seq > assessment.seq && e.kind === "decision" && e.actor === "host" && e.payload.action === "response_feedback_presented" && (e.payload.evidence_event_ids as string[] | undefined)?.includes(assessment.event_id));
      const observation = observations.find(v => v.component_revision_id === annotation.component_revision_id)?.observations.find(o => o.assessment_event_id === assessmentId);
      if (feedback && stage === "feedback") {
        const criteria = observation?.criterion_evidence ?? [];
        evidence = !observation || !criteria.length || criteria.some(c => !c.observed) || observation.outcome === "not_observed" ? "unknown" : observation.outcome === "success" && criteria.every(c => c.satisfied) ? "observed" : "repair";
        stage = evidence === "observed" ? "unit_complete" : "repair";
      }
    }
    if (events.some(control => control.seq > event.seq && control.kind === "decision" && control.actor === "learner" && control.payload.action === "learn_unit_skipped" && control.payload.unit_id === annotation.unit_id && control.payload.goal_revision_id === annotation.goal_revision_id && Array.isArray(control.payload.evidence_event_ids) && control.payload.evidence_event_ids.includes(event.event_id))) stage = "checkpoint";
    const state: TeachingState = { schema_version: 1, unit_id: annotation.unit_id, prepared_event_id: event.event_id, goal_revision_id: annotation.goal_revision_id, component_revision_id: annotation.component_revision_id, instruction_revision_id: annotation.instruction_revision_id, definition_revision_id: annotation.definition_revision_id, instance_revision_id: instanceId, stage, criterion_evidence: evidence };
    return state;
  });
  return units.find(unit => !["unit_complete", "checkpoint"].includes(unit.stage)) ?? units.at(-1) ?? null;
}

