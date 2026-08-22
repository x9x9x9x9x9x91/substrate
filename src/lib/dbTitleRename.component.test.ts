/** The table's Name cell, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A plain click on a Name cell used to open the note's foldout, which made
    the Name column the one column in the table you could not simply type
    into: renaming meant finding the rename dialog. The click now edits in
    place like every other cell, and the foldout answers to double-click and
    Enter instead. Three things have to hold together for that to be true, and
    none of them is reachable from tsc:

      1. the two gestures must not fight — the double-click's first click
         opens the editor, and the pair still has to open the note;
      2. a commit must ride the vault's rename (the file follows the title and
         every link to it is rewritten), never a prop write, and the foldout
         Enter asks for must be the note's NEW path;
      3. the selection gesture (a modified click) and the read-only case must
         come out of it unchanged.

    And because the Name cell now edits like every other column, it inherits
    the rest of that column's grammar: a double-click INSIDE the open editor
    is the text field's select-a-word and not the foldout's gesture, a bare
    letter typed at a focused name starts the rename instead of moving focus,
    and Tab carries the editor on to the neighbouring cell. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Task";

const SCHEMA = {
  Stage: { options: [{ value: "live" }] },
} as unknown as Record<string, PropSchema>;

function row(title: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: DB, Stage: "live" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [row("Ivo"), row("Vesna")];

/** DatabasePane's required props, with everything these tests don't drive
    inert — built loosely on purpose (same reasoning as the sub-item fold
    harness): the pane takes some thirty callbacks, and naming them all would
    pin the prop list rather than the behaviour. */
function paneProps(over: Record<string, unknown>): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "table" },
    typeSchema: SCHEMA,
    schema: { [DB]: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: [DB],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onPrefChange: () => {},
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

/** what the pane was asked to do, in the order it asked */
interface Spies {
  opened: string[];
  renamed: [string, string][];
}

function spies(): Spies {
  return { opened: [], renamed: [] };
}

/** a rename that succeeds: the note lands at the path its new title makes */
function renameProps(s: Spies, over: Record<string, unknown> = {}): Record<string, unknown> {
  return paneProps({
    onOpenNote: (p: string) => s.opened.push(p),
    onRenameNote: (p: string, title: string) => {
      s.renamed.push([p, title]);
      return Promise.resolve({ ...row(title) });
    },
    ...over,
  });
}

const titleCell = (r: { all(s: string): Element[] }, i: number): Element => r.all("td.db-title")[i];

/** the harness's own click carries no modifier — a modified one is the
    pane's selection gesture, and a double-click is its own event */
async function mouse(el: Element, kind: string, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, ...init }));
  });
}

async function typeInto(el: Element, value: string): Promise<void> {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

/** the pane's keyboard surface is bound to the window, the way App hands it over */
async function pressWindow(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

/** focus a Name cell without leaving its editor open: the click focuses and
    opens, Escape drops the editor and the focus ring stays */
async function focusName(r: Awaited<ReturnType<typeof renderComponent>>, i: number): Promise<void> {
  await r.click(titleCell(r, i));
  await press(r.one("td.db-title input")!, "Escape");
  await r.settle();
}

test("a plain click on a Name cell opens the rename editor and not the note", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  assert.deepEqual(s.opened, [], "the foldout stayed shut");
  const input = r.one("td.db-title input");
  assert.ok(input, "the Name cell is editing in place");
  assert.equal((input as HTMLInputElement).value, "Ivo", "seeded with the title it is renaming");
});

test("a double-click opens the note and drops the editor its first click opened", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  await mouse(titleCell(r, 0), "dblclick");
  await r.settle();
  assert.deepEqual(s.opened, ["Ivo.md"], "the second click opened the note");
  assert.deepEqual(s.renamed, [], "a dropped draft never writes");
  assert.equal(r.one("td.db-title input"), null, "the editor went with it");
});

test("Enter commits the rename through the vault and opens the note it moved to", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  const input = r.one("td.db-title input")!;
  await typeInto(input, "Ivo Andrić");
  await press(input, "Enter");
  await r.settle();

  assert.deepEqual(s.renamed, [["Ivo.md", "Ivo Andrić"]], "the vault owns the rename");
  assert.deepEqual(s.opened, ["Ivo Andrić.md"], "and the foldout follows the note that moved");
});

