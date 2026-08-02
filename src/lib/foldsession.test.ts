import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { foldSessionKey, migrateSessionFolds, sessionFolds } from "./foldsession.ts";

// SUB-785 — fold memory is keyed by the note's live path, so a rename moves
// the entries (plain and view-suffixed) instead of orphaning them.

const RANGES = [{ from: 3, to: 40 }];

beforeEach(() => sessionFolds.clear());

test("a rename moves the note's fold entry to the new path", () => {
  sessionFolds.set("Inbox/Old.md", RANGES);
  migrateSessionFolds("Inbox/Old.md", "Inbox/New.md");
  assert.equal(sessionFolds.get("Inbox/Old.md"), undefined);
  assert.deepEqual(sessionFolds.get("Inbox/New.md"), RANGES);
});

test("suffixed keys (the sheet source view) ride along", () => {
  sessionFolds.set("Sheets/Q.md", RANGES);
  sessionFolds.set("Sheets/Q.md:source", RANGES);
  migrateSessionFolds("Sheets/Q.md", "Sheets/R.md");
  assert.deepEqual(sessionFolds.get("Sheets/R.md"), RANGES);
  assert.deepEqual(sessionFolds.get("Sheets/R.md:source"), RANGES);
  assert.equal([...sessionFolds.keys()].some((k) => k.startsWith("Sheets/Q.md")), false);
});

test("a prefix that is not a path boundary stays put", () => {
  // "Notes/A.md" must not drag "Notes/A.md.backup" (no ':' boundary) along
  sessionFolds.set("Notes/A.md.backup", RANGES);
  migrateSessionFolds("Notes/A.md", "Notes/B.md");
  assert.deepEqual(sessionFolds.get("Notes/A.md.backup"), RANGES);
});

test("foldSessionKey strips only the mount nonce", () => {
  assert.equal(foldSessionKey("Inbox/N.md@3"), "Inbox/N.md");
  assert.equal(foldSessionKey("Inbox/N.md:source"), "Inbox/N.md:source");
});
