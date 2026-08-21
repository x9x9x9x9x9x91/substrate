/** The palette rendered for real, over the fixed-destination catalogue.

    `palette.test.ts` proves the catalogue is complete; this proves the
    component actually renders it, which is the other half of the claim — a
    row set no surface reads is a list, not an affordance. It also pins the
    doors: a saved view opens the view a sidebar pin opens, and a database
    row goes through the app's open-a-database callback rather than setting
    the database view itself, which is what lets a mounted folder land on its
    mount.

    Written up in `docs/component-tests.md`; `workbookPane.component.test.ts`
    is the worked example. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { FIXED_VIEW_COMMANDS } from "./palette.ts";
import { NEW_DASHBOARD_KINDS } from "./newdashboard.ts";
import type { NoteMeta, View } from "./types.ts";

before(async () => {
  await mockBackend();
});

/** what the palette was handed, so a test can assert on the door taken */
interface Calls {
  views: View[];
  dbs: string[];
  journal: number;
  timeTravel: number;
  shortcuts: number;
  assignKeys: number;
  search: (string | undefined)[];
  /** [title, kind] per dashboard the palette asked App to create */
  dashboards: [string, string][];
}

function note(path: string, title: string): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    props: {},
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
    tags: ["field", "gear"],
  };
}

/** Every prop, with the interesting ones staged: one database that is really
    a mounted folder, one saved view past the fifth pin, one tag folder, the
    vault's tags, and an undo/redo pair so both keycap rows render. */
function paletteProps(calls: Calls, over: Record<string, unknown> = {}) {
  return {
    mode: "palette" as const,
    notes: [note("Field Notes.md", "Field Notes")],
    excludeAppFiles: false,
    databases: [{ type: "samples", count: 12 }],
    icons: {},
    dashboards: [],
    folders: ["Journal"],
    savedViews: [{ id: "sv-six", name: "Sixth pin", db: "samples" }],
    tagFolders: [{ id: "tf-1", name: "Gear", tags: ["gear"], match: "any" as const, exclude: [] }],
    tags: [{ tag: "field", count: 3 }],
    proxyAvailable: false,
    current: null,
    templateTypes: [],
    onExportCsv: null,
    onPrint: null,
    undoCommand: { label: "Role → booking", run: () => {} },
    redoCommand: { label: "Role → booking", run: () => {} },
    onClose: () => {},
    onOpenNote: () => {},
    onSetView: (v: View) => calls.views.push(v),
    onOpenDb: (type: string) => calls.dbs.push(type),
    onOpenJournal: () => (calls.journal += 1),
    onOpenTimeTravel: () => (calls.timeTravel += 1),
    onOpenShortcuts: () => (calls.shortcuts += 1),
    onAssignKeys: () => (calls.assignKeys += 1),
    onCreate: () => {},
    onCreateFolder: () => {},
    onMoveNote: () => {},
    onRenameNote: () => {},
    onRenameFolder: () => {},
    onDuplicate: () => {},
    onSendAsLink: () => {},
    onTrashNote: () => {},
    onTogglePick: () => {},
    onTogglePin: () => {},
    pinnedPaths: [],
    onRevealRel: () => {},
    onCreateTyped: () => {},
    onEditTemplate: () => {},
    onNewDatabase: () => {},
    onCreateSheet: () => {},
    onCreateDashboard: (title: string, kind: string) => calls.dashboards.push([title, kind]),
    onImportCsv: () => {},
    onSwitchCapture: () => {},
    onOpenSearch: (seed?: string) => calls.search.push(seed),
    onMutated: () => {},
    onToast: () => {},
    onToggleTerminal: null,
    onTerminalRun: null,
    terminalActions: [],
    onOpenSettings: () => {},
    ...over,
  };
}

function freshCalls(): Calls {
  return {
    views: [],
    dbs: [],
    journal: 0,
    timeTravel: 0,
    shortcuts: 0,
    assignKeys: 0,
    search: [],
    dashboards: [],
  };
}

async function openPalette(t: Parameters<typeof renderComponent>[0], calls: Calls, over = {}) {
  const { default: Palette } = await import("../components/Palette.tsx");
  return renderComponent(t, h(Palette, paletteProps(calls, over) as never));
}

/** the row whose visible label is exactly `label`, or null */
function row(r: { all(s: string): Element[] }, label: string): Element | null {
  return (
    r
      .all(".palette-item")
      .find((el) => el.querySelector(".palette-item-label")?.textContent?.trim() === label) ?? null
  );
}

test("the empty palette lists every destination the catalogue names", async (t) => {
  const r = await openPalette(t, freshCalls());

  // read off the catalogue, not copied from it — a row added there and not
  // rendered here is the exact failure this is for. Machine-gated entries are
  // filtered the way the component filters them, with this fixture's answers.
  const expected = FIXED_VIEW_COMMANDS.filter(
    (c) =>
      c.when?.({
        proxyAvailable: false,
      }) ?? true
  );
  assert.ok(expected.length >= 10, "the catalogue parsed to almost nothing");
  for (const c of expected) {
    assert.ok(row(r, c.label), `no palette row for “${c.label}”`);
  }

  // plus the rows that are operations rather than views, so they have no
  // catalogue entry to be read off
  for (const label of [
    "Open today's journal",
    "Browse the vault's past",
    "Keyboard shortcuts",
    "Assign keys to sidebar rows…",
  ]) {
    assert.ok(row(r, label), `no palette row for “${label}”`);
  }
});

