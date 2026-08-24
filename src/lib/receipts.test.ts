/** The wording half of receipts (spec §4.4): the backend's `Actor` enum is
    semantic, and every word a person reads about who changed a fact is decided
    in `actorText`. Pinned here because the two writers that name themselves —
    a bulk run and an outside tool — carry a string the row has to show, and a
    switch that drops it reads as a perfectly plausible "You". */

import assert from "node:assert/strict";
import { test } from "node:test";
import { actorText, boundaryDate, footerText, lastChangeText, receiptRows } from "./receipts.ts";
import type { Actor, FactLane, FactPoint } from "./types.ts";

test("a bulk row names the run that swept the note", () => {
  assert.equal(
    actorText({ kind: "bulk", name: "renamed database “Books” to “Reading” (3 notes)" }),
    "You — renamed database “Books” to “Reading” (3 notes)",
  );
  // a pre-convention `bulk:` commit that said nothing is still a run of yours
  assert.equal(actorText({ kind: "bulk", name: "" }), "You");
});

test("an outside writer is named, not labelled", () => {
  assert.equal(actorText({ kind: "external_tool", name: "Obsidian" }), "Obsidian");
  // no trailer: the backend passes the commit author through, and that name is
  // still the truest thing the row can say
  assert.equal(actorText({ kind: "external_tool", name: "robin@example.com" }), "robin@example.com");
  assert.equal(actorText({ kind: "external" }), "external edit");
});

test("app rows separate this app's own conventions from history that predates them", () => {
  assert.equal(actorText({ kind: "app" }, "snapshot"), "You");
  assert.equal(actorText({ kind: "app" }, "seal Health/Weight.md"), "You");
  assert.equal(actorText({ kind: "app" }, "initial import"), "In the app");
  // the presweep fences the app takes before a destructive run (App.tsx,
  // lib.rs) are app-made, whatever the run is called
  assert.equal(actorText({ kind: "app" }, "before vault time travel"), "You");
  assert.equal(actorText({ kind: "app" }, "before rename database Books"), "You");
  assert.equal(actorText({ kind: "app" }, "before delete database Books"), "You");
  assert.equal(actorText({ kind: "app" }, "before rename property Books.author"), "You");
  assert.equal(actorText({ kind: "app" }, "before strip Books.author values"), "You");
  assert.equal(actorText({ kind: "app" }, "before unmounting Camera"), "You");
  assert.equal(actorText({ kind: "app" }, "before mounts migration"), "You");
  // the prefix is a prefix, not a substring: a commit that merely mentions it
  // stays in the pre-convention bucket
  assert.equal(actorText({ kind: "app" }, "cleanup before release"), "In the app");
  assert.equal(actorText({ kind: "mcp", name: "Claude" }), "Claude (via MCP)");
  assert.equal(actorText({ kind: "mcp", name: "" }), "via MCP");
  assert.equal(actorText({ kind: "sync" }), "sync");
});

/** A path reused by a new note (spec §5.5): the lane below these renderers is
    the PATH's, so it still carries the dead note's changes and its deletion.
    Receipts answer for a NOTE, so they start at `born_ts_ms`. */

const pt = (ts_ms: number, value: string | null, actor: Actor = { kind: "app" }): FactPoint => ({
  commit: `c${ts_ms}`,
  ts_ms,
  value,
  actor,
  subject: "snapshot",
});

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

const lane = (points: FactPoint[], over: Partial<FactLane> = {}): FactLane => ({
  path: "Inbox/test.md",
  key: "weight",
  points,
  oldest_ts_ms: day("2026-01-01"),
  born_ts_ms: null,
  ...over,
});

/** create → delete → recreate, with the new note's own edits after it */
const reborn = lane(
  [
    pt(day("2026-01-01"), "70", { kind: "external_tool", name: "Obsidian" }),
    pt(day("2026-02-01"), null),
    pt(day("2026-03-01"), "90"),
    pt(day("2026-04-01"), null),
    pt(day("2026-05-01"), "91"),
  ],
  { born_ts_ms: day("2026-03-01") }
);

test("a reborn note's peek shows its own life, not the path's", () => {
  const rows = receiptRows(reborn);
  // the dead note's value and the "cleared" row that was really its deletion
  // are gone; the note's own rows stand, newest first
  assert.deepEqual(
    rows.map((r) => [r.ts_ms, r.value]),
    [
      [day("2026-05-01"), "91"],
      [day("2026-04-01"), null],
      [day("2026-03-01"), "90"],
    ]
  );
  // the cut is by the note's existence, never by a null value: the key removed
  // in April is this note's own change and renders
  assert.equal(rows[1].value, null);
  // and the last-change line, which reads through the same rows, no longer
  // credits the previous note's writer
  assert.match(lastChangeText(reborn, day("2026-05-01")) ?? "", /^Last changed just now · You$/);
});

test("a reborn note's footer dates its birth instead of the previous life's trim", () => {
  // the trim boundary sits in the dead note's stretch, so "no history before"
  // would be answering for a note nobody is looking at
  const foot = footerText(reborn);
  assert.match(foot, /^first set /);
  assert.equal(foot, `first set ${boundaryDate(day("2026-03-01"))}`);
  assert.ok(!foot.includes("no history before"));
});

test("a lane that never lost its note is untouched by the cut", () => {
  // born_ts_ms null — every renderer behaves exactly as it did before rebirth
  const whole = lane([pt(day("2026-02-01"), "70"), pt(day("2026-03-01"), "72")]);
  assert.deepEqual(receiptRows(whole).map((r) => r.value), ["72", "70"]);
  assert.equal(footerText(whole), `first set ${boundaryDate(day("2026-02-01"))}`);
  // including the trim trap: a lane reaching back to the oldest snapshot still
  // refuses to claim a first set
  const trimmed = lane([pt(day("2026-01-01"), "70"), pt(day("2026-03-01"), "72")]);
  assert.equal(footerText(trimmed), `no history before ${boundaryDate(day("2026-01-01"))}`);
  assert.equal(footerText(lane([])), `no history before ${boundaryDate(day("2026-01-01"))}`);
  assert.equal(footerText(lane([], { oldest_ts_ms: null })), "no snapshots yet");
  assert.equal(footerText(undefined), "no snapshots yet");
  assert.equal(lastChangeText(undefined), undefined);
});
