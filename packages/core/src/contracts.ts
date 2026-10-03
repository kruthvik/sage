import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ minLength: 1, maxLength: 24000 });
const id = Type.String({ minLength: 1, maxLength: 180 });
const ids = Type.Array(id, { maxItems: 40 });
const notes = Type.Array(text, { maxItems: 30 });
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const choice = <const T extends string[]>(values: T) => Type.Enum(values);
export const subjects = ["math", "writing", "science", "humanities", "languages", "computing", "practical"] as const;
export const learningDimensions = ["execution", "discrimination", "explanation", "fluency"] as const;
export const errorCategories = ["conceptual", "procedural", "selection", "representation", "prerequisite", "careless_error", "unknown"] as const;
const confidence = choice(["low", "medium", "high", "unknown"]);
export const GoalSchema = object({
  mode: choice(["learn", "exam"]), objective: text, subject: choice([...subjects]),
  horizon_days: Type.Number({ minimum: 0, maximum: 3650 }),
  deadline: Type.Optional(text), budget_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
  target_format: text, criteria: notes, allowed_aids: notes, constraints: notes,
  prior_experience: Type.Optional(text), probe: choice(["offer", "skip", "taken"]),
  learner_notes: Type.Optional(text), provider_sharing: Type.Boolean(), source_ids: ids,
  exam: Type.Optional(object({ format: text, syllabus: notes, topic_weights: Type.Array(object({ component_revision_id: id, importance: choice(["low", "normal", "high"]) }), { maxItems: 40 }), time_limit_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })), grading_criteria: notes })),
});
const ConceptSchema = object({ title: text, description: text });
const ComponentSchema = object({ title: text, behavior: text, subject: choice([...subjects]), concept_revision_ids: ids, prerequisite_revision_ids: ids, uncertainty: text,
  target_dimensions: Type.Optional(Type.Array(choice([...learningDimensions]), { maxItems: 4, uniqueItems: true })),
  importance: Type.Optional(choice(["low", "normal", "high"])),
  knowledge_kind: Type.Optional(choice(["declarative", "conceptual", "procedural", "complex"])),
  retention_delay_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
});
const RubricSchema = object({ title: text, dimensions: Type.Array(object({ name: text, criterion: text, max_score: Type.Number({ exclusiveMinimum: 0, maximum: 100 }) }), { minItems: 1, maxItems: 12 }), provisional: Type.Boolean(), source_span_ids: ids });
const FamilySchema = object({ title: text, construct: text, variation: text, lineage_revision_ids: ids,
  component_revision_ids: Type.Optional(ids), concept_revision_ids: Type.Optional(ids), prerequisite_revision_ids: Type.Optional(ids),
  solution_structure: Type.Optional(text), method_selection: Type.Optional(text), representations: Type.Optional(notes),
  surface_context: Type.Optional(text), source_span_ids: Type.Optional(ids), difficulty_hypothesis: Type.Optional(text),
  variation_dimensions: Type.Optional(notes), common_errors: Type.Optional(notes),
  structural_signature: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
});
export type TaskFamily = Static<typeof FamilySchema>;
const DefinitionSchema = object({
  title: text, prompt: text, family_revision_id: id, component_revision_ids: Type.Array(id, { minItems: 1, maxItems: 12 }),
  rubric_revision_id: id, source_span_ids: ids, format: choice(["free_response", "solve", "explain", "discriminate", "perform", "code", "draw"]),
  allowed_aids: notes, steps: notes, answer: Type.Optional(text),
  scoring: choice(["exact", "numeric", "rubric"]), tolerance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  status: choice(["candidate", "needs_review", "practice_ready", "rejected", "retired"]),
  review: object({ method: choice(["unreviewed", "human", "curated", "deterministic"]), reason: text }),
  stakes: choice(["low", "high"]), partition: choice(["practice", "protected"]),
  changes: notes, uncertainty: text,
  representation: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
  variation: Type.Optional(object({ baseline_definition_revision_id: id, dimensions: Type.Array(choice(["surface", "representation", "structure", "method", "distractors", "context", "component_combination"]), { minItems: 1, maxItems: 7, uniqueItems: true }), invariant: text, rationale: text })),
  artifact_revision_ids: Type.Optional(ids),
});
const InstanceSchema = object({ definition_revision_id: id, goal_revision_id: id, purpose: choice(["practice", "probe", "independent", "retention", "application", "exam"]), conditions: notes });
const PlanSchema = object({ goal_revision_id: id, component_revision_ids: ids, next_activities: notes, known_gaps: notes, uncertain_assumptions: notes });
const ProfileSchema = object({ notes: text, provenance: text, confirmed: Type.Boolean() });
const HypothesisSchema = object({ component_revision_ids: Type.Array(id, { minItems: 1, maxItems: 12 }), category: choice([...errorCategories]), description: text,
  confidence, supporting_evidence_ids: ids, contradicting_evidence_ids: ids, status: choice(["active", "weakened", "resolved", "uncertain"]),
  first_observed_at: text, last_observed_at: text, competing_hypothesis_revision_ids: Type.Optional(ids),
  prerequisite_component_revision_id: Type.Optional(id),
});
export type Hypothesis = Static<typeof HypothesisSchema>;
const ArtifactSchema = object({ capability: Type.String({ minLength: 1, maxLength: 180 }), instance_revision_id: Type.Optional(id),
  goal_revision_id: Type.Optional(id),
  author: choice(["learner", "tutor", "external", "unknown"]), provenance: text,
  media_type: text, content: text, evidence_kind: choice(["artifact_only", "direct", "inferred"]), interpretation_uncertainty: text,
  response_event_id: Type.Optional(id), assistance_event_ids: ids,
});
export type Artifact = Static<typeof ArtifactSchema>;
export const revisionBodies = { goal: GoalSchema, concept: ConceptSchema, component: ComponentSchema, rubric: RubricSchema, task_family: FamilySchema, task_definition: DefinitionSchema, task_instance: InstanceSchema, plan: PlanSchema, profile: ProfileSchema, hypothesis: HypothesisSchema, artifact: ArtifactSchema };
export const DefineSchema = Type.Union(Object.entries(revisionBodies).map(([kind, body]) => object({
  operation_id: id, kind: Type.Literal(kind), entity_id: Type.Optional(id), parent_revision_id: Type.Optional(id), expected_goal_revision_id: Type.Optional(id), body,
})));
export type Goal = Static<typeof GoalSchema>;
export type Component = Static<typeof ComponentSchema>;
export type TaskDefinition = Static<typeof DefinitionSchema>;
export type TaskInstance = Static<typeof InstanceSchema>;
export type Rubric = Static<typeof RubricSchema>;
export type RevisionKind = keyof typeof revisionBodies | "source";
export interface Revision<T = Record<string, unknown>> { revision_id: string; entity_id: string; kind: RevisionKind; parent_revision_id: string | null; body: T; content_hash: string; created_at: string; created_seq: number }

