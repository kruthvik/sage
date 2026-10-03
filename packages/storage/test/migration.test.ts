import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStore, canonical } from "../src/store.ts";
import { learningFixture } from "../../runtime/test/learning-fixture.ts";
import { projectComponents } from "../src/projection.ts";

test("additive v1-to-v2 migration preserves events/revisions and all seven tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "sato-migration-"));
  let store: LearningStore | undefined;
  const fixture = learningFixture();
  try {
    fixture.observe(fixture.task("Fresh integration task"));
    const filename = join(root, "learning.sqlite");
    // Materialize an old-schema image without rewriting any canonical record.
    const image = fixture.store.db.serialize(); image[18] = 1; image[19] = 1;
    await Bun.write(filename, image);
    store = new LearningStore(filename, fixture.store.now);
    store.db.exec("DROP INDEX event_kind_time; DROP INDEX event_session; DROP INDEX revision_kind; PRAGMA user_version=1;");
    const revisions = canonical(store.revisions()), events = canonical(store.events());
    store.close(); store = new LearningStore(filename, fixture.store.now);
    expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(canonical(store.revisions())).toBe(revisions);
    expect(canonical(store.events())).toBe(events);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(7);
    expect(canonical(projectComponents(store, store.throughSeq, store.now()))).toBe(canonical(fixture.views()));
    expect(store.integrity()).toEqual(["ok"]);
  } finally { fixture.store.close(); store?.close(); await rm(root, { recursive: true, force: true }); }
});
