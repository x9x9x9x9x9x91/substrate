/** What a BURST of ⌘Z does — two presses inside one tick, the second queued
 *  behind the first's write.
 *
 *  The stack's cursor only moves once a write lands, so a queued press has to
 *  pick its entry when its turn comes rather than when the key was pressed
 *  (docs/undo.md §3.3). The subtle part is WHERE it picks from: the cursor is
 *  committed through a reducer, and a reducer's result reaches a ref written
 *  during render a macrotask later, while the queued press picks on the
 *  microtask right after the write it waited for. Read the render's copy and
 *  the second press picks the entry the first one just undid: it runs the same
 *  inverse twice, the second run refuses with `conflict:`, and the catch
 *  stales every entry on the stack plus toasts a disk conflict that never
 *  happened. So the hook advances its own copy synchronously, and this test is
 *  what says so.
 *
 *  The hook is exercised through a probe component rather than a rendered
 *  surface: ⌘Z dispatch is the seam, and no pixel below App shows it. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h, useEffect } from "react";
import * as react from "react";
import { renderComponent } from "./componentHarness.ts";
import * as undoStack from "./undo.ts";
import type { UndoEntry } from "./undo.ts";
/* imported inside the tests, not at module scope: the hook reaches for
   `../lib/undo` the way the bundler lets it, and only the harness's module
   resolver (installed as it evaluates) can follow an extensionless import. */
type UseUndoStack = typeof import("../hooks/useUndoStack.ts").useUndoStack;

const act = react.act as unknown as (scope: () => Promise<void>) => Promise<void>;

type Hook = ReturnType<UseUndoStack>;

let useUndoStack: UseUndoStack;

/** the hook's return, handed out from an effect rather than from the render
    body — a render is not the place to write to anything outside itself */
function Probe({ sink, toasts }: { sink: (api: Hook) => void; toasts: string[] }): null {
  const api = useUndoStack(
    () => {},
    (msg) => {
      toasts.push(msg);
    }
  );
  useEffect(() => {
    sink(api);
  }, [api, sink]);
  return null;
}

/** Render the probe and hand back a GETTER for the hook it exposed, not the
    hook itself. The callbacks are stable, but `undoState` is a fresh literal
    per render: a captured return value keeps forever whatever the first render
    held — an empty stack — so every assertion made through it passes without
    reading anything. The getter reads the latest render instead. */
async function mountHook(
  t: Parameters<typeof renderComponent>[0],
  toasts: string[]
): Promise<() => Hook> {
  let api: Hook | null = null;
  await renderComponent(t, h(Probe, {
      sink: (exposed: Hook) => {
        api = exposed;
      },
      toasts,
    }));
  assert.ok(api, "the probe rendered without exposing the hook");
  return () => api!;
}

/** an entry whose inverse takes a turn to land, the way a vault write does */
function entry(label: string, ran: string[]): Omit<UndoEntry, "id"> {
  return {
    label,
    scope: "vault",
    at: Date.now(),
    paths: [`${label}.md`],
    undo: async () => {
      await Promise.resolve();
      ran.push(label);
    },
  };
}

before(async () => {
  ({ useUndoStack } = await import("../hooks/useUndoStack.ts"));
});

test("two ⌘Z in one tick undo two different entries, newest first", async (t) => {
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  await act(async () => {
    hook().undoApi.record(entry("A", ran));
    hook().undoApi.record(entry("B", ran));
  });

  // both presses arrive before the first write lands — the second waits its
  // turn, then picks against the cursor the first one moved
  await act(async () => {
    const pick = () => ({ entry: undoStack.peekUndo(hook().undoStateRef.current) });
    const first = hook().runUndoEntry(pick, -1);
    const second = hook().runUndoEntry(pick, -1);
    await Promise.all([first, second]);
  });

  assert.deepEqual(ran, ["B", "A"], "the burst re-ran an entry instead of walking down the stack");
  assert.deepEqual(toasts, ["Undid B", "Undid A"]);
  // nothing went stale and nothing claimed a disk conflict
  assert.equal(
    hook().undoState.entries.filter((e) => e.stale).length,
    0,
    "the burst staled entries — the second press hit a conflict on its own undo"
  );
  assert.equal(hook().undoState.cursor, -1);
});

test("a third press with the stack exhausted runs nothing", async (t) => {
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  await act(async () => {
    hook().undoApi.record(entry("Only", ran));
  });
  await act(async () => {
    const pick = () => ({ entry: undoStack.peekUndo(hook().undoStateRef.current) });
    await Promise.all([hook().runUndoEntry(pick, -1), hook().runUndoEntry(pick, -1)]);
  });

  assert.deepEqual(ran, ["Only"]);
  assert.deepEqual(toasts, ["Undid Only"]);
});

