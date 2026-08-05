import { test } from "node:test";
import assert from "node:assert/strict";
import type { UndoEntry } from "./undo.ts";

/* Dropping a note on a tag folder is undoable like every other
   prop edit. The mock backend lives behind `isTauri`, which sniffs `window`
   at module scope, so shim one before importing (same trick as
   noteactions.test.ts) and import the app modules dynamically. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultRead, vaultSetProp } = await import("./ipc.ts");
const { addTagsUndoable } = await import("./undoprops.ts");

function recorder(): { entries: (Omit<UndoEntry, "id"> & { id?: number })[]; record: (e: Omit<UndoEntry, "id"> & { id?: number }) => void } {
  const entries: (Omit<UndoEntry, "id"> & { id?: number })[] = [];
  return { entries, record: (e) => entries.push(e) };
}

test("addTagsUndoable: records an entry and undo restores the prior tags", async () => {
  const note = await vaultCreate("Drop Target", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo", "live"], record: rec.record });

  assert.equal(rec.entries.length, 1, "the drop records exactly one undo entry");
  const entry = rec.entries[0];
  assert.deepEqual(entry.paths, [note.path]);
  assert.equal(entry.label, "Tagged #demo #live");
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["keep", "demo", "live"]);

  await entry.undo?.();
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["keep"],
    "undo restores the exact prior list"
  );

  await entry.redo?.();
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["keep", "demo", "live"]);
});

test("addTagsUndoable: overlapping tags survive undo — the add is a union", async () => {
  const note = await vaultCreate("Overlap", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["demo", "keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo", "live"], record: rec.record });
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo", "keep", "live"]);

  await rec.entries[0].undo?.();
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["demo", "keep"],
    "the tag the note already carried is NOT removed by undo"
  );
});

test("addTagsUndoable: a note with no tags yet undoes back to none", async () => {
  const note = await vaultCreate("Bare", "Tagged", undefined, undefined, "body\n");
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo"]);

  await rec.entries[0].undo?.();
  assert.equal((await vaultRead(note.path)).props["tags"], undefined);
});

test("addTagsUndoable: a no-op drop records nothing", async () => {
  const note = await vaultCreate("Already", "Tagged", undefined, undefined, "a #demo body\n");
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  assert.equal(rec.entries.length, 0, "the note already carried the tag inline — nothing to undo");
});

test("addTagsUndoable: undo is refused when the tags moved on disk", async () => {
  const note = await vaultCreate("Conflict", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  // someone else edits the prop between the drop and the ⌘Z
  await vaultSetProp(note.path, "tags", ["elsewhere"]);

  await assert.rejects(() => rec.entries[0].undo!(), /conflict:/);
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["elsewhere"],
    "the refused undo left the other edit alone"
  );
});
