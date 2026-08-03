import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta } from "./types.ts";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane (same
   trick as tauri.test.ts); every app import below is dynamic for that. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultRead, vaultSetProp } = await import("./ipc.ts");
const { duplicateNote, duplicatePropLanes, buildNoteActions } = await import("./noteactions.ts");

test("duplicatePropLanes: strings go to create pairs, bools/lists to sets", () => {
  const { pairs, sets } = duplicatePropLanes({
    status: "open",
    "cat#": 7,
    flagged: true,
    artists: ["a", "b"],
  });
  assert.deepEqual(pairs, [
    ["status", "open"],
    ["cat#", "7"],
  ]);
  assert.deepEqual(sets, [
    ["flagged", true],
    ["artists", ["a", "b"]],
  ]);
});

test("duplicatePropLanes: engine-owned props never copy", () => {
  const { pairs, sets } = duplicatePropLanes({
    Type: "idea",
    TITLE: "Custom",
    Created: "2026-01-01",
    Status: "open",
  });
  assert.deepEqual(pairs, [["Status", "open"]]);
  assert.deepEqual(sets, []);
});

test("duplicatePropLanes: values with no create-time form are skipped", () => {
  const { pairs, sets } = duplicatePropLanes({
    nothing: null,
    nested: { a: 1 },
    empty: [],
    mixed: ["a", 2],
    ok: "v",
  });
  assert.deepEqual(pairs, [["ok", "v"]]);
  assert.deepEqual(sets, []);
});

test("duplicateNote: copies body, folder, type and props as '<title> copy'", async () => {
  const src = await vaultCreate("Dupe Source", "Dupes", "idea", [["status", "open"]], "the body\n");
  await vaultSetProp(src.path, "flagged", true);
  await vaultSetProp(src.path, "artists", ["a", "b"]);

  const copy = await duplicateNote(src);

  assert.equal(copy.path, "Dupes/Dupe Source copy.md");
  assert.equal(copy.folder, "Dupes");
  assert.equal(copy.title, "Dupe Source copy");
  const read = await vaultRead(copy.path);
  assert.equal(read.body, "the body\n");
  assert.equal(read.props["type"], "idea");
  assert.equal(read.props["status"], "open");
  assert.equal(read.props["flagged"], true);
  assert.deepEqual(read.props["artists"], ["a", "b"]);
  assert.ok(read.props["created"], "the copy gets its own created date");
  assert.equal(read.props["title"], undefined, "title follows the filename, never a prop");
});

test("duplicateNote: folded system keys retain type without parallel props", async () => {
  const src = await vaultCreate("Dupe Folded 728", "Dupes", undefined, [], "folded body\n");
  await vaultSetProp(src.path, "Type", "release");
  await vaultSetProp(src.path, "Created", "1999-01-01");
  await vaultSetProp(src.path, "Status", "live");

  const copy = await duplicateNote(src);
  const read = await vaultRead(copy.path);
  assert.equal(read.props.type, "release", "folded Type supplies the create-time database");
  assert.equal(read.props.Status, "live");
  assert.ok(read.props.created, "the copy keeps only its own created date");
  assert.equal(read.props.Type, undefined);
  assert.equal(read.props.Created, undefined);
  assert.equal(read.props.TITLE, undefined);
});

test("duplicateNote: the engine dedupes an existing '<title> copy'", async () => {
  const src = await vaultCreate("Dupe Again", "Dupes");
  const first = await duplicateNote(src);
  const second = await duplicateNote(src);
  assert.equal(first.path, "Dupes/Dupe Again copy.md");
  assert.equal(second.path, "Dupes/Dupe Again copy 2.md");
});

test("duplicateNote: an untyped root note stays untyped at root", async () => {
  const src = await vaultCreate("Dupe Plain", "");
  const copy: NoteMeta = await duplicateNote(src);
  assert.equal(copy.path, "Dupe Plain copy.md");
  assert.equal(copy.props["type"], undefined);
});

test("buildNoteActions: the full handler set yields the canonical order", () => {
  const noop = () => {};
  const acts = buildNoteActions({
    open: noop,
    moveToFolder: noop,
    rename: noop,
    duplicate: noop,
    setProperty: noop,
    copyPath: noop,
    reveal: noop,
    exportMarkdown: noop,
    exportPdf: noop,
    exportOneSheet: noop,
    toggleCalendar: noop,
    togglePin: noop,
    trash: noop,
  });
  assert.deepEqual(
    acts.map((a) => a.id),
    ["open", "move", "rename", "duplicate", "prop", "copy", "reveal", "export-md", "export-pdf", "export-onesheet", "calendar", "pin", "trash"]
  );
});

test("buildNoteActions: only wired handlers appear, trash always last + separated", () => {
  const noop = () => {};
  const acts = buildNoteActions({ duplicate: noop, trash: noop, copyPath: noop });
  assert.deepEqual(
    acts.map((a) => a.id),
    ["duplicate", "copy", "trash"]
  );
  const trash = acts[acts.length - 1];
  assert.equal(trash.destructive, true);
  assert.equal(trash.separatorAbove, true);
  assert.equal(trash.hint, "recoverable");
  assert.equal(buildNoteActions({}).length, 0);
});

test("buildNoteActions: the pin label flips on pinned (SUB-410), non-destructive", () => {
  const noop = () => {};
  const [pin] = buildNoteActions({ togglePin: noop });
  assert.equal(pin.label, "Pin to sidebar");
  assert.equal(pin.icon, "pin");
  assert.equal(pin.destructive, undefined, "unpinning never trashes the note");
  assert.equal(buildNoteActions({ togglePin: noop, pinned: true })[0].label, "Remove pin");
});

test("buildNoteActions: the calendar label flips on calendarHidden", () => {
  const noop = () => {};
  assert.equal(buildNoteActions({ toggleCalendar: noop })[0].label, "Hide from calendar");
  assert.equal(
    buildNoteActions({ toggleCalendar: noop, calendarHidden: true })[0].label,
    "Show in calendar"
  );
});
