import { test } from "node:test";
import assert from "node:assert/strict";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane (same
   trick as noteactions.test.ts); every app import below is dynamic for that. */
(globalThis as { window?: unknown }).window = globalThis;
const undo = await import("./undo.ts");
const { push, peekUndo, peekRedo, invalidate, evictScope, advance, markStale, MAX_UNDO, emptyUndo } =
  undo;
const { vaultCreate, vaultRead, vaultSetProp } = await import("./ipc.ts");
const { setPropUndoable, setPropsUndoable, setPropUndoableBulk } = await import("./undoprops.ts");

const noop = async () => {};

function entry(over: Partial<Parameters<typeof push>[1]> = {}) {
  return {
    label: "edit",
    scope: "vault" as const,
    at: 0,
    paths: ["A.md"],
    undo: noop,
    redo: noop,
    ...over,
  };
}

/* ── 1–6: the stack ──────────────────────────────────────────────────── */

test("1: push then peekUndo returns it; 51 pushes evict the oldest", () => {
  let s = push(emptyUndo, entry({ label: "first" }));
  assert.equal(peekUndo(s)?.label, "first");

  s = emptyUndo;
  for (let i = 0; i < MAX_UNDO + 1; i++) s = push(s, entry({ label: `e${i}` }));
  assert.equal(s.entries.length, MAX_UNDO);
  assert.equal(s.entries[0].label, "e1", "the oldest fell off the end");
  assert.equal(peekUndo(s)?.label, `e${MAX_UNDO}`);
});

test("2: push clears the redo side, before and after an undo", () => {
  let s = push(push(emptyUndo, entry({ label: "a" })), entry({ label: "b" }));
  const b = peekUndo(s)!;
  s = advance(s, b.id, -1);
  assert.equal(peekRedo(s)?.label, "b", "b is redoable after undoing it");

  s = push(s, entry({ label: "c" }));
  assert.equal(peekRedo(s), null, "the new action dropped the forked branch");
  assert.deepEqual(
    s.entries.map((e) => e.label),
    ["a", "c"]
  );

  // and again: undo c, push d, redo side is empty once more
  s = advance(s, peekUndo(s)!.id, -1);
  s = push(s, entry({ label: "d" }));
  assert.equal(peekRedo(s), null);
  assert.deepEqual(
    s.entries.map((e) => e.label),
    ["a", "d"]
  );
});

test("3: invalidate marks only the entries touching the named path", () => {
  let s = push(emptyUndo, entry({ label: "a", paths: ["A.md"] }));
  s = push(s, entry({ label: "b", paths: ["B.md"] }));
  s = push(s, entry({ label: "ab", paths: ["B.md", "A.md"] }));
  s = invalidate(s, ["A.md"]);
  assert.deepEqual(
    s.entries.map((e) => [e.label, !!e.stale]),
    [
      ["a", true],
      ["b", false],
      ["ab", true],
    ]
  );
});

test("4: peekUndo skips a stale entry and returns the next live one", () => {
  let s = push(emptyUndo, entry({ label: "live", paths: ["A.md"] }));
  s = push(s, entry({ label: "doomed", paths: ["B.md"] }));
  s = invalidate(s, ["B.md"]);
  assert.equal(peekUndo(s)?.label, "live");
  assert.equal(s.entries.length, 2, "the stale entry stays visible (skip-and-show)");
});

test("5: evictScope drops a pane's entries and keeps vault ones", () => {
  let s = push(emptyUndo, entry({ label: "v1", scope: "vault" }));
  s = push(s, entry({ label: "f1", scope: "pane:food" }));
  s = push(s, entry({ label: "v2", scope: "vault" }));
  s = push(s, entry({ label: "f2", scope: "pane:food" }));
  s = evictScope(s, "pane:food");
  assert.deepEqual(
    s.entries.map((e) => e.label),
    ["v1", "v2"]
  );
  assert.equal(peekUndo(s)?.label, "v2", "the cursor followed the survivors");
});

test("6: advance is a no-op for an id that isn't the current cursor", () => {
  let s = push(push(emptyUndo, entry({ label: "a" })), entry({ label: "b" }));
  const stale = s.entries[0].id; // "a" — not what ⌘Z would run right now
  const after = advance(s, stale, -1);
  assert.equal(after, s, "same object: nothing moved");
  assert.equal(peekUndo(after)?.label, "b");

  // the real cursor entry does move it
  s = advance(s, s.entries[1].id, -1);
  assert.equal(peekUndo(s)?.label, "a");
});

test("6b: a failed inverse goes stale so ⌘Z walks past it instead of jamming", () => {
  let s = push(emptyUndo, entry({ label: "a" }));
  s = push(s, entry({ label: "doomed" }));
  const doomed = peekUndo(s)!;
  assert.equal(doomed.label, "doomed");

  // its inverse threw for a non-conflict reason: the entry can never succeed,
  // and advance() is deliberately not called on failure — without markStale
  // peekUndo keeps handing back the same dead entry forever
  s = markStale(s, doomed.id);
  assert.equal(peekUndo(s)?.label, "a", "the next keystroke reaches the live entry below");
  assert.equal(s.entries.length, 2, "the dead entry stays visible (skip-and-show)");

  // and it is not redoable either — a failed inverse isn't a completed undo
  assert.equal(peekRedo(s), null);

  // idempotent, and a no-op for an id that isn't on the stack
  assert.equal(markStale(s, doomed.id), s, "same object: already stale");
  assert.equal(markStale(s, 9999), s, "same object: unknown id");
});

