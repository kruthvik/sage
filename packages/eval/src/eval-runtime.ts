// Shared dev-eval runtime: Sage's own agent dir and the packages `sage setup` installed there (owner: never ~/.pi in place).
import { join } from "node:path";
import { homedir } from "node:os";
import { createSageRuntime } from "../../pi-adapter/src/runtime.ts";
import { sagePackages } from "../../pi-adapter/src/update.ts";
import { sagePaths } from "../../core/src/paths.ts";

export async function evalRuntime(_providers?: string[]) {
  const paths = sagePaths(process.env.SAGE_HOME ?? join(homedir(), ".sage"));
  return createSageRuntime({ paths, packages: await sagePackages(paths) });
}
