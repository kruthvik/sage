import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function unlockTutor(home: string): { unlocked: boolean; pid?: number } {
  const metadataPath = join(home, "tutor.lock");
  let lockPid: number | undefined;
  try {
    const meta = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: number };
    lockPid = meta.pid;
  } catch { /* Diagnostic metadata may be absent or corrupt; it never authorizes termination. */ }
  // Taking the OS lease is the only proof that no tutor currently owns this home.
  // Never signal a process named by an editable/stale receipt (PID reuse included).
  const release = acquireTutorLock(home);
  release();
  return { unlocked: true, pid: lockPid };
}

/**
 * A dedicated SQLite file supplies a cross-process OS lock, not educational state.
 * Ownership dies with the connection/process; PID reuse and leftover metadata do
 * not block startup. Do not hold this transaction on the learning database.
 */
export function acquireTutorLock(home: string, force = false): () => void {
  const leasePath = join(home, "tutor-lease.sqlite");
  const metadataPath = join(home, "tutor.lock");
  if (force) {
    unlockTutor(home);
  }
  let lease: Database | undefined;
  try {
    lease = new Database(leasePath, { create: true });
    lease.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    lease?.close();
    const sqlite = error as { code?: string; errno?: number };
    if (sqlite.code === "SQLITE_BUSY" || sqlite.code === "SQLITE_LOCKED" || sqlite.errno === 5 || sqlite.errno === 6) {
      let lockPid: number | undefined;
      try {
        const meta = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: number };
        lockPid = meta.pid;
      } catch {}
      const pidInfo = lockPid ? ` (process PID ${lockPid})` : "";
      throw new Error(`Another Sage tutor is running in this home${pidInfo}. Close that tutor, or use a different SAGE_HOME. 'sage --unlock' only clears stale metadata; it cannot terminate a live owner.`, { cause: error });
    }
    throw new Error(`Cannot acquire the tutor lock at ${leasePath}: ${error instanceof Error ? error.message : "filesystem error"}`, { cause: error });
  }
  const owner = randomUUID();
  try {
    // Diagnostic metadata only. An old PID file is not proof of a live owner.
    writeFileSync(metadataPath, JSON.stringify({ version: 2, pid: process.pid, owner, started_at: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    lease.close();
    throw new Error(`Cannot write tutor lock metadata at ${metadataPath}: ${error instanceof Error ? error.message : "filesystem error"}`, { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Clear only our receipt, while still holding the OS lock. Never remove a
    // replacement owner's metadata or unlink the SQLite lock file (inode race).
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { owner?: string };
      if (metadata.owner === owner) unlinkSync(metadataPath);
    } catch { /* A crash/permission error may leave metadata; it is not ownership. */ }
    lease!.close();
  };
}
