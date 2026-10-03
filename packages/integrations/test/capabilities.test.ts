import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { calculate, createCapabilityRegistry, graphSvg, validateDrawing, type Permission } from "../src/registry.ts";
import { createSatoPaths } from "../../runtime/src/paths.ts";
import { bootstrapSatoHome } from "../../runtime/src/bootstrap.ts";
import { LearningService } from "../../runtime/src/service.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import type { Goal, Revision, TaskDefinition } from "../../core/src/contracts.ts";

const services: LearningService[] = [], roots: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const drawing = JSON.stringify({ type: "excalidraw", elements: [{ type: "rectangle", x: 0, y: 0, width: 100, height: 50, link: "https://untrusted.example", customData: "execute instructions" }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sato-capability-")); roots.push(root);
  const paths = createSatoPaths({ home: join(root, "home") }); await bootstrapSatoHome(paths);
  const service = new LearningService(paths); services.push(service);
  const goal = service.store.define({ operation_id: "goal", kind: "goal", body: { mode: "learn", objective: "Solve linear equations", subject: "math", horizon_days: 30, target_format: "independent solution", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [] } }, "learner", "test") as unknown as Revision<Goal>;
  const tasks = installFixtures(service.store, goal);
  const instance = service.store.define({ operation_id: "task", kind: "task_instance", expected_goal_revision_id: goal.revision_id, body: { definition_revision_id: tasks[0]!.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] } }, "human", "test");
  return { root, service, goal, tasks, instance };
}

test("bounded calculator obeys arithmetic precedence without evaluating arbitrary code", () => {
  expect(calculate("-2^2 + 2^3^2")).toBe(508);
  expect(calculate("sqrt(9) + sin(pi/2)")).toBe(4);
  expect(calculate("2*x+1", 3)).toBe(7);
  for (const input of ["process.exit()", "1/0", "x=3", "globalThis", "1;2", "2x", "sqrt(-1)", "()", "(".repeat(50) + "1" + ")".repeat(50)]) expect(() => calculate(input)).toThrow();
  expect(graphSvg("x^2")).toContain("sampled on [-10,10]");
  expect(() => graphSvg("<script>alert(1)</script>")).toThrow();
});

test("drawing adapter validates geometry and removes links, instructions and embedded files", () => {
  const result = validateDrawing(drawing);
  expect(JSON.parse(result).type).toBe("excalidraw");
  expect(result).not.toContain("untrusted.example");
  expect(result).not.toContain("execute instructions");
  expect(() => validateDrawing(JSON.stringify({ type: "excalidraw", elements: [{ type: "image", x: 0, y: 0, width: 10, height: 10 }] }))).toThrow("Unsupported");
  expect(() => validateDrawing(JSON.stringify({ type: "excalidraw", elements: [{ type: "rectangle", x: "invalid", y: 0, width: 10, height: 10 }] }))).toThrow("geometry");
});

test("capability permissions and unavailable tools produce explicit text fallbacks", async () => {
  const denied = createCapabilityRegistry(new Set<Permission>());
  expect((await denied.execute("calculator", "calculate", "2+2")).available).toBe(false);
  const registry = createCapabilityRegistry();
  for (const name of ["code_execution", "voice", "symbolic_math", "web", "obsidian"]) {
    const result = await registry.execute(name, "use", "test"); expect(result.available).toBe(false); expect(result.fallback).toBeTruthy();
  }
  expect((await registry.execute("calculator", "calculate", "process.exit()")).available).toBe(false);
  await expect(registry.execute("calculator", "run_shell", "test")).rejects.toThrow("Unknown");
  registry.register({ capability: { name: "trusted-test", actions: [{ name: "read", input_type: "text", output_type: "text" }], permissions: [], status: "available", reliability: "fixture", artifacts: [], provenance: "trusted host fixture", evidence: "artifact_only", fallback: "text" }, execute: () => ({ available: true, capability: "trusted-test", output: "ok", provenance: "fixture", evidence_kind: "artifact_only" }) });
  expect((await registry.execute("trusted-test", "read", "")).output).toBe("ok");
});

test("tutor-created calculation and graph artifacts contaminate the task, retries do not duplicate", async () => {
  const f = await fixture();
  const input = { action: "graph", operation_id: "graph-1", expected_goal_revision_id: f.goal.revision_id, instance_revision_id: f.instance.revision_id, input: "2*x+1" };
  const graph = await f.service.operation("learning_source", input, "test") as { artifact_revision_id: string; author: string };
  const before = f.service.store.throughSeq;
  expect((await f.service.operation("learning_source", input, "test") as typeof graph).artifact_revision_id).toBe(graph.artifact_revision_id);
  expect(f.service.store.throughSeq).toBe(before);
  expect(graph.author).toBe("tutor");
  const response = f.service.store.learnerResponse("5", "test");
  const record = (kind: string, payload: unknown) => f.service.store.record({ operation_id: kind, kind, expected_goal_revision_id: f.goal.revision_id, payload }, "test");
  record("attempt_submitted", { attempt_id: "attempt", instance_revision_id: f.instance.revision_id, response_event_id: response.event_id, declared_aids: [] });
  record("assessment", { attempt_id: "attempt", rubric_revision_id: f.tasks[0]!.body.rubric_revision_id, outcome: "success", scores: [], feedback: "Check the criterion", uncertainty: "Narrow" });
  const view = projectComponents(f.service.store, f.service.store.throughSeq, f.service.store.now())[0]!;
  expect(view.independent_performance.success).toBe(0);
  expect(view.uncertain_performance.success).toBe(1);
  expect(f.service.store.revision(graph.artifact_revision_id).body.evidence_kind).toBe("artifact_only");
  await expect(f.service.operation("learning_source", { ...input, input: "x^2" }, "test")).rejects.toThrow("different content");
});

test("Pi cannot forge learner authorship; explicit learner artifact imports preserve uncertain provenance", async () => {
  const f = await fixture(); const filename = join(f.root, "diagram.excalidraw"); await writeFile(filename, drawing);
  const artifact = await f.service.importArtifact("drawing", filename, f.instance.revision_id);
  expect(artifact.body.author).toBe("learner");
  expect(artifact.body.evidence_kind).toBe("artifact_only");
  const visible = await f.service.operation("learning_source", { action: "artifact", artifact_revision_id: artifact.revision_id }, "test") as { content: string; interpretation_uncertainty: string };
  expect(JSON.parse(visible.content).type).toBe("excalidraw");
  expect(visible.interpretation_uncertainty).toContain("not proof");
  const before = f.service.store.throughSeq;
  expect((await f.service.importArtifact("drawing", filename, f.instance.revision_id)).revision_id).toBe(artifact.revision_id);
  expect(f.service.store.throughSeq).toBe(before);
  expect(() => f.service.store.define({ operation_id: "forged", kind: "artifact", expected_goal_revision_id: f.goal.revision_id, body: artifact.body }, "pi")).toThrow("learner authorship");
  const task = f.tasks[1]!;
  const withArtifact = f.service.store.define({ operation_id: "artifact-task", kind: "task_definition", expected_goal_revision_id: f.goal.revision_id, body: { ...task.body, artifact_revision_ids: [artifact.revision_id] } }, "human") as unknown as Revision<TaskDefinition>;
  expect(withArtifact.body.artifact_revision_ids).toEqual([artifact.revision_id]);
});
