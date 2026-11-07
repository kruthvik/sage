import { createSageResourceLoader } from "../../pi/src/runtime.ts";
import { bootstrapSageHome } from "./bootstrap.ts";
import type { SagePaths } from "./paths.ts";

export { createSagePaths } from "./paths.ts";
export { createSageRuntime } from "./runtime.ts";

export async function inspectSageResources(paths: SagePaths) {
  await bootstrapSageHome(paths);
  const loader = await createSageResourceLoader(paths);
  await loader.reload();
  return {
    extensions: loader.getExtensions().extensions.length,
    skills: loader.getSkills().skills.length,
    prompts: loader.getPrompts().prompts.length,
    themes: loader.getThemes().themes.length,
    errors: loader.getExtensions().errors,
    diagnostics: [...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics, ...loader.getThemes().diagnostics],
  };
}
