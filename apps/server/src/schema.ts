// API v1 (SPEC §17): one table is the params validator, the method list and the source of docs/api/v1.schema.json.
// `impl: false` methods are reserved names in the frozen surface; they answer `not_implemented` until their milestone.
export const API_VERSION = "1.0.0";
type Schema = Record<string, unknown>;
const str = { type: "string", minLength: 1 }, num = { type: "number" };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false });
const sid = { sessionId: str };

const goal = obj({
  objective: { type: "string", minLength: 3, maxLength: 2000 }, mode: { enum: ["cram", "learn", "drill", "accelerate"] }, pace: { enum: ["normal", "speed_up"] },
  timeBudgetMin: { type: "number", minimum: 5, maximum: 1440 }, horizonDays: num, allowedAids: { type: "array", items: { type: "string" } },
  accommodations: { type: "string" }, learnerParams: { type: "string", maxLength: 2000 }, sourceIds: { type: "array", items: { type: "string" } },
  exam: { type: "object" }, preview: { type: "object" },
}, ["objective"]);

export interface MethodSpec { params: Schema; learner?: boolean; impl?: false; note?: string }
export const METHODS: Record<string, MethodSpec> = {
  "session.create": { params: obj({ goal }, ["goal"]), learner: true },
  "session.list": { params: obj({}) },
  "session.resume": { params: obj({ ...sid, takeLease: { type: "boolean" } }, ["sessionId"]) },
  "session.end": { params: obj(sid, ["sessionId"]), learner: true, note: "checkpoint + release lease (engine control.stop)" },
  "plan.get": { params: obj(sid, ["sessionId"]) },
  "plan.edit": { params: obj({ ...sid, plan: { type: "object" } }, ["sessionId", "plan"]), learner: true },
  "plan.approve": { params: obj(sid, ["sessionId"]), learner: true },
  "diagnostic.skip": { params: obj(sid, ["sessionId"]), learner: true },
  "control.teach": { params: obj(sid, ["sessionId"]), learner: true },
  "control.morePractice": { params: obj(sid, ["sessionId"]), learner: true },
  "control.advance": { params: obj(sid, ["sessionId"]), learner: true },
  "control.leaveWithGaps": { params: obj({ ...sid, confirmToken: str }, ["sessionId"]), learner: true },
  "control.stop": { params: obj(sid, ["sessionId"]), learner: true },
  "control.resume": { params: obj(sid, ["sessionId"]), learner: true },
  "item.submit": { params: obj({ ...sid, text: { type: "string", maxLength: 8000 }, choice: { type: "integer", minimum: 0 }, fields: { type: "object" }, latencyMs: { type: "number", minimum: 0 } }, ["sessionId"]), learner: true },
  "hint.request": { params: obj({ ...sid, level: { enum: [1, 2, 3] } }, ["sessionId", "level"]), learner: true },
  "chunk.peek": { params: obj(sid, ["sessionId"]), learner: true },
  "feedback.ack": { params: obj({ ...sid, attemptId: str }, ["sessionId", "attemptId"]), learner: true },
  "grade.dispute": { params: obj({ ...sid, attemptId: str, argument: { type: "string", minLength: 1, maxLength: 2000 } }, ["sessionId", "attemptId", "argument"]), learner: true },
  "pace.set": { params: obj({ ...sid, pace: { enum: ["normal", "speed_up"] } }, ["sessionId", "pace"]), learner: true },
  "time.extend": { params: obj({ ...sid, minutes: { type: "number", minimum: 1, maximum: 600 } }, ["sessionId", "minutes"]), learner: true },
  "reviews.consent": { params: obj({ ...sid, subskillIds: { type: "array", items: str } }, ["sessionId", "subskillIds"]), learner: true },
  "state.get": { params: obj(sid, ["sessionId"]) },
  "context.inspect": { params: obj(sid, ["sessionId"]), note: "dev: the tutor packet as it would be built now" },
  "research.status": { params: obj(sid, ["sessionId"]) },
  "research.pack": { params: obj({ ...sid, packId: str }, ["sessionId", "packId"]) },
  "sources.acceptPack": { params: obj({ ...sid, packId: str, itemIds: { type: "array", items: str } }, ["sessionId", "packId"]), learner: true },
  "settings.get": { params: obj({}) },
  "settings.set": { params: obj({ roleModels: { type: "object" } }), learner: true },
  "usage.get": { params: obj({ sessionId: str }) },
  // Reserved in v1, implemented in later milestones.
  "turn.send": { params: obj({ ...sid, text: str }, ["sessionId", "text"]), learner: true, impl: false, note: "free-text turn to the tutor (needs an engine event)" },
  "image.consent": { params: obj({ ...sid }, ["sessionId"]), learner: true, impl: false, note: "M5" },
  "transcription.confirm": { params: obj({ ...sid }, ["sessionId"]), learner: true, impl: false, note: "M5" },
  "export.get": { params: obj({ ...sid }, ["sessionId"]), impl: false, note: "M4" },
  "sources.add": { params: obj({}), learner: true, impl: false, note: "M6" }, "sources.preview": { params: obj({}), impl: false, note: "M6" },
  "sources.accept": { params: obj({}), learner: true, impl: false, note: "M6" }, "sources.remove": { params: obj({}), learner: true, impl: false, note: "M6" },
  "sources.list": { params: obj({}), impl: false, note: "M6" }, "brain.get": { params: obj({}), impl: false, note: "Phase 2" }, "brain.set": { params: obj({}), learner: true, impl: false, note: "Phase 2" },
  "usage.set": { params: obj({}), learner: true, impl: false, note: "M4" }, "extensions.list": { params: obj({}), impl: false, note: "M6" },
  "extensions.install": { params: obj({}), learner: true, impl: false, note: "M6" }, "extensions.enable": { params: obj({}), learner: true, impl: false, note: "M6" },
  "extensions.disable": { params: obj({}), learner: true, impl: false, note: "M6" }, "extensions.update": { params: obj({}), learner: true, impl: false, note: "M6" },
  "extensions.importFromPi": { params: obj({}), learner: true, impl: false, note: "M6" }, "ui.respond": { params: obj({}), learner: true, impl: false, note: "no pi dialogs reach the client (pi no-op UI)" },
};

