import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { LearningPreferencesSchema, FeedbackReviewSchema } from "./experience.ts";

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
  mode: choice(["learn", "exam", "cram", "accelerate", "drill"]), objective: text, subject: choice([...subjects]),
  horizon_days: Type.Number({ minimum: 0, maximum: 3650 }),
  deadline: Type.Optional(text), budget_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
  study_windows: Type.Optional(Type.Array(object({ start: text, end: text }), { maxItems: 30 })),
  target_format: text, criteria: notes, allowed_aids: notes, constraints: notes,
  prior_experience: Type.Optional(text), probe: choice(["offer", "skip", "taken"]),
  learner_notes: Type.Optional(text), provider_sharing: Type.Boolean(), source_ids: ids,
  learning_preferences: Type.Optional(LearningPreferencesSchema),
  drill: Type.Optional(object({
    prioritized_source_span_ids: Type.Optional(ids),
    learner_instructions: Type.Optional(text),
    target_format: Type.Optional(text),
    difficulty_target: Type.Optional(choice(["similar", "harder"])),
  })),
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
  rubric_revision_id: id, source_span_ids: ids, format: choice(["free_response", "solve", "explain", "discriminate", "perform", "code", "draw", "mcq"]),
  choices: Type.Optional(Type.Array(object({ id: Type.String({ minLength: 1, maxLength: 24, pattern: "^[A-Za-z0-9_-]+$" }), text: Type.String({ minLength: 1, maxLength: 1000 }) }), { minItems: 2, maxItems: 8 })),
  drill_source_kind: Type.Optional(choice(["supplied_test_question", "question", "summary"])),
  allowed_aids: notes, steps: notes, answer: Type.Optional(text),
  refresher: Type.Optional(Type.String({ minLength: 1, maxLength: 1500 })),
  estimated_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1440 })),
  scoring: choice(["exact", "numeric", "rubric"]), tolerance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  status: choice(["candidate", "needs_review", "practice_ready", "rejected", "retired"]),
  review: object({ method: choice(["unreviewed", "human", "curated", "deterministic"]), reason: text,
    reviewer_role: Type.Optional(choice(["learner", "expert", "curator", "deterministic", "unknown"])), reviewer_provenance: Type.Optional(text),
  }),
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
  blob_hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});
