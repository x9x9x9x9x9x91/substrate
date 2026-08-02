import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  bucketKey,
  bucketLabel,
  chartSourceDesc,
  chartTitle,
  dateOf,
  dbRows,
  parseChartBlocks,
  parseChartConfig,
  sheetRows,
  xFractions,
  xSchemaOptions,
  summarySeries,
  type RowChartConfig,
} from "./chart.ts";
import { evaluateSheet, parseSheet } from "./sheet.ts";
import { ferr } from "./formula.ts";
import type { NoteMeta } from "./types.ts";

const noFx = () => null;

/** parse a fence known to use the row binding, narrowed so `x`/`y` read */
function parseRow(inner: string): RowChartConfig {
  const c = parseChartConfig(inner);
  assert.equal(c.bind, "rows");
  return c as RowChartConfig;
}

// ---------- parsing ----------

test("parse: database source, date bucket, count, default kind", () => {
  const c = parseRow("source: release\nx: released:month\ny: count\n");
  assert.deepEqual(c.source, { kind: "db", type: "release" });
  assert.deepEqual(c.x, { prop: "released", bucket: "month" });
  assert.deepEqual(c.y, { fn: "count" });
  assert.equal(c.kind, "bar");
  assert.equal(c.title, null);
});

test("parse: sheet source via {{Sheet.name}} binding, sum, line kind", () => {
  const c = parseRow(
    "source: {{Weight Log}}\nx: date:day\ny: avg:weight\nkind: line\ntitle: Weight\n"
  );
  assert.deepEqual(c.source, { kind: "sheet", name: "Weight Log" });
  assert.deepEqual(c.x, { prop: "date", bucket: "day" });
  assert.deepEqual(c.y, { fn: "avg", prop: "weight" });
  assert.equal(c.kind, "line");
  assert.equal(c.title, "Weight");
});

test("parse: categorical x (select prop), sum over number prop", () => {
  const c = parseRow("source: expense\nx: category\ny: sum:amount\nkind: bar");
  assert.deepEqual(c.x, { prop: "category", bucket: null });
  assert.deepEqual(c.y, { fn: "sum", prop: "amount" });
});

test("parse: comments and blank lines are skipped", () => {
  const c = parseRow("# a comment\n\nsource: release\nx: status\ny: count\n");
  assert.deepEqual(c.x, { prop: "status", bucket: null });
});

test("parse errors: missing keys, bad kind, bad bucket, bad y, unknown key, junk line", () => {
  assert.throws(() => parseChartConfig("x: a\ny: count"), /missing required key "source"/);
  assert.throws(() => parseChartConfig("source: r\ny: count"), /missing required key "x"/);
  assert.throws(() => parseChartConfig("source: r\nx: a"), /missing required key "y"/);
  assert.throws(() => parseChartConfig("source: r\nx: a\ny: count\nkind: pie"), /bar or line/);
  assert.throws(() => parseChartConfig("source: r\nx: a:quarter\ny: count"), /unknown x bucket/);
  assert.throws(() => parseChartConfig("source: r\nx: a\ny: max:v"), /y must be count/);
  assert.throws(() => parseChartConfig("source: r\nx: a\ny: count\nwidth: 3"), /unknown key/);
  assert.throws(() => parseChartConfig("source: r\nx: a\ny: count\nnot a line"), /can't parse line/);
});

test("parseChartBlocks: finds all fences in order, keeps errors per block", () => {
  const body = [
    "Some prose.",
    "",
    "```chart",
    "source: release",
    "x: released:month",
    "y: count",
    "```",
    "",
    "More prose with a ```csv fence.",
    "",
    "```chart",
    "y: count",
    "```",
    "",
  ].join("\n");
  const blocks = parseChartBlocks(body);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].error, null);
  assert.deepEqual(blocks[0].config?.source, { kind: "db", type: "release" });
  assert.equal(blocks[1].config, null);
  assert.match(blocks[1].error ?? "", /missing required key "source"/);
  assert.equal(parseChartBlocks("no fences here").length, 0);
});

// ---------- date bucketing ----------

test("dateOf: leading ISO date, datetime strings, rejects junk", () => {
  assert.equal(dateOf("2026-07-17"), "2026-07-17");
  assert.equal(dateOf("2026-07-17 10:28"), "2026-07-17");
  assert.equal(dateOf("  2026-07-17  "), "2026-07-17");
  assert.equal(dateOf("Jul 17, 2026"), null);
  assert.equal(dateOf("2026-13-01"), null);
});

