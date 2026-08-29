/** The food board's edits on the app's own undo stack (docs/undo.md §6.6).
 *
 *  The board used to keep a private pair of stacks and its own window ⌘Z. Two
 *  things were wrong with that: the stacks emptied when the board was
 *  navigated away from, and both were mutated BEFORE the write resolved, so a
 *  refused write still consumed an undo step and left a redo pointing at a
 *  body that never reached disk (§3.4-3).
 *
 *  What is pinned here is the fold, not the food maths (`food.test.ts` owns
 *  that): a logged row records ONE `pane:food` entry naming the log note,
 *  running its inverse puts the sheet back, and closing the board takes its
 *  entries with it. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

type Recorded = Omit<UndoEntry, "id"> & { id?: number };

/** The board wrapped in a recording undo provider — the seam App fills with
    its reducer, and the one thing this test needs to see. */
async function board(t: Parameters<typeof renderComponent>[0]) {
  const { default: FoodDashboard } = await import("../components/FoodDashboard.tsx");
  const { vaultRead } = await import("./ipc.ts");
  const entries: Recorded[] = [];
  const evicted: string[] = [];
  const meta = {
    path: "Dashboards/Calories.md",
    stem: "Calories",
    title: "Calories",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "food", log: "Food Log", db: "Food DB" },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
  const r = await renderComponent(
    t,
    h(
      UndoContext.Provider,
      {
        value: {
          record: (e: Recorded) => entries.push(e),
          runById: () => {},
          evictScope: (scope: string) => evicted.push(scope),
        },
      },
      h(FoodDashboard, {
        meta,
        vaultEpoch: 1,
        onOpenSource: () => {},
        onMutated: () => {},
      })
    )
  );
  await r.settle();
  const logBody = async () => (await vaultRead("Food Log.md")).body;
  return { r, entries, evicted, logBody };
}

/** Type into the quick-add form and submit it. */
type ActLike = (scope: () => Promise<void>) => Promise<void>;
/** Anything that lands a state update from outside the render — a typed
    field, a submit, an inverse writing the body back — runs inside act so the
    render it causes is finished before the next assertion reads. */
const inAct = act as unknown as ActLike;

async function logRow(
  r: Awaited<ReturnType<typeof board>>["r"],
  food: string,
  kcal: string
): Promise<void> {
  const foodField = r.one(".dash-form .food-food input") as HTMLInputElement | null;
  const kcalField = r.one('.dash-form input[type="number"]') as HTMLInputElement | null;
  assert.ok(foodField && kcalField, "the quick-add form is missing its fields");
  const set = (el: HTMLInputElement, v: string) => {
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(el, v);
    el.dispatchEvent(new el.ownerDocument.defaultView!.Event("input", { bubbles: true }));
  };
  await inAct(async () => {
    set(foodField, food);
    set(kcalField, kcal);
  });
  const form = r.one(".dash-form") as HTMLFormElement;
  await inAct(async () => {
    form.dispatchEvent(
      new form.ownerDocument.defaultView!.Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await r.settle();
}

test("logging a row records one pane-scoped entry that puts the sheet back", async (t) => {
  const { r, entries, logBody } = await board(t);
  const before = await logBody();
  await logRow(r, "Undo Kestrel", "412");

  assert.equal(entries.length, 1, "one action, one entry");
  const entry = entries[0];
  assert.equal(entry.scope, "pane:food", "pane-scoped, so closing the board drops it");
  assert.deepEqual(entry.paths, ["Food Log.md"], "the sheet it rewrote, not the board note");
  assert.match(entry.label, /Undo Kestrel/, "the label names the food, not 'body edit'");
  assert.match(await logBody(), /Undo Kestrel,412/, "the row landed");

  await inAct(() => entry.undo());
  assert.equal(await logBody(), before, "and ⌘Z takes the whole row back");
  await inAct(() => entry.redo!());
  assert.match(await logBody(), /Undo Kestrel,412/, "⇧⌘Z puts it back");
});

test("the entry is recorded after the write, not before it", async (t) => {
  const { r, entries, logBody } = await board(t);
  await logRow(r, "Undo Merlin", "300");
  assert.equal(entries.length, 1);
  // somebody else edits the sheet, then the inverse is asked to run: it must
  // refuse rather than clobber, and it must be the only stack effect — the
  // old board had already consumed its step at click time
  const { vaultWriteBody } = await import("./ipc.ts");
  const now = await logBody();
  await vaultWriteBody("Food Log.md", `${now}\nintruder\n`, now);
  // caught inside act, not around it: a rejection thrown THROUGH act escapes
  // as an unhandled one while the render it triggered is still settling
  let refusal: unknown;
  await inAct(async () => {
    refusal = await entries[0].undo().then(() => null, (e: unknown) => e);
  });
  assert.match(String(refusal), /conflict:/, "the inverse refused rather than clobbering");
  assert.match(await logBody(), /intruder/, "the other edit stands");
});

test("the quick-add form opts into app undo, so ⌘Z in a cleared field still means the add", async (t) => {
  const { r } = await board(t);
  const forms = r.all('.dash-form[data-undo-scope="app"]');
  assert.ok(forms.length >= 1, "the commit-and-clear form declares the app-undo hatch");
  const { inAppUndoForm } = await import("./dom.ts");
  const field = r.one(".dash-form .food-food input");
  assert.ok(field, "the form has a field to park the caret in");
  assert.equal(inAppUndoForm(field), true, "focus inside it routes ⌘Z to the app stack");
});

test("closing the board takes its entries with it", async (t) => {
  const { r, evicted } = await board(t);
  await r.unmount();
  assert.deepEqual(evicted, ["pane:food"], "its inverses close over pane state");
});

test("the mock vault still has its seeded rows", async () => {
  // the file writes above land in the shared mock vault; this file is the only
  // one that edits the food log, and it leaves it readable for the next run
  const { vaultRead } = await import("./ipc.ts");
  assert.match((await vaultRead("Food Log.md")).body, /date,food,kcal/);
  void win;
});
