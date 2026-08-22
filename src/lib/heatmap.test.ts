import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heatmapDbRows,
  heatmapGrid,
  heatmapLevel,
  heatmapSourceDesc,
  heatmapTitle,
  heatmapYears,
  parseHeatmapBlocks,
  parseHeatmapConfig,
  pickHeatmapYear,
  tallyHeatmap,
  type HeatmapConfig,
} from "./heatmap.ts";
import { sheetRows, type ChartRow } from "./chart.ts";
import { evaluateSheet, parseSheet } from "./sheet.ts";
import type { NoteMeta } from "./types.ts";

const noFx = () => null;

function note(path: string, props: Record<string, unknown>): NoteMeta {
  return {
    path,
    stem: path.replace(/\.md$/, ""),
    title: path.replace(/\.md$/, ""),
    folder: "",
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

function cfg(inner: string): HeatmapConfig {
  return parseHeatmapConfig(inner);
}

/** count-per-`logged` over a database, the common shape */
const COUNT = cfg("source: session\ndate: logged\nvalue: count");

// ---------- config parsing ----------

test("parses the full key set", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes\nquery: status:done");
  assert.deepEqual(c.source, { kind: "db", type: "session" });
  assert.equal(c.date, "logged");
  assert.deepEqual(c.value, { fn: "sum", prop: "minutes" });
  assert.equal(c.query, "status:done");
});

test("query is optional and absent reads as null", () => {
  assert.equal(COUNT.query, null);
});

test("a {{Sheet}} source parses as a sheet", () => {
  const c = cfg("source: {{Time Log}}\ndate: day\nvalue: sum:hours");
  assert.deepEqual(c.source, { kind: "sheet", name: "Time Log" });
});

test("keys and count are case-insensitive, values keep their casing", () => {
  const c = cfg("Source: Session\nDATE: Logged\nvalue: COUNT");
  assert.deepEqual(c.source, { kind: "db", type: "Session" });
  assert.equal(c.date, "Logged");
  assert.deepEqual(c.value, { fn: "count" });
});

test("sum: keeps the property's casing and trims it", () => {
  assert.deepEqual(cfg("source: s\ndate: d\nvalue: Sum:  Value USD ").value, {
    fn: "sum",
    prop: "Value USD",
  });
});

test("blank lines and # comments are skipped", () => {
  const c = cfg("\n# the year of sessions\nsource: session\n\ndate: logged\nvalue: count\n");
  assert.equal(c.date, "logged");
});

test("every malformed config is named", () => {
  const cases: [string, RegExp][] = [
    ["date: logged\nvalue: count", /missing required key "source"/],
    ["source: session\nvalue: count", /missing required key "date"/],
    ["source: session\ndate: logged", /missing required key "value"/],
    ["source: session\ndate: logged\nvalue: count\nkind: bar", /unknown key "kind"/],
    ["source: session\ndate: logged\nvalue: count\ndate: other", /duplicate key "date"/],
    ["source: session\ndate: logged\nvalue: count\nnonsense", /can't parse line: nonsense/],
    ["source: session\ndate: logged\nvalue: avg:minutes", /value must be count or sum:<prop>/],
    ["source: session\ndate: logged\nvalue: total", /value must be count or sum:<prop>/],
    ["source: session\ndate: logged\nvalue: sum", /value must be count or sum:<prop>/],
    ["source: session\ndate: logged\nvalue: sum:", /value must be count or sum:<prop> — got "sum:"/],
    ["source: session\ndate: logged\nvalue: sum:   ", /value must be count or sum:<prop>/],
    ["source: session\nvalue: count\ndate:", /can't parse line: date:/],
    ["source:\ndate: d\nvalue: count", /can't parse line: source:/],
  ];
  for (const [inner, re] of cases) {
    assert.throws(() => parseHeatmapConfig(inner), re, inner);
  }
});

test("an unknown key names the keys a heatmap does take", () => {
  assert.throws(
    () => cfg("source: s\ndate: d\nvalue: count\ntitle: Sessions"),
    /unknown key "title" — heatmaps take source, date, value, query/,
  );
});

test("query on a sheet source is a named error, not a silent no-op", () => {
  assert.throws(
    () => cfg("source: {{Time Log}}\ndate: day\nvalue: count\nquery: status:done"),
    /query filters database notes — drop query, or source a database/,
  );
});

// ---------- block scanning ----------

test("parseHeatmapBlocks returns one block per fence, in order", () => {
  const body = [
    "# Year",
    "```heatmap",
    "source: session",
    "date: logged",
    "value: count",
    "```",
    "prose between",
    "```heatmap",
    "source: session",
    "date: logged",
    "value: avg:minutes",
    "```",
  ].join("\n");
  const blocks = parseHeatmapBlocks(body);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[0].config?.date, "logged");
  assert.equal(blocks[1].config, null);
  assert.match(blocks[1].error ?? "", /value must be count or sum:<prop>/);
});

test("a broken fence never throws and never hides its siblings", () => {
  const body = "```heatmap\nnope\n```\n```heatmap\nsource: s\ndate: d\nvalue: count\n```";
  const blocks = parseHeatmapBlocks(body);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].error ?? "", /can't parse line: nope/);
  assert.equal(blocks[1].error, null);
});

test("CRLF fences parse", () => {
  const blocks = parseHeatmapBlocks("```heatmap\r\nsource: s\r\ndate: d\r\nvalue: count\r\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[0].config?.date, "d");
});

test("an opener with a stray trailing space still parses", () => {
  // the likeliest hand-typo of an opener; the year grid simply never drew.
  for (const open of ["```heatmap ", "```HeatMap\t"]) {
    const blocks = parseHeatmapBlocks(open + "\nsource: s\ndate: d\nvalue: count\n```");
    assert.equal(blocks.length, 1, open);
    assert.equal(blocks[0].error, null, open);
  }
  // still bare-form: a real second word is prose
  assert.equal(parseHeatmapBlocks("```heatmap year\nsource: s\ndate: d\nvalue: count\n```").length, 0);
});

test("a mixed-case opener parses, like the hub's dispatcher (SUB-1129)", () => {
  const blocks = parseHeatmapBlocks("```HeatMap\nsource: session\ndate: logged\nvalue: count\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[0].config?.date, "logged");
  // still bare-form: a tail is prose here as it is on the hub
  assert.equal(parseHeatmapBlocks("```HeatMap tail\nsource: s\ndate: d\nvalue: count\n```").length, 0);
});

test("other fences are not heatmap fences", () => {
  assert.equal(parseHeatmapBlocks("```chart\nsource: s\nx: d\ny: count\n```").length, 0);
});

// ---------- tally ----------

function rows(...rs: ChartRow[]): ChartRow[] {
  return rs;
}

test("counts rows per day", () => {
  const t = tallyHeatmap(
    rows(
      { logged: "2026-03-01" },
      { logged: "2026-03-01" },
      { logged: "2026-03-02" },
    ),
    COUNT,
  );
  assert.equal(t.days.get("2026-03-01")?.value, 2);
  assert.equal(t.days.get("2026-03-01")?.n, 2);
  assert.equal(t.days.get("2026-03-02")?.value, 1);
  assert.equal(t.skipped, 0);
  assert.equal(t.missing, null);
});

test("sums a numeric property per day", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes");
  const t = tallyHeatmap(
    rows(
      { logged: "2026-03-01", minutes: 30 },
      { logged: "2026-03-01", minutes: "12.5" },
      { logged: "2026-03-02", minutes: -4 },
    ),
    c,
  );
  assert.equal(t.days.get("2026-03-01")?.value, 42.5);
  assert.equal(t.days.get("2026-03-01")?.n, 2);
  assert.equal(t.days.get("2026-03-02")?.value, -4);
  assert.equal(t.skipped, 0);
});

test("prop lookup is case-insensitive on both sides", () => {
  const c = cfg("source: session\ndate: Logged\nvalue: sum:Minutes");
  const t = tallyHeatmap(rows({ LOGGED: "2026-03-01", minutes: 5 }), c);
  assert.equal(t.days.get("2026-03-01")?.value, 5);
});

test("a timestamp lands on its day", () => {
  const t = tallyHeatmap(rows({ logged: "2026-03-01 10:28" }, { logged: "2026-03-01T23:59:59Z" }), COUNT);
  assert.equal(t.days.get("2026-03-01")?.n, 2);
  assert.equal(t.days.size, 1);
});

test("rows without a readable date are skipped, not dated", () => {
  const t = tallyHeatmap(
    rows(
      { logged: "2026-03-01" },
      { logged: "" },
      { logged: "soon" },
      { logged: null },
      { logged: ["2026-03-01"] },
      {},
      { logged: "01.03.2026" },
    ),
    COUNT,
  );
  assert.equal(t.days.size, 1);
  assert.equal(t.skipped, 6);
});

test("an impossible calendar date is skipped", () => {
  const t = tallyHeatmap(rows({ logged: "2026-02-29" }, { logged: "2026-13-01" }, { logged: "2026-04-31" }), COUNT);
  assert.equal(t.days.size, 0);
  assert.equal(t.skipped, 3);
});

test("a real leap day counts", () => {
  const t = tallyHeatmap(rows({ logged: "2024-02-29" }), COUNT);
  assert.equal(t.days.get("2024-02-29")?.n, 1);
  assert.equal(t.skipped, 0);
});

test("sum: cells that are not strictly numeric skip their row", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes");
  const t = tallyHeatmap(
    rows(
      { logged: "2026-03-01", minutes: 10 },
      { logged: "2026-03-01", minutes: "1e3" },
      { logged: "2026-03-01", minutes: "0x10" },
      { logged: "2026-03-01", minutes: "Infinity" },
      { logged: "2026-03-01", minutes: Infinity },
      { logged: "2026-03-01", minutes: NaN },
      { logged: "2026-03-01", minutes: "twenty" },
      { logged: "2026-03-01", minutes: null },
      { logged: "2026-03-01", minutes: [1, 2] },
    ),
    c,
  );
  assert.equal(t.days.get("2026-03-01")?.value, 10);
  assert.equal(t.days.get("2026-03-01")?.n, 1);
  assert.equal(t.skipped, 8);
});

test("a bound property absent from every row is named", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes");
  const t = tallyHeatmap(rows({ day: "2026-03-01", mins: 3 }), c);
  assert.equal(t.missing, "no properties “logged” or “minutes” on session (has: day, mins)");
});

test("a sheet's missing binding says column", () => {
  const c = cfg("source: {{Time Log}}\ndate: day\nvalue: count");
  const t = tallyHeatmap(rows({ when: "2026-03-01" }), c);
  assert.equal(t.missing, "no column “day” on Time Log (has: when)");
});

test("no rows claims no missing binding", () => {
  assert.equal(tallyHeatmap([], COUNT).missing, null);
});

test("a property that exists but never parses is a zero match, not a miss", () => {
  const t = tallyHeatmap(rows({ logged: "someday" }), COUNT);
  assert.equal(t.missing, null);
  assert.equal(t.skipped, 1);
});

// ---------- year selection ----------

test("years lists every year the data touches, ascending", () => {
  const t = tallyHeatmap(rows({ logged: "2026-01-01" }, { logged: "2024-06-06" }, { logged: "2025-12-31" }), COUNT);
  assert.deepEqual(heatmapYears(t), [2024, 2025, 2026]);
});

test("the shown year is the latest one carrying data", () => {
  const t = tallyHeatmap(rows({ logged: "2024-06-06" }, { logged: "2026-01-01" }), COUNT);
  assert.equal(pickHeatmapYear(t, "2030-01-01"), 2026);
});

test("with no data the shown year is today's", () => {
  assert.equal(pickHeatmapYear(tallyHeatmap([], COUNT), "2026-08-03"), 2026);
});

// ---------- grid ----------

test("a common year is 365 squares, a leap year 366", () => {
  const empty = tallyHeatmap([], COUNT);
  const count = (year: number) =>
    heatmapGrid(empty, year).weeks.flat().filter((c) => c !== null).length;
  assert.equal(count(2026), 365);
  assert.equal(count(2024), 366);
  assert.equal(count(2000), 366);
  assert.equal(count(1900), 365);
});

test("every column holds seven slots and the year's days are contiguous", () => {
  const g = heatmapGrid(tallyHeatmap([], COUNT), 2026);
  for (const w of g.weeks) assert.equal(w.length, 7);
  const flat = g.weeks.flat();
  const days = flat.filter((c) => c !== null);
  assert.equal(days[0]?.iso, "2026-01-01");
  assert.equal(days[days.length - 1]?.iso, "2026-12-31");
  const first = flat.findIndex((c) => c !== null);
  const last = flat.length - 1 - [...flat].reverse().findIndex((c) => c !== null);
  for (let i = first; i <= last; i++) assert.notEqual(flat[i], null, `hole at ${i}`);
});

test("columns start on Monday: 2026-01-01 is a Thursday, so three lead nulls", () => {
  const g = heatmapGrid(tallyHeatmap([], COUNT), 2026);
  assert.deepEqual(g.weeks[0].slice(0, 3), [null, null, null]);
  assert.equal(g.weeks[0][3]?.iso, "2026-01-01");
});

test("a Monday-starting year has no lead nulls", () => {
  // 2024-01-01 was a Monday
  const g = heatmapGrid(tallyHeatmap([], COUNT), 2024);
  assert.equal(g.weeks[0][0]?.iso, "2024-01-01");
});

test("both year boundaries carry their own square", () => {
  const t = tallyHeatmap(rows({ logged: "2026-01-01" }, { logged: "2026-12-31" }), COUNT);
  const g = heatmapGrid(t, 2026);
  const byIso = new Map(g.weeks.flat().filter((c) => c !== null).map((c) => [c!.iso, c!]));
  assert.equal(byIso.get("2026-01-01")?.value, 1);
  assert.equal(byIso.get("2026-12-31")?.value, 1);
  assert.equal(g.total, 2);
  assert.equal(g.active, 2);
});

test("neighbouring years stay out of the grid but keep the tally", () => {
  const t = tallyHeatmap(rows({ logged: "2025-12-31" }, { logged: "2026-06-01" }, { logged: "2027-01-01" }), COUNT);
  const g = heatmapGrid(t, 2026);
  assert.equal(g.total, 1);
  assert.equal(g.active, 1);
  assert.equal(g.weeks.flat().filter((c) => c !== null).length, 365);
});

test("month labels sit on the column each month opens in", () => {
  const g = heatmapGrid(tallyHeatmap([], COUNT), 2026);
  assert.equal(g.months.length, 12);
  assert.equal(g.months[0].label, "Jan");
  assert.equal(g.months[0].col, 0);
  assert.equal(g.months[11].label, "Dec");
  for (const m of g.months) {
    const first = `2026-${String(g.months.indexOf(m) + 1).padStart(2, "0")}-01`;
    assert.ok(
      g.weeks[m.col].some((c) => c?.iso === first),
      `${m.label} column ${m.col} should hold ${first}`,
    );
  }
});

test("grid carries the tally's skipped count and missing error through", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes");
  const g = heatmapGrid(tallyHeatmap(rows({ day: "2026-03-01" }), c), 2026);
  assert.equal(g.skipped, 1);
  assert.match(g.missing ?? "", /no properties “logged” or “minutes” on session/);
});

