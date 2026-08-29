import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyDateOf, dailyPath, displayTitle, humanDate, humanDateShort, journalOrder, JOURNAL_DIR } from "./journal.ts";
import { shiftDate, todayIso } from "./dates.ts";
import type { NoteMeta } from "./types.ts";

function meta(path: string, updated_ms: number): NoteMeta {
  const stem = path.split("/").pop()!.replace(/\.md$/, "");
  return { path, stem, title: stem, folder: JOURNAL_DIR, props: {}, updated_ms, excerpt: "", sealed: false };
}

test("dailyDateOf recognizes journal paths only", () => {
  assert.equal(dailyDateOf("Journal/2026-07-17.md"), "2026-07-17");
  assert.equal(dailyDateOf("2026-07-17.md"), null);
  assert.equal(dailyDateOf("Journal/notes.md"), null);
  assert.equal(dailyDateOf("Journal/2026-07-17 2.md"), null);
  assert.equal(dailyDateOf("Inbox/2026-07-17.md"), null);
  assert.equal(dailyDateOf("Journal/sub/2026-07-17.md"), null);
});

test("dailyDateOf rejects impossible dates", () => {
  assert.equal(dailyDateOf("Journal/2026-02-30.md"), null);
  assert.equal(dailyDateOf("Journal/2026-13-01.md"), null);
  assert.equal(dailyDateOf("Journal/2025-02-29.md"), null);
  // 2024 is a leap year
  assert.equal(dailyDateOf("Journal/2024-02-29.md"), "2024-02-29");
});

test("dailyPath shape", () => {
  assert.equal(dailyPath("2026-07-17"), "Journal/2026-07-17.md");
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

test("humanDate renders a full local date", () => {
  assert.equal(humanDate("2026-07-17"), "Friday, 17 July 2026");
});

test("humanDateShort renders the list-density form", () => {
  assert.equal(humanDateShort("2026-07-17"), "Fri, 17 Jul 2026");
});

test("displayTitle humanizes dailies, leaves everything else raw", () => {
  assert.equal(displayTitle(meta("Journal/2026-07-17.md", 0)), "Fri, 17 Jul 2026");
  assert.equal(displayTitle(meta("Journal/ideas.md", 0)), "ideas");
  assert.equal(displayTitle(meta("Inbox/2026-07-17.md", 0)), "2026-07-17");
});

test("journalOrder sorts dailies newest-first, strays after by recency", () => {
  const notes = [
    meta("Journal/ideas.md", 300),
    meta("Journal/2026-07-17.md", 100),
    meta("Journal/2026-07-18.md", 200),
    meta("Journal/sub/2026-07-19.md", 400), // not a daily: date must sit at the root
  ];
  assert.deepEqual(
    journalOrder(notes).map((n) => n.path),
    ["Journal/2026-07-18.md", "Journal/2026-07-17.md", "Journal/sub/2026-07-19.md", "Journal/ideas.md"]
  );
  // input not mutated
  assert.deepEqual(
    notes.map((n) => n.path),
    ["Journal/ideas.md", "Journal/2026-07-17.md", "Journal/2026-07-18.md", "Journal/sub/2026-07-19.md"]
  );
});

test("journalOrder is stable on empty input", () => {
  assert.deepEqual(journalOrder([]), []);
});

test("journalOrder puts today before yesterday", () => {
  const today = dailyPath(todayIso());
  const yesterday = dailyPath(shiftDate(todayIso(), -1));
  assert.deepEqual(
    journalOrder([meta(yesterday, 500), meta(today, 100)]).map((n) => n.path),
    [today, yesterday]
  );
});

test("journalOrder settles equal mtimes by path, like every other list", () => {
  // a vault restored from a clone has one mtime across the whole tree; without
  // the tiebreak the strays come back in whatever order the index handed them
  const strays = ["Journal/zeta.md", "Journal/alpha.md", "Journal/mid.md"];
  const forward = journalOrder(strays.map((p) => meta(p, 777))).map((n) => n.path);
  const reversed = journalOrder(
    strays
      .slice()
      .reverse()
      .map((p) => meta(p, 777))
  ).map((n) => n.path);
  assert.deepEqual(forward, ["Journal/alpha.md", "Journal/mid.md", "Journal/zeta.md"]);
  assert.deepEqual(reversed, forward, "the same notes, the same order, whichever way they arrived");
});
