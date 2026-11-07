import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearningSkill } from "../src/skills.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sage-skill-reader-")); roots.push(root);
  const dir = join(root, "learning"); await mkdir(join(dir, "references"), { recursive: true });
  const filePath = join(dir, "SKILL.md"); await writeFile(filePath, "# Learning\nAsk for an attempt before assessing.");
  await writeFile(join(dir, "references", "feedback.md"), "Use criterion-specific feedback.");
  return { root, dir, skills: [{ name: "learning", description: "Attempt-first teaching", filePath }] };
}

test("skill reader lists native-selected metadata and reads the full skill and contained reference without execution", async () => {
  const f = await fixture();
  expect(await readLearningSkill(f.skills, {})).toMatchObject({ skills: [{ name: "learning", description: "Attempt-first teaching" }], omitted_count: 0 });
  expect(await readLearningSkill(f.skills, { name: "learning" })).toMatchObject({ name: "learning", reference: "SKILL.md", text: "# Learning\nAsk for an attempt before assessing." });
  expect(await readLearningSkill(f.skills, { name: "learning", reference: "references/feedback.md" })).toMatchObject({ text: "Use criterion-specific feedback." });
  await expect(readLearningSkill(f.skills, { name: "ambient-global-skill" })).rejects.toThrow("selected");
});

for (const reference of ["design.md", "reference.md"]) test(`missing ${reference} returns the selected main guide with an explicit fallback warning`, async () => {
  const f = await fixture();
  const before = (await readdir(f.dir)).sort();
  expect(await readLearningSkill(f.skills, { name: "learning", reference })).toMatchObject({
    reference: "SKILL.md", filePath: f.skills[0]!.filePath, text: "# Learning\nAsk for an attempt before assessing.",
    warning: "Requested skill reference was not found; returned the selected main guide instead. Use only reference paths linked in this guide; do not guess filenames.",
  });
  expect(await readLearningSkill(f.skills, { name: "learning" })).toMatchObject({ reference: "SKILL.md", text: "# Learning\nAsk for an attempt before assessing." });
  expect((await readdir(f.dir)).sort()).toEqual(before);
});

test("a missing main guide retains the filesystem error instead of recommending a retry of itself", async () => {
  const f = await fixture(); await rm(f.skills[0]!.filePath);
  for (const request of [{ name: "learning" }, { name: "learning", reference: "SKILL.md" }, { name: "learning", reference: "./SKILL.md" }]) {
    await expect(readLearningSkill(f.skills, request)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("skill reader rejects traversal, absolute paths, symlink escapes, executables, directories and ambiguous names", async () => {
  const f = await fixture(); await writeFile(join(f.root, "private.md"), "PRIVATE");
  const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "private.md"), "PRIVATE");
  await symlink(outside, join(f.dir, "escape"), process.platform === "win32" ? "junction" : "dir");
  for (const reference of ["../private.md", "..\\private.md", join(f.root, "private.md"), "C:\\private.md", "escape/private.md", "script.ts", "references"]) {
    await expect(readLearningSkill(f.skills, { name: "learning", reference })).rejects.toThrow();
  }
  await expect(readLearningSkill(f.skills, { reference: "SKILL.md" })).rejects.toThrow();
  await expect(readLearningSkill([...f.skills, ...f.skills], { name: "learning" })).rejects.toThrow("unique");
});

test("skill reader rejects oversized or malformed text and honors cancellation", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "large.md"), "x".repeat(32769));
  await writeFile(join(f.dir, "invalid.md"), Buffer.from([255, 0]));
  await expect(readLearningSkill(f.skills, { name: "learning", reference: "large.md" })).rejects.toThrow("32768");
  await expect(readLearningSkill(f.skills, { name: "learning", reference: "invalid.md" })).rejects.toThrow();
  const controller = new AbortController(); controller.abort(new Error("Cancelled"));
  await expect(readLearningSkill(f.skills, { name: "learning" }, controller.signal)).rejects.toThrow("Cancelled");
});
