/** The sort control's write path: `note-sort` in Settings.md, through the
    undo-guarded prop door, so a flip is ⌘Z-undoable like every ⌘, row.

    What this pins that the parser test cannot: the value the app writes is a
    value the app reads back. A formatter and a parser can each be right about
    a shape they disagree on, and the note in between is the only referee. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { UndoEntry } from "./undo.ts";
import type { ListSort } from "./listsort.ts";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope, so shim one before importing (same trick as undoprops.test.ts). */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultRead, vaultSetProp } = await import("./ipc.ts");
const { setPropUndoable } = await import("./undoprops.ts");
const { parseNoteSort, SETTINGS_PATH } = await import("./settings.ts");
const { DEFAULT_LIST_SORT, formatListSort } = await import("./listsort.ts");

function recorder(): {
  entries: (Omit<UndoEntry, "id"> & { id?: number })[];
  record: (e: Omit<UndoEntry, "id"> & { id?: number }) => void;
} {
  const entries: (Omit<UndoEntry, "id"> & { id?: number })[] = [];
  return { entries, record: (e) => entries.push(e) };
}

/** exactly what App's `onListSort` does, minus the optimistic local set */
function flip(sort: ListSort, record: (e: Omit<UndoEntry, "id">) => void) {
  return setPropUndoable({
    path: SETTINGS_PATH,
    key: "note-sort",
    value: formatListSort(sort),
    record,
    label: `Sort by ${sort.field}`,
  });
}

const stored = async () => parseNoteSort((await vaultRead(SETTINGS_PATH)).props);

test("a vault that never chose reads as no answer at all, not as the default", async () => {
  // the Journal yields its dateline order to an explicit pick and only to an
  // explicit pick, so "nobody said" has to be distinguishable from "somebody
  // said the default"
  await vaultSetProp(SETTINGS_PATH, "note-sort", null);
  assert.equal(await stored(), null);
  await vaultSetProp(SETTINGS_PATH, "note-sort", formatListSort(DEFAULT_LIST_SORT));
  assert.deepEqual(await stored(), DEFAULT_LIST_SORT, "stated, and therefore a choice");
});

test("every sort the control can pick round-trips through Settings.md", async () => {
  for (const field of ["updated", "created", "name"] as const) {
    for (const dir of ["desc", "asc"] as const) {
      const sort: ListSort = { field, dir };
      await vaultSetProp(SETTINGS_PATH, "note-sort", formatListSort(sort));
      assert.deepEqual(await stored(), sort, `${field} ${dir} came back changed`);
    }
  }
});

test("undo puts the list back on the order it was on", async () => {
  await vaultSetProp(SETTINGS_PATH, "note-sort", "updated desc");
  const rec = recorder();

  await flip({ field: "name", dir: "asc" }, rec.record);
  assert.equal(rec.entries.length, 1, "one flip, one undo entry");
  assert.deepEqual(rec.entries[0].paths, [SETTINGS_PATH]);
  assert.deepEqual(await stored(), { field: "name", dir: "asc" });

  await rec.entries[0].undo?.();
  assert.deepEqual(await stored(), { field: "updated", dir: "desc" }, "⌘Z restores the order");

  await rec.entries[0].redo?.();
  assert.deepEqual(await stored(), { field: "name", dir: "asc" });
});

test("undoing a flip of the direction alone lands on the direction, not the default", async () => {
  // the near-miss: name asc → name desc undoes to name ASC, and a redo of the
  // whole stack is the only thing that may reach the default again
  await vaultSetProp(SETTINGS_PATH, "note-sort", "name asc");
  const rec = recorder();
  await flip({ field: "name", dir: "desc" }, rec.record);
  await rec.entries[0].undo?.();
  assert.deepEqual(await stored(), { field: "name", dir: "asc" });
});

test("undo of the first flip a vault ever makes clears the key rather than pinning the default", async () => {
  // Settings.md holds the user's answers; a key nobody set is not an answer,
  // and undo must leave the note as it found it
  await vaultSetProp(SETTINGS_PATH, "note-sort", null);
  const rec = recorder();
  await flip({ field: "created", dir: "desc" }, rec.record);
  await rec.entries[0].undo?.();
  const props = (await vaultRead(SETTINGS_PATH)).props;
  assert.ok(!("note-sort" in props), "the key the flip added is gone again");
  assert.equal(parseNoteSort(props), null, "back to no answer, not to a stated default");
});
