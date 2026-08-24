/** The database's sort overview popover, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    Multi-key sorting was already there — shift-clicking headers appends up to
    three keys — but nothing on screen listed them, so these pin the surface
    that does: the keys in priority order, a direction toggle that rewrites
    one key, a remove that drops one, and an add that stops at the cap. The
    popover writes the same `sorts` list the headers write, so every
    assertion below reads the pref the pane handed back. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useState } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema, SavedViewSort, ViewPref } from "./types.ts";

const SCHEMA: Record<string, PropSchema> = {
  status: { options: [] },
  rating: { options: [], kind: "number" },
};

function row(title: string, status: string, rating: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: "Release", status, rating },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const ROWS = [row("Slow Bloom EP", "mixing", "9"), row("Dust Harbour", "live", "4")];

/** DatabasePane's required props, with everything these tests don't drive
    inert — the loose shape `databaseFilterEnter` uses, for the same reason:
    naming all thirty callbacks would pin the prop list, not the behaviour. */
function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: "Release",
    notes: ROWS,
    allNotes: ROWS,
    typeSchema: SCHEMA,
    schema: { Release: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: ["Release"],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    onSaveView: () => {},
    savedViews: [],
    pinKeys: {},
    onOpenView: () => {},
    onViewMenu: () => {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
    ...over,
  };
}

/** The pref is state the APP owns, so the pane is driven the way App drives
    it: a wrapper holds the pref and feeds every `onPrefChange` straight back
    in. Without it a write would render nothing and the popover could never be
    observed reacting to its own edit. */
function livePane(
  Pane: unknown,
  seed: ViewPref,
  seen: { pref: ViewPref }
): () => unknown {
  return function Live() {
    const [pref, setPref] = useState<ViewPref>(seed);
    seen.pref = pref;
    return h(Pane as never, paneProps({ pref, onPrefChange: setPref }) as never);
  };
}

async function openSortMenu(
  t: Parameters<typeof renderComponent>[0],
  sorts?: SavedViewSort[]
) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const seen = { pref: { view: "table" } as ViewPref };
  const seed: ViewPref = { view: "table", ...(sorts ? { sorts } : {}) };
  const r = await renderComponent(t, h(livePane(DatabasePane, seed, seen) as never));
  await r.click(".db-sorts-btn");
  return { r, seen };
}

/** the popover's rows, as "<ordinal> <name> <direction>" triples */
function listed(r: { all(sel: string): Element[] }): string[] {
  return r.all(".db-sorts-row").map((el) => {
    const part = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? "";
    return `${part(".db-sorts-ord")} ${part(".db-sorts-name")} ${part(".db-sorts-dir")}`;
  });
}

test("the popover lists the active sort keys in priority order", async (t) => {
  const { r } = await openSortMenu(t, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  assert.deepEqual(listed(r), ["1 Status ↑", "2 Rating ↓"]);
  assert.match(
    r.text(),
    /Shift-click a column header/,
    "the popover teaches the gesture that builds the list"
  );
});

test("the trigger reports the key count without being opened", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const seen = { pref: { view: "table" } as ViewPref };
  const r = await renderComponent(
    t,
    h(livePane(DatabasePane, { view: "table", sorts: [{ key: "status", dir: 1 }] }, seen) as never)
  );
  assert.equal(r.one(".db-sorts-count")?.textContent, "1");
  assert.equal(r.all(".db-sorts-row").length, 0, "and nothing is listed until it is opened");
});

test("the direction toggle rewrites that one key", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  await r.click(r.all(".db-sorts-row")[0].querySelector(".db-sorts-dir") as Element);
  assert.deepEqual(seen.pref.sorts, [
    { key: "status", dir: -1 },
    { key: "rating", dir: -1 },
  ]);
  assert.deepEqual(listed(r), ["1 Status ↓", "2 Rating ↓"], "and the popover stays open on it");
});

test("remove drops the key and re-numbers the rest", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  await r.click(r.all(".db-sorts-row")[0].querySelector(".db-sorts-drop") as Element);
  assert.deepEqual(seen.pref.sorts, [{ key: "rating", dir: -1 }]);
  assert.deepEqual(listed(r), ["1 Rating ↓"]);
});

test("removing the last key leaves the view unsorted", async (t) => {
  const { r, seen } = await openSortMenu(t, [{ key: "status", dir: 1 }]);
  await r.click(".db-sorts-drop");
  assert.equal(seen.pref.sorts, undefined, "an empty list is absent, never []");
  assert.equal(r.one(".db-sorts-count"), null, "the trigger goes quiet again");
});

