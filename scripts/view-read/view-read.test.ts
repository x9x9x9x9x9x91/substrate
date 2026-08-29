/** The headless verb, and the guarantee it exists for.
 *
 *  The component test next to the evaluator already pins pane == evaluator.
 *  What it cannot reach is the part that only exists out here: a FOLDER
 *  becoming rows. So the last test in this file writes a vault to disk,
 *  renders the real database pane over the notes this reader projected from
 *  those files, runs the CLI as its own process over the same folder, and
 *  asserts the painted table and the printed JSON are the same view — same
 *  columns, same order, same cells.
 *
 *  A change that made the CLI report something the screen does not show
 *  fails here, whichever side moved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h, type FunctionComponent } from "react";
import { markdown, NoVaultError, parseArgs, pickView, run, UsageError } from "./view-read.ts";
import { nthViewFence, run as engineRun, type DoorPayload, type EngineResponse } from "./viewengine.ts";
import { makeExcerpt, noteTags, parseProps, readVault, splitFrontmatter } from "./vaultread.ts";
import { mockBackend, renderComponent, type Rendered } from "../../src/lib/componentHarness.ts";
import { evaluateSavedView, savedViewPref } from "../../src/lib/vieweval.ts";
import { embedQueryFor, parseViewSpec } from "../../src/lib/embeds.ts";
import type { SavedView } from "../../src/lib/types.ts";

const CLI = fileURLToPath(new URL("./view-read.ts", import.meta.url));
const TODAY = "2026-08-18";

const NOTE_FILES: Record<string, string> = {
  "Tasks/Master the EP.md":
    "---\ntype: task\nstatus: todo\ndue: 2026-09-01\nbudget: 1200\nowner: Sam\ntags:\n  - studio\n  - mix\n---\nMastering pass over the whole EP. #deadline\n",
  "Tasks/Mix vocals.md":
    "---\ntype: task\nstatus: doing\ndue: 2026-08-01\nbudget: 300.5\nowner: Ada\n---\nVocal comp, then rides.\n",
  "Tasks/Book the room.md":
    "---\ntype: task\nstatus: todo\ndue: 2026-08-20\nbudget: 80\nowner: Sam\n---\nRoom for the session.\n",
  "Tasks/Sleeve art.md": "---\ntype: task\nbudget: 40\nowner: Rob\n---\nArtwork direction still open.\n",
  "Tasks/Shipped.md": "---\ntype: task\nstatus: done\nbudget: 9\nowner: Sam\n---\nAlready out.\n",
  // a colon in the title is why the engine writes a `title:` prop at all
  "Tasks/Vessel Songs Live.md":
    "---\ntype: task\ntitle: 'Vessel: Songs/Live'\nstatus: todo\ndue: 2026-08-19\nbudget: 250\nowner: Ada\n---\nLive set prep.\n",
  // another database entirely: it must never reach a task view's rows
  "People/Rob.md": "---\ntype: contact\nstatus: todo\n---\nSleeve artist.\n",
};

const SCHEMA_JSON = JSON.stringify({
  task: {
    icon: { glyph: "check", tint: "teal" },
    home: "Tasks",
    status: {
      options: [
        { value: "doing", color: "blue" },
        { value: "todo", color: "grey" },
        { value: "done" },
      ],
    },
    due: { options: [], kind: "date" },
    budget: { options: [], kind: "number", format: "euro" },
    owner: { options: [], kind: "text" },
  },
});

const OPEN_TASKS: SavedView = {
  id: "open-tasks",
  name: "Open tasks",
  db: "task",
  query: "-status:done",
  sorts: [{ key: "due", dir: 1 }],
  view: "table",
  table_group_by: "status",
};

const BY_OWNER: SavedView = {
  id: "by-owner",
  name: "By owner",
  db: "task",
  sorts: [{ key: "owner", dir: 1 }],
  columns: ["owner", "budget"],
  view: "table",
};

const VIEWS_JSON = JSON.stringify({
  // the database's own remembered sort, which a pin must NOT inherit — and
  // its curation (a dragged column order, hidden columns), which a pin must
  // not inherit either: a pin is a capture of what it was saved with
  task: {
    view: "table",
    sorts: [{ key: "budget", dir: -1 }],
    col_order: ["owner", "budget", "due", "status"],
    hidden: ["due"],
    hidden_per_layout: { table: ["budget"], list: [] },
  },
  $sidebar: { pins: ["Tasks/Sleeve art.md"] },
  $views: [OPEN_TASKS, BY_OWNER],
});

/** A vault on disk, torn down with the test that made it. */
function fixtureVault(t: { after: (fn: () => void) => void }, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-view-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries({ ...NOTE_FILES, ...extra })) {
    const at = rel.lastIndexOf("/");
    if (at > 0) mkdirSync(join(dir, rel.slice(0, at)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  mkdirSync(join(dir, ".vault"), { recursive: true });
  writeFileSync(join(dir, ".vault", "schema.json"), SCHEMA_JSON);
  writeFileSync(join(dir, ".vault", "views.json"), VIEWS_JSON);
  writeFileSync(join(dir, "Settings.md"), "---\nnumber-locale: de-DE\n---\n");
  return dir;
}

test("splitFrontmatter: block at byte 0 or nothing, BOM tolerated", () => {
  assert.deepEqual(splitFrontmatter("---\na: 1\n---\nbody\n"), { fm: "a: 1", body: "body\n" });
  assert.deepEqual(splitFrontmatter("﻿---\na: 1\n---\nbody\n"), { fm: "a: 1", body: "body\n" });
  // no closing fence: the whole file is body and the note has no props
  assert.deepEqual(splitFrontmatter("---\na: 1\nbody"), { fm: "", body: "---\na: 1\nbody" });
  // a block that does not start the file is body text, not frontmatter
  assert.deepEqual(splitFrontmatter("intro\n---\na: 1\n---\n").fm, "");
});

test("parseProps: scalars keep their YAML types, lists parse both spellings", () => {
  const { props, unreadable, rejected } = parseProps(
    [
      "type: task",
      "rating: 4",
      "ratio: 1.5",
      "signed: +5",
      "scaled: 1e3",
      "grouped: 1_000",
      "done: false",
      "quoted: 'a: b'",
      'escaped: "Vessel \\"Live\\""',
      "flow: [one, two]",
      "block:",
      "  - x",
      "  - y",
    ].join("\n")
  );
  assert.deepEqual(unreadable, []);
  assert.equal(rejected, null);
  assert.deepEqual(props, {
    type: "task",
    rating: 4,
    ratio: 1.5,
    // the core schema's own number grammar, which the app's parser resolves
    // and a narrower one would have left as sortable-as-text strings
    signed: 5,
    scaled: 1000,
    // …and the underscore grouping it does NOT resolve: a 1.1 spelling stays
    // the string it is on both sides
    grouped: "1_000",
    done: false,
    quoted: "a: b",
    // a double-quoted scalar is decoded, not passed through with its
    // backslashes, which is what the screen shows
    escaped: 'Vessel "Live"',
    flow: ["one", "two"],
    block: ["x", "y"],
  });
});

test("parseProps: an empty value is an absent prop, the way the app reads it", () => {
  const { props } = parseProps(["type: task", "owner:", "note: ~", "tag: null"].join("\n"));
  // present-and-empty would pass an empty-check and collate first; the app's
  // prop lookup reports these absent, so none of the keys exist here either
  assert.deepEqual(props, { type: "task" });
});

test("parseProps: every line outside the subset is reported, not just the first", () => {
  const { props, unreadable, rejected } = parseProps(
    "type: task\ncards:\n  label: Cash\n  total: 3\nbody: |\n"
  );
  assert.equal(props.type, "task");
  assert.equal(rejected, null);
  assert.equal(unreadable.length, 3, "each unread line names itself");
});

test("parseProps: a list item outside the subset warns, instead of reading as text", () => {
  // the key/value branch already refused these; a LIST item took them
  // literally, so `!secret` became part of the value and the cell showed a
  // string the app never shows, with nothing said
  const { props, unreadable, rejected } = parseProps("type: task\nowner:\n  - !secret foo\n  - Ada");
  assert.equal(rejected, null, "legal YAML this reader lacks is not a broken note");
  assert.deepEqual(props.owner, ["Ada"]);
  assert.ok(
    unreadable.some((u) => u.includes("!secret foo")),
    "the item that could not be read names itself"
  );
});

test("parseProps: a flow list splits on its separators, not on commas inside a value", () => {
  // a comma inside a quoted name used to make three entries out of two, and
  // said nothing — a relation cell then pointed at notes that do not exist
  assert.deepEqual(parseProps('artists: ["Autechre, Sean Booth", Rian]').props.artists, [
    "Autechre, Sean Booth",
    "Rian",
  ]);
  assert.deepEqual(parseProps("artists: ['Bell, Book', Rian]").props.artists, [
    "Bell, Book",
    "Rian",
  ]);
  // an apostrophe inside a plain scalar is a character, not an opening quote
  assert.deepEqual(parseProps("artists: [don't stop, Rian]").props.artists, [
    "don't stop",
    "Rian",
  ]);
  // an escaped quote does not end the entry it sits in
  assert.deepEqual(parseProps('artists: ["a \\"b\\", c", d]').props.artists, ['a "b", c', "d"]);
  // quoting that never closes is a syntax error to the engine too
  assert.ok(parseProps('artists: ["Autechre, Rian]').rejected !== null);
});

test("parseProps: a list of maps is a prop this reader lacks, not a note the app refuses", () => {
  // the metrics dashboard's `cards:` (vault-format §5.4) — a sequence of
  // mappings serde_yaml reads happily. Called `rejected`, it dropped a member
  // the pane still paints from the reader's payload, under a warning claiming
  // the app could not read the note either.
  const { props, unreadable, rejected } = parseProps(
    "type: task\ncards:\n  - label: Cash\n    total: 3\n  - label: Debt\nowner: Sam"
  );
  assert.equal(rejected, null, "the app has this note, so the reader keeps it");
  assert.equal(props.type, "task");
  assert.equal(props.owner, "Sam", "the keys after the list still parse");
  assert.equal(props.cards, undefined, "an unread prop is absent, never half-read");
  assert.ok(
    unreadable.some((u) => u.includes("label: Cash")),
    "the unread lines name themselves"
  );
  // a QUOTED colon in a list item is an ordinary scalar, not a mapping
  assert.deepEqual(parseProps('tags:\n  - "Vessel: Songs"').props.tags, ["Vessel: Songs"]);
});

test("parseProps: a block the app's parser would reject names itself and stops the note", () => {
  for (const fm of [
    "type: task\ntitle: Vessel: Songs/Live",
    "type: task\nowner: @handle",
    "type: task\nkey: *alias",
    "type: task\n\tstatus: todo",
    'type: task\nname: "bad \\q escape"',
  ]) {
    assert.ok(parseProps(fm).rejected !== null, `${fm} must be reported as rejected`);
  }
});

test("makeExcerpt: first non-empty line, markers dropped, capped", () => {
  assert.equal(makeExcerpt("\n\n# Heading\nbody"), "Heading");
  assert.equal(makeExcerpt("- [[Static Bouquet]] artwork"), "Static Bouquet artwork");
  assert.equal(makeExcerpt(`${"x".repeat(130)}\n`), `${"x".repeat(120)}…`);
});

test("noteTags: body tags union prop tags, folded for dedupe, body spelling first", () => {
  assert.deepEqual(noteTags({ tags: ["promo", "Demo"] }, "a #demo note"), ["demo", "promo"]);
  assert.deepEqual(noteTags({ tags: "vinyl, #promo " }, ""), ["vinyl", "promo"]);
  assert.deepEqual(noteTags({}, "see `#notatag` and a #real one"), ["real"]);
});

test("readVault: projects notes the way the index does", (t) => {
  const vault = fixtureVault(t, {
    "Tasks/Sealed.md": "SUBSTRATE-SEALED-1\nopaque bytes\n",
    ".vault/templates/Ignored.md": "---\ntype: task\n---\nhidden path\n",
  });
  const read = readVault(vault);

  const paths = read.notes.map((n) => n.path);
  assert.ok(!paths.some((p) => p.startsWith(".")), "hidden folders stay out of the index");
  // the notes, the sealed one, and Settings.md — the engine indexes the app's
  // own files too and only the notes list conceals them, so a reader that
  // dropped it here would be projecting something the index does not hold
  assert.equal(read.notes.length, Object.keys(NOTE_FILES).length + 2);
  assert.ok(paths.includes("Settings.md"));

  const ep = read.notes.find((n) => n.stem === "Master the EP");
  assert.ok(ep);
  assert.equal(ep.folder, "Tasks");
  assert.equal(ep.props.budget, 1200);
  assert.deepEqual(ep.tags, ["deadline", "studio", "mix"]);

  // the title prop carries what the filename could not
  const vessel = read.notes.find((n) => n.stem === "Vessel Songs Live");
  assert.equal(vessel?.title, "Vessel: Songs/Live");

  const sealed = read.notes.find((n) => n.stem === "Sealed");
  assert.equal(sealed?.sealed, true);
  assert.deepEqual(sealed?.props, {});
  assert.equal(sealed?.excerpt, "", "a sealed note's body never leaves the file");

  assert.equal(read.views.length, 2);
  assert.deepEqual(read.prefs.task?.sorts, [{ key: "budget", dir: -1 }]);
  assert.equal(read.settings["number-locale"], "de-DE");
  assert.equal(read.schema.task?.icon, undefined, "the reserved icon key is not a property");
  assert.equal(read.schema.task?.budget?.format, "euro");
  assert.deepEqual(read.warnings, []);
});

test("readVault: a corrupt config reads as empty rather than refusing the vault", (t) => {
  const vault = fixtureVault(t);
  writeFileSync(join(vault, ".vault", "views.json"), "{ not json");
  const read = readVault(vault);
  assert.deepEqual(read.views, []);
  assert.ok(read.notes.length > 0);
});

test("parseArgs: the verb's surface", () => {
  assert.deepEqual(parseArgs(["Open tasks", "--format", "md"]).name, "Open tasks");
  assert.equal(parseArgs(["--view", "Open tasks"]).name, "Open tasks");
  assert.equal(parseArgs(["--list"]).list, true);
  assert.throws(() => parseArgs(["--format", "csv"]), UsageError);
  assert.throws(() => parseArgs(["--today", "yesterday"]), UsageError);
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  // a forgotten path is a mistake to name, not a vault called `--list`
  assert.throws(() => parseArgs(["--vault", "--list"]), /needs a value/);
});

test("pickView: name folds case, an id works, a name in two databases asks", () => {
  const other: SavedView = { ...OPEN_TASKS, id: "other", db: "release" };
  assert.equal(pickView([OPEN_TASKS, BY_OWNER], "open TASKS", null).id, "open-tasks");
  assert.equal(pickView([OPEN_TASKS, BY_OWNER], "by-owner", null).id, "by-owner");
  assert.throws(() => pickView([OPEN_TASKS, other], "Open tasks", null), /more than one database/);
  assert.equal(pickView([OPEN_TASKS, other], "Open tasks", "release").id, "other");
  assert.throws(() => pickView([OPEN_TASKS], "Nope", null), /no saved view named Nope/);
});

test("the verb prints the saved view as JSON, rows grouped and in order", (t) => {
  const vault = fixtureVault(t);
  const out = JSON.parse(run(["Open tasks", "--vault", vault, "--today", TODAY], {}));

  assert.equal(out.schema, "substrate.view/1");
  assert.equal(out.view.name, "Open tasks");
  assert.equal(out.view.db, "task");
  assert.equal(out.group_by, "status");
  // the done task is filtered out; the contact was never a member
  assert.equal(out.total, 5);
  assert.ok(!out.rows.some((r: { path: string }) => r.path.startsWith("People/")));
  assert.deepEqual(
    out.rows.map((r: { title: string }) => r.title),
    ["Mix vocals", "Vessel: Songs/Live", "Book the room", "Master the EP", "Sleeve art"]
  );
  assert.deepEqual(
    out.groups.map((g: { label: string; count: number }) => [g.label, g.count]),
    [
      ["doing", 1],
      ["todo", 3],
      ["No status", 1],
    ]
  );

  const mix = out.rows[0];
  assert.equal(mix.path, "Tasks/Mix vocals.md");
  assert.equal(mix.cells.budget.display, "300,50 €");
  assert.equal(mix.cells.budget.raw, "300.5");
  assert.equal(mix.cells.due.display, "Aug 1, 2026");

  assert.deepEqual(out.reader, { vault, today: TODAY, numberLocale: "de-DE", fx: "none", warnings: [] });
});

test("the pin's own sort wins over the database's remembered one", (t) => {
  const vault = fixtureVault(t);
  const out = JSON.parse(run(["By owner", "--vault", vault, "--today", TODAY], {}));
  // views.json remembers budget descending for the database; this pin sorts
  // by owner, and a pin never inherits the database's sort
  assert.deepEqual(out.sorts, [{ key: "owner", dir: 1 }]);
  assert.deepEqual(
    out.rows.map((r: { title: string }) => r.title),
    ["Mix vocals", "Vessel: Songs/Live", "Sleeve art", "Book the room", "Master the EP", "Shipped"]
  );
  // a curated pin shows the columns it captured, in that order
  assert.deepEqual(out.columns, ["owner", "budget"]);
});

test("--today pins the day relative date filters are measured against", (t) => {
  const vault = fixtureVault(t);
  writeFileSync(
    join(vault, ".vault", "views.json"),
    // `due < 0d` is how the app spells the overdue question: earlier than the
    // reference day. The day itself is what --today moves.
    JSON.stringify({ $views: [{ id: "overdue", name: "Overdue", db: "task", query: "due < 0d", view: "table" }] })
  );
  const early = JSON.parse(run(["Overdue", "--vault", vault, "--today", "2026-08-10"], {}));
  const late = JSON.parse(run(["Overdue", "--vault", vault, "--today", "2026-09-30"], {}));
  assert.deepEqual(early.rows.map((r: { title: string }) => r.title), ["Mix vocals"]);
  // every dated task is behind the later day; the two undated ones never are
  assert.equal(late.total, 4);
});

test("a vault with no number dialect reads the same on every machine", (t) => {
  // the app follows the operating system's locale for a vault that never
  // chose a dialect; this reader must not, or the same folder would print
  // `300,50 €` on one machine and `300.50 €` on the next and a diff of two
  // runs would be about the machine rather than about the vault
  const vault = fixtureVault(t);
  writeFileSync(join(vault, "Settings.md"), "---\ncapture-hotkey: alt+space\n---\n");
  const out = JSON.parse(run(["Open tasks", "--vault", vault, "--today", TODAY], {}));
  assert.equal(out.reader.numberLocale, "de-DE");
  assert.equal(out.rows[0].cells.budget.display, "300,50 €");
});

test("a note this reader could only partly parse is named in the payload", (t) => {
  const vault = fixtureVault(t, {
    "Tasks/Odd.md": "---\ntype: task\nstatus: todo\ncards:\n  label: Cash\n---\nbody\n",
  });
  const out = JSON.parse(run(["Open tasks", "--vault", vault, "--today", TODAY], {}));
  assert.equal(out.reader.warnings.length, 1);
  assert.equal(out.reader.warnings[0].path, "Tasks/Odd.md");
  // partly read is still READ: the note keeps the props that parsed and is a
  // row, which is exactly why the warning has to name it
  assert.ok(out.rows.some((r: { path: string }) => r.path === "Tasks/Odd.md"));
});

test("a note the app's parser would reject is skipped here too, and said so", (t) => {
  const vault = fixtureVault(t, {
    // an unquoted colon inside a value: the engine's YAML parse fails the
    // whole block, so this note has no props, belongs to no database, and
    // appears nowhere in the app
    "Tasks/Unquoted.md": "---\ntype: task\ntitle: Vessel: Songs/Live\nstatus: todo\n---\nbody\n",
  });
  const out = JSON.parse(run(["Open tasks", "--vault", vault, "--today", TODAY], {}));
  assert.equal(out.rows.length, 5, "the rejected note must not be printed as a row");
  assert.equal(out.reader.warnings.length, 1);
  assert.equal(out.reader.warnings[0].path, "Tasks/Unquoted.md");
  assert.match(out.reader.warnings[0].reason, /skipped/);
});

test("--format md prints the view as a reader reads it", (t) => {
  const vault = fixtureVault(t);
  const md = run(["Open tasks", "--vault", vault, "--format", "md", "--today", TODAY], {});
  assert.match(md, /^# Open tasks$/m);
  assert.match(md, /^5 rows · database `task`$/m);
  assert.match(md, /^## todo \(3\)$/m);
  assert.match(md, /^\| Name \| status \| budget \| due \| owner \| tags \|$/m);
  // the trailing ` {2}` is the empty tags cell: one padding space each side
  assert.match(md, /^\| Mix vocals \| doing \| 300,50 € \| Aug 1, 2026 \| Ada \| {2}\|$/m);
});

test("--format md carries the reader's warnings under the table", (t) => {
  const vault = fixtureVault(t, {
    // rejected: the app has no such note, so the md table is a row SHORT and
    // only the footer can say why
    "Tasks/Unquoted.md": "---\ntype: task\ntitle: Vessel: Songs/Live\nstatus: todo\n---\nbody\n",
  });
  const md = run(["Open tasks", "--vault", vault, "--format", "md", "--today", TODAY], {});
  assert.match(md, /\*\*1 note this reader could not fully read\*\*/);
  assert.match(md, /^- `Tasks\/Unquoted\.md`: .*skipped/m);
  // a clean vault gets no footer at all
  assert.ok(
    !run(["Open tasks", "--vault", fixtureVault(t), "--format", "md", "--today", TODAY], {}).includes(
      "could not fully read"
    )
  );
});

test("--format md on an ungrouped, empty view says so instead of printing an empty table", (t) => {
  const vault = fixtureVault(t);
  writeFileSync(
    join(vault, ".vault", "views.json"),
    JSON.stringify({ $views: [{ id: "none", name: "None", db: "task", query: "owner:nobody", view: "table" }] })
  );
  assert.match(run(["None", "--vault", vault, "--format", "md"], {}), /_No rows\._/);
});

test("--list names every pin; no vault and no view name are told apart", (t) => {
  const vault = fixtureVault(t);
  assert.equal(run(["--list", "--vault", vault], {}), "Open tasks\ttask\topen-tasks\nBy owner\ttask\tby-owner\n");
  assert.throws(() => run([], {}), NoVaultError);
  assert.throws(() => run(["Open tasks"], {}), NoVaultError);
  // a vault but no name is the caller's mistake, not a missing vault
  assert.throws(() => run(["--vault", vault], {}), UsageError);
  // VAULT_DIR is the default, so a shell that exports it needs no flag
  assert.equal(JSON.parse(run(["Open tasks", "--today", TODAY], { VAULT_DIR: vault })).total, 5);
});

test("run as a process: exit 1 and the vault's pins on an unknown view name", (t) => {
  const vault = fixtureVault(t);
  const printed = execFileSync("node", [CLI, "Open tasks", "--vault", vault, "--today", TODAY], { encoding: "utf8" });
  assert.equal(JSON.parse(printed).view.id, "open-tasks");

  try {
    execFileSync("node", [CLI, "Nope", "--vault", vault], { encoding: "utf8", stdio: "pipe" });
    assert.fail("an unknown view must not exit 0");
  } catch (error) {
    const e = error as { status: number; stderr: string };
    assert.equal(e.status, 1);
    assert.match(e.stderr, /no saved view named Nope/);
    assert.match(e.stderr, /Open tasks/);
  }
});

test("run as a process: a symlinked path to the verb still prints the view", (t) => {
  const vault = fixtureVault(t);
  // a launcher hands over the path it was given, not the resolved one; the
  // module URL is always resolved. Compared raw, the verb reads itself as
  // imported and exits 0 printing nothing — silently, which is the trap.
  const dir = mkdtempSync(join(tmpdir(), "substrate-view-read-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "view-read.ts");
  symlinkSync(CLI, link);

  const printed = execFileSync("node", [link, "Open tasks", "--vault", vault, "--today", TODAY], { encoding: "utf8" });
  assert.equal(JSON.parse(printed).view.id, "open-tasks");
});

test("a vault that is not there is said so, not answered as an empty one", (t) => {
  const missing = join(fixtureVault(t), "no-such-folder");
  // the trap this guards: a folder that cannot be read walks as a folder with
  // nothing in it, which would make a typo'd path answer "no saved views" and
  // exit 0 — a caller cannot tell a wrong path from a bare vault
  assert.throws(() => run(["--list", "--vault", missing], {}), NoVaultError);
  try {
    execFileSync("node", [CLI, "--list", "--vault", missing], { encoding: "utf8", stdio: "pipe" });
    assert.fail("a missing vault must not exit 0");
  } catch (error) {
    const e = error as { status: number; stderr: string };
    assert.equal(e.status, 3);
    assert.match(e.stderr, /not a vault folder/);
  }
});

/** Every file under a folder, path to bytes — so "byte-identical" is checked
    against the bytes, not against a mtime a rewrite of the same content would
    also have moved. */
function vaultBytes(dir: string, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) vaultBytes(dir, rel, out);
    else out[rel] = readFileSync(join(dir, rel)).toString("base64");
  }
  return out;
}

test("the reader never writes: the vault is byte-identical after a read", (t) => {
  const vault = fixtureVault(t);
  const before = vaultBytes(vault);
  const stamps = readVault(vault).notes.map((n) => `${n.path}:${n.updated_ms}`);
  run(["Open tasks", "--vault", vault, "--today", TODAY], {});
  execFileSync("node", [CLI, "Open tasks", "--vault", vault, "--today", TODAY], { encoding: "utf8" });
  // content first — a file rewritten with identical bytes would still be a
  // write — then the mtimes, and no file added or removed either
  assert.deepEqual(vaultBytes(vault), before);
  assert.deepEqual(readVault(vault).notes.map((n) => `${n.path}:${n.updated_ms}`), stamps);
});

/** The painted table, read back the way a person reads it — the same scrape
    the evaluator's own component test does. */
function painted(r: Rendered): {
  columns: string[];
  rows: { title: string; cells: string[]; chips: (string[] | null)[] }[];
  groups: { label: string; count: number }[];
} {
  const columns = r
    .all("th .db-th-label")
    .map((el) => (el.textContent ?? "").replace(/[↑↓]/g, "").trim());
  // a multi or relation cell paints a row of pills carrying no separator of
  // its own, while the evaluator reports the same cell as the values joined —
  // read the chips back as that string so the two compare like with like, and
  // keep the list itself for a case that wants it value by value
  const chipsOf = (td: Element): string[] | null => {
    const pills = td.querySelector(".multi-pills");
    return pills ? Array.from(pills.children).map((el) => el.textContent ?? "") : null;
  };
  const rows = r
    .all("tbody tr")
    .filter((tr) => tr.querySelector("td[data-fc='0']"))
    .map((tr) => {
      const tds = Array.from(tr.querySelectorAll("td[data-fc]")).filter(
        (td) => td.getAttribute("data-fc") !== "0"
      );
      return {
        title: tr.querySelector("td[data-fc='0'] .db-title-txt")?.textContent ?? "",
        cells: tds.map((td) => {
          const chips = chipsOf(td);
          return chips ? chips.join(", ") : (td.querySelector(".db-cell-txt")?.textContent ?? "");
        }),
        chips: tds.map(chipsOf),
      };
    });
  const groups = r.all(".db-group-head").map((el) => ({
    label: el.querySelector(".db-group-label")?.textContent ?? "",
    count: Number(el.querySelector(".db-group-count")?.textContent ?? "0"),
  }));
  return { columns, rows, groups };
}

/** The pane over one pin of a read vault, rendered the way the shell renders
    it — the pref composed by the one function a headless reader of the same
    pin also calls.
 *
 *  `notes` is handed in reversed on purpose: the pane is given the index's
 *  order and moves an edited row to the end of it, while this reader walks
 *  the folder. A run of rows sharing a sort value left to the input order
 *  would paint one sequence and print another, so the pane is deliberately
 *  fed the opposite order to the one the CLI reads. */
async function paneOver(
  t: Parameters<typeof renderComponent>[0],
  read: ReturnType<typeof readVault>,
  view: SavedView
): Promise<Rendered> {
  await mockBackend();
  const { default: DatabasePane } = await import("../../src/components/DatabasePane.tsx");
  const dbNotes = read.notes.filter((n) => String(n.props.type).toLowerCase() === view.db).reverse();
  return renderComponent(
    t,
    h(DatabasePane as unknown as FunctionComponent<Record<string, unknown>>, {
      dbType: view.db,
      notes: dbNotes,
      allNotes: read.notes,
      pref: savedViewPref(view, read.prefs[view.db]),
      typeSchema: read.schema[view.db],
      schema: read.schema,
      onSaveIcon: () => {},
      usedValues: () => [],
      onSaveSchema: () => {},
      relationCandidates: () => [],
      onCreateEntry: async () => dbNotes[0],
      dbTypes: [view.db],
      openPath: null,
      newSignal: 0,
      gridDefault: false,
      numberLocale: "de-DE" as const,
      onPrefChange: () => {},
      onOpenNote: () => {},
      onNoteMenu: () => {},
      onTrashNotes: () => {},
      onMutated: () => {},
      initialQuery: view.query,
      initialColumns: view.columns,
      onColumnsChange: () => {},
      onSaveView: () => {},
      savedViews: read.views,
      activeViewId: view.id,
      onOpenView: () => {},
      onViewMenu: () => {},
      pinKeys: {},
      onRenameDb: () => {},
      onDeleteDb: () => {},
      onRenameProp: () => {},
      onRemoveProp: () => {},
    })
  );
}

test("same eyes: the CLI's rows are the rows the pane paints from the same folder", async (t) => {
  const vault = fixtureVault(t);
  const read = readVault(vault);
  const typeSchema = read.schema.task;
  const printed = JSON.parse(
    execFileSync("node", [CLI, "Open tasks", "--vault", vault, "--today", TODAY], { encoding: "utf8" })
  );

  const r = await paneOver(t, read, OPEN_TASKS);
  await r.settle();
  const seen = painted(r);

  // an empty table would satisfy any comparison — pin what this view shows
  assert.equal(seen.rows.length, 5);
  assert.equal(printed.total, 5);
  // this pin captured no columns, so it shows the database's whole column
  // union in the union's own order — NOT the order a header drag left on the
  // database, and with nothing hidden by the database's table curation
  assert.deepEqual(printed.columns, ["status", "budget", "due", "owner", "tags"]);
  assert.deepEqual(
    seen.columns,
    printed.columns.map((c: string) => c.charAt(0).toUpperCase() + c.slice(1))
  );
  assert.deepEqual(
    seen.rows,
    printed.rows.map(
      (row: { title: string; cells: Record<string, { display: string; values?: string[] }> }) => ({
        title: row.title,
        cells: printed.columns.map((c: string) => row.cells[c].display),
        // `values` is set for exactly the chip kinds; a cell with none paints
        // no pill row at all, which is the null on the painted side
        chips: printed.columns.map((c: string) => row.cells[c].values ?? null),
      })
    )
  );
  assert.deepEqual(
    seen.groups,
    printed.groups.map((g: { label: string; count: number }) => ({ label: g.label, count: g.count }))
  );

  // and the markdown a reader gets is the same table again, not a second
  // evaluation with its own opinions
  const md = markdown(evaluateSavedView(OPEN_TASKS, read.notes, typeSchema, { pref: read.prefs.task, today: TODAY, locale: "de-DE" }));
  for (const row of seen.rows) assert.ok(md.includes(`| ${row.title} |`), `${row.title} missing from the markdown`);
});

test("same eyes: rows sharing a sort value land in path order on both sides", async (t) => {
  const vault = fixtureVault(t);
  const read = readVault(vault);
  const printed = JSON.parse(
    execFileSync("node", [CLI, "By owner", "--vault", vault, "--today", TODAY], { encoding: "utf8" })
  );

  const r = await paneOver(t, read, BY_OWNER);
  await r.settle();
  const seen = painted(r);

  // Ada owns two of these rows and Sam owns three: within each run the sort
  // key says nothing, and the answer is the note's path — not the order
  // either reader happened to receive its rows in
  const order = [
    "Mix vocals",
    "Vessel: Songs/Live",
    "Sleeve art",
    "Book the room",
    "Master the EP",
    "Shipped",
  ];
  assert.deepEqual(
    printed.rows.map((row: { title: string }) => row.title),
    order
  );
  assert.deepEqual(seen.rows.map((row) => row.title), order);
});

/* ── The parity matrix ────────────────────────────────────────────────────
 *
 *  The two "same eyes" tests above cover a saved query with a sort and a tie
 *  run. What they never reach is the rest of the feature surface a caller can
 *  actually ask for: a grouped table, a rollup column derived from another
 *  database, a total scoped by grants, and — on the fence side — a `limit:`
 *  and a dotted relation column. Each of those is a separate projection step
 *  between the evaluator and the payload, and an unpinned projection is where
 *  "the door reports what the screen shows" quietly stops being true.
 *
 *  The cases share one fixture, kept apart from the vault above so the column
 *  unions and totals those tests pin stay untouched. Each is small and named
 *  for the one feature it pins. */

const MATRIX_NOTES: Record<string, string> = {
  "Crew/Ada.md": "---\ntype: crew\nrate: 120\ncity: Berlin\n---\nEngineer.\n",
  "Crew/Sam.md": "---\ntype: crew\nrate: 80\ncity: Lisbon\n---\nLive sound.\n",
  "Gigs/Night One.md": "---\ntype: gig\nstage: booked\nfee: 400\nlead: Ada\n---\nHeadline.\n",
  "Gigs/Night Two.md": "---\ntype: gig\nstage: held\nfee: 250\nlead: Sam\n---\nPencilled.\n",
  // two linked rows, so the rollup folds a list rather than a single value
  "Gigs/Night Three.md":
    "---\ntype: gig\nstage: booked\nfee: 150\nlead:\n  - Ada\n  - Sam\n---\nDouble bill.\n",
  // no relation at all: the rollup has nothing to fold, which is a missing
  // cell rather than a zero on both sides
  "Gigs/Night Four.md": "---\ntype: gig\nstage: done\nfee: 90\n---\nPlayed already.\n",
};

const MATRIX_SCHEMA = JSON.stringify({
  crew: {
    rate: { options: [], kind: "number" },
    city: { options: [], kind: "text" },
  },
  gig: {
    stage: {
      options: [{ value: "booked", color: "blue" }, { value: "held", color: "grey" }, { value: "done" }],
    },
    fee: { options: [], kind: "number" },
    lead: { options: [], kind: "relation", type: "crew" },
    // derived on read from the rows `lead` points at — stored nowhere, which
    // is exactly why both readers have to agree about it
    lead_rate: { options: [], kind: "rollup", relation: "lead", prop: "rate", agg: "sum" },
  },
});

const GROUPED_GIGS: SavedView = {
  id: "gigs-by-stage",
  name: "Gigs by stage",
  db: "gig",
  sorts: [{ key: "fee", dir: -1 }],
  columns: ["stage", "fee"],
  view: "table",
  table_group_by: "stage",
};

const ROLLED_GIGS: SavedView = {
  id: "gigs-by-rate",
  name: "Gigs by rate",
  db: "gig",
  sorts: [{ key: "lead_rate", dir: -1 }],
  columns: ["lead", "lead_rate", "fee"],
  view: "table",
};

const ALL_GIGS: SavedView = {
  id: "all-gigs",
  name: "All gigs",
  db: "gig",
  sorts: [{ key: "fee", dir: -1 }],
  columns: ["stage", "fee"],
  view: "table",
};

/** A pin naming a dotted column. The fence resolver reads such a name as a
    join through the relation; the saved-view path has no join step and drops
    any column the database does not itself store. Pinned as it stands: both
    readers must drop it the same way, and the day the saved path grows the
    join this case is where the two would part company. */
const DOTTED_PIN: SavedView = {
  id: "gigs-dotted",
  name: "Gigs dotted",
  db: "gig",
  sorts: [{ key: "fee", dir: -1 }],
  columns: ["fee", "lead.city"],
  view: "table",
};

/** A note carrying the fences the fence cases read, written as a reader would
    write them. Kept as one note with two fences so the engine's 1-based
    fence position is exercised alongside what the fences say. */
const FENCE_NOTE =
  "---\ntype: note\n---\nThe board.\n\n" +
  "```view\ntype: gig\nsort: fee:desc\nlimit: 2\n```\n\n" +
  "```view\ntype: gig\ncolumns: fee, lead.city\nsort: fee:desc\n```\n";

/** The matrix fixture: its own notes, schema and pin list, so nothing here
    moves a column union or a total the tests above pin. */
function matrixVault(t: Parameters<typeof fixtureVault>[0]): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-view-read-matrix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries({ ...MATRIX_NOTES, "Gigs/Board.md": FENCE_NOTE })) {
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  mkdirSync(join(dir, ".vault"), { recursive: true });
  writeFileSync(join(dir, ".vault", "schema.json"), MATRIX_SCHEMA);
  writeFileSync(
    join(dir, ".vault", "views.json"),
    JSON.stringify({ $views: [GROUPED_GIGS, ROLLED_GIGS, ALL_GIGS, DOTTED_PIN] })
  );
  writeFileSync(join(dir, "Settings.md"), "---\nnumber-locale: de-DE\n---\n");
  return dir;
}

/** The door's payload for a saved view, and the table the pane paints from
    the same read — the one comparison every saved-view case below makes. */
async function bothEyes(
  t: Parameters<typeof renderComponent>[0],
  vault: string,
  view: SavedView,
  allow?: string[]
): Promise<{ seen: ReturnType<typeof painted>; door: DoorPayload }> {
  const allowed = allow === undefined ? undefined : new Set(allow);
  const read = readVault(vault, {
    allow: allowed === undefined ? undefined : (rel: string) => allowed.has(rel),
  });
  const door = answered(
    ask(vault, allow ?? [...Object.keys(MATRIX_NOTES), "Gigs/Board.md"], { view: view.name })
  );
  const r = await paneOver(t, read, view);
  await r.settle();
  return { seen: painted(r), door };
}

/** The payload's rows in the shape `painted` reads off the DOM. */
function doorTable(door: DoorPayload): {
  columns: string[];
  rows: { title: string; cells: string[]; chips: (string[] | null)[] }[];
  groups: { label: string; count: number }[];
} {
  return {
    columns: door.columns.map((c) => c.charAt(0).toUpperCase() + c.slice(1)),
    rows: door.rows.map((row) => ({
      title: row.title,
      cells: door.columns.map((c) => row.cells[c].display),
      chips: door.columns.map((c) => row.cells[c].values ?? null),
    })),
    groups: door.groups.map((g) => ({ label: g.label, count: g.count })),
  };
}

test("parity: a grouped view's sections and their counts are the painted ones", async (t) => {
  const vault = matrixVault(t);
  const { seen, door } = await bothEyes(t, vault, GROUPED_GIGS);

  // booked (two rows) · held · done — the section run, not just the rows
  assert.equal(seen.rows.length, 4);
  assert.deepEqual(
    seen.groups,
    [{ label: "booked", count: 2 }, { label: "held", count: 1 }, { label: "done", count: 1 }]
  );
  assert.equal(door.group_by, "stage");
  const want = doorTable(door);
  assert.deepEqual(seen.groups, want.groups);
  assert.deepEqual(seen.columns, want.columns);
  assert.deepEqual(seen.rows, want.rows);
});

test("parity: a rollup column reads the same on both sides, empty cell included", async (t) => {
  const vault = matrixVault(t);
  const { seen, door } = await bothEyes(t, vault, ROLLED_GIGS);
  const want = doorTable(door);

  // the derivation itself, so the case cannot pass on two blank columns:
  // Ada+Sam folds to 200, Ada alone to 120, and the gig with no lead has no
  // value at all rather than a zero
  assert.deepEqual(
    door.rows.map((row) => [row.title, row.cells.lead_rate.display]),
    [
      ["Night Three", "200"],
      ["Night One", "120"],
      ["Night Two", "80"],
      ["Night Four", ""],
    ]
  );
  assert.ok(want.columns.includes("Lead_rate"), want.columns.join(","));
  // the relation cell is a pill per linked row on both sides — a single pill
  // reading "Ada, Sam" would satisfy the joined string and nothing else
  assert.deepEqual(seen.rows.map((row) => row.chips[0]), [["Ada", "Sam"], ["Ada"], ["Sam"], []]);
  assert.deepEqual(seen.columns, want.columns);
  assert.deepEqual(seen.rows, want.rows);
});

test("parity: a scoped read's total is the granted rows, on both sides", async (t) => {
  const vault = matrixVault(t);
  const allow = ["Gigs/Night One.md", "Gigs/Night Four.md", "Crew/Ada.md"];
  const { seen, door } = await bothEyes(t, vault, ALL_GIGS, allow);

  // the grant reaches two gigs, so that is the whole table — not the vault's
  // four with two of them hidden
  assert.equal(door.total, 2);
  assert.equal(door.reader.scope, "granted folders");
  assert.equal(door.reader.members, 2);
  assert.deepEqual(door.rows.map((row) => row.title), ["Night One", "Night Four"]);
  const want = doorTable(door);
  assert.equal(seen.rows.length, door.total);
  assert.deepEqual(seen.columns, want.columns);
  assert.deepEqual(seen.rows, want.rows);
});

test("parity: a pin's dotted column is dropped by both readers, not by one", async (t) => {
  const vault = matrixVault(t);
  const { seen, door } = await bothEyes(t, vault, DOTTED_PIN);

  // a dotted name is a join on the fence side and nothing on this one, so the
  // column simply is not there — the point is that the pane agrees
  assert.deepEqual(door.columns, ["fee"]);
  const want = doorTable(door);
  assert.deepEqual(seen.columns, want.columns);
  assert.deepEqual(seen.rows, want.rows);
});

/** The fence surfaces render one table component over the resolver's own
    result, so the fence cases compare the door's payload against THAT table
    painted — the projection between the two is what the engine adds. */
async function fenceEyes(
  t: Parameters<typeof renderComponent>[0],
  vault: string,
  fence: number
): Promise<{ painted: { columns: string[]; rows: { title: string; cells: string[] }[] }; door: DoorPayload }> {
  const read = readVault(vault);
  const door = answered(
    ask(vault, [...Object.keys(MATRIX_NOTES), "Gigs/Board.md"], { path: "Gigs/Board.md", fence })
  );
  const inner = nthViewFence(splitFrontmatter(readFileSync(join(vault, "Gigs/Board.md"), "utf8")).body, fence);
  assert.ok(inner !== null, `the fixture note has no fence ${fence}`);
  const result = embedQueryFor(parseViewSpec(inner), read.notes, read.schema, read.views);
  assert.ok(!("error" in result), JSON.stringify(result));

  await mockBackend();
  const { default: EmbedViewTable } = await import("../../src/components/EmbedViewTable.tsx");
  const r = await renderComponent(
    t,
    h(EmbedViewTable as unknown as FunctionComponent<Record<string, unknown>>, {
      result,
      onOpenSource: () => {},
    })
  );
  await r.settle();
  const columns = r.all("thead th").map((el) => (el.textContent ?? "").trim());
  const rows = r.all("tbody tr").map((tr) => {
    const tds = Array.from(tr.querySelectorAll("td"));
    return {
      title: (tds[0]?.textContent ?? "").trim(),
      cells: tds.slice(1).map((td) => (td.textContent ?? "").trim()),
    };
  });
  return { painted: { columns, rows }, door };
}

test("parity: a fence's limit cuts the door's rows exactly where the table stops", async (t) => {
  const vault = matrixVault(t);
  const { painted: seen, door } = await fenceEyes(t, vault, 1);

  // `limit: 2` after `sort: fee:desc` means the two dearest, and `total`
  // still reports every match — the cut is a cut, not a smaller query
  assert.deepEqual(door.rows.map((row) => row.title), ["Night One", "Night Two"]);
  assert.equal(door.total, 4);
  assert.deepEqual(seen.rows.map((row) => row.title), ["Night One", "Night Two"]);
  assert.deepEqual(
    seen.rows.map((row) => row.cells),
    door.rows.map((row) => door.columns.map((c) => row.cells[c].display))
  );
});

test("parity: a dotted column reads through the relation on both sides", async (t) => {
  const vault = matrixVault(t);
  const { painted: seen, door } = await fenceEyes(t, vault, 2);

  // `lead.city` is a value stored on the CREW row, read through the gig's
  // relation — nothing on the gig carries it, so a reader that lost the join
  // paints an empty column rather than failing
  assert.deepEqual(door.columns, ["fee", "lead.city"]);
  assert.deepEqual(
    door.rows.map((row) => [row.title, row.cells["lead.city"].display]),
    [
      ["Night One", "Berlin"],
      ["Night Two", "Lisbon"],
      ["Night Three", "Berlin, Lisbon"],
      ["Night Four", ""],
    ]
  );
  assert.deepEqual(seen.rows.map((row) => row.title), door.rows.map((row) => row.title));
  assert.deepEqual(
    seen.rows.map((row) => row.cells),
    door.rows.map((row) => door.columns.map((c) => row.cells[c].display))
  );
});

/** The same engine as the MCP door drives it: a request that names the notes
 *  the caller's grants reach, and a refusal that tells the caller nothing
 *  about the rest of the vault.
 *
 *  These sit here rather than beside the door because the rule they pin lives
 *  in the evaluator: the pins a name resolves against are the pins over a
 *  database the caller's own notes are members of. Resolving first and
 *  scoping after put the vault's pin list into the refusal strings — a name
 *  the caller was never given failed differently from a name nothing carries,
 *  and a name two databases share answered with the ungranted one's type. */
const GRANTED_TASKS = Object.keys(NOTE_FILES).filter((p) => p.startsWith("Tasks/"));

const DIRECTORY: SavedView = {
  id: "directory",
  name: "Directory",
  db: "contact",
  query: "",
  sorts: [],
  view: "table",
};

/** The fixture vault with a pin list of this test's choosing. */
function doorVault(t: Parameters<typeof fixtureVault>[0], views: SavedView[]): string {
  const vault = fixtureVault(t);
  writeFileSync(join(vault, ".vault", "views.json"), JSON.stringify({ $views: views }));
  return vault;
}

function refusal(res: EngineResponse): string {
  if (res.ok) throw new Error("the engine answered where a refusal was expected");
  return res.error;
}

function answered(res: EngineResponse): DoorPayload {
  if (!res.ok) throw new Error(`the engine refused: ${res.error}`);
  return res.payload;
}

function ask(vault: string, allow: string[], req: Record<string, unknown>): EngineResponse {
  return engineRun(JSON.stringify({ vault, allow, today: TODAY, ...req }));
}

test("door: a pin over a database no grant reaches refuses like a name this vault lacks", (t) => {
  const vault = doorVault(t, [OPEN_TASKS, DIRECTORY]);
  const ungranted = refusal(ask(vault, GRANTED_TASKS, { view: "Directory" }));
  const unknown = refusal(ask(vault, GRANTED_TASKS, { view: "Ferrous log" }));
  // the two refusals differ only by the name that was asked for: a client
  // must not be able to sort the pins it was not given from the pins that do
  // not exist by reading which way the door said no
  assert.equal(ungranted.replace("Directory", "<asked>"), unknown.replace("Ferrous log", "<asked>"));
  // and neither names the database behind the pin it did not get
  assert.ok(!ungranted.includes("contact"), ungranted);
});

test("door: a name two databases carry is settled by the grants before it is called ambiguous", (t) => {
  const rosterTasks: SavedView = { ...OPEN_TASKS, id: "roster-task", name: "Roster" };
  const rosterPeople: SavedView = { ...DIRECTORY, id: "roster-contact", name: "Roster" };
  const vault = doorVault(t, [rosterTasks, rosterPeople]);

  // grants over the tasks only: one of the two pins exists for this caller,
  // so the answer is that one and the other's database is never named
  const scoped = answered(ask(vault, GRANTED_TASKS, { view: "Roster" }));
  assert.equal(scoped.view.id, "roster-task");
  assert.equal(scoped.view.db, "task");

  // grants over both databases: the question is a real one again, and the
  // list it prints is the list this caller could have asked for
  const both = refusal(ask(vault, [...GRANTED_TASKS, "People/Rob.md"], { view: "Roster" }));
  assert.match(both, /more than one database/);
  assert.match(both, /task/);
  assert.match(both, /contact/);
});

test("door: notes_read, members and total count the granted notes, not the vault's", (t) => {
  const vault = doorVault(t, [OPEN_TASKS, DIRECTORY]);
  const allow = ["Tasks/Master the EP.md", "Tasks/Shipped.md"];
  const p = answered(ask(vault, allow, { view: "Open tasks" }));
  assert.equal(p.reader.scope, "granted folders");
  assert.equal(p.reader.notes_read, 2);
  assert.equal(p.reader.members, 2);
  // `Shipped` is done, so the pin's own filter drops it: the total is what
  // this caller's grants hold and the filter kept, never the vault's count
  assert.equal(p.total, 1);
  assert.deepEqual(p.rows.map((r) => r.path), ["Tasks/Master the EP.md"]);
});

test("door: a note that will not open is warned about without a host path in the reason", (t) => {
  if (process.getuid?.() === 0) return; // root opens a mode-000 file anyway
  const vault = doorVault(t, [OPEN_TASKS]);
  const rel = "Tasks/Locked.md";
  writeFileSync(join(vault, rel), "---\ntype: task\nstatus: todo\n---\nlocked\n", { mode: 0o000 });
  const p = answered(ask(vault, [...GRANTED_TASKS, rel], { view: "Open tasks" }));
  const warning = p.reader.warnings.find((w) => w.path === rel);
  assert.ok(warning !== undefined, JSON.stringify(p.reader.warnings));
  // the vault root is the one host path the engine holds, and a warning is
  // the easy way for it to travel: the reason names the failure, the `path`
  // beside it names the note the way every other key does
  assert.ok(!warning.reason.includes(vault), warning.reason);
  assert.ok(!warning.reason.includes("/"), warning.reason);
  assert.match(warning.reason, /EACCES|EPERM/);
});