test("bucketKey/label: day, month, week (Monday-first, across month/year edges)", () => {
  assert.equal(bucketKey("2026-07-17", "day"), "2026-07-17");
  assert.equal(bucketLabel("2026-07-17", "day"), "Jul 17");
  assert.equal(bucketKey("2026-07-17", "month"), "2026-07");
  assert.equal(bucketLabel("2026-07", "month"), "Jul 2026");
  // 2026-07-17 is a Friday → Monday of that week is 2026-07-13
  assert.equal(bucketKey("2026-07-17", "week"), "2026-07-13");
  assert.equal(bucketLabel("2026-07-13", "week"), "Jul 13");
  // Sunday belongs to the same week (Mon start)
  assert.equal(bucketKey("2026-07-19", "week"), "2026-07-13");
  // week crossing a month boundary
  assert.equal(bucketKey("2026-08-02", "week"), "2026-07-27");
  // week crossing a year boundary: 2026-01-01 is a Thursday → Monday is 2025-12-29
  assert.equal(bucketKey("2026-01-01", "week"), "2025-12-29");
});

// ---------- x fractions ----------

test("xFractions: regular day spacing stays even", () => {
  assert.deepEqual(
    xFractions(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]),
    [0, 0.25, 0.5, 0.75, 1]
  );
});