test("an empty title is refused and Escape reverts, both without a write", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  await typeInto(r.one("td.db-title input")!, "   ");
  await press(r.one("td.db-title input")!, "Enter");
  await r.settle();
  assert.deepEqual(s.renamed, [], "a blank name is a refusal, as in the rename dialog");

  await r.click(titleCell(r, 1));
  await typeInto(r.one("td.db-title input")!, "Vesna Parun");
  await press(r.one("td.db-title input")!, "Escape");
  await r.settle();
  assert.deepEqual(s.renamed, [], "Escape throws the draft away");
  assert.equal(r.one("td.db-title input"), null, "and closes the editor");
  assert.match(r.text(), /Vesna/, "the row keeps the name it had");
});

test("Enter on a focused Name cell that is not editing opens the note", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  // click to focus, Escape to leave the editor — the cell keeps the focus ring
  await r.click(titleCell(r, 1));
  await press(r.one("td.db-title input")!, "Escape");
  await r.settle();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await r.settle();
  assert.deepEqual(s.opened, ["Vesna.md"], "the keyboard route into the foldout is intact");
});

test("a modified click still selects, and never edits", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await mouse(titleCell(r, 0), "click", { metaKey: true });
  await mouse(titleCell(r, 1), "click", { metaKey: true });
  await r.settle();
  assert.match(r.text(), /2 selected/, "the selection gesture is unchanged");
  assert.equal(r.one("td.db-title input"), null, "and it opened no editor");
  assert.deepEqual(s.opened, [], "nor the foldout");
});

test("with nothing to rename the click keeps opening the note, as it always did", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  // a mounted folder's files are read-only: the pane is handed no rename route
  const props = renameProps(s, { onRenameNote: undefined });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await r.click(titleCell(r, 0));
  assert.equal(r.one("td.db-title input"), null, "no editor where nothing can be renamed");
  // the gesture is only worth moving where it buys a rename — on a mounted
  // folder it would buy nothing, and a dead click is the worse trade
  assert.deepEqual(s.opened, ["Ivo.md"], "so the click still opens the file");
});

test("F2 and type-to-replace open the Name editor, like every other column", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  // click to focus, Escape to leave the editor — the cell keeps the focus ring
  await r.click(titleCell(r, 0));
  await press(r.one("td.db-title input")!, "Escape");
  await r.settle();

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  await r.settle();
  assert.equal(
    (r.one("td.db-title input") as HTMLInputElement | null)?.value,
    "Ivo",
    "F2 edits in place, on the name it already has"
  );

  await press(r.one("td.db-title input")!, "Escape");
  await r.settle();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "N", bubbles: true }));
  });
  await r.settle();
  assert.equal(
    (r.one("td.db-title input") as HTMLInputElement | null)?.value,
    "N",
    "a printable key replaces the title and starts the draft with itself"
  );
  assert.deepEqual(s.opened, [], "neither opener is the foldout's");
});

test("clicking away commits the draft without opening the note", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  const input = r.one("td.db-title input")!;
  await typeInto(input, "Ivo Andrić");
  // React listens for the bubbling `focusout`, not `blur`
  await act(async () => {
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
  });
  await r.settle();

  assert.deepEqual(s.renamed, [["Ivo.md", "Ivo Andrić"]], "leaving the cell keeps the typing");
  assert.deepEqual(s.opened, [], "but only Enter and the double-click open the foldout");
  assert.equal(r.one("td.db-title input"), null, "and the editor closed behind it");
});

test("a double-click inside the open editor selects a word and keeps the draft", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  const input = r.one("td.db-title input")!;
  await typeInto(input, "Ivo Andrić");
  // the gesture every text field has: two clicks inside the field to select
  // the word under them, so it can be corrected
  await mouse(input, "click");
  await mouse(input, "click");
  await mouse(input, "dblclick");
  await r.settle();

  assert.deepEqual(s.opened, [], "the foldout is not what a double-click in a field means");
  assert.deepEqual(s.renamed, [], "and nothing was committed behind it");
  assert.equal(
    (r.one("td.db-title input") as HTMLInputElement | null)?.value,
    "Ivo Andrić",
    "the typing is still there to correct"
  );
});

