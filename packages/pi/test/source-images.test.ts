import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPi, type PiSdk } from "../src/sdk.ts";
import { createTutorRuntime } from "../src/tutor.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import { LearningService, startLearningServer } from "../../runtime/src/service.ts";
import { createTutorBridge } from "../../runtime/src/tutor-host.ts";
import { randomUUID } from "node:crypto";

const shell = Bun.which("powershell.exe"), cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
describe.skipIf(process.platform !== "win32" || !shell || !Bun.which("tesseract"))("selected original source image disclosure", () => {
  test("vision requests receive only selected accepted originals; text models receive an omission notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "sage-image-disclosure-")), paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
    const sdk = await loadPi(paths), ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const models = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const service = new LearningService(paths), server = startLearningServer(service), bridge = createTutorBridge(paths, service, server), outgoing: unknown[] = [];
    const injected: PiSdk = { ...sdk, createAgentSessionServices: options => sdk.createAgentSessionServices({ ...options, modelRuntime: models }) };
    const runtime = await createTutorRuntime(paths, bridge, injected);
    cleanups.push(async () => { await runtime.dispose(); server.stop(); service.close(); await rm(root, { recursive: true, force: true }); });
    models.registerProvider("sage-source-images", { api: "sage-source-images-api", baseUrl: "https://example.invalid", apiKey: "offline", models: ["vision", "text"].map(id => ({ id, name: `Synthetic ${id}`, reasoning: false, input: id === "vision" ? ["text" as const, "image" as const] : ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 })), streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream(), message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Synthetic source image response; not learner evidence" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
      void (async () => { try { const payload = { model: model.id, messages: context.messages }; await options?.onPayload?.(payload, model); outgoing.push(payload); stream.push({ type: "done", reason: "stop", message }); } catch (error) { stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }); } stream.end(); })(); return stream;
    } });
    const originals: Buffer[] = [];
    for (const color of ["White", "Blue"]) {
      const script = `Add-Type -AssemblyName System.Drawing;$b=[Drawing.Bitmap]::new(160,160);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::FromName([Console]::In.ReadToEnd()));$m=[IO.MemoryStream]::new();$b.Save($m,[Drawing.Imaging.ImageFormat]::Png);[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()));$g.Dispose();$b.Dispose();$m.Dispose()`;
      const child = Bun.spawn([shell!, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 10000);
      try { child.stdin.write(color); child.stdin.end(); const [text, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(code).toBe(0); const bytes = Buffer.from(text, "base64"); originals.push(bytes); await writeFile(join(root, `${color}.png`), bytes); }
      finally { clearTimeout(timer); }
    }
    const chosen = await service.sources.importFile(join(root, "White.png")), excluded = await service.sources.importFile(join(root, "Blue.png"));
    service.sources.accept(chosen.revision_id); service.sources.accept(excluded.revision_id);
    const owner = runtime.session.sessionId;
    await bridge.goal({ mode: "learn", objective: "Synthetic selected source", subject: "practical", horizon_days: 7, target_format: "Understanding", criteria: [], allowed_aids: [], constraints: [], probe: "skip", provider_sharing: true, source_ids: [chosen.revision_id] }, owner);
    await runtime.session.setModel(models.getModel("sage-source-images", "vision")!); await runtime.session.bindExtensions({});
    await runtime.session.prompt("Inspect the selected source", { source: "extension" });
    expect(outgoing).toHaveLength(1); expect(JSON.stringify(outgoing[0])).toContain(originals[0]!.toString("base64")); expect(JSON.stringify(outgoing[0])).not.toContain(originals[1]!.toString("base64"));
    expect(JSON.stringify(outgoing[0])).toContain("untrusted source"); expect(JSON.stringify(runtime.session.sessionManager.getEntries())).not.toContain(originals[0]!.toString("base64"));
    await runtime.session.setModel(models.getModel("sage-source-images", "text")!); await runtime.session.prompt("Use OCR only", { source: "extension" });
    expect(outgoing).toHaveLength(2); expect(JSON.stringify(outgoing[1])).not.toContain(originals[0]!.toString("base64")); expect(JSON.stringify(outgoing[1])).toContain("Original source images omitted");
    const goal = service.store.lessonGoal(owner)!;
    service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: goal.revision_id, expected_goal_revision_id: goal.revision_id, body: { ...goal.body, provider_sharing: false } }, "learner", owner);
    await expect(service.authorizeDisclosure(owner)).rejects.toThrow("sharing_disabled");
    await runtime.session.prompt("No sharing", { source: "extension" }); expect(outgoing).toHaveLength(2);
    expect(service.store.events().filter(event => event.kind === "assessment")).toEqual([]); expect(service.store.revisions("task_instance")).toEqual([]); expect(service.store.integrity()).toEqual(["ok"]);
    expect((await readFile(join(paths.data, "blobs", chosen.body.original_hash))).equals(originals[0]!)).toBe(true);
  }, 20000);
});