// ---------- levels ----------

test("levels quarter the year's heaviest day", () => {
  assert.equal(heatmapLevel(0, 8), 0);
  assert.equal(heatmapLevel(1, 8), 1);
  assert.equal(heatmapLevel(2, 8), 1);
  assert.equal(heatmapLevel(3, 8), 2);
  assert.equal(heatmapLevel(4, 8), 2);
  assert.equal(heatmapLevel(5, 8), 3);
  assert.equal(heatmapLevel(6, 8), 3);
  assert.equal(heatmapLevel(7, 8), 4);
  assert.equal(heatmapLevel(8, 8), 4);
});

test("any positive day is at least level 1, even against a huge max", () => {
  assert.equal(heatmapLevel(0.0001, 100000), 1);
});

test("zero and negative days read empty", () => {
  assert.equal(heatmapLevel(0, 0), 0);
  assert.equal(heatmapLevel(-5, 10), 0);
  assert.equal(heatmapLevel(5, 0), 0);
});

test("a day that summed to zero still reports its rows", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes");
  const t = tallyHeatmap(rows({ logged: "2026-03-01", minutes: 0 }, { logged: "2026-03-02", minutes: 4 }), c);
  const g = heatmapGrid(t, 2026);
  const zero = g.weeks.flat().find((c) => c?.iso === "2026-03-01");
  assert.equal(zero?.value, 0);
  assert.equal(zero?.n, 1);
  assert.equal(zero?.level, 0);
  assert.equal(g.active, 2);
  assert.equal(g.max, 4);
});

