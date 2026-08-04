import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, parseChartConfig, xSchemaOptions, type RowChartConfig } from "./chart.ts";
import {
  MOUNT_AGGREGATES,
  isMountAggregate,
  mountAggregate,
  mountCardText,
  mountChartRows,
} from "./mountdash.ts";
import { parseBind } from "./metriccards.ts";
import { sizeLabel } from "./mounts.ts";
import type { MountInfo, MountRow } from "./types.ts";

const mount = (over: Partial<MountInfo> = {}): MountInfo => ({
  id: "m1",
  name: "Album Pool",
  globs: [],
  watch: true,
  path: "/Users/t/Music/Pool",
  missing: false,
  scanned: "2026-08-03T10:00:00Z",
  files: 3,
  ...over,
});

const row = (over: Partial<MountRow> = {}): MountRow => ({
  rel: "takes/track.als",
  name: "track.als",
  extension: "als",
  size: 4096,
  modified: "2026-08-01 14:30",
  created: "2026-07-20",
  identity: "abc123",
  props: {},
  ...over,
});

/** The motivating fence (SUB-982): projects touched per month, straight off a
    mounted folder — same grammar a database source uses. */
const rowsConfig = (inner: string): RowChartConfig => {
  const c = parseChartConfig(inner);
  assert.equal(c.bind, "rows");
  return c as RowChartConfig;
};

// ---------- source resolution ----------

test("a mount name parses as a database source — no new fence grammar", () => {
  const c = parseChartConfig("source: Album Pool\nx: modified:month\ny: count\n");
  assert.deepEqual(c.source, { kind: "db", type: "Album Pool" });
});