test("xFractions: irregular snapshots space by time — 14/7/7/14-day gaps", () => {
  // Jun 1 → Jul 13 spans 42 days: fractions 0, 14/42, 21/42, 28/42, 1
  assert.deepEqual(
    xFractions(["2026-06-01", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-13"]),
    [0, 1 / 3, 1 / 2, 2 / 3, 1]
  );
});

test("xFractions: month buckets are time too, taken as their 1st", () => {
  // May 1 → Aug 1 spans 92 days; Jun 1 lands at 31/92
  const [a, b, c] = xFractions(["2026-05", "2026-06", "2026-08"]);
  assert.equal(a, 0);
  assert.ok(Math.abs(b - 31 / 92) < 1e-9, `expected ~${31 / 92}, got ${b}`);
  assert.equal(c, 1);
});

test("xFractions: categorical or mixed keys fall back to even index spacing", () => {
  assert.deepEqual(xFractions(["food", "gear", "misc"]), [0, 0.5, 1]);
  assert.deepEqual(xFractions(["2026-07-01", "banana", "2026-07-05"]), [0, 0.5, 1]);
});

test("xFractions: a single point centers", () => {
  assert.deepEqual(xFractions(["2026-07-17"]), [0.5]);
  assert.deepEqual(xFractions(["whatever"]), [0.5]);
});

test("xFractions: duplicate dates share an x, order kept", () => {
  assert.deepEqual(xFractions(["2026-06-01", "2026-06-01", "2026-06-15"]), [0, 0, 1]);
  // all one instant → all centered, like a single point
  assert.deepEqual(xFractions(["2026-06-01", "2026-06-01"]), [0.5, 0.5]);
});

test("xFractions: unsorted date keys fall back to even spacing — never silently re-sorted", () => {
  assert.deepEqual(xFractions(["2026-07-05", "2026-07-01", "2026-07-03"]), [0, 0.5, 1]);
});

test("xFractions: empty series", () => {
  assert.deepEqual(xFractions([]), []);
});

// ---------- aggregation ----------

function cfg(over: Partial<RowChartConfig>): RowChartConfig {
  return {
    source: { kind: "db", type: "release" },
    bind: "rows",
    x: { prop: "released", bucket: "month" },
    y: { fn: "count" },
    kind: "bar",
    title: null,
    ...over,
  };
}

test("aggregate: count over date buckets, sorted ascending, skips bad rows", () => {
  const rows = [
    { released: "2026-08-02" },
    { released: "2026-05-30" },
    { released: "2026-06-19" },
    { released: "2026-06-27" },
    { released: "not a date" },
    { status: "live" }, // missing x
  ];
  const s = aggregate(rows, cfg({}));
  assert.deepEqual(
    s.points.map((p) => [p.key, p.label, p.value, p.n]),
    [
      ["2026-05", "May 2026", 1, 1],
      ["2026-06", "Jun 2026", 2, 2],
      ["2026-07", "Jul 2026", 0, 0], // empty month zero-filled, not skipped
      ["2026-08", "Aug 2026", 1, 1],
    ]
  );
  assert.equal(s.skipped, 2);
});

test("aggregate: bar time axes zero-fill empty buckets (month across a year turn, day)", () => {
  const months = aggregate(
    [{ released: "2026-11-05" }, { released: "2027-02-14" }],
    cfg({})
  );
  assert.deepEqual(
    months.points.map((p) => [p.key, p.label, p.value]),
    [
      ["2026-11", "Nov 2026", 1],
      ["2026-12", "Dec 2026", 0],
      ["2027-01", "Jan 2027", 0],
      ["2027-02", "Feb 2027", 1],
    ]
  );
  const days = aggregate(
    [{ released: "2026-07-30" }, { released: "2026-08-02" }],
    cfg({ x: { prop: "released", bucket: "day" } })
  );
  assert.deepEqual(
    days.points.map((p) => [p.key, p.value]),
    [
      ["2026-07-30", 1],
      ["2026-07-31", 0],
      ["2026-08-01", 0],
      ["2026-08-02", 1],
    ]
  );
});

test("aggregate: line charts keep only real points — no zero-fill", () => {
  const s = aggregate(
    [{ released: "2026-05-30" }, { released: "2026-08-02" }],
    cfg({ kind: "line" })
  );
  assert.deepEqual(s.points.map((p) => p.key), ["2026-05", "2026-08"]);
});

test("aggregate: zero-fill bails when a stray date would explode the axis", () => {
  const s = aggregate(
    [{ released: "2026-07-01" }, { released: "1999-01-01" }],
    cfg({ x: { prop: "released", bucket: "day" } })
  );
  assert.deepEqual(s.points.map((p) => p.key), ["1999-01-01", "2026-07-01"]);
});

test("aggregate: sum and avg over a number prop, string numbers coerced", () => {
  const rows = [
    { category: "food", amount: "10" },
    { category: "food", amount: 5.5 },
    { category: "gear", amount: "100" },
    { category: "gear", amount: "nope" }, // non-numeric y → skipped
  ];
  const sum = aggregate(rows, cfg({ x: { prop: "category", bucket: null }, y: { fn: "sum", prop: "amount" } }));
  assert.deepEqual(
    sum.points.map((p) => [p.key, p.value, p.n]),
    [
      ["food", 15.5, 2],
      ["gear", 100, 1],
    ]
  );
  assert.equal(sum.skipped, 1);
  const avg = aggregate(rows, cfg({ x: { prop: "category", bucket: null }, y: { fn: "avg", prop: "amount" } }));
  assert.deepEqual(avg.points.map((p) => [p.key, p.value]), [
    ["food", 7.75],
    ["gear", 100],
  ]);
});

test("aggregate: y strings parse strictly — 1e3/0x10/Infinity are skipped, not charted (SUB-675)", () => {
  const rows = [
    { category: "food", amount: "10" },
    { category: "food", amount: "1e3" }, // exponent → text, not 1000
    { category: "food", amount: "0x10" }, // hex → text, not 16
    { category: "food", amount: "Infinity" }, // would break every bar height
    { category: "food", amount: "-Infinity" },
    { category: "food", amount: " 2.5 " }, // padding is still fine
  ];
  const sum = aggregate(rows, cfg({ x: { prop: "category", bucket: null }, y: { fn: "sum", prop: "amount" } }));
  assert.deepEqual(
    sum.points.map((p) => [p.key, p.value, p.n]),
    [["food", 12.5, 2]]
  );
  assert.equal(sum.skipped, 4);
});

test("aggregate: sheet-source y strings parse strictly too (SUB-675)", () => {
  const body = [
    "```csv",
    "asset,bucket,units",
    "A,etf,10",
    "B,etf,1e3",
    "C,etf,Infinity",
    "```",
    "",
  ].join("\n");
  const model = parseSheet(body);
  const ev = evaluateSheet(model, noFx);
  const rows = sheetRows(model, ev);
  const s = aggregate(rows, cfg({ x: { prop: "bucket", bucket: null }, y: { fn: "sum", prop: "units" } }));
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value, p.n]),
    [["etf", 10, 1]]
  );
  assert.equal(s.skipped, 2);
});

test("aggregate: non-finite numeric y is skipped, matching the string branch (SUB-675)", () => {
  const rows = [
    { category: "food", amount: 4 },
    { category: "food", amount: Infinity },
    { category: "food", amount: NaN },
  ];
  const s = aggregate(rows, cfg({ x: { prop: "category", bucket: null }, y: { fn: "sum", prop: "amount" } }));
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value, p.n]),
    [["food", 4, 1]]
  );
  assert.equal(s.skipped, 2);
});