/* ── 7–9: the setPropUndoable helper, over the mock backend ───────────── */

async function freshNote(title: string) {
  const m = await vaultCreate(title, "Inbox", "note", [], "body\n");
  return m.path;
}

test("7: a prior of null round-trips — set then undo leaves the key absent", async () => {
  const path = await freshNote("Undo Prior Null");
  let recorded: Omit<import("./undo.ts").UndoEntry, "id"> | null = null;
  await setPropUndoable({
    path,
    key: "status",
    value: "in review",
    record: (e) => (recorded = e),
  });
  assert.equal((await vaultRead(path)).props.status, "in review");
  await recorded!.undo();
  const props = (await vaultRead(path)).props;
  assert.ok(!("status" in props), `status should be gone, got ${JSON.stringify(props)}`);
});

test("8: a list value round-trips without stringification", async () => {
  const path = await freshNote("Undo List Value");
  await vaultSetProp(path, "tags", ["one", "two"]);
  let recorded: Omit<import("./undo.ts").UndoEntry, "id"> | null = null;
  await setPropUndoable({
    path,
    key: "tags",
    value: ["three"],
    record: (e) => (recorded = e),
  });
  assert.deepEqual((await vaultRead(path)).props.tags, ["three"]);
  await recorded!.undo();
  assert.deepEqual(
    (await vaultRead(path)).props.tags,
    ["one", "two"],
    "the prior list came back as a list"
  );
});

test("9: bulk over 3 paths where 1 fails records one entry with 2 paths", async () => {
  const a = await freshNote("Undo Bulk A");
  const b = await freshNote("Undo Bulk B");
  const gone = "Inbox/Undo Bulk Missing.md";
  let recorded: Omit<import("./undo.ts").UndoEntry, "id"> | null = null;
  const res = await setPropUndoableBulk({
    paths: [a, gone, b],
    key: "status",
    value: "done",
    record: (e) => (recorded = e),
  });
  assert.deepEqual(
    res.ok.map((o) => o.path),
    [a, b]
  );
  assert.equal(res.failed.length, 1);
  assert.deepEqual(recorded!.paths, [a, b], "only the writes that landed are undoable");
  assert.equal((await vaultRead(a)).props.status, "done");
  await recorded!.undo();
  assert.ok(!("status" in (await vaultRead(a)).props));
  assert.ok(!("status" in (await vaultRead(b)).props));
});

test("9b: bulk writes and undo keep each note's existing property casing", async () => {
  const upper = await freshNote("Undo Bulk Upper");
  const lower = await freshNote("Undo Bulk Lower");
  await vaultSetProp(upper, "Status", "todo");
  await vaultSetProp(lower, "status", "todo");
  let recorded: Omit<import("./undo.ts").UndoEntry, "id"> | null = null;
  await setPropUndoableBulk({
    paths: [upper, lower], key: "Status", keysByPath: { [upper]: "Status", [lower]: "status" },
    value: "done", record: (e) => (recorded = e),
  });
  assert.equal((await vaultRead(upper)).props.Status, "done");
  assert.equal((await vaultRead(lower)).props.status, "done");
  assert.ok(!("Status" in (await vaultRead(lower)).props), "bulk edit created no duplicate key");
  await recorded!.undo();
  assert.equal((await vaultRead(upper)).props.Status, "todo");
  assert.equal((await vaultRead(lower)).props.status, "todo");
});

test("10: a multi-key write that fails halfway is still undoable for the keys that landed", async () => {
  const path = await freshNote("Undo Multi Partial");
  await vaultSetProp(path, "repeat", "weekly");
  await vaultSetProp(path, "repeat_until", "2026-12-31");
  let recorded: Omit<import("./undo.ts").UndoEntry, "id"> | null = null;
  // the second key carries a value the engine refuses (a map), so the write
  // rejects after `repeat` has already been cleared — the calendar's
  // "repeat: None" shape, half-applied
  const bad = { nope: 1 } as unknown as import("./types.ts").PropValue;
  await assert.rejects(
    setPropsUndoable({
      path,
      edits: [
        { key: "repeat", value: null },
        { key: "repeat_until", value: bad },
      ],
      record: (e) => (recorded = e),
      label: "Clear repeat",
    }),
    "the caller still sees the failure"
  );
  const mid = (await vaultRead(path)).props;
  assert.ok(!("repeat" in mid), "the first key did land");
  assert.equal(mid.repeat_until, "2026-12-31", "the refused key is untouched");
  assert.notEqual(recorded, null, "the half-applied action pushed an undo entry");
  await recorded!.undo();
  assert.equal((await vaultRead(path)).props.repeat, "weekly", "undo takes back exactly what landed");
});
