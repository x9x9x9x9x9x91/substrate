import { test } from "node:test";
import assert from "node:assert/strict";
import { scanStatLine, scanSummary } from "./folders.ts";
import type { FolderScanStats } from "./types.ts";

const stat = (over: Partial<FolderScanStats>): FolderScanStats => ({
  folder: "~/Personal/Finance",
  db_type: "finance-doc",
  scanned: 0,
  created: 0,
  updated: 0,
  missing: 0,
  ...over,
});

test("no mappings explains where to configure", () => {
  assert.equal(scanSummary([]), "No folder mappings in .vault/folders.json");
});

test("all-zero scans read as up to date", () => {
  assert.equal(scanSummary([stat({ scanned: 12 })]), "Folder scan: everything up to date");
});

test("activity is summarized in order, errors appended", () => {
  assert.equal(
    scanSummary([stat({ scanned: 5, created: 3, updated: 1, missing: 2 })]),
    "Folder scan: 3 new · 1 updated · 2 missing"
  );
  assert.equal(scanSummary([stat({ created: 2 }), stat({ missing: 1 })]), "Folder scan: 2 new · 1 missing");
  assert.equal(
    scanSummary([stat({ created: 1 }), stat({ error: "not a folder: /gone" })]),
    "Folder scan: 1 new · 1 folder unreadable"
  );
  assert.equal(
    scanSummary([stat({ error: "x" }), stat({ error: "y" })]),
    "Folder scan: everything up to date · 2 folders unreadable"
  );
});

test("scanStatLine: one mapping's counts inline (SUB-672)", () => {
  assert.equal(
    scanStatLine(stat({ scanned: 12, created: 12 })),
    "12 notes created, 0 updated, 0 missing"
  );
  assert.equal(
    scanStatLine(stat({ created: 1, updated: 2, missing: 3 })),
    "1 note created, 2 updated, 3 missing"
  );
  assert.equal(scanStatLine(stat({})), "0 notes created, 0 updated, 0 missing");
});
