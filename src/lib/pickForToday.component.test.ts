/** The Today capture line and the Tasks row menu, rendered for real through
    the component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The line was free text only: the one way to put an existing task on today
    was to retype its title, which minted a second note saying the same thing.
    These pin the three decisions that fix costs — that a suggestion PICKS the
    note it names rather than creating one, that plain text still creates
    exactly as it did, and that a row on the Tasks board can reach the same
    verb from a right-click. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { TODAY_PROP } from "./today.ts";
import { todayIso } from "./dates.ts";

const SCHEMA: SchemaConfig = {};

function task(title: string, props: Record<string, unknown> = {}): NoteMeta {
  return {
    path: `Tasks/${title}.md`,
    stem: title,
    title,
    folder: "Tasks",
    props: { type: "task", status: "todo", created: "2026-07-01", ...props },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [task("Mix bounce"), task("Remix notes"), task("File receipts")];

/* The pick assertions run against the mock vault, not a spy: what the verb
   owes is a `today` prop on the note that already existed and no second note
   beside it, and only the vault can answer both. */
const PICK_PATH = "Quick Add Fixture.md";
/** a second open task, never picked, so the last test still has something to
    be offered after the pick test has taken the first one off the day. Named
    to sort AFTER the fixture: the list is ordered by title, and the keyboard
    walk in the pick test starts at the top of it. */
const SPARE_PATH = "Quick Add Spare.md";
/** the one hit behind the keyboard-walk and the dismissal tests: each types a
    query only this task matches, so the list is genuinely open when the walk
    steps back out of it or Escape puts it away. */
const WALK_PATH = "Quick Add Wrapstop.md";
const ESC_PATH = "Quick Add Undone.md";
/** a task already carrying today's pick — the row menu must say so and stay
    inert rather than write the same day twice. */
const DONE_PATH = "Quick Add Committed.md";
let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Weight Log.md", PICK_PATH);
  win.__mockEditProp(PICK_PATH, "type", "task");
  win.__mockEditProp(PICK_PATH, "status", "todo");
  win.__mockEditProp(PICK_PATH, TODAY_PROP, null);
  win.__mockCloneNote("Weight Log.md", SPARE_PATH);
  win.__mockEditProp(SPARE_PATH, "type", "task");
  win.__mockEditProp(SPARE_PATH, "status", "todo");
  win.__mockEditProp(SPARE_PATH, TODAY_PROP, null);
  for (const path of [WALK_PATH, ESC_PATH, DONE_PATH]) {
    win.__mockCloneNote("Weight Log.md", path);
    win.__mockEditProp(path, "type", "task");
    win.__mockEditProp(path, "status", "todo");
    win.__mockEditProp(path, TODAY_PROP, path === DONE_PATH ? todayIso() : null);
  }
});

const vaultNotes = async (): Promise<NoteMeta[]> => {
  const { vaultList } = await import("./ipc.ts");
  return vaultList();
};

