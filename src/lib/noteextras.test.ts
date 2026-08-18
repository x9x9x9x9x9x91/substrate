/** The cross-surface seal/lock/unseal doors, pinned on ORDERING.

    Sealing encrypts what is on disk and locking drops the identity the
    pending write needs, so a verb invoked on the note that is currently open
    has to let the pane's debounced save land first — the pane's own versions
    of these verbs have always done that. When the row menu and the palette
    gained the same verbs they reached the engine directly, so an edit typed
    inside the 500 ms window ended up in the sealed-locked recovery instead of
    in the file.

    e2e cannot see this: the mock backend's `vault_write_body` has no
    sealed-locked gate, so the doomed write succeeds there. Hence a unit test
    on the composition itself — the flush is held open and the assertion is
    that NOTHING has reached the dialog or the engine while it is. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoteExtras, type NoteExtrasDeps } from "./noteextras.ts";
import type { NoteMeta } from "./types.ts";

function note(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path: "Notes/Journal.md",
    stem: "Journal",
    title: "Journal",
    folder: "Notes",
    props: {},
    updated_ms: 0,
    excerpt: "",
    sealed: false,
    ...over,
  };
}

interface Rig {
  deps: NoteExtrasDeps;
  /** what the doors did, in the order they did it */
  log: string[];
  /** let the pending save land */
  landFlush: () => void;
}

function rig(unlockedSealed: string[] = []): Rig {
  const log: string[] = [];
  let release = (): void => {};
  const flushed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    log,
    landFlush: () => {
      log.push("flush");
      release();
    },
    deps: {
      unlockedSealed,
      schema: {},
      afterFlush: (fn) => flushed.then(fn),
      openSealDialog: (d) => log.push(`dialog:${d.mode}${d.then ? `>${d.then}` : ""}`),
      relock: (p) => log.push(`relock:${p}`),
      setCalendarHidden: (_n, hidden) => log.push(`calendar:${hidden}`),
    },
  };
}

test("seal waits for the open pane's save — the dialog opens after the flush", async () => {
  const r = rig();
  buildNoteExtras(note(), r.deps).seal?.();
  await Promise.resolve();
  assert.deepEqual(r.log, [], "the seal dialog opened over an unsaved buffer");

  r.landFlush();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(r.log, ["flush", "dialog:seal"]);
});

test("lock now waits for the open pane's save — the engine keeps the identity until then", async () => {
  const r = rig(["Notes/Journal.md"]);
  buildNoteExtras(note({ sealed: true }), r.deps).lockNow?.();
  await Promise.resolve();
  assert.deepEqual(r.log, [], "the note was relocked with a write still pending");

  r.landFlush();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(r.log, ["flush", "relock:Notes/Journal.md"]);
});

test("remove seal waits too, and chains unlock→confirm when the note is locked", async () => {
  const r = rig();
  buildNoteExtras(note({ sealed: true }), r.deps).unseal?.();
  await Promise.resolve();
  assert.deepEqual(r.log, []);

  r.landFlush();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(r.log, ["flush", "dialog:unlock>unseal"]);
});

test("remove seal on an already-unlocked note goes straight to the confirm, still after the flush", async () => {
  const r = rig(["Notes/Journal.md"]);
  buildNoteExtras(note({ sealed: true }), r.deps).unseal?.();
  r.landFlush();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(r.log, ["flush", "dialog:unseal"]);
});

test("availability: seal only when unsealed, lock only when this session holds the unlock", () => {
  const plain = buildNoteExtras(note(), rig().deps);
  assert.ok(plain.seal);
  assert.equal(plain.lockNow, undefined);
  assert.equal(plain.unseal, undefined);

  const locked = buildNoteExtras(note({ sealed: true }), rig().deps);
  assert.equal(locked.seal, undefined);
  assert.equal(locked.lockNow, undefined, "offered Lock now on a note we never unlocked");
  assert.ok(locked.unseal);

  const held = buildNoteExtras(note({ sealed: true }), rig(["Notes/Journal.md"]).deps);
  assert.ok(held.lockNow);
});

test("the calendar opt-out is offered only where it changes something, and is not flush-gated", async () => {
  const undated = rig();
  assert.equal(
    buildNoteExtras(note(), undated.deps).toggleCalendar,
    undefined,
    "a note with no dates never shows on the calendar — the verb would be a no-op"
  );

  const hidden = rig();
  const opted = buildNoteExtras(note({ props: { calendar: false } }), hidden.deps);
  assert.equal(opted.calendarHidden, true);
  opted.toggleCalendar?.();
  // a prop write, not an authorization change: nothing to order it behind
  assert.deepEqual(hidden.log, ["calendar:false"]);
});
