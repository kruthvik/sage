import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSageRuntime, ROLE_MAX_INPUT_CHARS } from "../src/runtime.ts";
import { sagePaths } from "../../core/src/paths.ts";

test("an isolated runtime sees no ambient credentials and rejects bad role calls before any network", async () => {
  const paths = sagePaths(await mkdtemp(join(tmpdir(), "sage-home-")));
  const rt = await createSageRuntime({ paths });
  expect(rt.agentDir).toBe(paths.agent);
  expect(process.env.PI_CODING_AGENT_DIR).toBe(paths.agent);
  expect(rt.services.resourceLoader.getSkills().skills).toEqual([]); // no ~/.agents/skills, no ambient .pi
  await expect(rt.roleCall({ provider: "nope", model: "nope", system: "s", user: "u" })).rejects.toThrow(/not available/);
  await expect(rt.roleCall({ provider: "nope", model: "nope", system: "", user: "x".repeat(ROLE_MAX_INPUT_CHARS + 1) })).rejects.toThrow(/exceeds/);
}, 30_000);