test("aggregate: categorical axis keeps first-appearance order, prop lookup is case-insensitive", () => {
  const rows = [
    { Status: "in review" },
    { Status: "live" },
    { Status: "in review" },
  ];
  const s = aggregate(rows, cfg({ x: { prop: "status", bucket: null } }));
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value]),
    [
      ["in review", 2],
      ["live", 1],
    ]
  );
});

test("aggregate: categorical axis follows schema option order, unschematized values last in appearance order", () => {
  const rows = [
    { status: "parked" },
    { status: "custom" },
    { status: "mastering" },
    { status: "Live" }, // case-insensitive match to the "live" option
    { status: "zzz" },
    { status: "in review" },
  ];
  const options = ["live", "in review", "mastering", "parked"].map((value) => ({ value }));
  const s = aggregate(rows, cfg({ x: { prop: "status", bucket: null } }), options);
  assert.deepEqual(
    s.points.map((p) => p.key),
    ["Live", "in review", "mastering", "parked", "custom", "zzz"]
  );
});

test("xSchemaOptions: resolves type and prop case-insensitively (SUB-679)", () => {
  const options = ["live", "in review", "mastering", "parked"].map((value) => ({ value }));
  const schema = { release: { Status: { options }, notes: { options: [] } } };
  // exact keys keep working
  assert.deepEqual(xSchemaOptions(schema, "release", "Status"), options);
  // either level mis-cased still finds the entry
  assert.deepEqual(xSchemaOptions(schema, "Release", "status"), options);
  assert.deepEqual(xSchemaOptions(schema, "RELEASE", "STATUS"), options);
  // genuinely absent type/prop stays undefined
  assert.equal(xSchemaOptions(schema, "track", "status"), undefined);
  assert.equal(xSchemaOptions(schema, "release", "nope"), undefined);
});

test("aggregate: mixed-case schema keys sort exactly like exact-case ones (SUB-679)", () => {
  const rows = [
    { Status: "parked" },
    { Status: "mastering" },
    { Status: "live" },
  ];
  const options = ["live", "in review", "mastering", "parked"].map((value) => ({ value }));
  // schema keyed `Status` under `Release`; the fence says `source: release` / `x: status`
  const schema = { Release: { Status: { options } } };
  const config = cfg({ source: { kind: "db", type: "release" }, x: { prop: "status", bucket: null } });
  const s = aggregate(rows, config, xSchemaOptions(schema, "release", config.x.prop));
  assert.deepEqual(
    s.points.map((p) => p.key),
    ["live", "mastering", "parked"] // schema option order, not row-arrival order
  );
});

test("aggregate: xOptions are ignored for date-bucketed axes", () => {
  const rows = [{ released: "2026-08-02" }, { released: "2026-05-30" }];
  const options = ["2026-08", "2026-05"].map((value) => ({ value }));
  const s = aggregate(rows, cfg({}), options);
  assert.deepEqual(
    s.points.map((p) => p.key),
    ["2026-05", "2026-06", "2026-07", "2026-08"] // ascending + zero-filled, options ignored
  );
});

test("aggregate: line over day buckets from datetime strings", () => {
  const rows = [
    { at: "2026-07-17 10:28", weight: "71.4" },
    { at: "2026-07-17 18:02", weight: "71.8" },
    { at: "2026-07-18 09:10", weight: "71.1" },
  ];
  const s = aggregate(rows, cfg({ x: { prop: "at", bucket: "day" }, y: { fn: "avg", prop: "weight" } }));
  assert.deepEqual(
    s.points.map((p) => [p.key, Math.round(p.value * 100) / 100]),
    [
      ["2026-07-17", 71.6],
      ["2026-07-18", 71.1],
    ]
  );
});

// ---------- row sources ----------