/** Type into a field — the harness synthesizes clicks only, so the value goes
    in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

interface Calls {
  picked: string[];
  added: string[];
}

async function today(t: Parameters<typeof renderComponent>[0], notes = NOTES) {
  const { default: TodayPane } = await import("../components/TodayPane.tsx");
  const calls: Calls = { picked: [], added: [] };
  const r = await renderComponent(
    t,
    h(TodayPane as never, {
      notes,
      schema: SCHEMA,
      icons: {},
      onOpenNote: () => {},
      onOpenJournal: () => {},
      onMutated: () => {},
      onRowContextMenu: () => {},
    } as never)
  );
  const field = r.one(".today-add-input");
  assert.ok(field, "the capture line is on screen");
  return { r, field, calls };
}

test("typing offers the open tasks that match, and nothing when none do", async (t) => {
  const { r, field } = await today(t);

  assert.equal(r.all(".today-suggest-row").length, 0, "an untouched line offers nothing");

  await type(field, "mix");
  assert.deepEqual(
    r.all(".today-suggest-row").map((el) => el.textContent?.replace("Pick", "").trim()),
    ["Mix bounce", "Remix notes"]
  );

  // a query nothing matches draws no panel at all — an empty box flashing at
  // every keystroke is worse than a line that stays quiet
  await type(field, "sausage");
  assert.equal(r.one(".today-suggest"), null);
  assert.equal((field as HTMLInputElement).getAttribute("aria-expanded"), "false");
});

test("Escape drops the suggestions without losing the typed thought", async (t) => {
  const { r, field } = await today(t);
  await type(field, "mix");
  assert.ok(r.one(".today-suggest"));

  await press(field, "Escape");
  assert.equal(r.one(".today-suggest"), null);
  assert.equal((field as HTMLInputElement).value, "mix");
});

test("arrowing to a suggestion and committing picks that note, never a copy", async (t) => {
  const before = await vaultNotes();
  const fixture = before.find((n) => n.path === PICK_PATH);
  assert.ok(fixture, "the fixture task is in the vault");
  assert.equal(fixture.props[TODAY_PROP], undefined, "and starts unpicked");

  const { r, field } = await today(t, before);
  const form = r.one(".today-add");
  assert.ok(form);

  await type(field, fixture.title.slice(0, 5).toLowerCase());
  await press(field, "ArrowDown");
  const selected = r.one(".today-suggest-row.selected");
  assert.ok(selected, "the first arrow lands on the first suggestion");
  assert.match(selected.textContent ?? "", new RegExp(fixture.title));
  // the commit button says what Enter will do now
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Pick/);

  await submit(form);
  await r.settle();

  const after = await vaultNotes();
  // the pick is a prop write on the note that already existed…
  assert.equal(after.find((n) => n.path === PICK_PATH)?.props[TODAY_PROP], todayIso());
  // …and nothing was created beside it
  assert.equal(after.length, before.length);
  assert.equal(
    after.filter((n) => n.title === fixture.title).length,
    1,
    "no second note carrying the same title"
  );
  // the line clears and the panel closes, as a committed capture does
  assert.equal((field as HTMLInputElement).value, "");
  assert.equal(r.one(".today-suggest"), null);
});

test("pressing the commit button cannot lose the highlight on the way down", async (t) => {
  const { r, field } = await today(t);
  await type(field, "mix");
  await press(field, "ArrowDown");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Pick/);

  // Leaving the line puts the panel away, and a panel put away has taken the
  // highlight with it — so the button must refuse the focus its press would
  // otherwise steal, or the click that says "pick" arrives at a line that has
  // forgotten which note, and creates one instead.
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => {
    r.one(".today-add-act")?.dispatchEvent(down);
  });
  assert.equal(down.defaultPrevented, true, "the press does not blur the line");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Pick/);
});

test("plain text with no suggestion highlighted still commits as a create", async (t) => {
  const before = await vaultNotes();
  const { r, field } = await today(t, before);
  const form = r.one(".today-add");
  assert.ok(form);

  // a query that matches nothing: the line is exactly the free-text field it
  // has always been
  const fresh = `Call the mastering house ${Date.now()}`;
  await type(field, fresh);
  assert.equal(r.one(".today-suggest"), null);
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Add/);
  assert.equal((r.one(".today-add-act") as HTMLButtonElement).disabled, false);

  await submit(form);
  await r.settle();

  const after = await vaultNotes();
  const made = after.find((n) => n.title === fresh);
  assert.ok(made, "the typed thought became a note");
  // born already picked, exactly as the line has always created
  assert.equal(made.props[TODAY_PROP], todayIso());
  assert.equal(after.length, before.length + 1);
  assert.equal((field as HTMLInputElement).value, "", "and the line clears");
});

test("a matching query still commits as text while nothing in the list is chosen", async (t) => {
  const before = await vaultNotes();
  const { r, field } = await today(t, before);
  const form = r.one(".today-add");
  assert.ok(form);

  // typing "mix" and pressing Enter means the NEW thought, not the old task:
  // the suggestions are an offer, and an offer not taken changes nothing
  // a substring of an open task's title, so the list is genuinely open —
  // and a title in its own right, so committing it is a real create
  const fresh = "Quick";
  await type(field, fresh);
  assert.ok(r.one(".today-suggest"), "the suggestions are there to be ignored");
  assert.equal(r.one(".today-suggest-row.selected"), null);
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Add/);

  await submit(form);
  await r.settle();

  const after = await vaultNotes();
  assert.ok(after.find((n) => n.title === fresh), "the typed title became its own note");
  assert.equal(after.length, before.length + 1);
});

test("a composing IME keeps the arrows and Escape to itself", async (t) => {
  const { r, field } = await today(t);
  await type(field, "mix");

  // a CJK candidate window is up: these keys belong to it, and a dropdown that
  // takes them walks its own list while the half-composed word dies
  await press(field, "ArrowDown", { isComposing: true });
  assert.equal(r.one(".today-suggest-row.selected"), null, "the highlight never moved");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Add/);
  await press(field, "Escape", { isComposing: true });
  assert.ok(r.one(".today-suggest"), "and the panel is still there");

  // composition over, the same keys do what they always did
  await press(field, "ArrowDown");
  assert.ok(r.one(".today-suggest-row.selected"), "the walk works once the IME is done");
});

test("arrowing back out of the list returns the line to plain text", async (t) => {
  const before = await vaultNotes();
  const walk = before.find((n) => n.path === WALK_PATH);
  assert.ok(walk, "the walk fixture is in the vault");

  const { r, field } = await today(t, before);
  const form = r.one(".today-add");
  assert.ok(form);

  // one hit, so the walk is: no selection → the hit → no selection again. The
  // wrap exists so the list can be left without leaving the line
  const typed = "wrapstop";
  await type(field, typed);
  assert.equal(r.all(".today-suggest-row").length, 1);
  await press(field, "ArrowDown");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Pick/);

  await press(field, "ArrowUp");
  assert.equal(r.one(".today-suggest-row.selected"), null, "the highlight is off the list");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Add/, "and Enter creates again");

  await submit(form);
  await r.settle();

  const after = await vaultNotes();
  assert.ok(after.find((n) => n.title === typed), "the typed thought became its own note");
  assert.equal(after.length, before.length + 1);
  // the task the walk passed through was never touched
  assert.equal(after.find((n) => n.path === WALK_PATH)?.props[TODAY_PROP], undefined);
});

test("dismissing the list leaves Enter committing the typed text", async (t) => {
  const before = await vaultNotes();
  const { r, field } = await today(t, before);
  const form = r.one(".today-add");
  assert.ok(form);

  const typed = "undone";
  await type(field, typed);
  assert.ok(r.one(".today-suggest"), "the offer is up");
  await press(field, "Escape");
  assert.equal(r.one(".today-suggest"), null, "Esc put it away");

  await submit(form);
  await r.settle();

  const after = await vaultNotes();
  assert.ok(after.find((n) => n.title === typed), "Enter created the new thought");
  assert.equal(after.length, before.length + 1);
  assert.equal(after.find((n) => n.path === ESC_PATH)?.props[TODAY_PROP], undefined);
});

test("a refused pick keeps the typed thought on the line", async (t) => {
  const before = await vaultNotes();
  // a task the pane can see but the vault cannot write — the same shape as a
  // sealed or vanished note: the write refuses, and the line must still hold
  // what was typed so the thought can go somewhere else
  const ghost: NoteMeta = task("Ghostly errand");
  const { r, field } = await today(t, [...before, ghost]);
  const form = r.one(".today-add");
  assert.ok(form);

  await type(field, "ghostly");
  await press(field, "ArrowDown");
  assert.match(r.one(".today-add-act")?.textContent ?? "", /Pick/);

  await submit(form);
  await r.settle();

  assert.equal((field as HTMLInputElement).value, "ghostly", "the typed text survived");
  const after = await vaultNotes();
  assert.equal(after.length, before.length, "and nothing was created in its place");
});

/* The Tasks board's half of the same verb. */

