import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, access, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { marked } from "marked";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSagePaths } from "../../../packages/runtime/src/paths.ts";
import { bootstrapSageHome } from "../../../packages/runtime/src/bootstrap.ts";
import { LearningService } from "../../../packages/runtime/src/service.ts";
import { createTutorArtifact } from "../../../packages/runtime/src/artifacts.ts";
import { exportMarkdownPdf } from "../../../packages/runtime/src/markdown-pdf.ts";
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
async function fixture(content = "# Area under a curve\n\nTutor-generated summary; not learner performance.\n\n- Set limits\n- Integrate x * e^x\n\n```js\nconsole.log('literal example');\n```") {
  const root = await mkdtemp(join(tmpdir(), "sage-pdf-cli-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const service = new LearningService(paths);
  try { const artifact = createTutorArtifact(service.store, { capability: "lesson_summary", content, provenance: "Owned offline export fixture" }, "fixture"); return { root, paths, artifact, sequence: service.store.throughSeq }; }
  finally { service.close(); }
}
function environment(home: string) {
  const env: Record<string, string> = { SAGE_HOME: home, HOME: home, USERPROFILE: home, TEMP: tmpdir(), TMP: tmpdir(), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["PATH", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function cli(home: string, args: string[], command = "artifact") {
  const child = Bun.spawn([process.execPath, entry, command, ...args], { env: environment(home), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}

test("e04s01 task 1: vault copies retain frozen attribution/source refs and inert content with exact-repeat reuse", async () => {
  const f = await fixture(), service = new LearningService(f.paths), session = "fixture";
  let id: string, spanId: string, sequence: number;
  try {
    service.activateSession(session);
    const sourceFile = join(f.root, "source.txt"); await writeFile(sourceFile, "Owned source: preserve equality by changing both sides.");
    const source = await service.sources.importFile(sourceFile); service.sources.accept(source.revision_id);
    spanId = service.sources.preview(source.revision_id)[0]!.span_id;
    const goal = service.store.define({ operation_id: randomUUID(), kind: "goal", body: { mode: "exam", objective: "Explain equality", subject: "math", horizon_days: 1, target_format: "explain", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [source.revision_id] } }, "learner", session);
    const define = (kind: string, body: unknown) => service.store.define({ operation_id: randomUUID(), kind, expected_goal_revision_id: goal.revision_id, body }, "human", session);
    const component = define("component", { title: "Equality", behavior: "Explain equality", subject: "math", concept_revision_ids: [], prerequisite_revision_ids: [], uncertainty: "Owned export fixture", target_dimensions: ["explanation"], knowledge_kind: "conceptual" });
    const rubric = define("rubric", { title: "Equality", dimensions: [{ name: "target", criterion: "Explain equality", max_score: 1 }], provisional: false, source_span_ids: [spanId] });
    const family = define("task_family", { title: "Equality", construct: "Explain equality", variation: "Numerical coefficients", lineage_revision_ids: [], component_revision_ids: [component.revision_id], solution_structure: "Same change both sides", method_selection: "Explain conservation", representations: ["symbolic"], structural_signature: "equality:v1" });
    const definition = define("task_definition", { title: "Explain equality", prompt: "Why change both sides?", family_revision_id: family.revision_id, component_revision_ids: [component.revision_id], rubric_revision_id: rubric.revision_id, source_span_ids: [spanId], format: "free_response", allowed_aids: [], steps: [], scoring: "rubric", status: "practice_ready", review: { method: "curated", reason: "Owned export fixture, not calibrated" }, stakes: "low", partition: "practice", changes: [], uncertainty: "No performance claim", representation: "symbolic" });
    const instance = define("task_instance", { definition_revision_id: definition.revision_id, goal_revision_id: goal.revision_id, purpose: "independent", conditions: [] });
    id = createTutorArtifact(service.store, { capability: "lesson_summary", instance_revision_id: instance.revision_id, content: '<script>steal()</script> [remote](https://example.invalid)\n~~~\nLiteral source', provenance: "Frozen source-qualified export fixture" }, session).revision_id;
    sequence = service.store.throughSeq;
  } finally { service.close(); }
  const vault = join(f.root, "owned-vault"); await mkdir(vault);
  expect((await cli(f.paths.home, ["configure", vault], "vault")).code).toBe(0);
  const first = await cli(f.paths.home, ["export", id, "notes/checked.md"], "vault"); expect(first.code).toBe(0);
  const note = join(vault, "Sage", "notes", "checked.md"), text = await readFile(note, "utf8");
  expect(text).toContain("Frozen source-qualified export fixture"); expect(text).toContain(spanId); expect(text).toContain('"sourceSpanIds":["' + spanId + '"]');
  const html = await marked.parse(text); expect(html).not.toContain("<script>"); expect(html).not.toContain('href="https://example.invalid"');
  const again = await cli(f.paths.home, ["export", id, "notes/checked.md"], "vault"); expect(again.code).toBe(0); expect(JSON.parse(again.stdout).created).toBe(false); expect(await readFile(note, "utf8")).toBe(text);
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(sequence); } finally { checked.close(); }
}, 30000);

test("e04s01 task 1: unknown, external, imported and hypothetical lineage cannot authorize vault or PDF copies", async () => {
  const f = await fixture(), service = new LearningService(f.paths), ids: string[] = [];
  try {
    for (const author of ["unknown", "external"] as const) ids.push(service.store.define({ operation_id: randomUUID(), kind: "artifact", body: { ...f.artifact.body, author } }, "human", "fixture").revision_id);
    ids.push(service.store.define({ operation_id: randomUUID(), kind: "artifact", body: f.artifact.body }, "import", "fixture").revision_id);
    const id = randomUUID(), receipt = service.store.append("decision", { action: "revision_defined", kind: "artifact", revision_id: id, reason: "Hypothetical only", evidence_event_ids: [] }, randomUUID(), "pi", "fixture", undefined, undefined, "hypothetical");
    service.store.insertRevision(id, randomUUID(), "artifact", null, f.artifact.body, receipt.seq, randomUUID(), {}); ids.push(id);
  } finally { service.close(); }
  const vault = join(f.root, "owned-vault"); await mkdir(vault); expect((await cli(f.paths.home, ["configure", vault], "vault")).code).toBe(0);
  for (const [i, id] of ids.entries()) {
    const pdf = join(f.root, `denied-${i}.pdf`);
    expect((await cli(f.paths.home, ["pdf", id, pdf])).code).not.toBe(0);
    expect((await cli(f.paths.home, ["export", id, `denied-${i}.md`], "vault")).code).not.toBe(0);
    await expect(access(pdf)).rejects.toThrow(); await expect(access(join(vault, "Sage", `denied-${i}.md`))).rejects.toThrow();
  }
}, 30000);

test("e04s01 task 1: learner PDF retains actual-response attribution and repeat conflict preserves bytes and ledger", async () => {
  const f = await fixture(), service = new LearningService(f.paths); let id: string, responseId: string, sequence: number;
  try {
    const response = service.store.learnerResponse("Actual owned learner working", "fixture"); responseId = response.event_id;
    id = service.store.define({ operation_id: randomUUID(), kind: "artifact", body: { ...f.artifact.body, author: "learner", response_event_id: responseId, provenance: "Actual fixture response; authorship self-declared" } }, "learner", "fixture").revision_id;
    sequence = service.store.throughSeq;
  } finally { service.close(); }
  const output = join(f.root, "learner.pdf"), result = await cli(f.paths.home, ["pdf", id, output]); expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout), bytes = await readFile(output), pdf = await PDFDocument.load(bytes); expect(receipt.origin).toBe("learner"); expect(receipt.evidenceKind).toBe("artifact_only"); expect(pdf.getPageCount()).toBe(receipt.pages);
  const text: string[] = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents(), streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream)) : contents instanceof PDFRawStream ? [contents] : [];
    for (const stream of streams) {
      const decoded = stream.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode" ? inflateSync(stream.getContents(), { maxOutputLength: 1048576 }) : stream.getContents();
      for (const match of Buffer.from(decoded).toString("latin1").matchAll(/<([a-fA-F0-9]+)>\s*Tj/g)) text.push(Buffer.from(match[1]!, "hex").toString("latin1"));
    }
  }
  expect(text.join("\n")).toContain(responseId);
  expect((await cli(f.paths.home, ["pdf", id, output])).code).not.toBe(0); expect(await readFile(output)).toEqual(bytes);
  expect((await readdir(f.root)).filter(name => name.startsWith(".sage-pdf-"))).toEqual([]);
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(sequence); } finally { checked.close(); }
}, 30000);

test("e04s01 task 1: edited/unmanaged notes and escaping destinations are preserved on denied export", async () => {
  const f = await fixture(), vault = join(f.root, "owned-vault"), outside = join(f.root, "outside"); await mkdir(vault); await mkdir(outside);
  expect((await cli(f.paths.home, ["configure", vault], "vault")).code).toBe(0);
  expect((await cli(f.paths.home, ["export", f.artifact.revision_id, "checked.md"], "vault")).code).toBe(0);
  const note = join(vault, "Sage", "checked.md"), sentinel = join(vault, "Sage", "unmanaged.md"); await writeFile(note, "User annotation"); await writeFile(sentinel, "Unmanaged sentinel");
  await symlink(outside, join(vault, "Sage", "linked"), process.platform === "win32" ? "junction" : "dir");
  for (const target of ["checked.md", "unmanaged.md", "../escaped.md", ".obsidian/rejected.md", "linked/escaped.md", "NUL.md"]) {
    const denied = await cli(f.paths.home, ["export", f.artifact.revision_id, target], "vault"); expect(denied.code).not.toBe(0);
  }
  expect(await readFile(note, "utf8")).toBe("User annotation"); expect(await readFile(sentinel, "utf8")).toBe("Unmanaged sentinel"); expect(await readdir(outside)).toEqual([]);
  await expect(access(join(vault, "escaped.md"))).rejects.toThrow(); await expect(access(join(vault, "Sage", ".obsidian"))).rejects.toThrow();
  expect((await cli(f.paths.home, ["export", f.artifact.revision_id, "retry/new-version.md"], "vault")).code).toBe(0);
}, 30000);

test("e04s01 task 1: competing PDF publication reports a conflict, preserves the verified winner and removes owned jobs", async () => {
  const f = await fixture(), output = join(f.root, "winner.pdf"), options = { outputPath: output, artifactRevisionId: f.artifact.revision_id, origin: "tutor" as const, provenance: f.artifact.body.provenance };
  const results = await Promise.allSettled([exportMarkdownPdf({ ...options, content: "First selected projection" }), exportMarkdownPdf({ ...options, content: "Competing selected projection" })]);
  const winner = results.find(result => result.status === "fulfilled"), failed = results.find(result => result.status === "rejected");
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  if (!winner || winner.status !== "fulfilled" || !failed || failed.status !== "rejected") throw new Error("Missing publication outcomes");
  expect(String(failed.reason)).toContain("PDF conflict"); const bytes = await readFile(output);
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(winner.value.fileHash); expect((await PDFDocument.load(bytes)).getPageCount()).toBe(winner.value.pages);
  expect((await readdir(f.root)).filter(name => name.startsWith(".sage-pdf-"))).toEqual([]);
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(f.sequence); } finally { checked.close(); }
}, 30000);

