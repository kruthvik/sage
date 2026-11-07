import { access } from "node:fs/promises";
import type { DisposableRuntime } from "../../core/src/index.ts";
import { createSagePiRuntime } from "../../pi/src/runtime.ts";
import { bootstrapSageHome } from "./bootstrap.ts";
import type { SagePaths } from "./paths.ts";

export interface RuntimeOptions {
  createPi?: (paths: SagePaths) => Promise<DisposableRuntime>;
}

export function createSageRuntime(paths: SagePaths, options: RuntimeOptions = {}) {
  let pi: DisposableRuntime | undefined;
  let closed = false;
  let startup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  return {
    async start(): Promise<void> {
      if (closed || startup) throw new Error("Sage runtime has already started or stopped");
      startup = (async () => {
        for (const root of Object.values(paths.builtIn)) {
          try { await access(root); } catch (error) { throw new Error(`Required application resource missing: ${root}`, { cause: error }); }
        }
        await bootstrapSageHome(paths);
        pi = await (options.createPi ?? createSagePiRuntime)(paths);
      })();
      await startup;
    },
    async dispose(): Promise<void> {
      closed = true;
      shutdown ??= (async () => {
        // Startup failures still propagate through start(), but must not prevent cleanup.
        await startup?.catch(() => {});
        const session = pi;
        pi = undefined;
        await session?.dispose();
      })();
      await shutdown;
    },
  };
}