test("a bare letter at a focused name starts the rename on THAT row", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  // h/j/k/l are vim nav on surfaces with no editor under the focus; on a Name
  // cell that renames in place they are the first letter of the new name.
  // Typing `kick` here used to move focus up a row and rename the row above.
  await focusName(r, 1);
  await pressWindow("k");
  await r.settle();
  const editing = titleCell(r, 1).querySelector("input") as HTMLInputElement | null;
  assert.equal(editing?.value, "k", "the keystroke opened the editor carrying itself");
  assert.equal(titleCell(r, 0).querySelector("input"), null, "and never on the row above");

  // Option is a character modifier on macOS: ⌥L types `@` on a German layout,
  // and a name may start with one as readily as a property value may
  await press(editing!, "Escape");
  await r.settle();
  await pressWindow("@", { altKey: true });
  await r.settle();
  assert.equal(
    (titleCell(r, 1).querySelector("input") as HTMLInputElement | null)?.value,
    "@",
    "an Option chord opens the name editor like it opens a cell's"
  );
  assert.deepEqual(s.opened, [], "neither keystroke is the foldout's");
});

test("with no rename behind it the Name column stays a nav surface", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const props = renameProps(s, { onRenameNote: undefined });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  // the click opens the file there, which also focuses the cell it opened
  await r.click(titleCell(r, 0));
  await r.settle();
  await pressWindow("j");
  await r.settle();
  assert.ok(
    titleCell(r, 1).className.includes("focused"),
    "j still moves down where there is no editor to type into"
  );
  await pressWindow("N");
  await r.settle();
  assert.equal(r.one("td.db-title input"), null, "and a printable key opens nothing");
});

test("Tab carries the Name editor on to the next cell, and Shift-Tab back into it", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const r = await renderComponent(t, h(DatabasePane as never, renameProps(s) as never));

  await r.click(titleCell(r, 0));
  await press(r.one("td.db-title input")!, "Tab");
  await r.settle();
  assert.equal(r.one("td.db-title input"), null, "the name editor closed behind the Tab");
  assert.deepEqual(s.renamed, [], "an untouched name is not a rename");
  const landed = r.one("td.db-cell.editing");
  assert.ok(landed, "and the first data cell of the row took the editor");
  assert.equal(
    (landed as HTMLElement).dataset.fc,
    "1",
    "the neighbour, not some other cell"
  );

  // a data cell's editor is a menu anchored to it, rendered through a portal
  // into the body rather than inside the <td> — the cell carries the class,
  // the field itself lives outside the render's container
  const cellEditor = document.querySelector(".selmenu-input");
  assert.ok(cellEditor, "with its field open and ready to type into");

  await press(cellEditor!, "Tab", { shiftKey: true });
  await r.settle();
  assert.equal(
    (titleCell(r, 0).querySelector("input") as HTMLInputElement | null)?.value,
    "Ivo",
    "Shift-Tab out of the first data column re-opens the name it came from"
  );
  assert.deepEqual(s.opened, [], "no part of the traversal opens the foldout");
});

test("a refused rename hands the typed name back instead of dropping it", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const s = spies();
  const props = renameProps(s, {
    onRenameNote: (p: string, title: string) => {
      s.renamed.push([p, title]);
      return Promise.reject(new Error("a note by that name is already there"));
    },
  });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await r.click(titleCell(r, 0));
  await typeInto(r.one("td.db-title input")!, "Vesna");
  await press(r.one("td.db-title input")!, "Enter");
  await r.settle();

  assert.deepEqual(s.renamed, [["Ivo.md", "Vesna"]], "the vault was asked, and refused");
  assert.equal(
    (r.one("td.db-title input") as HTMLInputElement | null)?.value,
    "Vesna",
    "the name that was refused is still there to correct or drop"
  );
  assert.deepEqual(s.opened, [], "and a rename that never landed opens nothing");
});
