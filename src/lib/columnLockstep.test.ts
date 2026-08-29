/** The renderer's half of the marker/fence lockstep pin.
 *
 *  Two languages that cannot import each other decide the same three things
 *  about a line: is it a column marker, does it open a fence, does it close
 *  one. This side lays the page out; `src-tauri/src/vault/mod.rs` decides what
 *  reaches the search index. Both sides said "lockstep twin" in a doc comment
 *  and nothing enforced it, and both drifted: the indexer recognized
 *  `<!-- /col -->`, which is not one of the three markers, so a line the
 *  editor showed was blanked out of snippets; and this side counted a no-break
 *  space, a form feed and a vertical tab as indentation, so a marker it hid
 *  was one the indexer printed.
 *
 *  The fixture is the whole pin: parity/lockstep/column-markers.json, replayed
 *  here and by `the_lockstep_fixture_gets_the_same_answers` under `cargo test`.
 *  A case added on one side is a case the other side answers or fails. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isColumnsClose, isColumnsDivider, isColumnsOpen } from "./columns.ts";
import { fenceCloses, fenceOpening } from "./fences.ts";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../parity/lockstep/column-markers.json"
);

interface Fixture {
  markers: { line: string; kind: "open" | "divider" | "close" | null; note?: string }[];
  fences: { line: string; opens: string | null; note?: string }[];
  closers: { line: string; run: string; closes: boolean; note?: string }[];
}

// unreadable or unparseable is a failure, never a skip — a pin that quietly
// stops running is the drift it exists to catch
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

/** Which of the three markers a line is, as the layout parser sees it. */
function kindOf(line: string): "open" | "divider" | "close" | null {
  if (isColumnsOpen(line)) return "open";
  if (isColumnsDivider(line)) return "divider";
  if (isColumnsClose(line)) return "close";
  return null;
}

test("the lockstep fixture is loaded and holds the cases it was written for", () => {
  assert.ok(fixture.markers.length > 10, `markers under ${FIXTURE}`);
  assert.ok(fixture.fences.length > 5, "fence cases");
  assert.ok(fixture.closers.length > 5, "closer cases");

  // the inputs the two sides were found disagreeing on stay named, so a
  // rewrite of the fixture cannot drop the regressions it was built from
  const found = [
    "<!-- /col -->",
    "<!--/col-->",
    "\u00a0<!-- columns -->",
    "\u000c<!-- columns -->",
    "\u000b<!-- columns -->",
  ];
  for (const line of found) {
    const row = fixture.markers.find((m) => m.line === line);
    assert.ok(row, `the found divergence ${JSON.stringify(line)} is still pinned`);
    assert.equal(row.kind, null, `${JSON.stringify(line)} is not a marker`);
  }
});

test("every fixture line is the marker the fixture says it is", () => {
  for (const { line, kind, note } of fixture.markers) {
    assert.equal(kindOf(line), kind, `${JSON.stringify(line)}${note ? ` — ${note}` : ""}`);
  }
});

test("every fixture line opens the fence the fixture says it opens", () => {
  for (const { line, opens, note } of fixture.fences) {
    assert.equal(fenceOpening(line), opens, `${JSON.stringify(line)}${note ? ` — ${note}` : ""}`);
  }
});

test("every fixture line closes, or does not close, the run the fixture names", () => {
  for (const { line, run, closes, note } of fixture.closers) {
    assert.equal(
      fenceCloses(line, run),
      closes,
      `${JSON.stringify(line)} vs ${JSON.stringify(run)}${note ? ` — ${note}` : ""}`
    );
  }
});