// ---------- database rows + query ----------

const NOTES: NoteMeta[] = [
  note("a.md", { type: "session", logged: "2026-03-01", minutes: 30, status: "done" }),
  note("b.md", { type: "session", logged: "2026-03-01", minutes: 15, status: "draft" }),
  note("c.md", { type: "Session", logged: "2026-03-02", minutes: 45, status: "done" }),
  note("d.md", { type: "release", logged: "2026-03-03", minutes: 99, status: "done" }),
];

test("db rows are the notes of the type, folded on the type name", () => {
  const t = tallyHeatmap(heatmapDbRows(COUNT, NOTES, {}), COUNT);
  assert.equal(t.days.get("2026-03-01")?.n, 2);
  assert.equal(t.days.get("2026-03-02")?.n, 1);
  assert.equal(t.days.has("2026-03-03"), false);
});

test("a query narrows the rows with the filter-bar language", () => {
  const c = cfg("source: session\ndate: logged\nvalue: count\nquery: status:done");
  const t = tallyHeatmap(heatmapDbRows(c, NOTES, {}), c);
  assert.equal(t.days.get("2026-03-01")?.n, 1);
  assert.equal(t.days.get("2026-03-02")?.n, 1);
});

test("a query that matches nothing yields an empty grid, not an error", () => {
  const c = cfg("source: session\ndate: logged\nvalue: count\nquery: status:archived");
  const t = tallyHeatmap(heatmapDbRows(c, NOTES, {}), c);
  assert.equal(t.days.size, 0);
  assert.equal(t.missing, null);
});

