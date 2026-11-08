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
  "session.retry": { params: obj(sid, ["sessionId"]), learner: true, note: "re-run the role call or tutor turn that failed (error.data.retry = true)" },
  "session.end": { params: obj(sid, ["sessionId"]), learner: true, note: "checkpoint + release lease (engine control.stop)" },
  "plan.get": { params: obj(sid, ["sessionId"]) },
  "plan.edit": { params: obj({ ...sid, plan: { type: "object" } }, ["sessionId", "plan"]), learner: true },
  "plan.approve": { params: obj(sid, ["sessionId"]), learner: true },
  "plan.merge": { params: obj({ ...sid, nodeIds: { type: "array", items: str } }, ["sessionId", "nodeIds"]), learner: true, note: "before approval: merge nodes into the first listed (the plan.fit event suggests groups)" },
  "diagnostic.skip": { params: obj(sid, ["sessionId"]), learner: true },
  "control.teach": { params: obj(sid, ["sessionId"]), learner: true },
  "control.morePractice": { params: obj(sid, ["sessionId"]), learner: true },
  "control.advance": { params: obj(sid, ["sessionId"]), learner: true },
  "control.leaveWithGaps": { params: obj({ ...sid, confirmToken: str }, ["sessionId"]), learner: true },
  "control.stop": { params: obj(sid, ["sessionId"]), learner: true },
  "control.resume": { params: obj(sid, ["sessionId"]), learner: true },
  "item.submit": { params: obj({ ...sid, text: { type: "string", maxLength: 8000 }, choice: { type: "integer", minimum: 0 }, indices: { type: "array", items: { type: "integer", minimum: 0 } }, fields: { type: "object" }, latencyMs: { type: "number", minimum: 0 } }, ["sessionId"]), learner: true },
  "hint.request": { params: obj({ ...sid, level: { enum: [1, 2, 3] } }, ["sessionId", "level"]), learner: true },
  "chunk.peek": { params: obj(sid, ["sessionId"]), learner: true },
  "source.open": { params: obj({ ...sid, spanId: { type: "string", minLength: 3, maxLength: 200 } }, ["sessionId", "spanId"]), learner: true },
  "feedback.ack": { params: obj({ ...sid, attemptId: str }, ["sessionId", "attemptId"]), learner: true },
  "grade.dispute": { params: obj({ ...sid, attemptId: str, argument: { type: "string", minLength: 1, maxLength: 2000 } }, ["sessionId", "attemptId", "argument"]), learner: true, note: "model grades any time; answer-key items while their feedback shows (a wrong key voids and replaces the item)" },
  "pace.set": { params: obj({ ...sid, pace: { enum: ["normal", "speed_up"] } }, ["sessionId", "pace"]), learner: true },
  "time.extend": { params: obj({ ...sid, minutes: { type: "number", minimum: 1, maximum: 600 } }, ["sessionId", "minutes"]), learner: true },
  "reviews.consent": { params: obj({ ...sid, subskillIds: { type: "array", items: str } }, ["sessionId", "subskillIds"]), learner: true },
  "state.get": { params: obj(sid, ["sessionId"]) },
  "context.inspect": { params: obj(sid, ["sessionId"]), note: "dev: the tutor packet as it would be built now" },
  "research.status": { params: obj(sid, ["sessionId"]) },
  "research.pack": { params: obj({ ...sid, packId: str }, ["sessionId", "packId"]) },
  "sources.acceptPack": { params: obj({ ...sid, packId: str, itemIds: { type: "array", items: str } }, ["sessionId", "packId"]), learner: true },
  "settings.get": { params: obj({}) },
  "settings.set": { params: obj({ roleModels: { type: "object" }, exportFontPath: { type: ["string", "null"] }, vaultPath: { type: ["string", "null"] } }), learner: true },
  "usage.get": { params: obj({ sessionId: str }) },
  // Reserved in v1, implemented in later milestones.
  "turn.send": { params: obj({ ...sid, text: str }, ["sessionId", "text"]), learner: true, impl: false, note: "free-text turn to the tutor (needs an engine event)" },
  "image.consent": { params: obj({ ...sid, images: { type: "array", items: obj({ dataBase64: { type: "string", minLength: 16, maxLength: 7_000_000 } }, ["dataBase64"]) } }, ["sessionId", "images"]), learner: true,
    note: "calling it IS the learner's consent to send these photos to the transcriber model (shown first in the client); 1–4 PNG/JPEG/WebP, ≤ 5 MB each, ≤ 12 MB total" },
  "transcription.confirm": { params: obj({ ...sid, text: { type: "string", minLength: 1, maxLength: 24000 }, latencyMs: { type: "number", minimum: 0 } }, ["sessionId", "text"]), learner: true,
    note: "the learner's checked (optionally edited) transcription; it becomes their response and is graded" },
  "export.get": { params: obj({ ...sid }, ["sessionId"]) },
  "sources.add": { params: obj({ name: str, dataBase64: { type: "string", minLength: 1, maxLength: 22_000_000 }, url: { type: "string", minLength: 8, maxLength: 2000 }, transcript: { type: "string", minLength: 1, maxLength: 4_000_000 }, title: str, text: { type: "string", minLength: 1, maxLength: 2_000_000 },
    notePath: { type: "string", minLength: 1, maxLength: 1000 }, examSample: { type: "boolean" } }), learner: true,
    note: "one of {name, dataBase64} (≤ 16 MB: pdf/docx/pptx/png/jpg/vtt/srt/txt/md), {url} (YouTube or a .vtt/.srt URL; only that URL is fetched), {title, text}, or {notePath} (a .md under settings.vaultPath). Returns the source in needs_review" },
  "sources.preview": { params: obj({ sourceId: str }, ["sourceId"]) },
  "sources.accept": { params: obj({ sourceId: str, shareWithModels: { type: "boolean" } }, ["sourceId", "shareWithModels"]), learner: true,
    note: "shareWithModels = the learner's consent to send excerpts to the planner/generator models; a session can only use sources accepted with it" },
  "sources.remove": { params: obj({ sourceId: str }, ["sourceId"]), learner: true, note: "blocks all future use; sessions that cited it keep their history" },
  "sources.list": { params: obj({}) }, "brain.get": { params: obj({}), impl: false, note: "Phase 2" }, "brain.set": { params: obj({}), learner: true, impl: false, note: "Phase 2" },
  "usage.set": { params: obj({ enabled: { type: "boolean" } }, ["enabled"]), learner: true }, "extensions.list": { params: obj({}), note: "pi packages in Sage's own agent dir, with the OS-privilege warning" },
  "extensions.install": { params: obj({}), learner: true, impl: false, note: "M6" }, "extensions.enable": { params: obj({}), learner: true, impl: false, note: "M6" },
  "extensions.disable": { params: obj({}), learner: true, impl: false, note: "M6" }, "extensions.update": { params: obj({}), learner: true, impl: false, note: "M6" },
  "extensions.importFromPi": { params: obj({}), learner: true, impl: false, note: "M6" }, "ui.respond": { params: obj({}), learner: true, impl: false, note: "no pi dialogs reach the client (pi no-op UI)" },
};

export const EVENTS = ["tutor.done", "item.present", "grade.result", "feedback.present", "repair.required", "hint.reveal", "gate.update", "node.status", "pace.notice",
  "confirm.required", "plan.changed", "plan.fit", "notice", "research.started", "research.ready", "cost.update", "export.ready", "checkpoint", "error", "dev.item_rejected", "transcription.review"] as const;

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
