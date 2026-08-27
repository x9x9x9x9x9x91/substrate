/* The time-travel bar's snapshot line. Pure string work, so the component
   itself never has to render to pin it. */
import "./componentHarness.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { snapshotLine } = await import("../components/TimeTravelBar.tsx");

test("an unlabelled snapshot says the word once", () => {
  // both backends spell an unlabelled commit's subject "snapshot"
  assert.equal(snapshotLine("Aug 26, 14:32", "snapshot"), "Aug 26, 14:32 snapshot");
  assert.equal(snapshotLine("Aug 26, 14:32", "Snapshot"), "Aug 26, 14:32 snapshot");
  assert.equal(snapshotLine("Aug 26, 14:32", "  "), "Aug 26, 14:32 snapshot");
  assert.equal(snapshotLine("Aug 26, 14:32", null), "Aug 26, 14:32 snapshot");
  assert.equal(snapshotLine("Aug 26, 14:32"), "Aug 26, 14:32 snapshot");
});

test("a labelled snapshot still names its label", () => {
  assert.equal(
    snapshotLine("Aug 26, 14:32", "Rewrote the release notes"),
    "Aug 26, 14:32 snapshot · Rewrote the release notes"
  );
});