function note(path: string, props: Record<string, unknown>): NoteMeta {
  return {
    path,
    stem: path.replace(/\.md$/, ""),
    title: path.replace(/\.md$/, ""),
    folder: "",
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

test("dbRows: filters by type (case-insensitive), lowercases prop keys", () => {
  const notes = [
    note("A.md", { type: "release", Released: "2026-05-30" }),
    note("B.md", { type: "Release", released: "2026-06-19" }),
    note("C.md", { type: "gear", released: "2026-07-01" }),
  ];
  const rows = dbRows(notes, "release");
  assert.equal(rows.length, 2);
  const s = aggregate(rows, cfg({}));
  assert.deepEqual(s.points.map((p) => p.key), ["2026-05", "2026-06"]);
});

test("sheetRows: data columns typed, computed columns available for sum", () => {
  const body = [
    "```csv",
    "asset,bucket,units,price_usd",
    "GLOW,etf,1200,31.4",
    "BTC,crypto,4.1,64200",
    "ARC,etf,80,92.5",
    "```",
    "",
    "```formulas",
    "value_usd = units * price_usd",
    "```",
    "",
  ].join("\n");
  const model = parseSheet(body);
  const ev = evaluateSheet(model, noFx);
  const rows = sheetRows(model, ev);
  assert.equal(rows.length, 3);
  const s = aggregate(
    rows,
    cfg({ x: { prop: "bucket", bucket: null }, y: { fn: "sum", prop: "value_usd" } })
  );
  assert.deepEqual(
    s.points.map((p) => [p.key, Math.round(p.value)]),
    [
      ["etf", 45080], // 1200*31.4 + 80*92.5
      ["crypto", 263220],
    ]
  );
});

test("sheetRows: a cross-sheet computed column resolves through the loader (SUB-671)", () => {
  const splits = parseSheet(
    ["```csv", "label,owed", "Umbra,400", "Vessel,600", "```", "", "```formulas", "owed_total = SUM(owed)", "```", ""].join(
      "\n"
    )
  );
  const body = [
    "```csv",
    "month,net_eur",
    "2026-05,3000",
    "2026-06,5000",
    "```",
    "",
    "```formulas",
    'owed_eur = net_eur - "Label Splits".owed_total',
    "```",
    "",
  ].join("\n");
  const model = parseSheet(body);
  const load = (n: string) => (n.toLowerCase() === "label splits" ? splits : ferr("no"));

  // what ChartsDashboard used to do: no cross context → every cell an FErr,
  // so every row is skipped and the chart reads "No rows matched"
  const bare = aggregate(
    sheetRows(model, evaluateSheet(model, noFx)),
    cfg({ x: { prop: "month", bucket: null }, y: { fn: "sum", prop: "owed_eur" } })
  );
  assert.deepEqual(bare.points, []);
  assert.equal(bare.skipped, 2);

  // with the loader the column is real numbers: 3000-1000, 5000-1000
  const ev = evaluateSheet(model, noFx, { self: "Revenue", load });
  const s = aggregate(
    sheetRows(model, ev),
    cfg({ x: { prop: "month", bucket: null }, y: { fn: "sum", prop: "owed_eur" } })
  );
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value]),
    [
      ["2026-05", 2000],
      ["2026-06", 4000],
    ]
  );
  assert.equal(s.skipped, 0);
});

test("aggregate: an errored x cell skips its row — never '[object Object]' (SUB-671)", () => {
  const rows = [
    { bucket: ferr("unknown sheet value “splits.owed_total”"), amount: 10 },
    { bucket: "etf", amount: 5 },
    { bucket: ferr("boom"), amount: 7 },
    { bucket: { nested: "object" }, amount: 3 }, // any non-scalar, same treatment
  ];
  const s = aggregate(
    rows,
    cfg({ x: { prop: "bucket", bucket: null }, y: { fn: "sum", prop: "amount" } })
  );
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value]),
    [["etf", 5]]
  );
  assert.equal(s.skipped, 3);
  assert.equal(
    s.points.some((p) => p.label.includes("object Object")),
    false
  );
  // A date axis accepts only scalar dates: errors and string lists both skip.
  // Joining the list here would make dateOf silently take its first item.
  const dated = aggregate(
    [
      { at: ferr("boom") },
      { at: ["2026-07-16", "2026-07-17"] },
      { at: "2026-07-17" },
    ],
    cfg({ x: { prop: "at", bucket: "day" } })
  );
  assert.deepEqual(dated.points.map((p) => p.key), ["2026-07-17"]);
  assert.equal(dated.skipped, 2);
});