const AttemptSchema = object({ attempt_id: id, instance_revision_id: id, response_event_id: id, confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), declared_aids: notes,
  learner_reported_work_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })),
});
const StepSchema = object({ step_attempt_id: id, attempt_id: id, step: text, response_event_id: id, prior_step_ids: ids });
const AssistanceSchema = object({ assistance_id: id, instance_revision_id: id, attempt_id: Type.Optional(id), step_attempt_id: Type.Optional(id), component_revision_ids: ids, stage: choice(["offered", "requested", "authorized", "exposed", "possibly_exposed"]), kind: choice(["hint", "cue", "example", "feedback", "reveal", "external", "accessibility"]), content: text, answer_bearing: Type.Boolean() });
const outcome = choice(["success", "partial", "failure", "not_observed"]);
const AssessmentSchema = object({ attempt_id: id, step_attempt_id: Type.Optional(id), rubric_revision_id: id, outcome, scores: Type.Array(object({ dimension: text, score: Type.Number({ minimum: 0, maximum: 100 }), evidence: text }), { maxItems: 12 }), feedback: text, uncertainty: text, correction_of_event_id: Type.Optional(id),
  component_outcomes: Type.Optional(Type.Array(object({ component_revision_id: id, outcome }), { maxItems: 12 })),
  claims: Type.Optional(Type.Array(object({ component_revision_id: id, dimension: choice([...learningDimensions]), outcome, evidence: text }), { maxItems: 24 })),
  error_category: Type.Optional(choice([...errorCategories])),
});
const ReviewSchema = object({ component_revision_id: id, due_at: text, consent: Type.Boolean(), consent_response_event_id: id, reason: text });
const CheckpointSchema = object({ goal_revision_id: id, summary: text, next_action: text, gaps: notes, stopped: Type.Boolean() });
export const eventBodies = { attempt_submitted: AttemptSchema, step_attempt: StepSchema, assistance: AssistanceSchema, assessment: AssessmentSchema, review_scheduled: ReviewSchema, checkpoint: CheckpointSchema, decision: object({ reason: text, evidence_event_ids: ids, action: text,
  policy_version: Type.Optional(id), candidate_ids: Type.Optional(Type.Array(id, { maxItems: 5 })), selected_candidate_id: Type.Optional(id),
  target_component_revision_ids: Type.Optional(ids), reason_codes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 180 }), { maxItems: 12 })),
  uncertainty: Type.Optional(confidence), model_call_id: Type.Optional(id), user_override: Type.Optional(Type.Boolean()),
}), review_completed: object({ schedule_event_id: id, assessment_event_id: id }) };
export const RecordSchema = Type.Union(Object.entries(eventBodies).map(([kind, payload]) => object({ operation_id: id, kind: Type.Literal(kind), expected_goal_revision_id: id, occurred_at: Type.Optional(text), payload })));
export type Attempt = Static<typeof AttemptSchema>;
export type Assessment = Static<typeof AssessmentSchema>;
export type Assistance = Static<typeof AssistanceSchema>;
export type EventKind = keyof typeof eventBodies | "learner_response" | "task_delivered" | "source_status" | "source_accepted" | "source_removed";
export interface LearningEvent<T = Record<string, unknown>> { seq: number; event_id: string; operation_id: string; kind: EventKind; session_id: string; branch: "real" | "hypothetical"; actor: string; occurred_at: string; recorded_at: string; payload: T }

