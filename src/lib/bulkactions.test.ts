import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBulkActions,
  getBulkSelection,
  registerBulkSelection,
  resetBulkSelectionForTests,
  subscribeBulkSelection,
  type BulkActionHandlers,
} from "./bulkactions.ts";

const noop = () => {};

test("buildBulkActions: every wired action, destructive lane last", () => {
  const acts = buildBulkActions({
    count: 3,
    setProperty: noop,
    trash: noop,
    clearSelection: noop,
  });
  assert.deepEqual(
    acts.map((a) => a.id),
    ["prop", "clear", "trash"]
  );
  assert.deepEqual(
    acts.map((a) => a.label),
    ["Set property…", "Clear selection", "Move to Trash"]
  );
  const trash = acts[2];
  assert.equal(trash.destructive, true);
  assert.equal(trash.separatorAbove, true);
  assert.equal(trash.hint, "recoverable");
  // nothing else claims the destructive styling or the separator
  assert.deepEqual(
    acts.slice(0, 2).map((a) => [a.destructive, a.separatorAbove]),
    [
      [undefined, undefined],
      [undefined, undefined],
    ]
  );
});

test("buildBulkActions: only the handlers a surface actually wired", () => {
  const acts = buildBulkActions({ count: 1, clearSelection: noop });
  assert.deepEqual(
    acts.map((a) => a.id),
    ["clear"]
  );
});

test("buildBulkActions: no selection means no actions at all", () => {
  assert.deepEqual(buildBulkActions({ count: 0, setProperty: noop, trash: noop }), []);
});

test("buildBulkActions: run is the handler the caller passed", () => {
  let ran = "";
  const acts = buildBulkActions({
    count: 2,
    setProperty: () => (ran = "prop"),
    trash: () => (ran = "trash"),
  });
  acts.find((a) => a.id === "trash")!.run();
  assert.equal(ran, "trash");
});

test("bulk selection slot: register publishes, cleanup clears, subscribers hear both", () => {
  resetBulkSelectionForTests();
  let beats = 0;
  const off = subscribeBulkSelection(() => beats++);
  assert.equal(getBulkSelection(), null);

  const sel: BulkActionHandlers = { count: 2, trash: noop };
  const unregister = registerBulkSelection(sel);
  assert.equal(getBulkSelection(), sel);
  assert.equal(beats, 1);

  unregister();
  assert.equal(getBulkSelection(), null);
  assert.equal(beats, 2);

  off();
  registerBulkSelection({ count: 1 });
  assert.equal(beats, 2);
  resetBulkSelectionForTests();
});

test("bulk selection slot: a stale cleanup never blanks the pane that took over", () => {
  resetBulkSelectionForTests();
  const first: BulkActionHandlers = { count: 1 };
  const second: BulkActionHandlers = { count: 5 };
  const dropFirst = registerBulkSelection(first);
  registerBulkSelection(second);
  // the old pane unmounts after the new one mounted — last one still wins
  dropFirst();
  assert.equal(getBulkSelection(), second);
  resetBulkSelectionForTests();
});