/** An entry whose inverse hangs until it is let go — the window a vault write
    leaves open, and the only place a fresh action can be recorded MID-undo. */
function gatedEntry(label: string, ran: string[]): {
  entry: Omit<UndoEntry, "id">;
  release: () => void;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entry: {
      label,
      scope: "vault",
      at: Date.now(),
      paths: [`${label}.md`],
      undo: async () => {
        await gate;
        ran.push(label);
      },
    },
    release,
  };
}

test("a gesture's second half never folds into the entry an in-flight ⌘Z is unwinding", async (t) => {
  /* The narrow race grouping opened: the cursor only moves once the inverse's
     write lands, so a half pushed while the FIRST half is being undone sees a
     stack that still looks foldable. Folded, the late half rides the merged
     entry below the cursor when `advance` matches it by the first half's id —
     home reverted, row still revealed, and no keystroke can reach it. The
     runner marks what it is running so the push lands as its own entry. */
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  const g = undoStack.nextUndoGroup();
  const held = gatedEntry("home", ran);
  await act(async () => {
    hook().undoApi.record({ ...held.entry, group: g });
  });

  const pick = () => ({ entry: undoStack.peekUndo(hook().undoStateRef.current) });
  let undoingHome: Promise<void>;
  await act(async () => {
    undoingHome = hook().runUndoEntry(pick, -1);
    await new Promise((r) => setTimeout(r, 0));
    // the gesture's other store finishes writing while the undo is in the air
    hook().undoApi.record({
      ...entry("reveal", ran),
      group: g,
      redo: async () => {
        ran.push("redo:reveal");
      },
    });
  });
  assert.equal(
    hook().undoStateRef.current.entries.length,
    2,
    "the reveal folded into the entry being unwound"
  );

  await act(async () => {
    held.release();
    await undoingHome!;
  });

  assert.deepEqual(ran, ["home"], "home's inverse ran once");
  assert.deepEqual(
    hook().undoState.entries.map((e) => e.label),
    ["reveal"],
    "the reveal is stranded — it should be sitting at the cursor for a second ⌘Z"
  );

  // a second ⌘Z takes the reveal back, and the redo side is sane afterwards
  await act(async () => {
    await hook().runUndoEntry(pick, -1);
  });
  assert.deepEqual(ran, ["home", "reveal"]);
  assert.equal(hook().undoState.cursor, -1);
  assert.equal(undoStack.peekRedo(hook().undoState)?.label, "reveal");
  assert.equal(
    hook().undoState.entries.filter((e) => e.stale).length,
    0,
    "an entry went stale: something ran an inverse twice"
  );
  assert.deepEqual(toasts, ["Undid home", "Undid reveal"]);
});

test("an action recorded during an in-flight undo retires the entry being undone", async (t) => {
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  const held = gatedEntry("B", ran);
  await act(async () => {
    hook().undoApi.record(entry("A", ran));
    hook().undoApi.record(held.entry);
  });

  const pick = () => ({ entry: undoStack.peekUndo(hook().undoStateRef.current) });
  let undoingB: Promise<void>;
  await act(async () => {
    undoingB = hook().runUndoEntry(pick, -1);
    // let the press take its turn and pick B before anything else happens
    await new Promise((r) => setTimeout(r, 0));
    // the user keeps working while B's inverse is still in the air
    hook().undoApi.record(entry("C", ran));
  });

  await act(async () => {
    held.release();
    await undoingB!;
  });

  assert.deepEqual(ran, ["B"], "B's inverse ran once");
  assert.deepEqual(
    hook().undoState.entries.map((e) => e.label),
    ["A", "C"],
    "the undone entry stayed on the stack, waiting to be run a second time"
  );

  // the action taken during the undo takes itself back, cleanly
  await act(async () => {
    await hook().runUndoEntry(pick, -1);
  });
  assert.deepEqual(ran, ["B", "C"]);

  // and the press after that reaches the entry BELOW the one that was undone
  await act(async () => {
    await hook().runUndoEntry(pick, -1);
  });
  assert.deepEqual(ran, ["B", "C", "A"], "⌘Z re-picked the already-undone entry");
  assert.deepEqual(toasts, ["Undid B", "Undid C", "Undid A"], "a toast blamed a disk conflict");
  assert.equal(
    hook().undoState.entries.filter((e) => e.stale).length,
    0,
    "an entry went stale: something ran an inverse twice"
  );
});