test("aggregate: string-list x cells join honestly; invalid lists stay skipped", () => {
  const rows = [
    { tags: ["ambient"], amount: 2 },
    { tags: ["ambient", "field"], amount: 3 },
    { tags: ["ambient", "field"], amount: 5 },
    { tags: [], amount: 7 },
    { tags: ["ambient", 42], amount: 11 },
    { tags: [{ nested: "object" }], amount: 13 },
    { tags: ferr("boom"), amount: 17 },
  ];
  const s = aggregate(
    rows,
    cfg({ x: { prop: "tags", bucket: null }, y: { fn: "sum", prop: "amount" } })
  );

  assert.deepEqual(
    s.points.map((p) => [p.key, p.label, p.value, p.n]),
    [
      ["ambient", "ambient", 2, 1],
      ["ambient, field", "ambient, field", 8, 2],
    ]
  );
  assert.equal(s.skipped, 4);
  assert.equal(
    s.points.some((p) => p.label.includes("object Object")),
    false
  );
});

test("aggregate: scalar non-strings still label (numbers, booleans)", () => {
  const s = aggregate(
    [{ year: 2026 }, { year: 2026 }, { year: 2025 }, { done: true }],
    cfg({ x: { prop: "year", bucket: null } })
  );
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value]),
    [
      ["2026", 2],
      ["2025", 1],
    ]
  );
  assert.equal(s.skipped, 1); // the row with no year at all
  const bools = aggregate([{ done: true }, { done: false }, { done: true }], cfg({ x: { prop: "done", bucket: null } }));
  assert.deepEqual(
    bools.points.map((p) => [p.key, p.value]),
    [
      ["true", 2],
      ["false", 1],
    ]
  );
});

// ---------- named binding misses (SUB-749) ----------

test("aggregate: a renamed sheet column is named, not 'No rows matched' (SUB-749)", () => {
  // the issue's repro: the chart binds y: sum:value_usd, the grid renames the
  // column to usd, so every row skips for the same absent column
  const body = [
    "```csv",
    "asset,bucket,units,price_usd",
    "GLOW,etf,1200,31.4",
    "BTC,crypto,4.1,64200",
    "```",
    "",
    "```formulas",
    "usd = units * price_usd",
    "```",
    "",
  ].join("\n");
  const model = parseSheet(body);
  const rows = sheetRows(model, evaluateSheet(model, noFx));
  const s = aggregate(
    rows,
    cfg({
      source: { kind: "sheet", name: "Holdings" },
      x: { prop: "bucket", bucket: null },
      y: { fn: "sum", prop: "value_usd" },
    })
  );
  assert.deepEqual(s.points, []);
  assert.equal(s.skipped, 2);
  assert.equal(
    s.missing,
    "no column “value_usd” on Holdings (has: asset, bucket, units, price_usd, usd)"
  );
});

test("aggregate: a missing x column reports by name; both missing report together", () => {
  const rows = [
    { asset: "GLOW", bucket: "etf", usd: 10 },
    { asset: "BTC", bucket: "crypto", usd: 20 },
  ];
  const x = aggregate(
    rows,
    cfg({
      source: { kind: "sheet", name: "Holdings" },
      x: { prop: "sector", bucket: null },
      y: { fn: "sum", prop: "usd" },
    })
  );
  assert.equal(x.missing, "no column “sector” on Holdings (has: asset, bucket, usd)");

  const both = aggregate(
    rows,
    cfg({
      source: { kind: "sheet", name: "Holdings" },
      x: { prop: "sector", bucket: null },
      y: { fn: "sum", prop: "value_usd" },
    })
  );
  assert.equal(
    both.missing,
    "no columns “sector” or “value_usd” on Holdings (has: asset, bucket, usd)"
  );

  // a count chart binds no y, so only x can go missing
  const counted = aggregate(rows, cfg({ source: { kind: "sheet", name: "Holdings" }, x: { prop: "sector", bucket: null } }));
  assert.equal(counted.missing, "no column “sector” on Holdings (has: asset, bucket, usd)");
});

test("aggregate: a database source says 'property' and names the type (SUB-749)", () => {
  const notes = [
    note("A.md", { type: "release", released: "2026-05-30", label: "Aviary" }),
    note("B.md", { type: "release", released: "2026-06-19", label: "Aviary" }),
  ];
  const s = aggregate(dbRows(notes, "release"), cfg({ y: { fn: "sum", prop: "revenue" } }));
  assert.equal(
    s.missing,
    "no property “revenue” on release (has: title, type, released, label)"
  );
});

