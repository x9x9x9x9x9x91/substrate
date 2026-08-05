import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPending,
  applyPending,
  applyPendingTo,
  dropPending,
  NO_PENDING,
  prunePending,
  settlePending,
} from "./pendingprops.ts";
import type { NoteMeta } from "./types.ts";

const note = (path: string, props: Record<string, unknown> = {}): NoteMeta => ({
  path,
  stem: path.replace(/\.md$/, ""),
  title: path.replace(/\.md$/, ""),
  folder: "",
  props,
  updated_ms: 0,
  excerpt: "",
  sealed: false,
});

const notes = [note("a.md", { Status: "todo" }), note("b.md", { Status: "todo" })];
const propOf = (ns: NoteMeta[], path: string, key: string) =>
  ns.find((n) => n.path === path)?.props[key];

test("applyPending: nothing pending returns the very same array", () => {
  assert.equal(applyPending(notes, NO_PENDING), notes);
});

test("applyPending: a pending write paints over disk without mutating it", () => {
  const p = addPending(NO_PENDING, [{ path: "a.md", key: "Status", value: "done" }]);
  const shown = applyPending(notes, p);
  assert.equal(propOf(shown, "a.md", "Status"), "done");
  // untouched rows keep their identity, and disk itself never changed
  assert.equal(shown[1], notes[1]);
  assert.equal(propOf(notes, "a.md", "Status"), "todo");
});

test("applyPending: a null write paints the prop as absent (a cleared cell)", () => {
  const p = addPending(NO_PENDING, [{ path: "a.md", key: "Status", value: null }]);
  const shown = applyPending(notes, p);
  assert.equal("Status" in (shown[0]?.props ?? {}), false);
});

test("dropPending: a refused write rolls back to disk on the spot", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const p = dropPending(addPending(NO_PENDING, w), w);
  assert.equal(p.size, 0);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "todo");
});

test("prunePending: a settled write retires once disk stops disagreeing", () => {
  // the write landed, so disk IS the truth — including an engine
  // normalization the typed value will never compare equal to. The entry
  // gives the write's own refresh one chance to arrive (see the stale-refresh
  // test below), then lets go.
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const p = prunePending(prunePending(settlePending(addPending(NO_PENDING, w), w), notes), notes);
  assert.equal(p.size, 0);
});

test("settlePending: a landed write holds the screen until the refresh arrives", () => {
  // between the write resolving and the re-sync delivering it, dropping the
  // entry would paint the OLD value for those frames
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const p = settlePending(addPending(NO_PENDING, w), w);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "done");
});

test("prunePending: the refresh that carries the value retires the entry", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const fresh = [note("a.md", { Status: "done" }), notes[1]!];
  const p = prunePending(addPending(NO_PENDING, w), fresh);
  assert.equal(p.size, 0);
  assert.equal(propOf(applyPending(fresh, p), "a.md", "Status"), "done");
});

test("prunePending: an unsettled write outlives a refresh that predates it", () => {
  // the pane re-renders for unrelated reasons all the time; a write still in
  // flight must not blink back to the old value on one of them
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const p = prunePending(addPending(NO_PENDING, w), notes);
  assert.equal(p.size, 1);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "done");
});

test("prunePending: a list value compares element-wise, not by identity", () => {
  const w = [{ path: "a.md", key: "Tags", value: ["x", "y"] }];
  const fresh = [note("a.md", { Tags: ["x", "y"] }), notes[1]!];
  assert.equal(prunePending(addPending(NO_PENDING, w), fresh).size, 0);
  const other = [note("a.md", { Tags: ["x"] }), notes[1]!];
  assert.equal(prunePending(addPending(NO_PENDING, w), other).size, 1);
});

test("prunePending: a numeric scalar off YAML matches the typed text", () => {
  // the editor authors "12"; the vault hands 12 back — the same value
  const w = [{ path: "a.md", key: "Rating", value: "12" }];
  const fresh = [note("a.md", { Rating: 12 }), notes[1]!];
  assert.equal(prunePending(addPending(NO_PENDING, w), fresh).size, 0);
});

test("settlePending: a newer write for the same cell keeps the cell", () => {
  const first = [{ path: "a.md", key: "Status", value: "done" }];
  const second = [{ path: "a.md", key: "Status", value: "shipped" }];
  // the second write started before the first resolved: the first's settle
  // must not hand the cell to a refresh that only knows the first value
  const p = settlePending(addPending(addPending(NO_PENDING, first), second), first);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "shipped");
  assert.equal(prunePending(p, notes).size, 1, "still in flight");
});

test("dropPending: a refused OLDER write leaves the retyped value on screen", () => {
  // the user typed "done", it was slow; they retyped "shipped" before the
  // first write came back refused. Dropping on id alone wiped "shipped" —
  // the cell flashed disk's stale "todo" and the second settle no-oped.
  const first = [{ path: "a.md", key: "Status", value: "done" }];
  const second = [{ path: "a.md", key: "Status", value: "shipped" }];
  let p = addPending(addPending(NO_PENDING, first), second);
  p = dropPending(p, first);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "shipped");
  // and the newer write can still settle — the drop didn't consume its entry
  p = settlePending(p, second);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "shipped");
});

