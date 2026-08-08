/** The wording half of receipts (spec §4.4): the backend's `Actor` enum is
    semantic, and every word a person reads about who changed a fact is decided
    in `actorText`. Pinned here because the two writers that name themselves —
    a bulk run and an outside tool — carry a string the row has to show, and a
    switch that drops it reads as a perfectly plausible "You". */

import assert from "node:assert/strict";
import { test } from "node:test";
import { actorText } from "./receipts.ts";

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
  assert.equal(actorText({ kind: "mcp", name: "Claude" }), "Claude (via MCP)");
  assert.equal(actorText({ kind: "mcp", name: "" }), "via MCP");
  assert.equal(actorText({ kind: "sync" }), "sync");
});
