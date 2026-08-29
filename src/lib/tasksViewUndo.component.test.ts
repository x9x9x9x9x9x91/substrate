/** The tasks board's view and sort flips on the app's own undo stack
 *  (docs/undo.md §1.2).
 *
 *  The board used to hold these two flips off the stack on purpose — a layout
 *  choice is not content, and ⌘Z landing on one between two prop edits would
 *  read as data loss. Every database pane now records its view flips, so the
 *  same gesture meant opposite things depending on which pane you were in;
 *  the flips are undoable everywhere instead.
 *
 *  What is pinned here is the fold, not the board's layout maths
 *  (`tasksDashboard.test.ts` owns that): a flip records ONE entry naming the
 *  dashboard note, ⌘Z puts the switch AND the frontmatter back, and a layout
 *  that moved elsewhere since refuses rather than clobbering it. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

const BOARD = "Dashboards/Tasks Undo.md";
const SCHEMA: SchemaConfig = {};

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Dashboards/Umbra Home.md", BOARD);
  // the board this pane configures: no stored layout yet, so the first flip
  // writes the prop and its inverse clears it again
  win.__mockEditProp(BOARD, "dashboard", "tasks");
  win.__mockEditProp(BOARD, "view", null);
  win.__mockEditProp(BOARD, "sort", null);
});

after(() => win.__mockDeleteNote(BOARD));

type Recorded = Omit<UndoEntry, "id"> & { id?: number };

type ActLike = (scope: () => Promise<void>) => Promise<void>;
/** Anything that lands a state update from outside the render — a click, an
    inverse writing the prop back — runs inside act so the render it causes is
    finished before the next assertion reads. */
const inAct = act as unknown as ActLike;

function task(title: string): NoteMeta {
  return {
    path: `Tasks/${title}.md`,
    stem: title,
    title,
    folder: "Tasks",
    props: { type: "task", area: "Studio", created: "2026-07-01" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/** The board wrapped in a recording undo provider — the seam App fills with
    its reducer, and the one thing this test needs to see. */
async function board(t: Parameters<typeof renderComponent>[0]) {
  const { default: TasksDashboard } = await import("../components/TasksDashboard.tsx");
  const entries: Recorded[] = [];
  const meta: NoteMeta = {
    path: BOARD,
    stem: "Tasks Undo",
    title: "Tasks Undo",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "tasks" },
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
          evictScope: () => {},
        },
      },
      h(TasksDashboard, {
        meta,
        notes: [task("Mix bounce")],
        schema: SCHEMA,
        onOpenSource: () => {},
        onMutated: () => {},
      })
    )
  );
  await r.settle();
  return { r, entries };
}

/** Press a button in one of the head's switch groups. */
async function press(
  r: Awaited<ReturnType<typeof board>>["r"],
  group: string,
  label: string
): Promise<void> {
  const button = r
    .all(`.${group} button`)
    .find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
  assert.ok(button, `the ${group} switch has no ${label} button`);
  await inAct(async () => {
    button.dispatchEvent(
      new button.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true })
    );
  });
  await r.settle();
}

/** What the note on disk says the layout is. */
async function stored(key: string): Promise<unknown> {
  const { vaultRead } = await import("./ipc.ts");
  return (await vaultRead(BOARD)).props[key] ?? null;
}

/** Which button in a switch group reads as chosen. */
function chosen(r: Awaited<ReturnType<typeof board>>["r"], group: string): string {
  const active = r.all(`.${group} button`).find((b) => b.getAttribute("aria-pressed") === "true");
  return (active?.textContent ?? "").trim();
}

test("a layout flip records one entry and ⌘Z puts the board back", async (t) => {
  const { r, entries } = await board(t);
  assert.equal(chosen(r, "tasks-view"), "List", "the board starts on its default layout");

  await press(r, "tasks-view", "Board");

  assert.equal(entries.length, 1, "one flip, one entry");
  const entry = entries[0];
  assert.equal(entry.scope, "vault", "the session stack, not a pane that closes with the board");
  assert.deepEqual(entry.paths, [BOARD], "the dashboard note it wrote");
  assert.equal(entry.label, "Layout → Board", "the switch's own words, not the frontmatter key");
  assert.equal(await stored("view"), "board", "the flip reached disk");
  assert.equal(chosen(r, "tasks-view"), "Board");

  await inAct(() => entry.undo());
  assert.equal(await stored("view"), null, "⌘Z cleared the prop the flip wrote");
  assert.equal(chosen(r, "tasks-view"), "List", "and the switch followed it back");

  await inAct(() => entry.redo!());
  assert.equal(await stored("view"), "board", "⇧⌘Z puts the layout back");
  assert.equal(chosen(r, "tasks-view"), "Board");
  await inAct(() => entry.undo());
});

test("a sort flip is undoable on the same terms", async (t) => {
  const { r, entries } = await board(t);
  await press(r, "tasks-sort", "Due");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "Order rows by → Due");
  assert.equal(await stored("sort"), "due");
  assert.equal(chosen(r, "tasks-sort"), "Due");

  await inAct(() => entries[0].undo());
  assert.equal(await stored("sort"), null, "back to the board's default order");
  assert.equal(chosen(r, "tasks-sort"), "Urgency");
});

test("a layout changed elsewhere refuses the undo instead of clobbering it", async (t) => {
  const { r, entries } = await board(t);
  await press(r, "tasks-view", "Board");
  assert.equal(entries.length, 1);

  // somebody else edits the board note — another window, an agent, the file
  // itself. The inverse is guarded on the value the flip wrote, so it must
  // refuse rather than write the older layout over this one.
  win.__mockEditProp(BOARD, "view", "list");

  // caught inside act, not around it: a rejection thrown THROUGH act escapes
  // as an unhandled one while the render it triggered is still settling
  let refusal: unknown;
  await inAct(async () => {
    refusal = await entries[0].undo().then(
      () => null,
      (e: unknown) => e
    );
  });
  assert.match(String(refusal), /conflict:/, "the inverse refused rather than clobbering");
  assert.equal(await stored("view"), "list", "the other edit stands");
  assert.equal(
    chosen(r, "tasks-view"),
    "List",
    "the switch kept advertising a layout the note no longer holds"
  );
  assert.equal(entries.length, 1, "and the refusal recorded nothing new");
  // the entry is still the one the runner will stale — it was never consumed
  assert.equal(entries[0].label, "Layout → Board");
  win.__mockEditProp(BOARD, "view", null);
});