test("aggregate: a present column keeps the neutral empty state (SUB-749)", () => {
  // the column exists; its cells simply never plot — filters excluding
  // everything, unparseable values, an errored computed column. That is a
  // genuine zero-match, and accusing the column would be a lie.
  const s = aggregate(
    [
      { bucket: "etf", value_usd: "n/a" },
      { bucket: "crypto", value_usd: ferr("boom") },
    ],
    cfg({
      source: { kind: "sheet", name: "Holdings" },
      x: { prop: "bucket", bucket: null },
      y: { fn: "sum", prop: "value_usd" },
    })
  );
  assert.deepEqual(s.points, []);
  assert.equal(s.skipped, 2);
  assert.equal(s.missing, null);

  // an empty source has no column universe to judge against — nothing claimed
  const empty = aggregate(
    [],
    cfg({ source: { kind: "sheet", name: "Holdings" }, y: { fn: "sum", prop: "value_usd" } })
  );
  assert.equal(empty.missing, null);
  assert.deepEqual(empty.points, []);
});

test("aggregate: binding names fold case, like every other lookup (SUB-749)", () => {
  const s = aggregate(
    [{ Bucket: "etf", Value_USD: 10 }],
    cfg({
      source: { kind: "sheet", name: "Holdings" },
      x: { prop: "bucket", bucket: null },
      y: { fn: "sum", prop: "value_usd" },
    })
  );
  assert.equal(s.missing, null);
  assert.deepEqual(
    s.points.map((p) => [p.key, p.value]),
    [["etf", 10]]
  );
});

test("aggregate: a row missing the column doesn't accuse it — the union decides", () => {
  // sparse db props: only some notes carry `revenue`, which is presence enough
  const s = aggregate(
    [{ released: "2026-05-30" }, { released: "2026-06-19", revenue: 42 }],
    cfg({ y: { fn: "sum", prop: "revenue" } })
  );
  assert.equal(s.missing, null);
  assert.equal(s.skipped, 1);
});

test("summarySeries: no binding-miss field to carry — misses are already named", () => {
  const model = parseSheet(BUCKET_SHEET);
  const { series } = summarySeries(evaluateSheet(model, noFx), ["etf"]);
  assert.equal(series?.missing, null);
});

test("chartSourceDesc: human provenance for both source kinds (SUB-180)", () => {
  assert.equal(chartSourceDesc(cfg({})), "database: release");
  assert.equal(
    chartSourceDesc(cfg({ source: { kind: "sheet", name: "Weight Log" } })),
    "sheet: Weight Log"
  );
});

test("chartTitle: explicit title wins, else derived", () => {
  assert.equal(chartTitle(cfg({ title: "Releases per month" })), "Releases per month");
  assert.equal(chartTitle(cfg({})), "Release per month");
  assert.equal(
    chartTitle(cfg({ x: { prop: "category", bucket: null }, y: { fn: "sum", prop: "amount" } })),
    "Sum of amount by category"
  );
});

// ---------- summary binding (SUB-745) ----------

/** the shape the issue names: bucket totals live as summaries (a COUNTIF /
    SUMIF set), NOT as materialized bucket rows */
const BUCKET_SHEET = [
  "```csv",
  "asset,bucket,value_eur",
  "GLOW,etf,41000",
  "ARC,etf,7400",
  "BTC,crypto,263220",
  "EUR,cash,12000",
  "```",
  "",
  "```formulas",
  "etf    = SUMIF(bucket, \"etf\", value_eur)",
  "crypto = SUMIF(bucket, \"crypto\", value_eur)",
  "cash   = SUMIF(bucket, \"cash\", value_eur)",
  "n_etf  = COUNTIF(bucket, \"etf\")",
  "label  = \"portfolio\"",
  "```",
  "",
].join("\n");

function bucketEval() {
  const model = parseSheet(BUCKET_SHEET);
  return evaluateSheet(model, noFx);
}

test("parse: series binds sheet summaries, no x/y needed (SUB-745)", () => {
  const c = parseChartConfig("source: {{Holdings}}\nseries: etf, crypto, cash\n");
  assert.equal(c.bind, "summaries");
  assert.deepEqual(c.source, { kind: "sheet", name: "Holdings" });
  assert.deepEqual(c.bind === "summaries" ? c.series : null, ["etf", "crypto", "cash"]);
  assert.equal(c.kind, "bar");
  assert.equal(c.title, null);
});

test("parse: series accepts kind/title and tolerates ragged commas (SUB-745)", () => {
  const c = parseChartConfig(
    "source: {{Holdings}}\nseries:  etf ,, crypto ,\nkind: line\ntitle: Buckets\n"
  );
  assert.deepEqual(c.bind === "summaries" ? c.series : null, ["etf", "crypto"]);
  assert.equal(c.kind, "line");
  assert.equal(c.title, "Buckets");
});

