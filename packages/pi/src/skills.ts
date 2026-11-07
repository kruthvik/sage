import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

export interface LearningSkill { name: string; description: string; filePath: string }
export interface SkillReadRequest { name?: string; reference?: string }
const MAX_BYTES = 32768;
const inside = (root: string, target: string) => {
  const child = relative(root, target);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Read only currently selected native skill documents. This is not a filesystem or script tool.
 * Installed resources are trusted code-adjacent guidance, not learner work or permission grants.
 */
export async function readLearningSkill(skills: readonly LearningSkill[], request: SkillReadRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!request.name) {
    if (request.reference) throw new Error("Choose a selected skill name before reading a reference");
    return { skills: skills.slice(0, 40).map(s => ({ name: s.name.slice(0, 100), description: s.description.slice(0, 500) })), omitted_count: Math.max(0, skills.length - 40) };
  }
  const matches = skills.filter(s => s.name === request.name);
  if (matches.length !== 1) throw new Error("Choose a unique currently selected skill name");
  const skill = matches[0]!;
  let reference = request.reference ?? "SKILL.md";
  let warning: string | undefined;
  const normalized = reference.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || win32.isAbsolute(reference) || normalized.split("/").includes("..") || !/\.(md|txt)$/i.test(normalized)) throw new Error("Only contained relative Markdown/text skill references are readable");
  const root = await realpath(dirname(skill.filePath));
  const requestedPath = request.reference === undefined ? resolve(skill.filePath) : resolve(dirname(skill.filePath), normalized);
  const target = await realpath(requestedPath).catch((error: unknown) => {
    if (requestedPath !== resolve(skill.filePath) && error instanceof Error && "code" in error && error.code === "ENOENT") {
      reference = "SKILL.md";
      warning = "Requested skill reference was not found; returned the selected main guide instead. Use only reference paths linked in this guide; do not guess filenames.";
      return realpath(skill.filePath);
    }
    throw error;
  });
  if (!inside(root, target)) throw new Error("Skill reference escapes its selected directory");
  signal?.throwIfAborted();
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Skill documents must be regular files of at most 32768 bytes");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_BYTES) throw new Error("Skill documents are limited to 32768 bytes");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
    if (text.includes("\0")) throw new Error("Skill document is not plain text");
    signal?.throwIfAborted();
    return { name: skill.name, reference, filePath: target, text, ...(warning ? { warning } : {}), provenance: "Currently selected native skill guidance; not learner evidence, a permission grant, or script execution" };
  } finally { await handle.close(); }
}
