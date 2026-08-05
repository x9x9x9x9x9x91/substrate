import test from "node:test";
import assert from "node:assert/strict";
import {
  endOfLocalDay,
  historySheetSnapshots,
  isoDayOf,
  makeHistoryResolver,
  presentValue,
  valueAt,
} from "./history-facts.ts";
import type { FactLane, HistorySheetsAt, NoteMeta } from "./types.ts";

const day = (iso: string) => endOfLocalDay(iso) as number;
// noon local on `iso` — a snapshot time inside the day, well clear of either edge
const noon = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

const lane = (points: [string, string | null][], oldest: string | null): FactLane => ({
  path: "Health/Weight.md",
  key: "weight",
  points: points.map(([iso, value], i) => ({
    commit: `c${i}`,
    ts_ms: noon(iso),
    value,
  })),
  oldest_ts_ms: oldest === null ? null : noon(oldest),
});

const note = (path: string, props: Record<string, unknown>) =>
  ({ path, props }) as Pick<NoteMeta, "path" | "props">;

test("endOfLocalDay: the last instant of the day, in the reader's own timezone", () => {
  const end = day("2026-03-01");
  assert.equal(new Date(end).getDate(), 1);
  assert.equal(new Date(end + 1).getDate(), 2);
  // one millisecond short of the next midnight, whatever the offset
  assert.equal(new Date(end + 1).getHours(), 0);
  assert.equal(endOfLocalDay("2026-02-30"), null);
  assert.equal(endOfLocalDay("not a date"), null);
});

test("endOfLocalDay: spans a DST boundary without losing or gaining a day", () => {
  // last Sunday in March / October — DST edges in most northern-hemisphere zones
  for (const iso of ["2026-03-29", "2026-10-25"]) {
    const end = day(iso);
    assert.equal(isoDayOf(end), iso);
    assert.equal(isoDayOf(end + 1) > iso, true);
  }
});

test("valueAt: reaches backwards across quiet days to the last change", () => {
  const l = lane(
    [
      ["2026-01-10", "80"],
      ["2026-02-01", "78"],
    ],
    "2026-01-01"
  );
  assert.deepEqual(valueAt(l, day("2026-01-20")), { kind: "value", value: "80" });
  assert.deepEqual(valueAt(l, day("2026-06-30")), { kind: "value", value: "78" });
  // the change's own day answers with the changed value: the reading is the
  // day's *closing* value, not its opening one
  assert.deepEqual(valueAt(l, day("2026-02-01")), { kind: "value", value: "78" });
});

test("valueAt: before the oldest snapshot is unknowable, never the oldest value", () => {
  const l = lane([["2026-01-10", "80"]], "2026-01-01");
  assert.deepEqual(valueAt(l, day("2025-12-31")), {
    kind: "unknowable",
    oldest: "2026-01-01",
  });
  // a vault with no snapshots at all can say nothing about any date
  assert.deepEqual(valueAt(lane([], null), day("2026-01-10")), {
    kind: "unknowable",
    oldest: null,
  });
});

test("valueAt: covered by history but not yet written is blank, and so is a deletion", () => {
  const l = lane(
    [
      ["2026-02-01", "78"],
      ["2026-03-01", null],
    ],
    "2026-01-01"
  );
  assert.deepEqual(valueAt(l, day("2026-01-15")), { kind: "absent" });
  assert.deepEqual(valueAt(l, day("2026-03-05")), { kind: "absent" });
});

test("presentValue: renders lists joined, and treats empty as absent", () => {
  const props = { weight: 72.4, note: "72.4 kg", done: true, tags: ["a", "b"], blank: "  " };
  assert.deepEqual(presentValue(props, "weight"), { kind: "value", value: "72.4" });
  assert.deepEqual(presentValue(props, "note"), { kind: "value", value: "72.4 kg" });
  assert.deepEqual(presentValue(props, "done"), { kind: "value", value: "true" });
  assert.deepEqual(presentValue(props, "tags"), { kind: "value", value: "a, b" });
  assert.deepEqual(presentValue(props, "blank"), { kind: "absent" });
  assert.deepEqual(presentValue(props, "missing"), { kind: "absent" });
});

test("makeHistoryResolver: a path with no note today is an error in both tenses", () => {
  const r = makeHistoryResolver([note("Health/Weight.md", { weight: 80 })], [
    lane([["2026-01-10", "80"]], "2026-01-01"),
  ]);
  assert.deepEqual(r("Typo.md", "weight", null), { kind: "unknown-note" });
  assert.deepEqual(r("Typo.md", "weight", "2026-02-01"), { kind: "unknown-note" });
});

test("makeHistoryResolver: present tense reads the live note, as-of reads the lane", () => {
  const r = makeHistoryResolver(
    [note("Health/Weight.md", { weight: 76 })],
    [lane([["2026-01-10", "80"]], "2026-01-01")]
  );
  assert.deepEqual(r("Health/Weight.md", "weight", null), { kind: "value", value: "76" });
  assert.deepEqual(r("Health/Weight.md", "weight", "2026-02-01"), {
    kind: "value",
    value: "80",
  });
});

test("makeHistoryResolver: a fact with no lane is pending, not blank", () => {
  const r = makeHistoryResolver([note("Health/Weight.md", { weight: 76 })]);
  assert.deepEqual(r("Health/Weight.md", "weight", "2026-02-01"), { kind: "pending" });
  // a key that is genuinely missing today still answers blank in the present
  assert.deepEqual(r("Health/Weight.md", "height", null), { kind: "absent" });
});

test("sheet snapshots pair back onto the days that asked, by the reader's own day boundary", () => {
  const ats: HistorySheetsAt[] = [
    {
      instant_ms: day("2026-02-15"),
      commit: "abc",
      oldest_ts_ms: noon("2026-01-05"),
      sheets: [{ path: "Money/Holdings.md", title: "Holdings", stem: "Holdings", body: "x" }],
    },
    // asked for, but the vault has nothing at or before it
    { instant_ms: day("2026-01-01"), commit: null, oldest_ts_ms: noon("2026-01-05"), sheets: [] },
  ];
  const out = historySheetSnapshots(["2026-02-15", "2026-01-01", "2026-02-20", "nonsense"], ats);
  assert.deepEqual(
    out.map((s) => [s.date, s.commit, s.oldest, s.notes.length]),
    [
      ["2026-02-15", "abc", "2026-01-05", 1],
      ["2026-01-01", null, "2026-01-05", 0],
    ]
  );
  // a day the backend did not answer is absent, and reads as "not loaded yet"
  assert.equal(
    out.find((s) => s.date === "2026-02-20"),
    undefined
  );
});

test("a vault with no snapshots at all carries a null boundary, not a fake day", () => {
  const out = historySheetSnapshots(
    ["2026-02-15"],
    [{ instant_ms: day("2026-02-15"), commit: null, oldest_ts_ms: null, sheets: [] }]
  );
  assert.equal(out[0].oldest, null);
});