export type Artifact = Static<typeof ArtifactSchema>;
const DrillRoundSchema = object({
  goal_revision_id: id,
  ordinal: Type.Number({ minimum: 1, maximum: 100 }),
  task_instance_ids: Type.Array(id, { minItems: 1, maxItems: 20 }),
  source_anchor_span_ids: ids,
  format: text,
  conditions: notes,
  prior_round_revision_id: Type.Optional(id),
  difficulty_target: choice(["similar", "harder"]),
  learner_instructions: Type.Optional(text),
});
export type DrillRound = Static<typeof DrillRoundSchema>;
export const revisionBodies = { goal: GoalSchema, concept: ConceptSchema, component: ComponentSchema, rubric: RubricSchema, task_family: FamilySchema, task_definition: DefinitionSchema, task_instance: InstanceSchema, plan: PlanSchema, profile: ProfileSchema, hypothesis: HypothesisSchema, artifact: ArtifactSchema, drill_round: DrillRoundSchema };
export const DefineSchema = Type.Union(Object.entries(revisionBodies).map(([kind, body]) => object({
  operation_id: id, kind: Type.Literal(kind), entity_id: Type.Optional(id), parent_revision_id: Type.Optional(id), expected_goal_revision_id: Type.Optional(id), expected_state_revision: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), body,
})));
/** Transport operation only: preparation still writes the existing immutable revision kinds. */
export const LessonPreparationSchema = object({
  operation_id: id, kind: Type.Literal("lesson_preparation"), expected_goal_revision_id: id,
  expected_state_revision: Type.String({ minLength: 1, maxLength: 300 }),
  body: object({
    component: Type.Union([object({ revision_id: id }), object({ title: text, behavior: text })]),
    title: text, instruction: Type.String({ minLength: 1, maxLength: 4000 }),
    prompt: Type.String({ minLength: 1, maxLength: 4000 }), criteria: RubricSchema.properties.dimensions,
    construct: text, variation: text, allowed_aids: notes, source_span_ids: ids, uncertainty: text,
    format: Type.Optional(choice(["free_response", "solve", "explain", "discriminate", "perform", "code", "draw"])),
  }),
});
export type LessonPreparation = Static<typeof LessonPreparationSchema>;
/** Content for one host-selected step, not a new revision or evidence kind. */
export const LearnStepSchema = object({
  operation_id: id, kind: Type.Literal("learn_step"), expected_goal_revision_id: id,
  expected_state_revision: Type.String({ minLength: 1, maxLength: 300 }), step_id: id,
  body: object({
    component: Type.Optional(LessonPreparationSchema.properties.body.properties.component),
    title: text, prompt: LessonPreparationSchema.properties.body.properties.prompt,
    instruction: Type.Optional(LessonPreparationSchema.properties.body.properties.instruction),
    criteria: Type.Optional(RubricSchema.properties.dimensions),
    reasoning_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 1500 })),
    contrast_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 1500 })),
    application_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 1500 })),
    source_span_ids: ids, challenge_rationale: Type.String({ minLength: 1, maxLength: 1500 }), uncertainty: text,
  }),
});
export type LearnStepRequest = Static<typeof LearnStepSchema>;
export const LearningDefineSchema = Type.Union([...DefineSchema.anyOf, LessonPreparationSchema, LearnStepSchema]);
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
const StepSchema = object({ step_attempt_id: id, attempt_id: id, step: text, spontaneous: Type.Optional(Type.Boolean()), response_event_id: id, prior_step_ids: Type.Array(id, { maxItems: 40, uniqueItems: true }) });
const AssistanceSchema = object({ assistance_id: id, instance_revision_id: id, attempt_id: Type.Optional(id), step_attempt_id: Type.Optional(id), component_revision_ids: ids, stage: choice(["offered", "requested", "authorized", "exposed", "possibly_exposed"]), kind: choice(["hint", "cue", "example", "feedback", "reveal", "external", "accessibility"]), content: text, answer_bearing: Type.Boolean() });
const outcome = choice(["success", "partial", "failure", "not_observed"]);
const AssessmentSchema = object({ attempt_id: id, step_attempt_id: Type.Optional(id), rubric_revision_id: id, outcome, scores: Type.Array(object({ dimension: text, score: Type.Number({ minimum: 0, maximum: 100 }), evidence: text }), { maxItems: 12 }), feedback: text, uncertainty: text, correction_of_event_id: Type.Optional(id),
  component_outcomes: Type.Optional(Type.Array(object({ component_revision_id: id, outcome }), { maxItems: 12 })),
  claims: Type.Optional(Type.Array(object({ component_revision_id: id, dimension: choice([...learningDimensions]), outcome, evidence: text }), { maxItems: 24 })),
  error_category: Type.Optional(choice([...errorCategories])),
  feedback_review: Type.Optional(FeedbackReviewSchema),
});
const ReviewSchema = object({ component_revision_id: id, due_at: text, consent: Type.Boolean(), consent_response_event_id: id, reason: text, authorization_event_id: Type.Optional(id) });
const CheckpointSchema = object({ goal_revision_id: id, summary: text, next_action: text, gaps: notes, stopped: Type.Boolean() });
export const CramSelectionSchema = object({
  instance_revision_id: id, stage: choice(["diagnostic", "repair", "intervening", "recheck", "mini_set"]),
  allocated_minutes: Type.Number({ exclusiveMinimum: 0, maximum: 1440 }),
  estimated_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1440 })),
  baseline_assessment_event_id: Type.Optional(id), not_before: Type.Optional(text),
  diagnostic_targets: Type.Array(object({ component_revision_id: id, demand: id }), { minItems: 1, maxItems: 3 }),
});
export type CramSelection = Static<typeof CramSelectionSchema>;
export const TeachingAnnotationSchema = object({
  schema_version: Type.Literal(1), unit_id: id,
  stage: choice(["prepared", "presented", "linked", "completed"]),
  goal_revision_id: id, component_revision_id: id, instruction_revision_id: id, definition_revision_id: id,
  prepared_event_id: Type.Optional(id), instance_revision_id: Type.Optional(id),
});
export type TeachingAnnotation = Static<typeof TeachingAnnotationSchema>;
export const eventBodies = { attempt_submitted: AttemptSchema, step_attempt: StepSchema, assistance: AssistanceSchema, assessment: AssessmentSchema, review_scheduled: ReviewSchema, checkpoint: CheckpointSchema, decision: object({ reason: text, evidence_event_ids: ids, action: text,
  cram_selection: Type.Optional(CramSelectionSchema), teaching: Type.Optional(TeachingAnnotationSchema),
  policy_version: Type.Optional(id), candidate_ids: Type.Optional(Type.Array(id, { maxItems: 5 })), selected_candidate_id: Type.Optional(id),
  target_component_revision_ids: Type.Optional(ids), reason_codes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 180 }), { maxItems: 12 })),
  uncertainty: Type.Optional(confidence), model_call_id: Type.Optional(id), user_override: Type.Optional(Type.Boolean()),
  lesson_goal_entity_id: Type.Optional(id), goal_revision_id: Type.Optional(id), component_revision_id: Type.Optional(id), due_at: Type.Optional(text), offer_action: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), schedule_event_id: Type.Optional(id), new_due_at: Type.Optional(text),
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
  const kind = value && typeof value === "object" && "kind" in value ? value.kind : undefined;
  if (Value.Check(schema, value)) return;
  // Select diagnostics only; the complete schema above still decides acceptance.
  if (Type.IsUnion(schema)) {
    const kinds = schema.anyOf.flatMap(branch => Type.IsObject(branch) && Type.IsLiteral(branch.properties.kind) && typeof branch.properties.kind.const === "string" ? [branch.properties.kind.const] : []);
    if (kinds.length > 0 && kinds.length === schema.anyOf.length && (typeof kind !== "string" || !kinds.includes(kind))) throw new Error(`Invalid operation: /kind: expected one of ${kinds.join(", ")}. Use these exact names; do not guess aliases.`);
  }
  const branches = typeof kind === "string" && Type.IsUnion(schema)
    ? schema.anyOf.filter(branch => Type.IsObject(branch) && Type.IsLiteral(branch.properties.kind) && branch.properties.kind.const === kind) : [];
  const diagnosticSchema = branches.length === 1 ? branches[0]! : schema;
  throw new Error(`Invalid operation: ${[...Value.Errors(diagnosticSchema, value)].slice(0, 3).map(error => `${error.instancePath || "/"}: ${error.message}`).join("; ")}`);
}
export function validTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Expected an ISO date-time with timezone");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Date-time must specify a timezone");
  return new Date(value).toISOString();
}
