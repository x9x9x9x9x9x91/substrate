import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { setTrackedPos, trackedPos, trackedPositions } from "./trackpos.ts";

/* An intake captures where the embed belongs (the caret at paste time,
   the point under a drop) and only writes it after an IPC round trip. These
   cover the mapping the StateField does in between — trackPos() itself needs a
   live EditorView and is covered in e2e/dropmap.spec.ts. */

function seed(doc: string, id: number, pos: number) {
  const state = EditorState.create({ doc, extensions: [trackedPositions] });
  return state.update({ effects: setTrackedPos.of({ id, pos }) }).state;
}

test("a tracked position shifts by text inserted before it (SUB-664)", () => {
  // drop lands at offset 5 ("hello|world"), then the user types at the top
  let state = seed("helloworld", 1, 5);
  assert.equal(trackedPos(state, 1), 5);
  state = state.update({ changes: { from: 0, insert: "AB" } }).state;
  assert.equal(trackedPos(state, 1), 7, "the mark rides the shift, not the raw offset");
});

test("text inserted after the mark leaves it alone (SUB-664)", () => {
  let state = seed("helloworld", 1, 5);
  state = state.update({ changes: { from: 10, insert: "!!" } }).state;
  assert.equal(trackedPos(state, 1), 5);
});

test("typing exactly at the mark pushes the mark after it (SUB-664)", () => {
  // assoc 1: a pending embed appends to what the user wrote at the drop point
  // rather than splitting it in half
  let state = seed("helloworld", 1, 5);
  state = state.update({ changes: { from: 5, insert: "XY" } }).state;
  assert.equal(trackedPos(state, 1), 7);
});

test("a deletion spanning the mark collapses it to the cut (SUB-664)", () => {
  let state = seed("helloworld", 1, 5);
  state = state.update({ changes: { from: 2, to: 8 } }).state;
  assert.equal(trackedPos(state, 1), 2, "still a valid position in the shortened doc");
  assert.ok(trackedPos(state, 1)! <= state.doc.length);
});

test("several intakes track independently and release one at a time (SUB-664)", () => {
  // a multi-file batch chains: each embed lands after the last, so the marks
  // must not share state
  let state = seed("helloworld", 1, 2);
  state = state.update({ effects: setTrackedPos.of({ id: 2, pos: 8 }) }).state;
  state = state.update({ changes: { from: 0, insert: "AB" } }).state;
  assert.equal(trackedPos(state, 1), 4);
  assert.equal(trackedPos(state, 2), 10);

  state = state.update({ effects: setTrackedPos.of({ id: 1, pos: null }) }).state;
  assert.equal(trackedPos(state, 1), null, "released");
  assert.equal(trackedPos(state, 2), 10, "the other intake is untouched");
});

test("a released mark stops costing a map, and re-registering is exact (SUB-664)", () => {
  let state = seed("helloworld", 1, 5);
  state = state.update({ effects: setTrackedPos.of({ id: 1, pos: null }) }).state;
  state = state.update({ changes: { from: 0, insert: "AB" } }).state;
  assert.equal(trackedPos(state, 1), null);

  // a fresh intake registers a raw offset — it must not inherit old mapping
  state = state.update({ effects: setTrackedPos.of({ id: 1, pos: 3 }) }).state;
  assert.equal(trackedPos(state, 1), 3);
});

test("registering and mapping in one transaction takes the raw position (SUB-664)", () => {
  // the effect's position is expressed against the transaction's NEW doc, so
  // it must not also be mapped by that same transaction's changes
  const state = EditorState.create({ doc: "helloworld", extensions: [trackedPositions] })
    .update({ changes: { from: 0, insert: "AB" }, effects: setTrackedPos.of({ id: 1, pos: 5 }) })
    .state;
  assert.equal(trackedPos(state, 1), 5);
});

test("an unknown id and a stateless doc both read null, never throw (SUB-664)", () => {
  const tracked = seed("helloworld", 1, 5);
  assert.equal(trackedPos(tracked, 99), null);
  // the field is absent when the editor was built without the extension
  const bare = EditorState.create({ doc: "helloworld" });
  assert.equal(trackedPos(bare, 1), null);
});