test("an unsorted view opens straight on the property list", async (t) => {
  const { r, seen } = await openSortMenu(t);
  assert.equal(r.all(".db-sorts-row").length, 0);
  const names = r.all(".db-sorts-add-item").map((el) => el.textContent);
  assert.deepEqual(names, ["Name", "Status", "Rating"], "the Name column sorts too");

  await r.click(r.all(".db-sorts-add-item")[1]);
  assert.deepEqual(seen.pref.sorts, [{ key: "status", dir: 1 }], "a new key appends ascending");
  assert.deepEqual(listed(r), ["1 Status ↑"], "and the panel is back on the overview");
});

test("adding stops at three keys", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "title", dir: 1 },
    { key: "status", dir: 1 },
  ]);
  await r.click(".db-sorts-add");
  const names = r.all(".db-sorts-add-item").map((el) => el.textContent);
  assert.deepEqual(names, ["Rating"], "only the keys that are not already sorting");

  await r.click(".db-sorts-add-item");
  assert.equal(seen.pref.sorts?.length, 3);
  assert.equal(r.one(".db-sorts-add"), null, "no way in at the cap");
  assert.match(r.text(), /3 keys is the limit/, "the row says what it is waiting on instead");
});

/* ---- reorder ----

   jsdom has no drag-and-drop, so the payload the handlers write is stubbed on
   to a plain event — all React needs to route it. The gesture the popover
   relies on is the state it keeps, not the transfer object, so the stub is
   only there to keep `effectAllowed`/`dropEffect` assignable. */
function dragEvent(type: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" },
  });
  return ev;
}

async function dragRowOnto(
  r: { all(sel: string): Element[]; settle(): Promise<void> },
  from: number,
  to: number
): Promise<void> {
  const rows = r.all(".db-sorts-row");
  await act(async () => {
    rows[from].dispatchEvent(dragEvent("dragstart"));
  });
  await act(async () => {
    rows[to].dispatchEvent(dragEvent("dragover"));
  });
  await act(async () => {
    rows[to].dispatchEvent(dragEvent("drop"));
  });
  await r.settle();
}

test("dragging a key onto another changes the priority order", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "title", dir: 1 },
    { key: "status", dir: -1 },
    { key: "rating", dir: 1 },
  ]);
  assert.deepEqual(listed(r), ["1 Name ↑", "2 Status ↓", "3 Rating ↑"]);

  // the third key onto the first: it takes that place, the rest move down
  await dragRowOnto(r, 2, 0);
  assert.deepEqual(seen.pref.sorts, [
    { key: "rating", dir: 1 },
    { key: "title", dir: 1 },
    { key: "status", dir: -1 },
  ]);
  assert.deepEqual(listed(r), ["1 Rating ↑", "2 Name ↑", "3 Status ↓"]);
});

test("dragging the first key onto the last makes it last", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "title", dir: 1 },
    { key: "status", dir: -1 },
    { key: "rating", dir: 1 },
  ]);
  await dragRowOnto(r, 0, 2);
  assert.deepEqual(seen.pref.sorts, [
    { key: "status", dir: -1 },
    { key: "rating", dir: 1 },
    { key: "title", dir: 1 },
  ]);
});

test("a drop on the row it started from changes nothing and comes to rest", async (t) => {
  const { r, seen } = await openSortMenu(t, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  await dragRowOnto(r, 1, 1);
  assert.deepEqual(seen.pref.sorts, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  assert.equal(
    r.all(".db-sorts-row").filter((el) => el.classList.contains("dragging")).length,
    0,
    "the panel is not left mid-gesture"
  );
});

test("the row under the pointer marks where the key will land", async (t) => {
  const { r } = await openSortMenu(t, [
    { key: "status", dir: 1 },
    { key: "rating", dir: -1 },
  ]);
  const rows = r.all(".db-sorts-row");
  await act(async () => {
    rows[0].dispatchEvent(dragEvent("dragstart"));
  });
  await act(async () => {
    rows[1].dispatchEvent(dragEvent("dragover"));
  });
  await r.settle();
  const now = r.all(".db-sorts-row");
  assert.ok(now[0].classList.contains("dragging"), "the grabbed key is marked in flight");
  assert.ok(now[1].classList.contains("drop-on"), "and the target shows the landing place");

  await act(async () => {
    now[0].dispatchEvent(dragEvent("dragend"));
  });
  await r.settle();
  assert.equal(r.all(".db-sorts-row.dragging").length, 0, "dragend comes back to rest");
  assert.equal(r.all(".db-sorts-row.drop-on").length, 0);
});

test("the add list opens under the keys, not over them", async (t) => {
  const { r } = await openSortMenu(t, [{ key: "status", dir: 1 }]);
  await r.click(".db-sorts-add");
  assert.deepEqual(listed(r), ["1 Status ↑"], "the key it is about to add to stays on screen");
  assert.deepEqual(
    r.all(".db-sorts-add-item").map((el) => el.textContent),
    ["Name", "Rating"]
  );
});