test("parse errors: series is exclusive with x/y, sheet-only, non-empty (SUB-745)", () => {
  assert.throws(
    () => parseChartConfig("source: {{Holdings}}\nseries: etf\nx: bucket\ny: count"),
    /drop x and y, or drop series/
  );
  assert.throws(
    () => parseChartConfig("source: {{Holdings}}\nseries: etf\nx: bucket"),
    /drop x and y, or drop series/
  );
  assert.throws(() => parseChartConfig("source: release\nseries: etf"), /must be \{\{Sheet Name\}\}/);
  assert.throws(() => parseChartConfig("source: {{Holdings}}\nseries: , ,"), /at least one summary/);
  // x/y stay required when series is absent
  assert.throws(() => parseChartConfig("source: {{Holdings}}"), /missing required key "x"/);
});

test("summarySeries: a summary-bound chart renders one point per named summary (SUB-745)", () => {
  const { series, error } = summarySeries(bucketEval(), ["etf", "crypto", "cash"]);
  assert.equal(error, null);
  assert.deepEqual(
    series?.points.map((p) => [p.key, p.label, p.value, p.n]),
    [
      ["etf", "etf", 48400, 1],
      ["crypto", "crypto", 263220, 1],
      ["cash", "cash", 12000, 1],
    ]
  );
  assert.equal(series?.skipped, 0);
});

test("summarySeries: fence order is the axis order, names match case-insensitively (SUB-745)", () => {
  const { series } = summarySeries(bucketEval(), ["CASH", "Etf"]);
  assert.deepEqual(
    series?.points.map((p) => [p.label, p.value]),
    [
      ["cash", 12000], // the sheet's own casing, not the fence's
      ["etf", 48400],
    ]
  );
});

test("summarySeries: a missing summary name is an honest error, not an empty chart (SUB-745)", () => {
  const { series, error } = summarySeries(bucketEval(), ["etf", "bonds"]);
  assert.equal(series, null);
  assert.match(error ?? "", /no summary “bonds” on this sheet/);
  // every bad name reports, not just the first
  const many = summarySeries(bucketEval(), ["bonds", "reits"]);
  assert.match(many.error ?? "", /“bonds”[\s\S]*“reits”/);
});

test("summarySeries: a row column is not a summary — naming one errors (SUB-745)", () => {
  const { series, error } = summarySeries(bucketEval(), ["value_eur"]);
  assert.equal(series, null);
  assert.match(error ?? "", /no summary “value_eur” on this sheet/);
});

test("summarySeries: error and non-numeric summaries report by name, never plot as 0 (SUB-745)", () => {
  const broken = evaluateSheet(
    parseSheet(
      ["```csv", "a", "1", "```", "", "```formulas", "boom = SUM(nope)", "```", ""].join("\n")
    ),
    noFx
  );
  const b = summarySeries(broken, ["boom"]);
  assert.equal(b.series, null);
  assert.match(b.error ?? "", /summary “boom”: /);

  const t = summarySeries(bucketEval(), ["label"]);
  assert.equal(t.series, null);
  assert.match(t.error ?? "", /summary “label” is not a number/);
});

test("summarySeries: counts bind too — COUNTIF buckets chart without bucket rows (SUB-745)", () => {
  const { series } = summarySeries(bucketEval(), ["n_etf"]);
  assert.deepEqual(
    series?.points.map((p) => [p.label, p.value]),
    [["n_etf", 2]]
  );
});

test("chartTitle/chartSourceDesc: summary charts derive an honest title (SUB-745)", () => {
  const c = parseChartConfig("source: {{Holdings}}\nseries: etf, crypto\n");
  assert.equal(chartTitle(c), "Holdings summaries");
  assert.equal(chartSourceDesc(c), "sheet: Holdings");
  const titled = parseChartConfig("source: {{Holdings}}\nseries: etf\ntitle: Buckets\n");
  assert.equal(chartTitle(titled), "Buckets");
});

test("parseChartBlocks: summary fences parse alongside row fences (SUB-745)", () => {
  const body = [
    "```chart",
    "source: {{Holdings}}",
    "series: etf, crypto",
    "```",
    "",
    "```chart",
    "source: release",
    "x: released:month",
    "y: count",
    "```",
  ].join("\n");
  const blocks = parseChartBlocks(body);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[0].config?.bind, "summaries");
  assert.equal(blocks[1].config?.bind, "rows");
});
