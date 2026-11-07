import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SagePaths } from "./paths.ts";

export async function bootstrapSageHome(paths: SagePaths): Promise<void> {
  try {
    await mkdir(paths.sessions, { recursive: true });
    for (const root of Object.values(paths.userResources)) {
      await mkdir(root, { recursive: true });
    }
    const template = await readFile(join(paths.applicationRoot, "brain.md"), "utf8");
    await writeFile(paths.brain, template, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  } catch (error) {
    throw new Error("Unable to initialize Sage home directory", { cause: error });
  }
}
