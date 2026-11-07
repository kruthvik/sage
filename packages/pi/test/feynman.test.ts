import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewWithPi } from "../src/feynman.ts";
import { parseFeynmanReview, type FeynmanRequest } from "../../core/src/feynman.ts";
import { loadPi } from "../src/sdk.ts";
import { createSagePaths } from "../../runtime/src/paths.ts";
import { bootstrapSageHome } from "../../runtime/src/bootstrap.ts";
import type { CallEntry } from "../../core/src/contracts.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const request: FeynmanRequest = { objective: "Explain chemiosmosis", prompt: "Teach me how a proton gradient helps make ATP.", criteria: ["Relate gradient, proton flow and ATP synthase"], explanation: "The gradient stores energy. Protons make ATP." };
const review = { summary: "The link between proton flow and ATP formation is unclear.", strengths: ["Identifies stored gradient energy"], gaps: [{ quote: "Protons make ATP.", issue: "May omit ATP synthase and the mechanism; omission is not yet a misconception.", question: "How do the protons help?" }], follow_up: "How do the protons help make ATP?", uncertainty: "A short explanation cannot establish independent application or retention." };

test("teach-back schema rejects invented quotes, extra keys, excessive gaps and oversized output", () => {
  expect(parseFeynmanReview(JSON.stringify(review), request.explanation)).toEqual(review);
  expect(parseFeynmanReview(`\`\`\`json\n${JSON.stringify(review)}\n\`\`\``, request.explanation)).toEqual(review);
  expect(() => parseFeynmanReview(JSON.stringify({ ...review, gaps: [{ ...review.gaps[0], quote: "I said something else" }] }), request.explanation)).toThrow("verbatim");
  expect(() => parseFeynmanReview(JSON.stringify({ ...review, mastery: 0.9 }), request.explanation)).toThrow();
  expect(() => parseFeynmanReview(JSON.stringify({ ...review, gaps: Array(4).fill(review.gaps[0]) }), request.explanation)).toThrow();
  expect(() => parseFeynmanReview(" ".repeat(12001), request.explanation)).toThrow("bound");
});

test("actual Pi Feynman child is isolated, single-call, cancellable and records attributable telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-feynman-")); roots.push(root);
  const paths = createSagePaths({ home: join(root, "home") }); await bootstrapSageHome(paths);
  const sdk = await loadPi(paths);
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(paths.agent, "auth.json"), modelsPath: null, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false, allowModelNetwork: false });
  let count = 0;
  let output = JSON.stringify(review);
  let waitForCancel = false;
  let useToolCall = false;
  modelRuntime.registerProvider("sage-feynman-test", {
    api: "sage-feynman-test-api", baseUrl: "https://example.invalid", apiKey: "offline",
    models: [{ id: "novice", name: "Offline novice", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    streamSimple(model, context, options) {
      count++;
      const system = context.messages.filter(message => message.role === "system");
      expect(system.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : [])).toEqual([]);
      expect(options?.maxTokens).toBe(4096);
      expect(JSON.stringify(system)).toContain("curious novice/student");
      expect(JSON.stringify(system)).not.toContain("UNAUTHORIZED_CONTEXT");
      const stream = ai.createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.({ offline: true }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        if (waitForCancel && !options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        const message = { role: "assistant", content: useToolCall ? [{ type: "toolCall", id: "unwanted", name: "not_allowed", arguments: {} }] : [{ type: "text", text: output }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: options?.signal?.aborted ? "aborted" : useToolCall ? "toolUse" : "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        stream.push(options?.signal?.aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: message.stopReason, message }); stream.end();
      })();
      return stream;
    },
  });
  await mkdir(paths.config, { recursive: true });
  await writeFile(join(paths.config, "AGENTS.md"), "UNAUTHORIZED_CONTEXT");
  await writeFile(join(paths.userResources.extensions, "must-not-load.ts"), 'throw new Error("User extension must not execute in Feynman child");');
  const calls: CallEntry[] = [];
  const options = { sdk, modelRuntime, model: modelRuntime.getModel("sage-feynman-test", "novice")!, sessionId: "parent", calls: async (entry: CallEntry) => { calls.push(entry); }, authorize: async () => ({ session_id: "parent", revision: "offline-authorized-scope", packet: { goal: { body: { provider_sharing: true } } } }), signal: new AbortController().signal };
  expect(await reviewWithPi(paths, request, options)).toEqual(review);
  expect(count).toBe(1);
  expect(calls.map(call => call.phase)).toEqual(["started", "response", "completed"]);
  expect(calls[0]!.operation).toBe("pi_feynman_request");
  expect(calls[2]!.output_tokens).toBe(2);
  output = "Not valid JSON";
  await expect(reviewWithPi(paths, request, options)).rejects.toThrow();
  expect(count).toBe(2);
  output = JSON.stringify({ ...review, gaps: [{ ...review.gaps[0], quote: "fabricated learner sentence" }] });
  await expect(reviewWithPi(paths, request, options)).rejects.toThrow("verbatim");
  expect(count).toBe(3);
  const cancelled = new AbortController(); cancelled.abort(new Error("Cancelled"));
  await expect(reviewWithPi(paths, request, { ...options, signal: cancelled.signal })).rejects.toThrow("Cancelled");
  expect(count).toBe(3);
  waitForCancel = true;
  await expect(reviewWithPi(paths, request, { ...options, timeoutMs: 150 })).rejects.toThrow("too long");
  expect(count).toBe(4);
  expect(calls.at(-1)!.phase).toBe("cancelled");
  waitForCancel = false; useToolCall = true;
  await expect(reviewWithPi(paths, request, options)).rejects.toThrow("complete text");
  expect(count).toBe(5);
  await expect(reviewWithPi(paths, request, { ...options, authorize: async () => { throw new Error("Current disclosure scope denied"); } })).rejects.toThrow("disclosure");
  expect(count).toBe(5);
});
