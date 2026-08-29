import { test } from "node:test";
import assert from "node:assert/strict";

import { bodyEditUndoable } from "./undobody.ts";

type Entry = Omit<import("./undo.ts").UndoEntry, "id"> & { id?: number };

function recorder() {
  const box: { entry: Entry | null; pushes: number } = { entry: null, pushes: 0 };
  return {
    box,
    record: (e: Entry) => {
      box.entry = e;
      box.pushes++;
    },
  };
}

/** A note in memory that behaves like the guarded body write: it refuses
    unless the caller names the body it currently holds. */
function note(start: string) {
  const state = { body: start };
  const write = async (next: string, expected: string) => {
    if (state.body !== expected) throw new Error("conflict: file changed on disk");
    state.body = next;
  };
  return { state, write };
}

test("a body action undoes and redoes through the guarded write", async () => {
  const n = note("a\n");
  const { box, record } = recorder();
  await bodyEditUndoable({
    path: "Food/Log.md",
    next: "a\nb\n",
    prior: n.state.body,
    label: "Log Eggs",
    scope: "pane:food",
    record,
    write: n.write,
  });
  assert.equal(n.state.body, "a\nb\n", "the forward write landed");
  assert.deepEqual(box.entry!.paths, ["Food/Log.md"], "the note it rewrote, so an external edit disarms it");
  assert.equal(box.entry!.scope, "pane:food", "pane-scoped, so closing the board takes it with it");

  await box.entry!.undo();
  assert.equal(n.state.body, "a\n");
  await box.entry!.redo!();
  assert.equal(n.state.body, "a\nb\n");
});

test("a refused write records nothing — no phantom step to take back", async () => {
  // the pop-before-write bug in one assertion (docs/undo.md §3.4-3): the old
  // pane pushed first, so a conflict consumed an undo step and left a redo
  // pointing at a body that never reached disk
  const n = note("a\n");
  const { box, record } = recorder();
  await assert.rejects(
    bodyEditUndoable({
      path: "Food/Log.md",
      next: "a\nb\n",
      prior: "something else\n",
      label: "Log Eggs",
      scope: "pane:food",
      record,
      write: n.write,
    }),
    /conflict:/
  );
  assert.equal(box.pushes, 0, "nothing on the stack");
  assert.equal(n.state.body, "a\n", "and the note is untouched");
});

test("an inverse refuses once the note moved underneath it", async () => {
  const n = note("a\n");
  const { box, record } = recorder();
  await bodyEditUndoable({
    path: "Food/Log.md",
    next: "a\nb\n",
    prior: "a\n",
    label: "Log Eggs",
    scope: "pane:food",
    record,
    write: n.write,
  });
  n.state.body = "a\nb\nc\n"; // somebody else appended
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.equal(n.state.body, "a\nb\nc\n", "the other edit stands");
});

test("consecutive actions undo in order, each guarded on the one above it", async () => {
  const n = note("a\n");
  const entries: Entry[] = [];
  const record = (e: Entry) => entries.push(e);
  for (const line of ["b", "c"]) {
    const prior = n.state.body;
    await bodyEditUndoable({
      path: "Food/Log.md",
      next: `${prior}${line}\n`,
      prior,
      label: `Log ${line}`,
      scope: "pane:food",
      record,
      write: n.write,
    });
  }
  assert.equal(n.state.body, "a\nb\nc\n");
  await entries[1].undo();
  await entries[0].undo();
  assert.equal(n.state.body, "a\n", "a burst walks the stack down, not into a conflict");
});
