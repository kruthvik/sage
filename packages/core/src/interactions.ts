import { Type, type Static } from "typebox";

export const ActivitySchema = Type.Object({
  action: Type.Enum(["mcq", "open_response", "feynman", "scrap_work"]),
  operation_id: Type.String({ minLength: 1, maxLength: 120 }),
  expected_goal_revision_id: Type.String({ minLength: 1, maxLength: 180 }),
  instance_revision_id: Type.String({ minLength: 1, maxLength: 180 }),
}, { additionalProperties: false });
export type ActivityRequest = Static<typeof ActivitySchema>;
const teachingId = Type.String({ minLength: 1, maxLength: 180 });
export const TeachingActivitySchema = Type.Object({
  action: Type.Literal("teaching"), operation_id: Type.String({ minLength: 1, maxLength: 120 }),
  expected_goal_revision_id: teachingId, unit_id: teachingId, component_revision_id: teachingId,
  instruction_revision_id: teachingId, definition_revision_id: teachingId,
}, { additionalProperties: false });
export type TeachingActivityRequest = Static<typeof TeachingActivitySchema>;
export const NativeActivitySchema = Type.Union([ActivitySchema, TeachingActivitySchema]);
export type NativeActivityRequest = ActivityRequest | TeachingActivityRequest;
export interface TeachingActivityOffer {
  instruction: string;
  content_hash: string;
  /** One-use host continuation capability; never serialized into model/tool content. */
  continue: () => Promise<{ instance_revision_id: string; prompt: string }>;
}
export interface SubmittedImage { type: "image"; data: string; mimeType: string }
export interface SubmissionMetadata { selected_choice_id?: string; reasoning?: string; instance_revision_id?: string; goal_revision_id?: string; image_only?: boolean; images?: Array<{ hash: string; mime: string; size: number }> }
export interface ActivityPacket {
  request: ActivityRequest;
  objective: string;
  prompt: string;
  criteria: string[];
  choices?: Array<{ id: string; text: string }>;
  completed?: ActivityReceipt;
}
export interface ActivityReceipt {
  response_event_id: string;
  attempt_id: string;
  instance_revision_id: string;
  explanation?: string;
  selected_choice_id?: string;
  reasoning?: string;
}
