import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Goal, TaskDefinition } from "../../core/src/contracts.ts";
import { installFixtures } from "../../activities/src/fixtures.ts";
import { verifyLinearEquation } from "../../activities/src/validation.ts";
import { canonical, hash, LearningStore } from "../../storage/src/store.ts";
import { projectComponents } from "../../storage/src/projection.ts";
import { parseLaunchArgs } from "../../../apps/cli/src/index.ts";
import { bootstrapSageHome } from "../src/bootstrap.ts";
import { createSagePaths } from "../src/paths.ts";
import { LearningService } from "../src/service.ts";
import { deliverProtectedAssessment, importProtectedTask } from "../src/assessment.ts";
import { acquireTutorLock, unlockTutor } from "../src/tutor-lock.ts";

const roots: string[] = [];
const leases: Array<() => void> = [];
afterEach(async () => {
  for (const release of leases.splice(0)) release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function home() { const root = await mkdtemp(join(tmpdir(), "sage-tutor-lock-")); roots.push(root); return root; }
function acquire(root: string) { const release = acquireTutorLock(root); leases.push(release); return release; }

test("only one tutor owns a home; release is idempotent and separate homes stay independent", async () => {
  const root = await home();
  const release = acquire(root);
  expect(() => acquireTutorLock(root)).toThrow("Another Sage tutor is running");
  const other = acquire(await home()); other();
  release(); release();
  expect(existsSync(join(root, "tutor.lock"))).toBe(false);
  const next = acquire(root);
  expect(JSON.parse(await readFile(join(root, "tutor.lock"), "utf8")).pid).toBe(process.pid);
  next();
});

test("unlock and force cannot displace a live lease or delete its diagnostic receipt", async () => {
  const root = await home(); const release = acquire(root);
  const receipt = await readFile(join(root, "tutor.lock"), "utf8");
  expect(() => unlockTutor(root)).toThrow("Another Sage tutor is running");
  expect(() => acquireTutorLock(root, true)).toThrow("Another Sage tutor is running");
  expect(await readFile(join(root, "tutor.lock"), "utf8")).toBe(receipt);
  release();
});

test("stale metadata is not authority to terminate any PID", async () => {
  const root = await home();
  await writeFile(join(root, "tutor.lock"), JSON.stringify({ version: 2, pid: process.pid + 1000000, owner: "untrusted-stale" }));
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  try {
    expect(unlockTutor(root).unlocked).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(join(root, "tutor.lock"))).toBe(false);
    const next = acquire(root); next();
  } finally { kill.mockRestore(); }
});

test("stale legacy PID, empty and corrupt diagnostic receipts never falsely block startup", async () => {
  const root = await home();
  for (const stale of [String(process.pid), "", "unfinished JSON", JSON.stringify({ version: 2, pid: process.pid, owner: "old-owner" })]) {
    await writeFile(join(root, "tutor.lock"), stale);
    const release = acquire(root);
    expect(JSON.parse(await readFile(join(root, "tutor.lock"), "utf8")).owner).not.toBe("old-owner");
    release();
  }
});

test("old release callbacks cannot remove a new owner's receipt", async () => {
  const root = await home();
  const old = acquire(root); old();
  const next = acquire(root);
  const receipt = await readFile(join(root, "tutor.lock"), "utf8");
  old();
  expect(await readFile(join(root, "tutor.lock"), "utf8")).toBe(receipt);
  next();
});

test("filesystem and metadata errors are not misreported as another tutor and release any acquired lease", async () => {
  const root = await home();
  const invalid = join(root, "not-a-directory"); await writeFile(invalid, "file");
  expect(() => acquireTutorLock(invalid)).toThrow("Cannot acquire the tutor lock");
  await mkdir(join(root, "tutor.lock"));
  expect(() => acquireTutorLock(root)).toThrow("Cannot write tutor lock metadata");
  await rm(join(root, "tutor.lock"), { recursive: true });
  const release = acquire(root); release();
});

test("abrupt process exit releases the OS lock even when diagnostic metadata remains", async () => {
  const root = await home();
  const module = new URL("../src/tutor-lock.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "-e", `import { acquireTutorLock } from ${JSON.stringify(module)}; acquireTutorLock(${JSON.stringify(root)}); console.log('ready'); setInterval(() => {}, 1000);`], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    try {
      const started = await Promise.race([reader.read(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Lock child startup timed out")), 10000); timer.unref(); })]);
      expect(new TextDecoder().decode(started.value)).toContain("ready");
    } finally { reader.releaseLock(); }
    expect(() => acquireTutorLock(root)).toThrow("Another Sage tutor is running");
    child.kill("SIGKILL"); await child.exited;
    expect(existsSync(join(root, "tutor.lock"))).toBe(true);
    const recovered = acquire(root); recovered();
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
});

function ledger(store: LearningStore) {
  const tables = ["blob_manifest", "event", "job", "model_call_log", "object_revision", "projection", "source_span"];
  expect(store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name)).toEqual(tables);
  expect(store.integrity()).toEqual(["ok"]);
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  return hash(canonical([
    store.db.query("SELECT * FROM blob_manifest ORDER BY rowid").all(),
    store.db.query("SELECT * FROM event ORDER BY rowid").all(),
    store.db.query("SELECT * FROM job ORDER BY rowid").all(),
    store.db.query("SELECT * FROM model_call_log ORDER BY rowid").all(),
    store.db.query("SELECT * FROM object_revision ORDER BY rowid").all(),
    store.db.query("SELECT * FROM projection ORDER BY rowid").all(),
    store.db.query("SELECT * FROM source_span ORDER BY rowid").all(),
  ]));
}

async function maintenance(root: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, SAGE_HOME: root }; delete env.PI_PACKAGE_DIR;
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../../apps/cli/src/index.ts", import.meta.url)), ...args], { env, stdout: "pipe", stderr: "pipe" });
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}

async function ownedStore(root: string) {
  const paths = createSagePaths({ home: root }); await bootstrapSageHome(paths);
  const service = new LearningService(paths);
  const base = service.ensureLessonGoal("test", "Inspect retained evidence offline");
  const goal = service.store.revision<Goal>(service.store.define({ operation_id: randomUUID(), kind: "goal", parent_revision_id: base.revision_id, expected_goal_revision_id: base.revision_id, body: { ...base.body, subject: "math" } }, "learner", "test").revision_id);
  const task = installFixtures(service.store, goal)[0]!;
  return { service, goal, task };
}

for (const status of ["candidate", "needs_review"] as const) {
  for (const review of [
    { method: "human", reviewer_role: "expert", reviewer_provenance: "Supplied expert assertion, not authenticated credentials", reason: "Retain external human review" },
    { method: "curated", reviewer_role: "curator", reviewer_provenance: "Supplied curator assertion, not authenticated credentials", reason: "Retain external curated review" },
  ] as const) {
    test(`e01s03 task 3: verifiable protected ${status} retains ${review.reviewer_role} attestation through replay reopen and refused delivery`, async () => {
      const root = await home(); const { service, goal, task } = await ownedStore(root);
      try {
        const store = service.store;
        expect(task.body.prompt).toBe("Solve 3x + 5 = 20. Respond with only the numerical value of x.");
        expect(task.body.answer).toBe("5"); expect(task.body.scoring).toBe("numeric"); expect(task.body.stakes).toBe("low");
        const { partition, ...definition } = task.body; expect(partition).toBe("practice");
        const input = { ...definition, status, review };
        const body = { ...input, partition: "protected" as const };
        expect(verifyLinearEquation(body)).toBe(true);
        const originals = store.revisions(); const originalEvents = store.events();
        const receipt = store.append("decision", { action: "assessment_import_authorized", goal_revision_id: goal.revision_id, task_hash: hash(canonical(input)), reason: "Exact scoped import assertion only", evidence_event_ids: [] }, randomUUID(), review.reviewer_role, "test");
        const command = { operation_id: `protected-import:${receipt.event_id}`, kind: "task_definition", expected_goal_revision_id: goal.revision_id, body };
        const imported = importProtectedTask(store, input, "test", receipt.event_id);
        expect(imported.body).toEqual(body);
        expect(imported.content_hash).toBe(hash(canonical(body)));
        const raw = store.db.query("SELECT operation_id, command_hash, content_hash FROM object_revision WHERE revision_id=?").get(imported.revision_id);
        expect(raw).toEqual({ operation_id: command.operation_id, command_hash: hash(canonical(command)), content_hash: hash(canonical(body)) });
        expect(store.events().slice(originalEvents.length)).toEqual([receipt, expect.objectContaining({ kind: "decision", actor: review.reviewer_role, payload: expect.objectContaining({ action: "revision_defined" }) })]);
        const admitted = ledger(store);
        expect(importProtectedTask(store, input, "test", receipt.event_id)).toEqual(imported);
        expect(store.define(command, review.reviewer_role, "test")).toEqual(imported);
        expect(() => store.define({ ...command, body: { ...body, uncertainty: "Changed raw command" } }, review.reviewer_role, "test")).toThrow("different content");
        expect(() => deliverProtectedAssessment(store, imported.revision_id, "test")).toThrow("not reviewed and ready");
        expect(ledger(store)).toBe(admitted);
        for (const original of originals) expect(store.revision(original.revision_id)).toEqual(original);
        expect(store.events().slice(0, originalEvents.length)).toEqual(originalEvents);
        expect(store.events().filter(e => ["task_delivered", "attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
        expect(projectComponents(store, store.throughSeq, store.now(), "test").every(v => v.observations.length === 0 && v.independent_performance.success === 0)).toBe(true);
        service.close();
        const reopened = new LearningService(service.paths);
        try {
          expect(ledger(reopened.store)).toBe(admitted);
          expect(importProtectedTask(reopened.store, input, "test", receipt.event_id)).toEqual(imported);
          expect(reopened.store.db.query("SELECT operation_id, command_hash, content_hash FROM object_revision WHERE revision_id=?").get(imported.revision_id)).toEqual(raw);
          expect(() => deliverProtectedAssessment(reopened.store, imported.revision_id, "test")).toThrow("not reviewed and ready");
          expect(ledger(reopened.store)).toBe(admitted);
          // Nonprotected Pi candidates still use the bounded calculator, for both statuses.
          const practice = await reopened.operation("learning_define", { operation_id: randomUUID(), kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...task.body, status, review: { method: "unreviewed", reason: "Ordinary generated practice" } } }, "test") as { body: TaskDefinition };
          expect(practice.body.status).toBe("practice_ready"); expect(practice.body.review.method).toBe("deterministic");
          expect(practice.body.stakes).toBe("low"); expect(practice.body.source_span_ids).toEqual(task.body.source_span_ids);
          expect(reopened.store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
          expect(reopened.store.revision(imported.revision_id)).toEqual(imported);
          ledger(reopened.store);
        } finally { reopened.close(); }
      } finally { service.close(); }
    });
  }
}

test("e01s03 task 3: protected attestation rejection and replay preserve retained originals through public inspection and owned reopen", async () => {
  const root = await home(); const { service, goal, task } = await ownedStore(root);
  try {
    const store = service.store;
    const legacy = store.append("review_scheduled", { component_revision_id: task.body.component_revision_ids[0], goal_revision_id: goal.revision_id, due_at: "2026-01-01T00:00:00.000Z", reason: "Retained untrusted legacy assertion" }, randomUUID(), "pi", "test");
    const input = { ...task.body, prompt: "Externally attested offline item", review: { method: "human", reviewer_role: "expert", reviewer_provenance: "Supplied reviewer assertion; credentials not independently verified", reason: "Supplied rubric review" } };
    const authorize = (actor: string, session = "test", branch: "real" | "hypothetical" = "real", goalId = goal.revision_id) => store.append("decision", { action: "assessment_import_authorized", goal_revision_id: goalId, task_hash: hash(canonical(input)), evidence_event_ids: [], reason: "Exact scoped import assertion only" }, randomUUID(), actor, session, store.now(), undefined, branch);
    const valid = authorize("expert");
    const rejected = [authorize("learner"), authorize("pi"), authorize("expert", "foreign"), authorize("expert", "test", "hypothetical"), authorize("expert", "test", "real", "stale-goal")];
    const before = ledger(store); const original = store.revision<TaskDefinition>(task.revision_id);
    expect(() => importProtectedTask(store, input, "test")).toThrow("attestation");
    for (const receipt of rejected) expect(() => importProtectedTask(store, input, "test", receipt.event_id)).toThrow("attestation");
    expect(() => importProtectedTask(store, { ...input, prompt: "Changed content" }, "test", valid.event_id)).toThrow("attestation");
    expect(ledger(store)).toBe(before);
    const forged = { ...input, status: "candidate", review: { ...input.review, method: "model" } };
    const forgedReceipt = store.append("decision", { action: "assessment_import_authorized", goal_revision_id: goal.revision_id, task_hash: hash(canonical(forged)), reason: "Model review cannot become expert", evidence_event_ids: [] }, randomUUID(), "expert", "test");
    const afterReceipt = ledger(store);
    expect(() => importProtectedTask(store, forged, "test", forgedReceipt.event_id)).toThrow("review method");
    await expect(service.operation("learning_define", { operation_id: "forged-expert-import", kind: "task_definition", expected_goal_revision_id: goal.revision_id, body: { ...input, partition: "protected" }, actor: "expert" }, "test")).rejects.toThrow();
    expect(ledger(store)).toBe(afterReceipt);
    expect(before).not.toBe(afterReceipt); // Only the explicit diagnostic decision was appended.
    const imported = importProtectedTask(store, input, "test", valid.event_id);
    expect(imported.body).toEqual({ ...input, partition: "protected" });
    expect(store.events().find(e => e.seq === imported.created_seq)?.actor).toBe("expert");
    const importedLedger = ledger(store);
    expect(() => importProtectedTask(store, { ...input, prompt: "Changed after valid import" }, "test", valid.event_id)).toThrow("attestation");
    expect(ledger(store)).toBe(importedLedger);
    expect(store.revision(imported.revision_id)).toEqual(imported);
    expect(importProtectedTask(store, input, "test", valid.event_id)).toEqual(imported);
    expect(ledger(store)).toBe(importedLedger);
    expect(store.revision(task.revision_id)).toEqual(original);
    expect(store.event(legacy.event_id)).toEqual(legacy);
    expect(store.events().filter(e => ["attempt_submitted", "assessment"].includes(e.kind))).toEqual([]);
    const inspect = service.reviewControl("inspect", {}, "test");
    expect(inspect.queue).toEqual([expect.objectContaining({ schedule_event_id: legacy.event_id, status: "unresolved", unresolved_reason: expect.any(String) })]);
    const context = await service.context({}, "test");
    expect(context.disclosure).toMatchObject({ allowed: false, reason: "legacy_provenance_unknown" });
    expect(context.omissions).toEqual([expect.stringContaining("Originals remain local")]);
    expect(projectComponents(store, store.throughSeq, store.now(), "test").every(v => v.independent_performance.success === 0 && v.observations.length === 0)).toBe(true);
    expect(store.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => store.db.exec("UPDATE event SET actor='expert' WHERE seq=1")).toThrow("Immutable");
    expect(() => store.db.exec("DELETE FROM object_revision")).toThrow("Immutable");
    expect(ledger(store)).toBe(importedLedger);
    service.close();
    const reopened = new LearningService(service.paths);
    try {
      expect(ledger(reopened.store)).toBe(importedLedger);
      expect(reopened.reviewControl("inspect", {}, "test")).toEqual(inspect);
      expect(reopened.store.revision(imported.revision_id)).toEqual(imported);
      expect(reopened.store.event(legacy.event_id)).toEqual(legacy);
      expect(importProtectedTask(reopened.store, input, "test", valid.event_id)).toEqual(imported);
      expect(ledger(reopened.store)).toBe(importedLedger);
      const result = await maintenance(root, ["--unlock"]);
      expect(result.exit).toBe(0); expect(result.stdout).toContain("No process was terminated");
      expect(ledger(reopened.store)).toBe(importedLedger);
    } finally { reopened.close(); }
  } finally { service.close(); }
});

test("e01s03 task 3: actual CLI recovery preserves native guards and owned OS lease authority without signalling diagnostic PID", async () => {
  const root = await home(); const { service } = await ownedStore(root); const before = ledger(service.store);
  const module = new URL("../src/tutor-lock.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "-e", `import { acquireTutorLock } from ${JSON.stringify(module)}; const release = acquireTutorLock(${JSON.stringify(root)}); process.once('exit', release); console.log('ready'); setInterval(() => {}, 1000);`], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); } finally { reader.releaseLock(); }
    expect(() => acquireTutorLock(root, true)).toThrow("Another Sage tutor is running");
    const receipt = await readFile(join(root, "tutor.lock"), "utf8");
    for (const args of [["--unlock"], ["--force"]]) {
      const result = await maintenance(root, args);
      expect(result).toMatchObject({ exit: 1, stdout: "" });
      // --force retains the native terminal guard before lease acquisition.
      expect(result.stderr).toContain(args[0] === "--unlock" ? "Another Sage tutor is running" : "Interactive tutor requires a terminal");
      expect(result.stderr).not.toContain("provider");
      expect(await readFile(join(root, "tutor.lock"), "utf8")).toBe(receipt);
      expect(ledger(service.store)).toBe(before);
      expect(child.exitCode).toBeNull();
    }
    child.kill("SIGKILL"); await child.exited; // Only this explicitly owned lease fixture is terminated.
    expect(await readFile(join(root, "tutor.lock"), "utf8")).toBe(receipt);
    const stale = JSON.stringify({ version: 2, pid: process.pid, owner: "reused-untrusted-PID" });
    await writeFile(join(root, "tutor.lock"), stale);
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(unlockTutor(root)).toEqual({ unlocked: true, pid: process.pid });
      await writeFile(join(root, "tutor.lock"), stale);
      const release = acquireTutorLock(root, true); release();
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
    // The real CLI gets no signalable PID; reused PID handling above is safely mocked.
    await writeFile(join(root, "tutor.lock"), JSON.stringify({ pid: "invalid-diagnostic-only", owner: "untrusted" }));
    const recovered = await maintenance(root, ["--unlock"]);
    expect(recovered.exit).toBe(0); expect(recovered.stdout).toContain("No process was terminated");
    expect(existsSync(join(root, "tutor.lock"))).toBe(false);
    const next = acquire(root); next();
    expect(ledger(service.store)).toBe(before);
    service.close(); const reopened = new LearningStore(join(service.paths.data, "learning.sqlite"));
    try { expect(ledger(reopened)).toBe(before); } finally { reopened.close(); }
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    service.close();
  }
});

test("e01s03 task 3: force parsing and maintenance errors precede launch without creating learning state", async () => {
  expect(parseLaunchArgs(["--force"])).toEqual({ action: "tutor", selection: {} });
  expect(parseLaunchArgs(["--force", "--mode", "exam", "Owned offline goal"])).toEqual({ action: "tutor", selection: { mode: "exam", goal: "Owned offline goal" } });
  const root = await home();
  for (const args of [["--unlock", "--force"], ["--force", "--mode", "invalid"]]) {
    const result = await maintenance(root, args);
    expect(result.exit).toBe(1); expect(result.stderr).toContain("Usage: sage");
    expect(existsSync(join(root, "data", "learning.sqlite"))).toBe(false);
    expect(existsSync(join(root, "tutor.lock"))).toBe(false);
  }
  const invalid = join(root, "not-a-home"); await writeFile(invalid, "retained file");
  const result = await maintenance(invalid, ["--unlock"]);
  expect(result.exit).toBe(1); expect(result.stderr).toContain("Cannot acquire the tutor lock");
  expect(result.stderr).not.toContain("Another Sage tutor");
  expect(await readFile(invalid, "utf8")).toBe("retained file");
});