async function board(t: Parameters<typeof renderComponent>[0], notes: NoteMeta[]) {
  const { default: TasksDashboard } = await import("../components/TasksDashboard.tsx");
  return renderComponent(
    t,
    h(TasksDashboard as never, {
      meta: {
        path: "Dashboards/Tasks.md",
        stem: "Tasks",
        title: "Tasks",
        folder: "Dashboards",
        props: { type: "dashboard", dashboard: "tasks" },
        updated_ms: 0,
        excerpt: "",
        sealed: false,
      },
      notes,
      schema: SCHEMA,
      onOpenSource: () => {},
      onMutated: () => {},
    } as never)
  );
}

test("right-clicking a task row offers Pick for today, and it writes the day", async (t) => {
  const before = await vaultNotes();
  const target = before.find((n) => n.path === SPARE_PATH);
  assert.ok(target, "the spare task is in the vault");
  assert.equal(target.props[TODAY_PROP], undefined, "and starts unpicked");

  const r = await board(t, before);

  const row = r
    .all(".tasks-row")
    .find((el) => el.getAttribute("data-task-path") === SPARE_PATH);
  assert.ok(row, "the task has a row on the board");
  assert.equal(document.querySelector(".ctx-menu"), null, "no menu until asked for");

  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });

  const items = [...document.querySelectorAll(".ctx-item")];
  assert.ok(items.length > 0, "the right-click opened a menu");
  const pick = items.find((el) => (el.textContent ?? "").includes("Pick for today"));
  assert.ok(pick, "and the menu leads with the day's verb");
  assert.equal(items[0], pick, "Pick is the first item");

  await act(async () => {
    pick.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await r.settle();

  const after = await vaultNotes();
  assert.equal(after.find((n) => n.path === SPARE_PATH)?.props[TODAY_PROP], todayIso());
  // the board picks the task it already has — it never mints a second one
  assert.equal(after.length, before.length);
});

