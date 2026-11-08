// Session folder exports from a scripted session (no models). Software checks, not learning efficacy.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFor, runSession, type Persona } from "../../eval/src/fixture.ts";
import { writeExports } from "../src/writer.ts";

const good = "Because the rule brings the exponent down and lowers it by one, which follows from the limit definition.";
const allCorrect: Persona = i => i.key?.kind === "numeric" ? { input: { kind: "text", text: answerFor(i) } } : { input: { kind: "text", text: good }, quality: "good" };
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "sage-exports-")); homes.push(h); return h; };

test("final export writes session.md with all six outcomes, node files and PDFs; reruns keep user edits", async () => {
  const r = runSession(allCorrect);
  expect(r.state.phase).toBe("ended");
  const h = home();
  const res = await writeExports(h, r.state, r.log, "final");
  expect(res.errors).toEqual([]);
  const md = readFileSync(join(res.dir, "session.md"), "utf8");
  for (const row of ["Acquisition", "Explanation / understanding", "Recall", "Retention (delayed only)", "Execution & selection", "Changed application"]) expect(md).toContain(`| ${row} |`);
  for (const sec of ["## Primary metrics", "## Plan", "## Timeline"]) expect(md).toContain(sec);
  expect(res.written.some(f => /^nodes\/01-[^/]+\/lesson\.md$/.test(f))).toBe(true);
  expect(readFileSync(join(res.dir, "cheatsheet.md"), "utf8")).toContain("## Left with gaps");
  expect(res.pdfs).toContain("cheatsheet.pdf");
  expect(readFileSync(join(res.dir, "cheatsheet.pdf")).subarray(0, 5).toString()).toBe("%PDF-");

  writeFileSync(join(res.dir, "session.md"), "my notes");
  const again = await writeExports(h, r.state, r.log, "final");
  expect(again.userEdited).toContain("session.md");
  expect(readFileSync(join(res.dir, "session.md"), "utf8")).toBe("my notes");
  expect(again.written).toEqual([]); // nothing else changed
  expect(existsSync(join(res.dir, ".sage-export.json"))).toBe(true);
}, 30000);

test("cheat sheet quotes the learner's own mistakes", async () => {
  let n = 0;
  const r = runSession((i, c) => i.key?.kind !== "numeric" && n++ < 3 ? { input: { kind: "text", text: "It just halves." }, quality: "wrong_reasoning" } : allCorrect(i, c), { maxSteps: 400 });
  const res = await writeExports(home(), r.state, r.log, "session");
  const sheet = res.written.find(f => f.endsWith("cheatsheet.md"));
  expect(sheet).toBeDefined();
  const all = res.written.filter(f => f.endsWith("cheatsheet.md")).map(f => readFileSync(join(res.dir, f), "utf8")).join("\n");
  expect(all).toContain("## Your mistakes");
  expect(all).toContain('"It just halves."');
});
