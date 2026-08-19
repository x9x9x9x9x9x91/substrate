/** The database cell editor's close hand-off.

    The rule under test is one the pane defends everywhere: never move focus
    or the viewport under a user who has deliberately put focus somewhere
    else. The close is the one moment where both are owed at once — the
    editor took focus with it, and a reveal asked for mid-edit was refused
    while it held it — so the matrix of "where did focus land" against "is a
    reveal owed" is the whole behaviour. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyActive,
  focusAfterEditorClose,
  revealAfterEditorClose,
  type ActiveAfterClose,
} from "./editorClose.ts";

test("focus goes back to the anchoring cell only when nothing claimed it", () => {
  // Escape, a keyboard commit, a stale anchor: the editor unmounted and the
  // browser dropped focus on <body>. Without the restore the grid keeps its
  // accent ring and loses its keyboard.
  assert.equal(focusAfterEditorClose("nowhere"), "restore");
  // the composite already holds it (a click straight onto another cell)
  assert.equal(focusAfterEditorClose("grid-cell"), "leave");
  // the click-away landed in a real control — the user went there on purpose
  assert.equal(focusAfterEditorClose("other-control"), "leave");
});

test("an owed reveal is settled at the close, scroll-only against a focused control", () => {
  // nothing owed: the close moves no viewport at all
  for (const active of ["nowhere", "grid-cell", "other-control"] as ActiveAfterClose[])
    assert.equal(revealAfterEditorClose({ owed: false, active }), "none");

  // owed and focus is free: the ordinary reveal, tab stop and all
  assert.equal(revealAfterEditorClose({ owed: true, active: "nowhere" }), "focus-and-scroll");
  assert.equal(revealAfterEditorClose({ owed: true, active: "grid-cell" }), "focus-and-scroll");

  // owed while the user is typing in something else: the late-yank case.
  // The row still has to be shown — that is what was asked for — but taking
  // their focus to show it is not on offer.
  assert.equal(revealAfterEditorClose({ owed: true, active: "other-control" }), "scroll-only");
});

test("the close always settles the reveal — never leaves one armed", () => {
  // The defect was the absence of a "later": an owed reveal that survived the
  // close was handed over by whatever scroll or resize re-ran the effect next,
  // yanking the viewport long after the ask. Every branch of the matrix here
  // is a delivery decision, so there is no branch that leaves one pending.
  for (const active of ["nowhere", "grid-cell", "other-control"] as ActiveAfterClose[])
    assert.notEqual(revealAfterEditorClose({ owed: true, active }), "none");
});

/* classifyActive reads a live DOM. The suite runs without one, so the shapes
   it asks about are stood up as the smallest objects that answer them —
   the point being WHICH questions decide the classification. */
function fakeEl(opts: {
  selectorMatches?: boolean;
  inDocument?: boolean;
  isBody?: boolean;
}): Element {
  const body = { tag: "body" } as unknown as Element;
  const el = {
    matches: () => opts.selectorMatches ?? false,
    ownerDocument: {
      body: opts.isBody ? undefined : body,
      documentElement: { tag: "html" },
      contains: () => opts.inDocument ?? true,
    },
  } as unknown as Element;
  return el;
}

test("classifyActive: nothing focused reads as nowhere", () => {
  assert.equal(classifyActive(null), "nowhere");
  assert.equal(classifyActive(undefined), "nowhere");
});

test("classifyActive: the unmounted editor input reads as nowhere", () => {
  // The editor's own field can still be activeElement for the frame after it
  // is torn out of the tree. Nobody claimed focus, so the cell may take it.
  assert.equal(classifyActive(fakeEl({ inDocument: false })), "nowhere");
});

test("classifyActive: a roving tab stop is the composite, a control is not", () => {
  assert.equal(classifyActive(fakeEl({ selectorMatches: true })), "grid-cell");
  assert.equal(classifyActive(fakeEl({ selectorMatches: false })), "other-control");
});
