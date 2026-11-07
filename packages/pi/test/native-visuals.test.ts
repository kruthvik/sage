import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Goal } from "../../core/src/contracts.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { createCapabilityRegistry } from "../../integrations/src/registry.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { LearningService } from "../../runtime/src/service.ts";
import { projectLearningState } from "../../runtime/src/learning-state.ts";
import { nativeToolPresentation } from "../src/presentation.ts";
import { createSageResourceLoader } from "../src/runtime.ts";
import { readLearningSkill } from "../src/skills.ts";

const roots: string[] = [], services: LearningService[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const theme = { fg: (_color: string, text: string) => text } as Theme;
type Context = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
function render(value: unknown, expanded = false, isPartial = false, isError = false, name = "learning_source") {
  return nativeToolPresentation(name).renderResult!({ content: [{ type: "text", text: JSON.stringify(value) }], details: undefined }, { expanded, isPartial }, theme, { isError } as Context);
}
async function graph(expression: string) {
  return { ...await createCapabilityRegistry().execute("graph", "graph", expression), author: "tutor", artifact_revision_id: "synthetic-artifact", native_preview: true };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-native-visuals-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home"), cwd: root }); await bootstrapSageHome(paths);
  return { paths };
}
const lines = (component: ReturnType<typeof render>, width: number) => component.render(width).map(stripVTControlCharacters);
const grid = (output: string[]) => output.filter(line => /^(?:\+10 |  0 |\-10 |    )[ |+*\-]+$/.test(line));

test("native Pi shows an existing tutor graph without expanding, mutating evidence or replacing its SVG", async () => {
  const { paths } = await fixture(); const service = new LearningService(paths); services.push(service);
  const goal = service.store.define({ operation_id: "goal", kind: "goal", body: { mode: "learn", objective: "Understand a straight line", subject: "math", horizon_days: 30, target_format: "explanation", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "native-visual");
  const request = { action: "graph", input: "x", operation_id: "graph", expected_goal_revision_id: goal.revision_id };
  const value = await service.operation("learning_source", request, "native-visual");
  const original = JSON.stringify(value), before = service.store.throughSeq;
  const component = render(value); const output = lines(component, 80).join("\n");
  expect(output).toContain("Native plot: y=x");
  expect(output).toContain("not learner performance");
  expect(output).toContain("discontinuities may be missed");
  expect(output).toContain("x,y range [-10,10]");
  expect(output).toContain("*"); expect(output).not.toContain("<svg");
  expect(lines(render(value, true), 100).join("\n")).toContain("<svg");
  expect(JSON.stringify(value)).toBe(original); expect(service.store.throughSeq).toBe(before);
  expect(await service.operation("learning_source", request, "native-visual")).toMatchObject({ artifact_revision_id: (value as { artifact_revision_id: string }).artifact_revision_id });
  expect(service.store.throughSeq).toBe(before);
});

test("native graph preview preserves coordinate direction, an origin sample and terminal width when resized", async () => {
  const component = render(await graph("x"));
  const wide = grid(lines(component, 80));
  expect(wide).toHaveLength(17);
  expect(wide[0]!.trimEnd().endsWith("*")).toBe(true);
  expect(wide[16]![4]).toBe("*");
  expect(wide[8]![4 + 30]).toBe("*");
  const narrow = grid(lines(component, 36)); expect(narrow).toHaveLength(17);
  expect(narrow[8]![4 + 15]).toBe("*");
  for (const width of [1, 12, 23, 24, 36, 80, 160]) {
    const output = lines(component, width);
    expect(output.length).toBeGreaterThan(0);
    expect(output.every(line => visibleWidth(line) <= width)).toBe(true);
  }
  expect(lines(component, 12).join("\n")).toContain("Widen");
  expect(lines(component, 80)).toEqual(lines(render(await graph("x")), 80));
});

test("undefined samples and empty plotting windows do not invent connected curves or clipped boundary points", async () => {
  const reciprocal = grid(lines(render(await graph("1/x")), 80));
  expect(reciprocal).toHaveLength(17);
  expect(reciprocal[8]![4 + 30]).toBe("+");
  const offWindow = lines(render(await graph("100")), 80);
  expect(offWindow.join("\n")).toContain("No sampled points lie in this window");
  expect(grid(offWindow).every(line => !line.includes("*"))).toBe(true);
});

test("only complete bounded Sage plot results get a preview; errors, partials and ordinary tool summaries remain compact", async () => {
  const value = await graph("x");
  for (const [expanded, partial, error, name] of [[false, true, false, "learning_source"], [false, false, true, "learning_source"], [false, false, false, "learning_context"]] as const) {
    expect(lines(render(value, expanded, partial, error, name), 160).join("\n")).not.toContain("Native plot");
  }
  for (const invalid of [
    { ...value, available: false }, { ...value, author: "learner" }, { ...value, capability: "drawing" },
    { ...value, provenance: "unreviewed renderer" }, { ...value, media_type: "text/plain" },
    { ...value, artifact_revision_id: undefined }, { ...value, evidence_kind: "inferred" },
    { ...value, native_preview: undefined }, { ...value, native_preview: false }, { ...value, native_preview: "true" },
    { ...value, output: value.output! + "<script>fetch('https://example.invalid')</script>" },
    { ...value, output: value.output!.replace("M0.0,300.0", "M999.0,300.0") },
    { ...value, output: value.output!.replace("L3.0,298.1", "Q3.0,298.1") },
    { ...value, output: value.output!.replaceAll("y=x;", "y=other;") },
    { ...value, output: "x".repeat(32769) }, { output: value.output }, null, [],
  ]) expect(lines(render(invalid), 160).join("\n")).not.toContain("Native plot");
  expect(lines(render({ available: true, capability: "calculator", output: "4" }), 160).join("\n")).toContain("Source action completed");
});

test("hostile SVG labels are not interpreted as terminal commands or general SVG", async () => {
  const value = await graph("x");
  const hostile = { ...value, output: value.output!.replaceAll("graph of x;", "graph of \u001b]52;c;SYNTHETIC\u0007x;").replaceAll("y=x;", "y=\u001b]52;c;SYNTHETIC\u0007x;") };
  const result = render(hostile); const output = lines(result, 80).join("\n");
  expect(output).not.toContain("Native plot"); expect(output).not.toContain("SYNTHETIC");
  expect(result.render(80).join("\n")).not.toContain("\u001b]52;");
});

test("host preview eligibility protects frozen pending work, stopped lessons and exam/cram/drill modes, including graph retries", async () => {
  for (const mode of ["learn", "exam", "cram", "drill"]) {
    const { paths } = await fixture(); const service = new LearningService(paths); services.push(service);
    const goal = service.store.define({ operation_id: "goal", kind: "goal", body: { mode, objective: "Plot a line", subject: "math", horizon_days: 30, deadline: "2027-01-01T12:00:00.000Z", target_format: "explanation", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "native-visual");
    const request = { action: "graph", input: "x", operation_id: "before-task", expected_goal_revision_id: goal.revision_id };
    const initial = await service.operation("learning_source", request, "native-visual");
    expect(initial).toMatchObject({ native_preview: mode === "learn" });
    expect(lines(render(initial), 80).join("\n").includes("Native plot")).toBe(mode === "learn");
    const task = installFixtures(service.store, service.store.revision<Goal>(goal.revision_id, "goal"))[0]!;
    const instance = service.store.define({ operation_id: "task", kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: task.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: ["No aids"] } }, "human", "native-visual");
    for (const input of [request, { ...request, operation_id: "during-task", instance_revision_id: instance.revision_id }]) {
      const value = await service.operation("learning_source", input, "native-visual");
      expect(value).toMatchObject({ native_preview: false });
      expect(lines(render(value), 80).join("\n")).not.toContain("Native plot");
    }
    service.store.record({ operation_id: "stop", kind: "checkpoint", expected_goal_revision_id: goal.revision_id, payload: { goal_revision_id: goal.revision_id, summary: "Paused", next_action: "Resume this question", gaps: [], stopped: true } }, "native-visual");
    expect(await service.operation("learning_source", request, "native-visual")).toMatchObject({ native_preview: false });
  }
});

test("governed instruction can include a native plot while waiting for Continue, but preview never releases the question", async () => {
  const { paths } = await fixture(); const service = new LearningService(paths); services.push(service);
  const createdGoal = service.store.define({ operation_id: "goal", kind: "goal", body: { mode: "learn", objective: "Understand straight lines", subject: "math", horizon_days: 30, target_format: "explanation", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "native-visual");
  const goal = service.store.revision<Goal>(createdGoal.revision_id, "goal");
  const task = installFixtures(service.store, goal)[0]!;
  const define = (operation_id: string, kind: string, body: unknown) => service.store.define({ operation_id, kind, expected_goal_revision_id: goal.revision_id, body }, "human", "native-visual");
  const instruction = define("instruction", "artifact", { capability: "worked_example", author: "tutor", provenance: "Owned offline instruction", media_type: "text/plain", content: "A straight line has a constant slope.", evidence_kind: "artifact_only", interpretation_uncertainty: "Software fixture, not efficacy evidence", assistance_event_ids: [], goal_revision_id: goal.revision_id });
  const definition = define("definition", "task_definition", { ...task.body, artifact_revision_ids: [instruction.revision_id] });
  const teaching = { schema_version: 1, unit_id: "native-unit", stage: "prepared", goal_revision_id: goal.revision_id, component_revision_id: task.body.component_revision_ids[0], instruction_revision_id: instruction.revision_id, definition_revision_id: definition.revision_id };
  const receipt = (id: string, annotation: Record<string, unknown>) => service.store.append("decision", { action: "teaching_stage", reason: "Owned software fixture", evidence_event_ids: [], teaching: annotation }, id, "host", "native-visual");
  const prepared = receipt("prepared", teaching);
  receipt("presented", { ...teaching, stage: "presented", prepared_event_id: prepared.event_id });
  expect(projectLearningState(service.store, "native-visual").phase).toBe("question_pending");
  const request = { action: "graph", input: "x", operation_id: "unit-graph", expected_goal_revision_id: goal.revision_id };
  const value = await service.operation("learning_source", request, "native-visual");
  expect(value).toMatchObject({ native_preview: true });
  expect(lines(render(value), 80).join("\n")).toContain("Native plot");
  expect(projectLearningState(service.store, "native-visual")).toMatchObject({ phase: "question_pending", teaching: { instance_revision_id: null, prepared_event_id: prepared.event_id } });
  expect(service.store.events().filter(e => e.kind === "task_delivered")).toHaveLength(0);
  const instance = define("instance", "task_instance", { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: ["No aids"] });
  receipt("linked", { ...teaching, stage: "linked", prepared_event_id: prepared.event_id, instance_revision_id: instance.revision_id });
  expect(projectLearningState(service.store, "native-visual").phase).toBe("awaiting_answer");
  expect(await service.operation("learning_source", request, "native-visual")).toMatchObject({ native_preview: false });
});

test("native-selected visualize guidance covers automatic and requested aids without granting browser, execution or scoring authority", async () => {
  const { paths } = await fixture(); const loader = await createSageResourceLoader(paths); await loader.reload();
  const skills = loader.getSkills().skills;
  expect(skills.some(skill => skill.name === "visualize")).toBe(true);
  const result = await readLearningSkill(skills, { name: "visualize" });
  const text = ("text" in result ? result.text : "")!;
  expect(text).toContain("automatically when useful"); expect(text).toContain("when the learner asks");
  for (const phrase of ["native Pi", "frozen aids", "Continue", "not learner performance", "learning_source", "learning_context", "browser", "permission", "x,y range [-10,10]"]) expect(text).toContain(phrase);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
});
