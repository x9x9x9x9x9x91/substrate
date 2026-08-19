import { test } from "node:test";
import assert from "node:assert/strict";

import { askFreshness, capStamps, makeFreshCache, type FreshStamp } from "./freshcache.ts";
import type { FactFreshness } from "./types.ts";

const stamp = (path: string, key: string, updated_ms: number): FreshStamp => ({
  path,
  key,
  updated_ms,
});

const answer = (path: string, key: string): FactFreshness => ({
  path,
  key,
  reviewed_ts_ms: 1_700_000_000_000,
  reviewed_commit: "c1",
  reviewed_actor: { kind: "app" },
  only_bulk: false,
  oldest_ts_ms: 1_600_000_000_000,
});

test("a repaint over an unchanged vault asks the history for nothing", () => {
  const cache = makeFreshCache();
  const rows = [stamp("A.md", "phone", 10), stamp("B.md", "phone", 20)];
  const first = cache.plan(rows);
  assert.deepEqual(first.misses, rows);
  assert.deepEqual(first.hits, []);
  cache.fill(first.misses, [answer("A.md", "phone"), answer("B.md", "phone")]);

  // this is the perf claim, asserted: the table repaints, nothing is mined
  const second = cache.plan(rows);
  assert.deepEqual(second.misses, []);
  assert.deepEqual(
    second.hits.map((h) => h.path),
    ["A.md", "B.md"]
  );
});

test("only the notes that changed are asked again", () => {
  const cache = makeFreshCache();
  const before = [stamp("A.md", "phone", 10), stamp("B.md", "phone", 20)];
  cache.fill(cache.plan(before).misses, [answer("A.md", "phone"), answer("B.md", "phone")]);

  // B was edited; A was not touched
  const after = cache.plan([stamp("A.md", "phone", 10), stamp("B.md", "phone", 21)]);
  assert.deepEqual(after.misses, [stamp("B.md", "phone", 21)]);
  assert.deepEqual(
    after.hits.map((h) => h.path),
    ["A.md"]
  );
});

test("a note rolled BACK is re-asked, not reused", () => {
  // sync and undo both move a note's stamp downward; the held answer is about
  // a state the file is no longer in either way
  const cache = makeFreshCache();
  cache.fill(cache.plan([stamp("A.md", "phone", 10)]).misses, [answer("A.md", "phone")]);
  assert.deepEqual(cache.plan([stamp("A.md", "phone", 4)]).misses, [stamp("A.md", "phone", 4)]);
});

test("a fact the history cannot date is remembered as asked", () => {
  // the expensive case: no history for this fact at all. Remembering the
  // silence is what stops every repaint from re-walking those notes.
  const cache = makeFreshCache();
  const rows = [stamp("Imported.md", "phone", 10)];
  cache.fill(cache.plan(rows).misses, []);
  const again = cache.plan(rows);
  assert.deepEqual(again.misses, []);
  assert.deepEqual(again.hits, []);
  assert.equal(cache.size(), 1);
});

test("two facts on one note are held apart", () => {
  const cache = makeFreshCache();
  const rows = [stamp("A.md", "phone", 10), stamp("A.md", "price", 10)];
  cache.fill(cache.plan(rows).misses, [answer("A.md", "phone"), answer("A.md", "price")]);
  assert.equal(cache.size(), 2);
  assert.deepEqual(
    cache.plan(rows).hits.map((h) => h.key),
    ["phone", "price"]
  );
});

test("switching vaults forgets answers that were about the other one", () => {
  const cache = makeFreshCache();
  const rows = [stamp("Notes/Contact.md", "phone", 10)];
  cache.fill(cache.plan(rows).misses, [answer("Notes/Contact.md", "phone")]);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.deepEqual(cache.plan(rows).misses, rows);
});

test("a whole-vault ask goes down the wire in bounded chunks", async () => {
  // the lock claim, asserted: the history mutex is taken once per CALL, so a
  // 150-fact report that arrived as one call would hold it for the whole walk
  const cache = makeFreshCache();
  const rows = Array.from({ length: 150 }, (_, i) => stamp(`N${i}.md`, "phone", 1));
  const calls: number[] = [];
  const seen: number[] = [];
  await askFreshness(
    rows,
    async (refs) => {
      calls.push(refs.length);
      return refs.map((r) => answer(r.path, r.key));
    },
    (found) => seen.push(found.length),
    () => true,
    cache,
    60
  );
  assert.deepEqual(calls, [60, 60, 30]);
  // each chunk paints as it lands rather than the surface waiting for all
  assert.deepEqual(seen, [60, 120, 150]);
  // and every chunk's answers are kept, so a repaint re-asks nothing
  assert.deepEqual(cache.plan(rows).misses, []);
});

test("a surface that goes away mid-walk stops asking", async () => {
  const cache = makeFreshCache();
  const rows = Array.from({ length: 100 }, (_, i) => stamp(`N${i}.md`, "phone", 1));
  let live = true;
  const calls: number[] = [];
  await askFreshness(
    rows,
    async (refs) => {
      calls.push(refs.length);
      live = false; // the pane unmounted while the first chunk was walking
      return refs.map((r) => answer(r.path, r.key));
    },
    () => assert.fail("an unmounted surface must not be painted"),
    () => live,
    cache,
    25
  );
  assert.deepEqual(calls, [25]);
  // the walk that was already paid for is still kept for the next surface
  assert.equal(cache.size(), 25);
});

test("a vault too big to walk is capped, and says how much it left", () => {
  const rows = Array.from({ length: 30 }, (_, i) => stamp(`N${i}.md`, "phone", 1));
  const { asked, unread } = capStamps(rows, 10);
  assert.equal(asked.length, 10);
  assert.equal(unread, 20);
  // the caller's own ranking survives: what is dropped is its tail
  assert.equal(asked[0].path, "N0.md");
  assert.deepEqual(capStamps(rows, 30), { asked: rows, unread: 0 });
});

test("the held answers are bounded, oldest first", () => {
  const cache = makeFreshCache(3);
  for (const i of [0, 1, 2, 3]) {
    const s = stamp(`N${i}.md`, "phone", 1);
    cache.fill([s], [answer(s.path, s.key)]);
  }
  assert.equal(cache.size(), 3);
  // N0 was the first in, so it is the one forgotten
  assert.deepEqual(cache.plan([stamp("N0.md", "phone", 1)]).misses, [stamp("N0.md", "phone", 1)]);
  assert.deepEqual(cache.plan([stamp("N3.md", "phone", 1)]).misses, []);
});