test("saved views, tag folders and tags are destinations", async (t) => {
  const r = await openPalette(t, freshCalls());

  // the sixth saved view — past ⌘5…⌘9, so the palette is its only route
  assert.ok(row(r, "Go to Sixth pin"), "a saved view has no palette row");
  assert.ok(row(r, "Go to Gear"), "a tag folder has no palette row");
  assert.ok(row(r, "#field"), "a tag has no palette row");
});

test("a saved-view row opens the view a sidebar pin opens", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  await r.click(row(r, "Go to Sixth pin")!);
  assert.deepEqual(calls.views, [{ kind: "saved", id: "sv-six" }]);
});

test("a tag row opens that tag's collection", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  await r.click(row(r, "#field")!);
  assert.deepEqual(calls.views, [{ kind: "tag", tag: "field" }]);
});

test("a database row takes the open-a-database door, not the view directly", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  // the door is the whole point: a mounted folder's name IS a database type,
  // and only App's own opener knows to land on the mount instead
  await r.click(row(r, "Go to Samples")!);
  assert.deepEqual(calls.dbs, ["samples"]);
  assert.deepEqual(calls.views, [], "the row set the database view behind the opener's back");
});

test("the search row opens the pane through its own door, seeding nothing", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  // not setView({kind:"search"}): that door stashes the view Esc returns to.
  // And no seed at all — an empty-string seed would CLEAR the last search,
  // where the ⌘⇧F this row prints leaves it standing.
  await r.click(row(r, "Search notes")!);
  assert.deepEqual(calls.search, [undefined]);
  assert.deepEqual(calls.views, []);
});

test("time travel and the key rows go to their handlers", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  await r.click(row(r, "Browse the vault's past")!);
  assert.equal(calls.timeTravel, 1);
});

test("no time-travel row while a past state is already on screen", async (t) => {
  const r = await openPalette(t, freshCalls(), { onOpenTimeTravel: null });

  // paired with a positive assertion: an empty render satisfies absence alone
  assert.ok(row(r, "Go to Today"), "the palette did not render at all");
  assert.equal(row(r, "Browse the vault's past"), null);
});

test("the key rows are absent where their overlays are (mobile)", async (t) => {
  const r = await openPalette(t, freshCalls(), { onOpenShortcuts: null, onAssignKeys: null });

  assert.ok(row(r, "Go to Today"), "the palette did not render at all");
  assert.equal(row(r, "Keyboard shortcuts"), null);
  assert.equal(row(r, "Assign keys to sidebar rows…"), null);
});

test("the print row appears only where the surface can print itself", async (t) => {
  // ⌘P opens the palette on every surface; only the printable ones may
  // answer it with a print row
  const plain = await openPalette(t, freshCalls());
  assert.ok(row(plain, "Go to Today"), "the palette did not render at all");
  assert.equal(row(plain, "Print…"), null);

  let printed = 0;
  const r = await openPalette(t, freshCalls(), { onPrint: () => (printed += 1) });
  const printRow = row(r, "Print…");
  assert.ok(printRow, "no print row on a surface that prints");
  await r.click(printRow);
  assert.equal(printed, 1, "the print row did not run the surface's print action");
});

test("keycaps come from the shortcut registry, spelled its way", async (t) => {
  // the terminal rows are desktop-only, and they carry one of the keycaps —
  // enabled here so every derived cap in the palette is under a render
  const r = await openPalette(t, freshCalls(), { onToggleTerminal: () => {} });
  const hint = (label: string) => row(r, label)?.querySelector(".palette-hint")?.textContent;

  // the drift this replaced: the redo row printed ⇧⌘Z, the sheet ⌘⇧Z
  assert.equal(hint("Redo Role → booking"), "⌘⇧Z");
  assert.equal(hint("Undo Role → booking"), "⌘Z");
  assert.equal(hint("Go to Calendar"), "⌘4");
  assert.equal(hint("Open today's journal"), "⌘D");
  assert.equal(hint("Keyboard shortcuts"), "⌘/");
  assert.equal(hint("Toggle terminal"), "⌘⇧T");
  assert.equal(hint("New note…"), "⌘N");
  assert.equal(hint("Settings…"), "⌘,");
});


test("“New dashboard…” picks a kind and creates that kind's note", async (t) => {
  const calls = freshCalls();
  const r = await openPalette(t, calls);

  // the whole path the docs used to spell as "new note, then hand-set two
  // frontmatter props": a command, a kind, a note
  await r.click(row(r, "New dashboard…")!);
  const tasksRow = row(r, "New Tasks dashboard…");
  assert.ok(tasksRow, "the kind picker offers no tasks board");
  await r.click(tasksRow);

  // no title typed: the row names the default before it is pressed
  const create = row(r, "New dashboard “Tasks”");
  assert.ok(create, "the naming stage does not name the default title");
  await r.click(create);
  assert.deepEqual(calls.dashboards, [["Tasks", "tasks"]]);
});

test("the kind picker offers every kind this build can render", async (t) => {
  const r = await openPalette(t, freshCalls());
  await r.click(row(r, "New dashboard…")!);

  // read off the list, not copied from it — the private kinds are absent from
  // the mirrored tree on both sides at once, which is what the fences are for
  for (const o of NEW_DASHBOARD_KINDS) {
    assert.ok(row(r, `New ${o.title} dashboard…`), `no picker row for “${o.kind}”`);
  }
});
