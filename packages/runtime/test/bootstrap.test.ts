import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createSagePaths } from "../src/paths.ts";

const tempHomes: string[] = [];
afterEach(async () => { for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true }); });

test("creates only user-owned bootstrap files and resource roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-bootstrap-"));
  tempHomes.push(root);
  const paths = createSagePaths({ home: join(root, ".learn") });
  await bootstrapSageHome(paths);
  expect((await readdir(paths.home)).sort()).toEqual(["agent", "brain.md", "sessions"]);
  expect((await readdir(paths.agent)).sort()).toEqual(["extensions", "prompts", "skills", "themes"]);
  expect(await readFile(paths.brain, "utf8")).toContain("Sage");
  expect(await readFile(paths.brain, "utf8")).toBe(await readFile(join(paths.applicationRoot, "brain.md"), "utf8"));
  await writeFile(paths.brain, "My own instructions\n");
  await bootstrapSageHome(paths);
  expect(await readFile(paths.brain, "utf8")).toBe("My own instructions\n");
});