test("dropPending: a refused re-write of the SAME value still rolls back", () => {
  // toggle A → B → A: the third write's value equals the first's, so value
  // equality would call the live entry superseded and refuse to roll it back
  const on = { path: "a.md", key: "Flag", value: "on" };
  const off = { path: "a.md", key: "Flag", value: "off" };
  const onAgain = { path: "a.md", key: "Flag", value: "on" };
  let p = addPending(addPending(addPending(NO_PENDING, [on]), [off]), [onAgain]);
  // the first two resolved and were superseded; the live one is refused
  p = dropPending(dropPending(p, [on]), [off]);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Flag"), "on", "still the live write");
  p = dropPending(p, [onAgain]);
  assert.equal(p.size, 0);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Flag"), undefined);
});

test("prunePending: a settled entry survives one stale refresh, then retires", () => {
  // a watcher refresh already in flight when the write landed knows only the
  // OLD value; retiring against it is the stale flash settle exists to
  // prevent. But the engine may normalize the value past sameValue's reach,
  // so the entry must not pin the overlay forever either.
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  let p = settlePending(addPending(NO_PENDING, w), w);
  // refresh 1: stale (still says "todo") — the value holds
  p = prunePending(p, notes);
  assert.equal(p.size, 1);
  assert.equal(propOf(applyPending(notes, p), "a.md", "Status"), "done");
  // refresh 2: still doesn't carry it (engine normalized to something else) —
  // disk wins rather than the overlay outliving its write
  p = prunePending(p, notes);
  assert.equal(p.size, 0);
});

test("prunePending: the refresh that carries the value retires a settled entry at once", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const fresh = [note("a.md", { Status: "done" }), notes[1]!];
  const p = prunePending(settlePending(addPending(NO_PENDING, w), w), fresh);
  assert.equal(p.size, 0);
});

test("a bulk set paints every row and rolls back only the refused ones", () => {
  const w = notes.map((n) => ({ path: n.path, key: "Status", value: "done" }));
  let p = addPending(NO_PENDING, w);
  let shown = applyPending(notes, p);
  assert.deepEqual(
    shown.map((n) => n.props.Status),
    ["done", "done"]
  );
  // b.md's write was refused; a.md's landed
  p = dropPending(settlePending(p, [w[0]!]), [w[1]!]);
  shown = applyPending(notes, p);
  assert.deepEqual(
    shown.map((n) => n.props.Status),
    ["done", "todo"]
  );
});

/* The note page holds ONE note's props, not a list */

const diskProps = { Status: "todo", Tags: ["a"] };

test("applyPendingTo: nothing pending returns the very same object", () => {
  assert.equal(applyPendingTo("a.md", diskProps, NO_PENDING), diskProps);
});

test("applyPendingTo: only this note's writes paint on it", () => {
  const p = addPending(NO_PENDING, [{ path: "b.md", key: "Status", value: "done" }]);
  // someone else's write in flight leaves this note's props identical
  assert.equal(applyPendingTo("a.md", diskProps, p), diskProps);
  assert.equal(applyPendingTo("b.md", diskProps, p).Status, "done");
});

test("applyPendingTo: a committed chip paints before the write lands", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const shown = applyPendingTo("a.md", diskProps, addPending(NO_PENDING, w));
  assert.equal(shown.Status, "done");
  // disk itself is untouched
  assert.equal(diskProps.Status, "todo");
});

test("applyPendingTo: a null write paints the prop as absent (a removed chip)", () => {
  const w = [{ path: "a.md", key: "Status", value: null }];
  const shown = applyPendingTo("a.md", diskProps, addPending(NO_PENDING, w));
  assert.equal("Status" in shown, false);
});

test("applyPendingTo: a refused write rolls the chip back visibly", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  const p = dropPending(addPending(NO_PENDING, w), w);
  assert.equal(applyPendingTo("a.md", diskProps, p).Status, "todo");
});

test("prunePending: the note pane's one-note refresh retires its entry", () => {
  const w = [{ path: "a.md", key: "Status", value: "done" }];
  let p = settlePending(addPending(NO_PENDING, w), w);
  // the pane re-read and disk still says todo — absorbed, the paint stays
  p = prunePending(p, [{ path: "a.md", props: diskProps }]);
  assert.equal(applyPendingTo("a.md", diskProps, p).Status, "done");
  // the write's own re-read carries it: the overlay retires, disk shows through
  p = prunePending(p, [{ path: "a.md", props: { Status: "done" } }]);
  assert.equal(p.size, 0);
});

test("a late refusal of a superseded chip edit leaves the newer paint alone", () => {
  const first = [{ path: "a.md", key: "Status", value: "doing" }];
  const second = [{ path: "a.md", key: "Status", value: "done" }];
  let p = addPending(NO_PENDING, first);
  p = addPending(p, second);
  p = dropPending(p, first);
  assert.equal(applyPendingTo("a.md", diskProps, p).Status, "done");
});
