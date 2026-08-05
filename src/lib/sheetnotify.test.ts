import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnNotifyOf,
  findRevealCell,
  looksDated,
  notifyHint,
  parseColumnNotify,
} from "./sheetnotify.ts";

test("looksDated accepts an ISO day with or without a time, and nothing else", () => {
  assert.equal(looksDated("2026-08-10"), true);
  assert.equal(looksDated("  2026-08-10 09:30 "), true);
  assert.equal(looksDated("2026-08-10/2026-08-14"), true, "a range is a date value too");
  assert.equal(looksDated("10.08.2026"), false);
  assert.equal(looksDated(""), false);
  assert.equal(looksDated("renewal"), false);
});

test("looksDated offers nothing the scheduler would refuse", () => {
  // parse_due rejects seconds and unpadded fields; a menu
  // entry on such a cell could be switched on and would never fire
  assert.equal(looksDated("2026-08-01 14:30:00"), false);
  assert.equal(looksDated("2026-8-1"), false);
  assert.equal(looksDated("2026-08-10 extra"), false);
});

test("columnNotifyOf binds a header to its key case-insensitively, both directions", () => {
  const cols = { Renewal: { notify: true }, due: { notifyBefore: 7 } };
  assert.deepEqual(columnNotifyOf(cols, "renewal"), { notify: true });
  assert.deepEqual(columnNotifyOf(cols, "Due"), { notifyBefore: 7 });
});

test("columnNotifyOf prefers an exact match when both spellings are stored", () => {
  // order in the map must not decide which setting a header reads as its own
  const both = { Due: { notify: true }, due: { notifyBefore: 3 } };
  assert.deepEqual(columnNotifyOf(both, "due"), { notifyBefore: 3 });
  assert.deepEqual(columnNotifyOf(both, "Due"), { notify: true });
});

test("columnNotifyOf is quiet for an unknown column or a sheet with no map", () => {
  const cols = { Renewal: { notify: true } };
  assert.equal(columnNotifyOf(cols, "Notes"), undefined);
  assert.equal(columnNotifyOf(undefined, "Renewal"), undefined);
});

test("notifyHint reads out whichever alerts are on", () => {
  assert.equal(notifyHint({ notify: true }), "on the day");
  assert.equal(notifyHint({ notifyBefore: 7 }), "7d before");
  assert.equal(notifyHint({ notify: true, notifyBefore: 1 }), "on the day · 1d before");
});

test("notifyHint says nothing for a column that never fires", () => {
  assert.equal(notifyHint(undefined), "");
  assert.equal(notifyHint({}), "");
  assert.equal(notifyHint({ notify: false }), "");
});

test("parseColumnNotify reads back the map a write produced", () => {
  assert.deepEqual(parseColumnNotify({ Renewal: { notify: true, notifyBefore: 7 } }), {
    Renewal: { notify: true, notifyBefore: 7 },
  });
});

test("parseColumnNotify ignores a snake_case lead — camelCase is the on-disk spelling", () => {
  // the scheduler folds for `notifyBefore` only, so reading `notify_before`
  // here would confirm a setting in the menu that never fires
  assert.deepEqual(parseColumnNotify({ Due: { notify_before: 3 } }), {
    Due: { notify: false, notifyBefore: undefined },
  });
});

test("parseColumnNotify drops entries that don't parse without losing the rest", () => {
  // one bad line in hand-edited frontmatter must not hide the working columns
  assert.deepEqual(
    parseColumnNotify({
      Due: "yes",
      Renewal: { notify: true },
      Ship: ["x"],
      Paid: { notifyBefore: "7" },
    }),
    {
      Renewal: { notify: true, notifyBefore: undefined },
      Paid: { notify: false, notifyBefore: undefined },
    }
  );
});

test("parseColumnNotify is undefined when there is no map at all", () => {
  assert.equal(parseColumnNotify(undefined), undefined);
  assert.equal(parseColumnNotify("columns"), undefined);
  assert.equal(parseColumnNotify([{ Due: { notify: true } }]), undefined);
});

const headers = ["Service", "Renewal", "Cost"];
const rows = [
  ["Streaming", "2026-08-10", "18"],
  ["Storage", "2026-09-01", "12"],
];

test("findRevealCell finds the row by its label cell, folded and trimmed", () => {
  assert.deepEqual(findRevealCell(headers, rows, { column: "Renewal", row: "streaming" }), {
    r: 0,
    c: 1,
  });
  assert.deepEqual(findRevealCell(headers, rows, { column: " renewal ", row: " Storage " }), {
    r: 1,
    c: 1,
  });
});

test("findRevealCell resolves a row that moved — position is never the identity", () => {
  const sorted = [rows[1], rows[0]];
  assert.deepEqual(findRevealCell(headers, sorted, { column: "Renewal", row: "Streaming" }), {
    r: 1,
    c: 1,
  });
});

test("findRevealCell gives up quietly on a renamed row or a dropped column", () => {
  assert.equal(findRevealCell(headers, rows, { column: "Renewal", row: "Backups" }), null);
  assert.equal(findRevealCell(headers, rows, { column: "Expires", row: "Streaming" }), null);
});