test("a comparison query resolves against today", () => {
  const c = cfg("source: session\ndate: logged\nvalue: count\nquery: logged>2026-03-01");
  const t = tallyHeatmap(heatmapDbRows(c, NOTES, {}, "2026-08-03"), c);
  assert.equal(t.days.size, 1);
  assert.equal(t.days.get("2026-03-02")?.n, 1);
});

test("a sum: query totals only the matched rows", () => {
  const c = cfg("source: session\ndate: logged\nvalue: sum:minutes\nquery: status:done");
  const t = tallyHeatmap(heatmapDbRows(c, NOTES, {}), c);
  assert.equal(t.days.get("2026-03-01")?.value, 30);
  assert.equal(t.days.get("2026-03-02")?.value, 45);
});

test("a sheet source draws no database rows", () => {
  const c = cfg("source: {{Time Log}}\ndate: day\nvalue: count");
  assert.deepEqual(heatmapDbRows(c, NOTES, {}), []);
});

// ---------- sheet rows ----------

test("sheet rows tally the same way", () => {
  const md = [
    "```csv",
    "day,hours",
    "2026-03-01,2",
    "2026-03-01,1.5",
    "2026-03-02,3",
    "```",
    "",
  ].join("\n");
  const model = parseSheet(md);
  const ev = evaluateSheet(model, noFx);
  const c = cfg("source: {{Time Log}}\ndate: day\nvalue: sum:hours");
  const t = tallyHeatmap(sheetRows(model, ev), c);
  assert.equal(t.days.get("2026-03-01")?.value, 3.5);
  assert.equal(t.days.get("2026-03-02")?.value, 3);
  assert.equal(t.missing, null);
});