test("mount rows chart under the mount's own name", () => {
  const rows = mountChartRows(mount(), [row(), row({ rel: "b.als", name: "b.als" })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "Album Pool");
  assert.equal(rows[0].title, "track.als");
  assert.equal(rows[0].modified, "2026-08-01 14:30");
  assert.equal(rows[0].size, 4096);
});

test("a sidecar's props chart alongside the file's intrinsics", () => {
  const rows = mountChartRows(mount(), [
    row({ note: "Mounts/Album Pool/track.md", props: { Status: "mixing" } }),
  ]);
  // dbRows folds prop keys, so `by: status` finds a prop written `Status:`
  assert.equal(rows[0].status, "mixing");
  assert.equal(rows[0].extension, "als");
});

test("a mount charts per month over file-modified", () => {
  const rows = mountChartRows(mount(), [
    row({ rel: "a", name: "a", modified: "2026-06-02 09:00" }),
    row({ rel: "b", name: "b", modified: "2026-06-28 22:10" }),
    row({ rel: "c", name: "c", modified: "2026-08-01 14:30" }),
  ]);
  const s = aggregate(rows, rowsConfig("source: Album Pool\nx: modified:month\ny: count\n"));
  // July is empty but real: a zero-filled time axis keeps the gap visible
  assert.deepEqual(
    s.points.map((p) => [p.label, p.value]),
    [
      ["Jun 2026", 2],
      ["Jul 2026", 0],
      ["Aug 2026", 1],
    ],
  );
});

test("a mount chart splits by a sidecar prop", () => {
  const rows = mountChartRows(mount(), [
    row({ rel: "a", name: "a", modified: "2026-06-02 09:00", props: { stage: "sketch" } }),
    row({ rel: "b", name: "b", modified: "2026-06-28 22:10", props: { stage: "mixing" } }),
    row({ rel: "c", name: "c", modified: "2026-06-30 10:00", props: { stage: "sketch" } }),
  ]);
  const s = aggregate(rows, rowsConfig("source: Album Pool\nx: modified:month\ny: count\nby: stage\n"));
  assert.deepEqual(
    s.bands?.map((b) => [b.name, b.points.map((p) => p.value)]),
    [
      ["sketch", [2]],
      ["mixing", [1]],
    ],
  );
});

test("bytes on the axis: sum:size over a mount", () => {
  const rows = mountChartRows(mount(), [
    row({ rel: "a", name: "a", size: 100, modified: "2026-06-02 09:00" }),
    row({ rel: "b", name: "b", size: 250, modified: "2026-06-09 09:00" }),
  ]);
  const s = aggregate(rows, rowsConfig("source: Album Pool\nx: modified:month\ny: sum:size\n"));
  assert.deepEqual(
    s.points.map((p) => p.value),
    [350],
  );
});

test("a mount's schema'd x options colour and order its chart the way the board does", () => {
  // a mount IS a schema type, so `stage` on the mount carries the same options
  // the mount's own board wears — the chart must not fall back to
  // first-appearance order and default hues (SUB-982 review must-fix 1)
  const schema = {
    "album pool": {
      stage: {
        options: [
          { value: "sketch", color: "blue" },
          { value: "mixing", color: "red" },
          { value: "mastering", color: "green" },
        ],
      },
    },
  };
  const opts = xSchemaOptions(schema, "Album Pool", "stage");
  assert.deepEqual(
    opts?.map((o) => o.value),
    ["sketch", "mixing", "mastering"],
  );
  const rows = mountChartRows(mount(), [
    // deliberately NOT in schema order
    row({ rel: "a", name: "a", props: { stage: "mastering" } }),
    row({ rel: "b", name: "b", props: { stage: "sketch" } }),
    row({ rel: "c", name: "c", props: { stage: "mixing" } }),
  ]);
  const cfg = rowsConfig("source: Album Pool\nx: stage\ny: count\n");
  assert.deepEqual(
    aggregate(rows, cfg, opts).points.map((p) => p.label),
    ["sketch", "mixing", "mastering"],
  );
  // without the options — what the mount branch did before the fix — the axis
  // is first-appearance order, which is the bug this test pins
  assert.deepEqual(
    aggregate(rows, cfg).points.map((p) => p.label),
    ["mastering", "sketch", "mixing"],
  );
});

// ---------- card aggregate resolution ----------

test("a mount card binds through the existing {{Name.aggregate}} grammar", () => {
  assert.deepEqual(parseBind("{{Album Pool.count}}"), { sheet: "Album Pool", name: "count" });
});

test("count / present / missing over an index that remembers a gone file", () => {
  const rows = [row(), row({ rel: "b", name: "b" }), row({ rel: "c", name: "c", missing: true })];
  assert.equal(mountAggregate(rows, "count"), 3);
  assert.equal(mountAggregate(rows, "present"), 2);
  assert.equal(mountAggregate(rows, "missing"), 1);
});

test("bytes counts only files that are actually there", () => {
  const rows = [
    row({ rel: "a", name: "a", size: 100 }),
    row({ rel: "b", name: "b", size: 900, missing: true }),
  ];
  assert.equal(mountAggregate(rows, "bytes"), 100);
});

test("newest and oldest read the index's own modified stamps", () => {
  const rows = [
    row({ rel: "a", name: "a", modified: "2026-06-02 09:00" }),
    row({ rel: "b", name: "b", modified: "2026-08-01 14:30" }),
    row({ rel: "c", name: "c", modified: "2025-12-24 08:00" }),
  ];
  assert.equal(mountAggregate(rows, "newest"), "2026-08-01 14:30");
  assert.equal(mountAggregate(rows, "oldest"), "2025-12-24 08:00");
});

test("an empty index has no newest file rather than a fabricated date", () => {
  assert.equal(mountAggregate([], "newest"), "");
  assert.equal(mountAggregate([], "count"), 0);
});

test("a row with no stamp never wins newest", () => {
  const rows = [row({ rel: "a", name: "a", modified: "" }), row({ rel: "b", name: "b", modified: "2026-01-02 03:04" })];
  assert.equal(mountAggregate(rows, "newest"), "2026-01-02 03:04");
  assert.equal(mountAggregate(rows, "oldest"), "2026-01-02 03:04");
});

test("aggregate names fold case", () => {
  assert.equal(mountAggregate([row()], "Count"), 1);
  assert.ok(isMountAggregate("NEWEST"));
});

// ---------- one number, one voice ----------

test("bytes speaks the board's size language, not a raw integer", () => {
  // the board's size column says "11,8 MB" via sizeLabel/formatFileSize — a
  // card over the same folder must not say "12.386.304" (review must-fix 4)
  assert.equal(mountCardText("bytes", 12_386_304), sizeLabel({ ...row(), size: 12_386_304 }));
  assert.equal(mountCardText("bytes", 12_386_304), "11,8 MB");
  assert.equal(mountCardText("bytes", 900), "900 B");
  assert.equal(mountCardText("BYTES", 2048), "2,0 KB");
});

test("an explicit format on a bytes card still wins", () => {
  // asking for `number` is asking for the byte count itself
  assert.equal(mountCardText("bytes", 12_386_304, "number"), "12.386.304");
});

test("other aggregates keep the plain card formatter", () => {
  assert.equal(mountCardText("count", 1234), "1234");
  assert.equal(mountCardText("count", 1234, "number"), "1.234");
  assert.equal(mountCardText("newest", "2026-08-01 14:30"), "2026-08-01 14:30");
});

test("an unknown aggregate is null, so the card can name it", () => {
  assert.equal(mountAggregate([row()], "total"), null);
  assert.equal(isMountAggregate("total"), false);
  assert.deepEqual([...MOUNT_AGGREGATES], ["count", "missing", "present", "bytes", "newest", "oldest"]);
});
