import { homedir } from "node:os";
import { join } from "node:path";

/** SAGE_HOME layout (SPEC §14). v3 defaulted to ~/.learn; the server offers a one-time migration from there. */
export function sagePaths(home = process.env.SAGE_HOME || join(homedir(), ".sage")) {
  return {
    home, brain: join(home, "brain.md"), settings: join(home, "settings.json"), agent: join(home, "agent"),
    db: join(home, "data", "sage.sqlite"), blobs: join(home, "data", "blobs"), usage: join(home, "data", "usage.json"),
    sessions: join(home, "sessions"), legacyV3: join(homedir(), ".learn"),
  };
}
