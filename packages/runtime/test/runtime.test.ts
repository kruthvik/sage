import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSageRuntime } from "../src/runtime.ts";
import { createSagePaths } from "../src/paths.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

test("bootstraps, hands control to Pi once and disposes idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-runtime-"));
  temporary.push(root);
  const paths = createSagePaths({ home: join(root, ".learn") });
  let starts = 0;
  let disposals = 0;
  const runtime = createSageRuntime(paths, {
    createPi: async (received) => {
      expect(received).toBe(paths);
      starts++;
      return { dispose: async () => { disposals++; } };
    },
  });
  await runtime.start();
  expect(starts).toBe(1);
  expect(await readdir(paths.home)).toContain("brain.md");
  await runtime.dispose();
  await runtime.dispose();
  expect(disposals).toBe(1);
});

test("shutdown waits for pending startup and disposes the resulting Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-runtime-"));
  temporary.push(root);
  let signalStarted!: () => void;
  let finishStartup!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const pending = new Promise<void>(resolve => { finishStartup = resolve; });
  let disposals = 0;
  const runtime = createSageRuntime(createSagePaths({ home: join(root, ".learn") }), {
    createPi: async () => {
      signalStarted();
      await pending;
      return { dispose: async () => { disposals++; } };
    },
  });
  const startup = runtime.start();
  await started;
  const shutdown = runtime.dispose();
  finishStartup();
  await Promise.all([startup, shutdown]);
  await runtime.dispose();
  expect(disposals).toBe(1);
});

test("rejects a second start while Pi startup is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-runtime-"));
  temporary.push(root);
  let signalStarted!: () => void;
  let finishStartup!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const pending = new Promise<void>(resolve => { finishStartup = resolve; });
  let starts = 0;
  const runtime = createSageRuntime(createSagePaths({ home: join(root, ".learn") }), {
    createPi: async () => {
      starts++;
      signalStarted();
      await pending;
      return { dispose: async () => {} };
    },
  });
  const startup = runtime.start();
  await started;
  const secondStart = runtime.start().then(() => false, () => true);
  finishStartup();
  await startup;
  expect(await secondStart).toBe(true);
  expect(starts).toBe(1);
  await runtime.dispose();
});

test("repeated shutdown waits for the same pending cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-runtime-"));
  temporary.push(root);
  let signalDisposing!: () => void;
  let finishDisposal!: () => void;
  const disposing = new Promise<void>(resolve => { signalDisposing = resolve; });
  const pending = new Promise<void>(resolve => { finishDisposal = resolve; });
  let disposals = 0;
  const runtime = createSageRuntime(createSagePaths({ home: join(root, ".learn") }), {
    createPi: async () => ({ dispose: async () => {
      disposals++;
      signalDisposing();
      await pending;
    } }),
  });
  await runtime.start();
  const firstShutdown = runtime.dispose();
  await disposing;
  let settled = false;
  const secondShutdown = runtime.dispose().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finishDisposal();
  await Promise.all([firstShutdown, secondShutdown]);
  expect(disposals).toBe(1);
});

test("startup failure remains visible and does not prevent shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-runtime-"));
  temporary.push(root);
  const failure = new Error("Pi startup failed");
  const runtime = createSageRuntime(createSagePaths({ home: join(root, ".learn") }), {
    createPi: async () => { throw failure; },
  });
  await expect(runtime.start()).rejects.toBe(failure);
  await runtime.dispose();
  await expect(runtime.start()).rejects.toThrow("already started or stopped");
});