test("CLI exports the selected artifact as a structurally readable attributed PDF without changing evidence", async () => {
  const f = await fixture(); const output = join(f.root, "lesson.pdf");
  const result = await cli(f.paths.home, ["pdf", f.artifact.revision_id, output]); expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout); expect(receipt.artifactRevisionId).toBe(f.artifact.revision_id); expect(receipt.origin).toBe("tutor"); expect(receipt.evidenceKind).toBe("artifact_only"); expect(receipt.pages).toBeGreaterThan(0);
  const bytes = await readFile(output); expect(bytes.subarray(0, 5).toString()).toBe("%PDF-"); expect(bytes.subarray(-20).toString()).toContain("%%EOF");
  expect(receipt.fileHash).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  const checked = new LearningService(f.paths); try { expect(checked.store.throughSeq).toBe(f.sequence); } finally { checked.close(); }
}, 30000);

test("document HTML/scripts/images/links do not execute, fetch resources or expose a referenced local file", async () => {
  let requests = 0; const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { requests++; return new Response("MUST_NOT_APPEAR_HTTP_SECRET"); } });
  try {
    const f = await fixture(); const secret = join(f.root, "private.txt"); await writeFile(secret, "MUST_NOT_APPEAR_LOCAL_SECRET");
    const service = new LearningService(f.paths); let id: string;
    try { id = createTutorArtifact(service.store, { capability: "lesson_summary", provenance: "Untrusted strings are inert", content: `# Inert example\n\n![external](http://127.0.0.1:${server.port}/image)\n\n![local](file:///${secret.replaceAll("\\", "/")})\n\n[click](javascript:alert(1))\n\n<script src="http://127.0.0.1:${server.port}/script">alert(1)</script>\n\n<iframe src="http://127.0.0.1:${server.port}/frame"></iframe>` }, "fixture").revision_id; } finally { service.close(); }
    const output = join(f.root, "inert.pdf"); const result = await cli(f.paths.home, ["pdf", id, output]); expect(result.code).toBe(0); expect(requests).toBe(0);
    const parsed = await PDFDocument.load(await readFile(output)); const extracted: string[] = [];
    expect(parsed.getPageCount()).toBeGreaterThan(0);
    for (const page of parsed.getPages()) {
      expect(page.node.Annots()?.size() ?? 0).toBe(0); expect(page.node.has(PDFName.of("AA"))).toBe(false);
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream)) : contents instanceof PDFRawStream ? [contents] : [];
      for (const stream of streams) {
        const filter = stream.dict.get(PDFName.of("Filter"));
        const bytes = filter?.toString() === "/FlateDecode" ? inflateSync(stream.getContents(), { maxOutputLength: 1048576 }) : stream.getContents();
        for (const match of Buffer.from(bytes).toString("latin1").matchAll(/<([a-fA-F0-9]+)>\s*Tj/g)) extracted.push(Buffer.from(match[1]!, "hex").toString("latin1"));
      }
    }
    expect(parsed.catalog.has(PDFName.of("OpenAction"))).toBe(false);
    expect(extracted.join("\n")).toContain("Inert example"); expect(extracted.join("\n")).not.toContain("MUST_NOT_APPEAR");
  } finally { server.stop(true); }
}, 30000);