// ---------- display ----------

test("the title is derived, since a heatmap declares none", () => {
  assert.equal(heatmapTitle(COUNT), "Session per day");
  assert.equal(heatmapTitle(cfg("source: {{Time Log}}\ndate: d\nvalue: count")), "Time Log per day");
  assert.equal(heatmapTitle(cfg("source: s\ndate: d\nvalue: sum:minutes")), "Sum of minutes per day");
});

test("the source line names the source and any query", () => {
  assert.equal(heatmapSourceDesc(COUNT), "database: session");
  assert.equal(
    heatmapSourceDesc(cfg("source: session\ndate: d\nvalue: count\nquery: status:done")),
    "database: session · status:done",
  );
  assert.equal(heatmapSourceDesc(cfg("source: {{Time Log}}\ndate: d\nvalue: count")), "sheet: Time Log");
});

test("parseHeatmapBlocks: an unclosed fence is a banner, not a silent zero", () => {
  const blocks = parseHeatmapBlocks("```heatmap\nsource: session\ndate: logged\nvalue: count\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].config, null);
  assert.match(blocks[0].error ?? "", /```heatmap fence is never closed — add a closing ``` line/);
  // the opener folds case here, exactly as this parser's own opener does
  assert.match(
    parseHeatmapBlocks("```HeatMap\nsource: session\n")[0]?.error ?? "",
    /never closed/
  );
});

test("parseHeatmapBlocks: no banner over a grid the board just drew", () => {
  const config = "source: session\ndate: logged\nvalue: count";
  for (const body of [
    "```heatmap\n" + config + "\n  ```\n",
    "```heatmap\n" + config + "\n```js\n",
    "```heatmap\n" + config + "\n```\n\n```ts\nconst x = 1;\n",
  ]) {
    const blocks = parseHeatmapBlocks(body);
    assert.equal(blocks.length, 1, body);
    assert.equal(blocks[0].error, null, body);
  }
  assert.deepEqual(parseHeatmapBlocks("~~~\n```heatmap\n" + config + "\n~~~\n"), []);
});
