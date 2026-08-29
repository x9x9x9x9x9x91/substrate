/** A toast's Undo button and ⌘Z are ONE operation, not two lookalikes.
 *
 *  Every surface that announces an action offers to take it back, and the
 *  cheap way to build that button is a closure over the inverse the action
 *  already computed. Two paths to the same revert drift: the button runs its
 *  own write while the stack entry stays live, so the keystroke afterwards
 *  reverts an edit that is already gone — with a check-then-act guard that is
 *  a refusal that stales the whole stack, and without one it is a double
 *  revert. So a surface mints the entry id first (`nextUndoId`) and its button
 *  calls `runById` on it (docs/undo.md §6.5).
 *
 *  Two halves, and both matter: the hook consuming the entry the keystroke
 *  would have picked, and every toast site actually being wired that way. The
 *  second is read off the source, so a site added tomorrow is covered without
 *  anyone remembering this file exists. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { createElement as h, useEffect } from "react";
import * as react from "react";
import { renderComponent } from "./componentHarness.ts";
import * as undoStack from "./undo.ts";
import type { UndoEntry } from "./undo.ts";

type UseUndoStack = typeof import("../hooks/useUndoStack.ts").useUndoStack;
type Hook = ReturnType<UseUndoStack>;

const act = react.act as unknown as (scope: () => Promise<void>) => Promise<void>;
const HERE = dirname(fileURLToPath(import.meta.url));

let useUndoStack: UseUndoStack;

before(async () => {
  ({ useUndoStack } = await import("../hooks/useUndoStack.ts"));
});

/** the hook's return, handed out from an effect (undoStackQueue's probe) */
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

async function mountHook(
  t: Parameters<typeof renderComponent>[0],
  toasts: string[]
): Promise<() => Hook> {
  let api: Hook | null = null;
  await renderComponent(t, h(Probe, { sink: (exposed: Hook) => (api = exposed), toasts }));
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

/** ⌘Z, as the app dispatches it */
function pressUndo(hook: () => Hook): Promise<void> {
  return hook().runUndoEntry(() => ({ entry: undoStack.peekUndo(hook().undoStateRef.current) }), -1);
}

test("the toast button consumes the entry ⌘Z would have taken", async (t) => {
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  // two actions, each recorded the way a surface with its own Undo button
  // does it: mint the id first, hand the same id to the entry and the button
  const idA = undoStack.nextUndoId();
  const idB = undoStack.nextUndoId();
  await act(async () => {
    hook().undoApi.record({ ...entry("A", ran), id: idA });
    hook().undoApi.record({ ...entry("B", ran), id: idB });
  });

  assert.equal(
    undoStack.peekUndo(hook().undoStateRef.current)?.id,
    idB,
    "the newest action's toast holds the very entry the keystroke is aimed at"
  );

  // press the toast's Undo rather than the keystroke
  await act(async () => {
    hook().undoApi.runById(idB);
    await Promise.resolve();
  });

  assert.deepEqual(ran, ["B"]);
  assert.deepEqual(toasts, ["Undid B"]);
  assert.equal(
    undoStack.peekUndo(hook().undoStateRef.current)?.id,
    idA,
    "the button moved the cursor, so the keystroke is now aimed one action down"
  );

  // …and the keystroke that follows walks on rather than re-running B
  await act(async () => {
    await pressUndo(hook);
  });
  assert.deepEqual(ran, ["B", "A"], "⌘Z re-ran the entry the toast button already consumed");
  assert.equal(
    hook().undoState.entries.filter((e) => e.stale).length,
    0,
    "the second revert hit a conflict — the two paths were not the same operation"
  );
});

test("an entry ⌘Z already took back does nothing when its toast is pressed", async (t) => {
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  const id = undoStack.nextUndoId();
  await act(async () => {
    hook().undoApi.record({ ...entry("A", ran), id });
  });
  await act(async () => {
    await pressUndo(hook);
  });
  assert.deepEqual(ran, ["A"]);

  // the toast is still on screen; its button now points at a spent entry
  await act(async () => {
    hook().undoApi.runById(id);
    await Promise.resolve();
  });
  assert.deepEqual(ran, ["A"], "the toast wrote a second time behind the keystroke's back");
  assert.deepEqual(toasts, ["Undid A"]);
});

test("an entry an external write staled does nothing when its toast is pressed", async (t) => {
  // ⌘Z skips a stale entry and says so without writing; a button that ran the
  // inverse anyway would hit the conflict guard, and the failure path then
  // marks EVERY entry stale — runnable ones included. The button must lose to
  // the skip.
  undoStack.__resetUndoIds();
  const toasts: string[] = [];
  const ran: string[] = [];
  const hook = await mountHook(t, toasts);

  const idA = undoStack.nextUndoId();
  const idB = undoStack.nextUndoId();
  await act(async () => {
    hook().undoApi.record({ ...entry("A", ran), id: idA });
    hook().undoApi.record({ ...entry("B", ran), id: idB });
  });
  // B's note changed on disk while its toast was still up
  await act(async () => {
    hook().undoDispatch({ t: "invalidate", paths: ["B.md"] });
  });

  await act(async () => {
    hook().undoApi.runById(idB);
    await Promise.resolve();
  });
  assert.deepEqual(ran, [], "the stale entry's inverse ran anyway");
  assert.equal(
    hook().undoState.entries.filter((e) => e.stale).length,
    1,
    "the refused press dragged the rest of the stack stale with it"
  );

  // …and A is still cleanly undoable afterwards
  await act(async () => {
    await pressUndo(hook);
  });
  assert.deepEqual(ran, ["A"], "the runnable entry below survived the refused press");
});

/** every `.ts`/`.tsx` under src, minus the tests */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

test("every toast Undo button in the app runs a stack entry by id", () => {
  const sites: string[] = [];
  for (const file of sourceFiles(resolve(HERE, ".."))) {
    const src = readFileSync(file, "utf8");
    // a toast action literal: `label: "Undo"` and the `run` beside it, which
    // may sit on the same line or the next few
    for (const m of src.matchAll(/label: "Undo",\s*(?:\/\/[^\n]*\n\s*)*run:([^\n]*)/g)) {
      sites.push(`${file}: ${m[1].trim()}`);
      assert.match(
        m[1],
        /runById\(/,
        `a toast Undo button in ${file} closes over its own inverse instead of running the stack entry — ` +
          `mint the id with nextUndoId() and call runById(id)`
      );
    }
  }
  // the regex going stale would pass in silence, so the count is asserted too:
  // the sweep found these when it was written and must keep finding them
  assert.ok(sites.length >= 7, `the toast Undo sweep found only ${sites.length} sites — did the regex go stale?`);
});
