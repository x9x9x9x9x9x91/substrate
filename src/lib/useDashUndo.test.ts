import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashUndoStore, kindUndoAvailability } from "../components/useDashUndo.ts";

/* Named for its subject rather than for a squashed spelling of it: the suite
   only scans a few roots and `src/components` is not one of them, so a test
   for a file over there lives here and has to carry the name to say so. */

test("board undo store publishes direction availability and stable empty snapshots (SUB-726)", () => {
  const store = createDashUndoStore();
  const empty = store.getSnapshot();
  const changes: Array<[boolean, boolean]> = [];
  store.subscribe(() => {
    const state = store.getSnapshot();
    changes.push([state.canUndo, state.canRedo]);
  });

  const first = store.register();
  assert.equal(store.getSnapshot(), empty, "mounting empty history does not publish");
  first.set({ canUndo: true, canRedo: false });
  assert.deepEqual(store.getSnapshot(), { canUndo: true, canRedo: false });
  first.set({ canUndo: false, canRedo: true });
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: true });
  first.unregister();
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: false });
  assert.deepEqual(changes, [
    [true, false],
    [false, true],
    [false, false],
  ]);
});

test("overlapping board registrations aggregate without cleanup races", () => {
  const store = createDashUndoStore();
  const outgoing = store.register();
  const incoming = store.register();
  outgoing.set({ canUndo: true, canRedo: false });
  incoming.set({ canUndo: false, canRedo: true });
  assert.deepEqual(store.getSnapshot(), { canUndo: true, canRedo: true });
  outgoing.unregister();
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: true });
  incoming.unregister();
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: false });
});

test("a vault kind's ctx.setUndo claims the same chord a built-in board does (SUB-1451)", () => {
  // The demotion made the yield board vault-resident, and a kind's window
  // listener registers AFTER App's — so without a publication route one ⌘Z
  // ran session undo AND the board's, the same double-fire the first test
  // above guards, with a vault kind as the new owner. `ctx.setUndo` is that
  // route: same store, same gate.
  const store = createDashUndoStore();
  const pane = store.register();
  const publish = (avail: { undo: boolean; redo: boolean } | null) =>
    pane.set(kindUndoAvailability(avail));

  publish(null);
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: false }, "an empty stack yields the chord back");

  publish({ undo: true, redo: false });
  assert.deepEqual(store.getSnapshot(), { canUndo: true, canRedo: false });
  // …which is what `shortcuts.ts` reads as `dashCanUndo`, and the session
  // undo entry's `when` is its negation (pinned in shortcuts.test.ts).
  publish({ undo: true, redo: true });
  assert.deepEqual(store.getSnapshot(), { canUndo: true, canRedo: true });

  // Withdrawal, both ways: the kind saying so, and the board going away.
  publish(null);
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: false });
  publish({ undo: true, redo: true });
  pane.unregister();
  assert.deepEqual(store.getSnapshot(), { canUndo: false, canRedo: false }, "leaving the board withdraws it");
});