test("PDF export refuses existing files and junction destinations without changing the originals", async () => {
  const f = await fixture(); const output = join(f.root, "user.pdf"); await writeFile(output, "User original");
  const collision = await cli(f.paths.home, ["pdf", f.artifact.revision_id, output]); expect(collision.code).not.toBe(0); expect(collision.stderr).toContain("conflict"); expect(await readFile(output, "utf8")).toBe("User original");
  const outside = join(f.root, "outside"); await mkdir(outside); const junction = join(f.root, "linked"); await symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  const escaped = await cli(f.paths.home, ["pdf", f.artifact.revision_id, join(junction, "escaped.pdf")]); expect(escaped.code).not.toBe(0); expect(escaped.stderr).toContain("symlink"); await expect(access(join(outside, "escaped.pdf"))).rejects.toThrow();
}, 30000);

test("unsupported default-font glyphs and invalid PDF arguments never publish a degraded or partial document", async () => {
  const f = await fixture("# Greek formula\n\npi: π"); const output = join(f.root, "greek.pdf");
  const result = await cli(f.paths.home, ["pdf", f.artifact.revision_id, output]); expect(result.code).not.toBe(0); expect(result.stderr).toContain("font"); await expect(access(output)).rejects.toThrow();
  expect((await cli(f.paths.home, ["pdf", f.artifact.revision_id, output, "--bogus"])).code).not.toBe(0);
}, 30000);