test("the ContextMenu key reaches the row menu without a pointer", async (t) => {
  const before = await vaultNotes();
  const r = await board(t, before);
  const row = r.all(".tasks-row").find((el) => el.getAttribute("data-task-path") === WALK_PATH);
  assert.ok(row, "the task has a row on the board");
  // the row says out loud what summons its menu, as the card does
  assert.equal(row.getAttribute("role"), "group");
  assert.equal(row.getAttribute("aria-label"), "Quick Add Wrapstop");
  assert.equal(row.getAttribute("aria-keyshortcuts"), "Shift+F10");
  assert.equal(document.querySelector(".ctx-menu"), null, "no menu until asked for");

  await press(row, "ContextMenu");
  assert.match(
    [...document.querySelectorAll(".ctx-item")][0]?.textContent ?? "",
    /Pick for today/,
    "the key opened the same menu the right-click does"
  );

  // Shift+F10 is the other spelling of that key, for keyboards without it
  const menu = document.querySelector(".ctx-menu");
  assert.ok(menu, "the menu took the focus, so Escape is its own");
  await press(menu, "Escape");
  assert.equal(document.querySelector(".ctx-menu"), null, "and put it away again");
  await press(row, "F10", { shiftKey: true });
  assert.match(
    [...document.querySelectorAll(".ctx-item")][0]?.textContent ?? "",
    /Pick for today/,
    "and so does Shift+F10"
  );
});

test("a task already picked offers the unpick, and it clears the pick", async (t) => {
  const before = await vaultNotes();
  const committed = before.find((n) => n.path === DONE_PATH);
  assert.ok(committed, "the committed fixture is in the vault");
  assert.equal(committed.props[TODAY_PROP], todayIso(), "and starts picked for today");

  const r = await board(t, before);
  const row = r.all(".tasks-row").find((el) => el.getAttribute("data-task-path") === DONE_PATH);
  assert.ok(row, "the picked task still has a row on the board");

  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });

  // one mark means one toggle: a picked row's menu leads with the undo of the
  // verb, live — not a spent "Pick for today" sitting there disabled
  const unpick = [...document.querySelectorAll(".ctx-item")][0];
  assert.match(unpick?.textContent ?? "", /Unpick from today/);
  assert.ok(!unpick?.classList.contains("disabled"), "the undo is a live verb");

  await act(async () => {
    unpick?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await r.settle();

  const after = await vaultNotes();
  assert.equal(
    after.find((n) => n.path === DONE_PATH)?.props[TODAY_PROP],
    undefined,
    "the unpick cleared the day's mark"
  );
  assert.equal(after.length, before.length, "and wrote nothing else");
});