export const EVENTS = ["tutor.done", "item.present", "grade.result", "feedback.present", "repair.required", "hint.reveal", "gate.update", "node.status", "pace.notice",
  "confirm.required", "plan.changed", "notice", "research.started", "research.ready", "cost.update", "export.ready", "checkpoint", "error", "dev.item_rejected"] as const;

/** Minimal JSON Schema check for the subset used above (type, enum, required, additionalProperties:false, min/max, items). */
export function check(schema: Schema, v: unknown, path = "params"): string[] {
  const p: string[] = [];
  if (schema.enum && !(schema.enum as unknown[]).includes(v)) return [`${path} must be one of ${JSON.stringify(schema.enum)}`];
  const t = schema.type as string | undefined;
  if (t === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${path} must be an object`];
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if ((v as Record<string, unknown>)[r] === undefined) p.push(`${path}.${r} is required`);
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) p.push(...check(props[k]!, x, `${path}.${k}`));
      else if (schema.additionalProperties === false && Object.keys(props).length) p.push(`${path}.${k} is not allowed`);
    }
  } else if (t === "array") { if (!Array.isArray(v)) return [`${path} must be an array`]; v.forEach((x, i) => p.push(...check((schema.items ?? {}) as Schema, x, `${path}[${i}]`))); }
  else if (t === "string") { if (typeof v !== "string") return [`${path} must be a string`]; if (v.length < (schema.minLength as number ?? 0)) p.push(`${path} is too short`); if (schema.maxLength !== undefined && v.length > (schema.maxLength as number)) p.push(`${path} is too long`); }
  else if (t === "number" || t === "integer") { if (typeof v !== "number" || !Number.isFinite(v) || (t === "integer" && !Number.isInteger(v))) return [`${path} must be a ${t}`]; if (schema.minimum !== undefined && v < (schema.minimum as number)) p.push(`${path} is below ${schema.minimum}`); if (schema.maximum !== undefined && v > (schema.maximum as number)) p.push(`${path} is above ${schema.maximum}`); }
  else if (t === "boolean" && typeof v !== "boolean") p.push(`${path} must be a boolean`);
  return p;
}

export const schemaDocument = () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", title: `Sage engine API v${API_VERSION}`, version: API_VERSION,
  methods: Object.fromEntries(Object.entries(METHODS).map(([k, m]) => [k, { params: m.params, learner: !!m.learner, implemented: m.impl !== false, ...(m.note ? { note: m.note } : {}) }])), events: EVENTS });