export const ContextSchema = object({ goal_revision_id: Type.Optional(id), component_revision_ids: Type.Optional(ids), instance_revision_id: Type.Optional(id), through_seq: Type.Optional(Type.Integer({ minimum: 0 })), as_of_time: Type.Optional(text), budget_chars: Type.Optional(Type.Integer({ minimum: 2000, maximum: 48000 })), source_query: Type.Optional(Type.String({ maxLength: 500 })), evidence_event_ids: Type.Optional(Type.Array(id, { maxItems: 5 })), hypothesis_revision_ids: Type.Optional(Type.Array(id, { maxItems: 3 })) });
export const SourceSchema = object({ action: choice(["list", "status", "search", "capabilities", "calculate", "graph", "drawing", "artifact"]), source_id: Type.Optional(id), artifact_revision_id: Type.Optional(id), query: Type.Optional(Type.String({ maxLength: 500 })), operation_id: Type.Optional(id), expected_goal_revision_id: Type.Optional(id), instance_revision_id: Type.Optional(id), input: Type.Optional(Type.String({ maxLength: 12000 })) });
export const CallSchema = object({ call_id: id, phase: choice(["started", "response", "completed", "failed", "cancelled", "unknown"]), provider: text, model: text, operation: text, request_hash: Type.Optional(text), response_hash: Type.Optional(text), status: Type.Optional(Type.Integer()), input_tokens: Type.Optional(Type.Number({ minimum: 0 })), output_tokens: Type.Optional(Type.Number({ minimum: 0 })), cost: Type.Optional(Type.Number({ minimum: 0 })), gap: Type.Optional(text) });
export type CallEntry = Static<typeof CallSchema>;
export function validate<T>(schema: TSchema, value: unknown): asserts value is T {
  if (!Value.Check(schema, value)) throw new Error(`Invalid operation: ${[...Value.Errors(schema, value)].slice(0, 3).map(error => error.message).join("; ")}`);
}
export function validTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Expected an ISO date-time with timezone");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Date-time must specify a timezone");
  return new Date(value).toISOString();
}
