import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ferr,
  isErr,
  type FErr,
  type FxResolver,
  type HistoryResolver,
} from "./formula.ts";
import {
  addSheetColumn,
  addSheetRow,
  deleteSheetColumn,
  deleteSheetFormula,
  deleteSheetRow,
  moveSheetColumn,
  moveSheetRow,
  evaluateSheet,
  findSummary,
  columnFormat,
  formatNum,
  formatNumIn,
  formatSummary,
  formatValue,
  parseCsv,
  parseSheet,
  serializeCsv,
  setSheetCell,
  sheetColumnFormats,
  sheetHistoryRefs,
  sheetHistorySheetDates,
  makeHistorySheetValue,
  sheetSummaryFormats,
  sheetUsesFx,
  sheetUsesHistory,
  summaryBar,
  updateSheetFormula,
  columnTakesNumberInput,
  countPickKind,
  addSheetFormula,
  selectionStats,
  summaryFormulaError,
  totalsRow,
  type SheetModel,
} from "./sheet.ts";
import { makeHistoryResolver, type HistorySheetSnapshot } from "./history-facts.ts";
import type { FactLane } from "./types.ts";

const fx: FxResolver = (from, to) => (from === "USD" && to === "EUR" ? 0.8721 : null);

// The spec's example, spreadsheet portfolio tracker semantics
const BODY = `---
type: sheet
title: Holdings
---

Some prose that must survive edits.

\`\`\`csv
asset,bucket,units,price_usd
GLOW,etf,1200,31.4
BTC,crypto,4.1,64200
\`\`\`

\`\`\`formulas
value_usd = units * price_usd
value_eur = value_usd * FX("USD","EUR")

total       = SUM(value_eur)
crypto      = SUMIF(bucket, "crypto", value_eur)
etf         = SUMIF(bucket, "etf", value_eur)
rest        = total - crypto
\`\`\`
`;

function near(v: unknown, expected: number, eps = 1e-6) {
  assert.equal(typeof v, "number", `expected number, got ${JSON.stringify(v)}`);
  assert.ok(Math.abs((v as number) - expected) < eps, `${v} != ${expected}`);
}

test("parse: csv headers/rows and formula classification", () => {
  const m = parseSheet(BODY);
  assert.deepEqual(m.headers, ["asset", "bucket", "units", "price_usd"]);
  assert.equal(m.rows.length, 2);
  assert.equal(m.errors.length, 0);
  assert.equal(m.hasCsv, true);
  const kinds = m.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`);
  assert.deepEqual(kinds, [
    "value_usd:col",
    "value_eur:col",
    "total:agg",
    "crypto:agg",
    "etf:agg",
    "rest:agg",
  ]);
});

test("evaluate: computed columns chain, summaries see them, summaries chain", () => {
  const ev = evaluateSheet(parseSheet(BODY), fx);
  assert.deepEqual(ev.computed.map((c) => c.name), ["value_usd", "value_eur"]);
  const [vusd, veur] = ev.computed;
  near(vusd.cells[0], 1200 * 31.4);
  near(vusd.cells[1], 4.1 * 64200);
  near(veur.cells[0], 1200 * 31.4 * 0.8721);
  near(veur.cells[1], 4.1 * 64200 * 0.8721);
  const sum = (a: number, b: number) => a + b;
  const total = [veur.cells[0], veur.cells[1]] as number[];
  near(findSummary(ev, "total"), total.reduce(sum, 0));
  near(findSummary(ev, "crypto"), veur.cells[1] as number);
  near(findSummary(ev, "etf"), veur.cells[0] as number);
  // summary referencing earlier summaries
  near(findSummary(ev, "rest"), total.reduce(sum, 0) - (veur.cells[1] as number));
});

test("evaluate: unknown column in computed cell yields per-cell error", () => {
  const body = "```csv\na\n1\n2\n```\n\n```formulas\nb = nope * 2\nt = SUM(a)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  assert.ok(isErr(ev.computed[0].cells[0]));
  assert.ok(isErr(ev.computed[0].cells[1]));
  assert.equal(findSummary(ev, "t"), 3);
});

test("evaluate: bad formula line lands in errors, good lines still run", () => {
  const body = "```csv\na\n1\n```\n\n```formulas\nthis is not a formula\nt = SUM(a)\n```\n";
  const m = parseSheet(body);
  assert.equal(m.errors.length, 1);
  assert.equal(findSummary(evaluateSheet(m, fx), "t"), 1);
});

test("errors propagate from computed cells into aggregates, Excel-style", () => {
  const body = "```csv\na\n1\n0\n```\n\n```formulas\nb = a / a\nt = SUM(b)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  assert.equal(ev.computed[0].cells[0], 1);
  assert.ok(isErr(ev.computed[0].cells[1]), "0/0 errors in that row only");
  assert.ok(isErr(findSummary(ev, "t")), "SUM over a broken cell is broken");
});

test("SUMIF/COUNTIF comparison criteria over real CSV cells (SUB-743)", () => {
  // the risk-bucket idiom the enumeration workaround existed for: scores are
  // CSV text here, including 0 and decimals
  const body =
    "```csv\nitem,score,cost\na,0,10\nb,1,20\nc,2.5,30\nd,5,40\ne,,50\n```\n\n" +
    "```formulas\nat_risk = COUNTIF(score, \">=1\")\nsafe = COUNTIF(score, \"<1\")\n" +
    "nonzero = COUNTIF(score, \"<>0\")\nrisk_cost = SUMIF(score, \">=1\", cost)\n" +
    "high_cost = SUMIF(score, \">2.5\", cost)\nexact = COUNTIF(score, 1)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  assert.equal(findSummary(ev, "at_risk"), 3, "1, 2.5, 5 — blank row excluded");
  assert.equal(findSummary(ev, "safe"), 1, "only the 0");
  assert.equal(findSummary(ev, "nonzero"), 3, "blank never satisfies a comparison");
  assert.equal(findSummary(ev, "risk_cost"), 20 + 30 + 40);
  assert.equal(findSummary(ev, "high_cost"), 40, "> excludes the boundary");
  assert.equal(findSummary(ev, "exact"), 1, "plain criteria still exact-match");
  // a numeric comparator over a text column errors honestly rather than guessing
  const textBody =
    "```csv\nitem,score\na,low\nb,high\n```\n\n```formulas\nn = COUNTIF(score, \">=1\")\n```\n";
  assert.ok(isErr(findSummary(evaluateSheet(parseSheet(textBody), fx), "n") as FErr));
});

test("LAST: the snapshot idiom — most recent row wins, over data and computed columns", () => {
  const body =
    "```csv\ndate,total\n2026-07-28,100\n2026-07-29,\n2026-07-30,142\n```\n\n" +
    "```formulas\ndelta = total - 100\nlatest = LAST(total)\nlatest_delta = LAST(delta)\ndoubled = latest * 2\n```\n";
  const m = parseSheet(body);
  assert.equal(m.formulas.find((f) => f.name === "delta")!.aggregate, false);
  assert.equal(m.formulas.find((f) => f.name === "latest")!.aggregate, true, "LAST makes a summary");
  const ev = evaluateSheet(m, fx);
  assert.equal(findSummary(ev, "latest"), 142, "stored row order, gap row skipped");
  assert.equal(findSummary(ev, "latest_delta"), 42, "LAST over a computed column");
  assert.equal(findSummary(ev, "doubled"), 284, "LAST composes with arithmetic");
});

test("LAST: strings pass through; an all-empty column errors like MAX", () => {
  const body =
    "```csv\nname,note\na,\nb,\n```\n\n```formulas\nlatest_name = LAST(name)\nlatest_note = LAST(note)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  assert.equal(findSummary(ev, "latest_name"), "b");
  assert.ok(isErr(findSummary(ev, "latest_note")), "no non-empty values is an error, not null");
});

test("dates in sheets: Days-Held column, shifted-date column, AVG summary (SUB-717)", () => {
  const body =
    "```csv\nasset,bought,cost\nGLOW,2026-01-15,1000\nBTC,2026-07-01,2000\n```\n\n" +
    "```formulas\ndays_held = TODAY() - bought\nuntil = bought + 90\navg_held = AVG(days_held)\n```\n";
  // injected clock: the test pins "today", the wall clock stays out of it
  const ev = evaluateSheet(parseSheet(body), fx, undefined, () => "2026-07-31");
  const held = ev.computed.find((c) => c.name === "days_held")!;
  assert.deepEqual(held.cells, [197, 30]);
  const until = ev.computed.find((c) => c.name === "until")!;
  assert.deepEqual(until.cells, ["2026-04-15", "2026-09-29"]);
  near(findSummary(ev, "avg_held"), (197 + 30) / 2);
  // volatile at sheet level too: a second evaluation re-reads the clock
  const ev2 = evaluateSheet(parseSheet(body), fx, undefined, () => "2026-08-01");
  assert.deepEqual(ev2.computed.find((c) => c.name === "days_held")!.cells, [198, 31]);
});

test("typed cells: numeric strings become numbers, blanks are null", () => {
  const ev = evaluateSheet(parseSheet(BODY), fx);
  assert.equal(ev.rows[0][2], 1200);
  assert.equal(ev.rows[0][0], "GLOW");
  const blank = evaluateSheet(parseSheet("```csv\na,b\n,2\n```"), fx);
  assert.equal(blank.rows[0][0], null);
});

test("typed cells: hex/exponent/Infinity strings stay text (SUB-221)", () => {
  const ev = evaluateSheet(parseSheet("```csv\na\n1e3\n0x10\nInfinity\n-12.5\n```"), fx);
  assert.equal(ev.rows[0][0], "1e3", "exponent notation is text now");
  assert.equal(ev.rows[1][0], "0x10", "hex is text now");
  assert.equal(ev.rows[2][0], "Infinity");
  assert.equal(ev.rows[3][0], -12.5, "plain decimals still type as numbers");
});

test("setSheetCell rewrites only the csv fence", () => {
  const next = setSheetCell(BODY, 1, 2, "5");
  assert.ok(next.includes("Some prose that must survive edits."));
  assert.ok(next.includes("BTC,crypto,5,64200"));
  assert.ok(next.includes("GLOW,etf,1200,31.4"));
  const ev = evaluateSheet(parseSheet(next), fx);
  near(ev.computed[0].cells[1], 5 * 64200);
});

test("addSheetRow appends an empty row; aggregates ignore blanks", () => {
  const next = addSheetRow(BODY);
  const m = parseSheet(next);
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows[2], ["", "", "", ""]);
  const ev = evaluateSheet(m, fx);
  assert.equal(ev.computed[0].cells[2], 0); // null * null = 0, Excel-style
  near(findSummary(ev, "crypto"), (4.1 * 64200 * 0.8721) as number);
});

test("addSheetColumn appends header + empty cells, rejects dupes/bad names", () => {
  const next = addSheetColumn(BODY, "weight");
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["asset", "bucket", "units", "price_usd", "weight"]);
  assert.deepEqual(m.rows[0], ["GLOW", "etf", "1200", "31.4", ""]);
  assert.equal(addSheetColumn(BODY, "UNITS"), BODY, "case-insensitive dupe");
  assert.equal(addSheetColumn(BODY, "not a name"), BODY);
});

test("addSheetColumn on a note without csv creates the fence", () => {
  const body = "Just a note.\n";
  const next = addSheetColumn(body, "asset");
  assert.ok(next.includes("Just a note."));
  assert.ok(next.includes("```csv\nasset\n```"));
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["asset"]);
  assert.equal(m.rows.length, 0);
});

test("csv quoting round-trips commas, quotes, newlines", () => {
  const rows = [
    ["name", "note"],
    ["a,b", 'say "hi"'],
    ["plain", "line1\nline2"],
  ];
  const text = serializeCsv(rows);
  assert.deepEqual(parseCsv(text), rows);
});

test("a bare quote mid-cell is literal text, not a quote opener", () => {
  // an inch mark typed by hand: `12" single`. Treating it as an opener made
  // quote mode swallow every following comma and newline, fusing the rest of
  // the sheet into one cell — and the next save wrote the fusion back.
  assert.deepEqual(parseCsv('name,note\ntap,12" single\nfoo,bar'), [
    ["name", "note"],
    ["tap", '12" single'],
    ["foo", "bar"],
  ]);
  // a properly quoted cell still opens, and doubled quotes inside it still unescape
  assert.deepEqual(parseCsv('a,"b,c"\n"say ""hi""",d'), [
    ["a", "b,c"],
    ['say "hi"', "d"],
  ]);
});

test("parseCsv tolerates CRLF and trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("a UTF-8 BOM doesn't shift the columns (SUB-560)", () => {
  // Excel/Sheets exports start with U+FEFF. Written as an escape on purpose:
  // the literal byte is invisible in a diff and gets eaten by editors.
  const BOM = "\uFEFF";
  // the plain case: the BOM used to survive into the first header's name
  assert.deepEqual(parseCsv(`${BOM}Name,Status\nRavel Cortez,live\n`), [
    ["Name", "Status"],
    ["Ravel Cortez", "live"],
  ]);
  // the damaging case: a quoted first header with a comma in it. The BOM sat
  // where the opening quote had to be, so the quote read as literal text and
  // the header split in two — every column after it shifted by one, `Status`
  // took the catalogue number and `Cat#` came out empty.
  assert.deepEqual(parseCsv(`${BOM}"Artist, Label",Status,Cat#\nRavel Cortez,live,RVC-030\n`), [
    ["Artist, Label", "Status", "Cat#"],
    ["Ravel Cortez", "live", "RVC-030"],
  ]);
  // only a LEADING BOM is a byte-order mark; one mid-text is ordinary content
  assert.deepEqual(parseCsv(`a,b${BOM}c\n`), [["a", `b${BOM}c`]]);
});

test("formatValue: numbers grouped, errors as !, blanks empty", () => {
  assert.equal(formatValue(32863.128), "32.863,13");
  assert.equal(formatValue(3), "3");
  assert.equal(formatValue(null), "");
  assert.equal(formatValue({ err: "boom" }), "!");
  assert.equal(formatValue("GLOW"), "GLOW");
  assert.equal(formatValue(true), "true");
});

test("formatValue: integers grouped bare, fractions grouped with exactly 2 decimals (SUB-137)", () => {
  assert.equal(formatValue(12345), "12.345");
  assert.equal(formatValue(-1234567), "-1.234.567");
  assert.equal(formatValue(1234.5), "1.234,50");
  assert.equal(formatValue(0.5), "0,50");
  assert.equal(formatValue(1000000.001), "1.000.000,00");
});

test("formatNum: the grid renders the de-DE dialect (SUB-282)", () => {
  assert.equal(formatNum(1234.56), "1.234,56");
  assert.equal(formatNum(12345), "12.345");
  assert.equal(formatNum(-1234567.891), "-1.234.567,89");
  assert.equal(formatNum(0.5), "0,50");
  assert.equal(formatNum(-3), "-3");
});

test("formatValue: four-digit integers render ungrouped everywhere (SUB-633)", () => {
  // the bug: a bare year read as a thousands-grouped number ("2.026")
  assert.equal(formatValue(2026, "year"), "2026");
  assert.equal(formatValue(2026), "2026"); // no header needed — ports, PLZ, codes
  assert.equal(formatValue(-1999), "-1999");
  assert.equal(formatValue(1234, "files"), "1234"); // a real quantity loses nothing
  // five digits and up stay grouped, header or not
  assert.equal(formatValue(23949, "size_mb"), "23.949");
  assert.equal(formatValue(23949), "23.949");
  assert.equal(formatValue(-1234567), "-1.234.567");
  // fractions are never affected — the rule is integers only
  assert.equal(formatValue(2026.5, "year"), "2.026,50");
  assert.equal(formatValue(1234.5), "1.234,50");
});

test("formatValue: label columns render longer integers ungrouped too (SUB-633)", () => {
  assert.equal(formatValue(48211, "order_id"), "48211");
  assert.equal(formatValue(1000042, "invoice no"), "1000042");
  assert.equal(formatValue(102456, "job-nr"), "102456");
  assert.equal(formatValue(1999, "Jahr"), "1999");
  // near-misses stay grouped: only the whole header (or a trailing token) counts
  assert.equal(formatValue(20260, "years_active"), "20.260");
  assert.equal(formatValue(20260, "yield"), "20.260");
  assert.equal(formatValue(12345, "paid"), "12.345");
  // decimals in a label column still format de-DE
  assert.equal(formatValue(48211.5, "order_id"), "48.211,50");
  // non-numbers unaffected
  assert.equal(formatValue("2026-06-13", "year"), "2026-06-13");
  assert.equal(formatValue(null, "year"), "");
});

// ── per-column number format ──────────────────────────────────────

test("columnFormat: one decision per column, not per value (SUB-1000)", () => {
  // the collision: a money column holding 7400 and 37680 used to render
  // "7400" beside "37.680" — one dot apart from a 1000× misread
  assert.deepEqual(columnFormat([7400, 37680], "value_usd"), { decimals: 0, group: true });
  // any fraction in the column puts every cell on 2 decimals
  assert.deepEqual(columnFormat([1200, 4.1], "units"), { decimals: 2, group: true });
  // all-integer and all under the threshold: still bare
  assert.deepEqual(columnFormat([12, 340, 9999], "count"), { decimals: 0, group: false });
  // label columns stay bare however large
  assert.deepEqual(columnFormat([48211, 1000042], "order_id"), { decimals: 0, group: false });
  assert.deepEqual(columnFormat([2024, 2025, 2026], "year"), { decimals: 0, group: false });
  // nothing numeric to decide from — errors, blanks, text
  assert.deepEqual(columnFormat([], "empty"), { decimals: 0, group: false });
  assert.deepEqual(columnFormat(["GLOW", null, { err: "boom" }], "asset"), {
    decimals: 0,
    group: false,
  });
  // non-finite values never drive the decision
  assert.deepEqual(columnFormat([Number.NaN, 5, 7], "n"), { decimals: 0, group: false });
});

test("formatNumIn: the column's format wins over the value's own shape (SUB-1000)", () => {
  const money = { decimals: 0, group: true } as const;
  assert.equal(formatNumIn(7400, money), "7.400");
  assert.equal(formatNumIn(37680, money), "37.680");
  // a four-digit integer in a grouped money column groups too — consistency
  // beats the bare-year rule once the column as a whole has been judged money
  assert.equal(formatNumIn(2026, money), "2.026");
  const two = { decimals: 2, group: true } as const;
  assert.equal(formatNumIn(1200, two), "1.200,00");
  assert.equal(formatNumIn(4.1, two), "4,10");
  const bare = { decimals: 0, group: false } as const;
  assert.equal(formatNumIn(2026, bare), "2026");
  assert.equal(formatNumIn(48211, bare), "48211");
});

test("Holdings grid: every column renders in one regime (SUB-1000)", () => {
  // the reported grid: units 1200 next to 4,10; price_usd 64.200 next to 3050;
  // value_usd 37.680 next to 7400 IN THE SAME COLUMN
  const body =
    "```csv\nasset,bucket,units,price_usd\nGLOW,etf,1200,31.4\nBTC,crypto,4.1,64200\nCASH,cash,7400,1\n```\n\n" +
    '```formulas\nvalue_usd = units * price_usd\nvalue_eur = value_usd * FX("USD","EUR")\n```\n';
  const ev = evaluateSheet(parseSheet(body), fx);
  const fmts = sheetColumnFormats(ev);
  const col = (c: number) => ev.rows.map((row) => formatValue(row[c], ev.headers[c], fmts.data[c]));
  const comp = (i: number) =>
    ev.computed[i].cells.map((v) => formatValue(v, ev.computed[i].name, fmts.computed[i]));

  assert.deepEqual(col(0), ["GLOW", "BTC", "CASH"]);
  assert.deepEqual(col(2), ["1.200,00", "4,10", "7.400,00"]); // units: one regime
  assert.deepEqual(col(3), ["31,40", "64.200,00", "1,00"]); // price_usd: one regime
  assert.deepEqual(comp(0), ["37.680", "263.220", "7.400"]); // the 1000× trap, closed
  assert.deepEqual(comp(1), ["32.860,73", "229.554,16", "6.453,54"]);

  // entry and computed columns are judged by the same rule
  assert.deepEqual(fmts.data[2], { decimals: 2, group: true });
  assert.deepEqual(fmts.computed[0], { decimals: 0, group: true });
});

test("sheetColumnFormats: identifier columns survive the consistency pass (SUB-633)", () => {
  const body =
    "```csv\nyear,order_id,units\n2024,48211,12\n2025,1000042,3400\n```\n\n" +
    "```formulas\ndoubled = units * 2\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  const fmts = sheetColumnFormats(ev);
  assert.deepEqual(fmts.data[0], { decimals: 0, group: false });
  assert.deepEqual(fmts.data[1], { decimals: 0, group: false });
  assert.deepEqual(fmts.data[2], { decimals: 0, group: false }); // 12 and 3400: both bare
  assert.deepEqual(fmts.computed[0], { decimals: 0, group: false }); // 24 and 6800
  assert.deepEqual(
    ev.rows.map((r) => formatValue(r[0], ev.headers[0], fmts.data[0])),
    ["2024", "2025"]
  );
});

test("Work Index sheet: the year column renders ungrouped (SUB-633)", () => {
  const body =
    "```csv\n" +
    "category,client,job,year,last_active,files,size_mb,flags\n" +
    "MASTERING,Ada Voss,Voss Signal,2026,2026-06-13,318,23949,\n" +
    "OWN WORK,COLLABS,Lila,2024,2024-01-23,54,3880,\n" +
    "```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  const render = (r: number) => ev.headers.map((h, c) => formatValue(ev.rows[r][c], h));
  assert.deepEqual(render(0), [
    "MASTERING",
    "Ada Voss",
    "Voss Signal",
    "2026",
    "2026-06-13",
    "318",
    "23.949", // five digits: size stays a grouped quantity
    "",
  ]);
  assert.equal(render(1)[3], "2024");
});

// ── summary chips inherit their column's format ───────────────────

/** Every chip of a sheet, rendered the way the summary bar renders them. */
const chips = (body: string): Record<string, string> => {
  const model = parseSheet(body);
  const ev = evaluateSheet(model, fx);
  const fmts = sheetSummaryFormats(model, ev);
  const out: Record<string, string> = {};
  for (const s of ev.summaries) out[s.name] = formatSummary(s.value, fmts.get(s.name.toLowerCase()));
  return out;
};

test("summary chip renders in the grammar of the column it sums (SUB-1084)", () => {
  // the reported case: value_usd renders 7.400 / 37.680, but a
  // total landing under 10000 and integral rendered "7400" one row below it
  const body =
    "```csv\nasset,value_usd\nBTC,37680\nHEDGE,-30280\n```\n\n" +
    "```formulas\ntotal = SUM(value_usd)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  const fmts = sheetColumnFormats(ev);
  // the column groups: it carries a five-digit value, so the column grammar renders it money-shaped
  assert.deepEqual(
    ev.rows.map((r) => formatValue(r[1], "value_usd", fmts.data[1])),
    ["37.680", "-30.280"]
  );
  // the sum lands under 10000 and integral — legacy per-value rules rendered it "7400"
  assert.equal(formatValue(7400), "7400");
  // the chip now agrees with its column
  assert.deepEqual(chips(body), { total: "7.400" });
});

test("summary chips: unit-preserving aggregates inherit, counts do not (SUB-1084)", () => {
  const body =
    "```csv\nasset,value_usd\nGLOW,7400\nBTC,37680\nCASH,2010\n```\n\n" +
    "```formulas\n" +
    "total = SUM(value_usd)\nsmallest = MIN(value_usd)\nlargest = MAX(value_usd)\n" +
    "rows = COUNT(value_usd)\nmean = AVG(value_usd)\n```\n";
  assert.deepEqual(chips(body), {
    total: "47.090",
    smallest: "2.010", // four digits, but the column is money — it groups
    largest: "37.680",
    rows: "3", // a count is dimensionless: no money grammar, no "3,00"
    mean: "15.696,67", // fractional under a whole-number column keeps 2 decimals
  });
});

test("summary chips: identifier columns keep their bare grammar (SUB-1084/SUB-633)", () => {
  const body =
    "```csv\nyear,port\n2024,8080\n2026,9000\n```\n\n" +
    "```formulas\nlatest = MAX(year)\nport_max = MAX(port)\n```\n";
  // a year is a name, not a quantity: the chip must not render "2.026"
  assert.deepEqual(chips(body), { latest: "2026", port_max: "9000" });
});

test("summary chips: a claimless summary keeps the legacy rendering (SUB-1084)", () => {
  const body =
    "```csv\nasset,value_usd\nGLOW,7400\nBTC,37680\n```\n\n" +
    "```formulas\n" +
    "flat = 7400\nrounded = ROUND(SUM(value_usd), 0)\nlabelled = LAST(asset)\n```\n";
  // flat is a bare literal and rounded states its own decimals: no column
  // claim → formatValue's per-value rules, byte-identical to before.
  // labelled DOES claim asset's format (LAST is unit-preserving); it renders
  // legacy because formatSummary short-circuits on a non-number.
  assert.deepEqual(chips(body), { flat: "7400", rounded: "45.080", labelled: "BTC" });
});

test("summary chips: a count scales a quantity instead of erasing it (SUB-1084)", () => {
  // the review's repro: COUNT abstained, and abstention propagated through the
  // division, so the mean fell back to the per-value rules — 3700 rendered bare
  // beneath a column rendering 37.680 / -30.280, the exact 1000x ambiguity
  const body =
    "```csv\nasset,value_usd\nBTC,37680\nHEDGE,-30280\n```\n\n" +
    "```formulas\n" +
    "rows = COUNT(value_usd)\nmean = SUM(value_usd) / COUNT(value_usd)\n" +
    "scaled = COUNT(value_usd) * SUM(value_usd)\nvia_ref = SUM(value_usd) / rows\n```\n";
  assert.equal(formatValue(3700), "3700"); // what the chip used to say
  assert.deepEqual(chips(body), {
    rows: "2", // the count itself stays dimensionless
    mean: "3.700",
    scaled: "14.800", // a count multiplies a quantity too
    via_ref: "3.700", // and carries its claim through an earlier summary
  });
});

test("summary chips: a count added to a quantity claims neither (SUB-1084)", () => {
  // `*` and `/` scale; `+` and `-` mix dimensions, so the result is not the
  // money column's to name and the chip abstains to the legacy rendering
  const body =
    "```csv\nasset,value_usd\nBTC,37680\nHEDGE,-30280\n```\n\n" +
    "```formulas\nodd = SUM(value_usd) + COUNT(value_usd)\n```\n";
  assert.deepEqual(chips(body), { odd: "7402" });
});

test("summary chips: several columns merge toward the explicit grammar (SUB-1084)", () => {
  // value_usd groups (7400 beside 37680); fees is all-integer under 10000 and
  // reads identifier-shaped on its own — but their difference is money, and
  // the ungrouped reading is the dangerous one
  const body =
    "```csv\nasset,value_usd,fees\nGLOW,7400,120\nBTC,37680,80.5\n```\n\n" +
    "```formulas\nnet = SUM(value_usd) - SUM(fees)\n```\n";
  assert.deepEqual(chips(body), { net: "44.879,50" });
});

test("summary chips: a summary built on an earlier summary inherits through it (SUB-1084)", () => {
  const body =
    "```csv\nasset,value_usd\nGLOW,7400\nBTC,37680\n```\n\n" +
    "```formulas\ntotal = SUM(value_usd)\nhalf = total / 2\ndoubled = total * 2\n```\n";
  assert.deepEqual(chips(body), { total: "45.080", half: "22.540", doubled: "90.160" });
});

test("summary chips: LOOKUP inherits its value column, SUMPRODUCT abstains (SUB-1112)", () => {
  // LOOKUP picks a row and returns that row's value_usd cell, exactly as LAST
  // returns a cell — so the chip must read as money like the column does.
  // SUMPRODUCT abstains on purpose: no single column names its result.
  const body =
    "```csv\nasset,value_usd,units\nBTC,37680,1\nHEDGE,-30280,1\nGLOW,7400,0\n```\n\n" +
    "```formulas\n" +
    "picked = LOOKUP(\"GLOW\", asset, value_usd)\n" +
    "keyed = LOOKUP(\"GLOW\", asset, asset)\n" +
    "weighted = SUMPRODUCT(value_usd, units)\n```\n";
  const ev = evaluateSheet(parseSheet(body), fx);
  const fmts = sheetColumnFormats(ev);
  assert.deepEqual(
    ev.rows.map((r) => formatValue(r[1], "value_usd", fmts.data[1])),
    ["37.680", "-30.280", "7.400"]
  );
  assert.equal(formatValue(7400), "7400"); // what the chip used to say
  const out = chips(body);
  assert.equal(out.picked, "7.400");
  assert.equal(out.keyed, "GLOW"); // a text column's claim still renders as text
  // same 7400, no claim: SUMPRODUCT keeps the legacy per-value rendering
  assert.equal(out.weighted, "7400");
});

test("formatSummary: no format is byte-identical to formatValue (SUB-1084)", () => {
  for (const v of [7400, 37680, 2026, 4.1, 0, -9500, "text", true, null, ferr("boom")]) {
    assert.equal(formatSummary(v as never), formatValue(v as never));
  }
  // and a non-finite number can't be dressed in a column's grammar
  assert.equal(formatSummary(Number.NaN, { decimals: 2, group: true }), formatValue(Number.NaN));
});

// ---------- v2: cross-sheet references + formula fence editing ----------

const CASH = `---
type: sheet
title: Cash
---

\`\`\`csv
account,balance_eur
Nordkasse,14200
TR,3800
\`\`\`

\`\`\`formulas
cash_total = SUM(balance_eur)
\`\`\`
`;

const loadCash = (name: string): SheetModel | FErr =>
  name.toLowerCase() === "cash" ? parseSheet(CASH) : ferr(`no note named “${name}”`);

const CROSS_BODY = `---
type: sheet
title: Holdings
---

\`\`\`csv
asset,bucket,units,price_usd
GLOW,etf,1200,31.4
BTC,crypto,4.1,64200
\`\`\`

\`\`\`formulas
value_usd = units * price_usd
value_eur = value_usd * FX("USD","EUR")
total = SUM(value_eur)
grand_total = total + Cash.cash_total
share = value_eur / Cash.cash_total
cash_rows = COUNT(Cash.balance_eur)
\`\`\`
`;

test("classification: cross-sheet scalars make summaries, mixed refs stay columns", () => {
  const m = parseSheet(CROSS_BODY);
  const kinds = m.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`);
  assert.deepEqual(kinds, [
    "value_usd:col",
    "value_eur:col",
    "total:agg",
    "grand_total:agg",
    "share:col",
    "cash_rows:agg",
  ]);
  // a bare cross-sheet scalar is a summary; a constant is one too
  const m2 = parseSheet(
    "```csv\na\n1\n```\n\n```formulas\nplain = Cash.cash_total\nlit = 42\n```"
  );
  assert.deepEqual(
    m2.formulas.map((f) => f.aggregate),
    [true, true]
  );
});

test("classification: constant-only right sides are summaries (SUB-715)", () => {
  const m = parseSheet(
    "```csv\na,b\n1,2\n3,4\n```\n\n```formulas\n" +
      "ceiling = 25000\n" +
      "annual = 2500 * 12\n" +
      'label = "cap"\n' +
      "neg = -5\n" +
      "double = ceiling * 2\n" +
      "mixed = a + 10\n" +
      "row = a * b\n" +
      "total = SUM(a)\n```"
  );
  assert.deepEqual(
    m.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    [
      "ceiling:agg", // bare literal
      "annual:agg", // constant arithmetic (no refs = constant)
      "label:agg", // string literal
      "neg:agg", // negated literal
      "double:agg", // summary over a constant chains like any other
      "mixed:col", // column ref + constant stays a per-row column
      "row:col", // existing computed columns unaffected
      "total:agg",
    ]
  );
  const ev = evaluateSheet(m, fx);
  // no per-row poison: constants are not computed columns…
  assert.deepEqual(ev.computed.map((c) => c.name), ["mixed", "row"]);
  // …but single values, bindable from dashboards (findSummary is the binding path)
  assert.equal(findSummary(ev, "ceiling"), 25000);
  assert.equal(findSummary(ev, "annual"), 30000);
  assert.equal(findSummary(ev, "label"), "cap");
  assert.equal(findSummary(ev, "neg"), -5);
  assert.equal(findSummary(ev, "double"), 50000);
  assert.equal(findSummary(ev, "total"), 4);
  // mixed/existing computed columns still evaluate per row
  assert.deepEqual(ev.computed[0].cells, [11, 13]);
  assert.deepEqual(ev.computed[1].cells, [2, 12]);
  // cross-sheet, a constant binds as a scalar like any other summary
  const mine = parseSheet("```csv\nx\n1\n```\n\n```formulas\ny = Caps.ceiling + 1\n```");
  const ev2 = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n: string): SheetModel | FErr => (n.toLowerCase() === "caps" ? m : ferr("no")),
  });
  assert.equal(findSummary(ev2, "y"), 25001);
});

test("cross-sheet: summaries as scalars, columns in aggregates, per-row mix", () => {
  const ev = evaluateSheet(parseSheet(CROSS_BODY), fx, { self: "Holdings", load: loadCash });
  const total = 300900 * 0.8721;
  near(findSummary(ev, "total"), total);
  near(findSummary(ev, "grand_total"), total + 18000);
  // cross-sheet summary scalar usable per-row
  const share = ev.computed.find((c) => c.name === "share")!;
  near(share.cells[0], (1200 * 31.4 * 0.8721) / 18000);
  near(share.cells[1], (4.1 * 64200 * 0.8721) / 18000);
  // another sheet's data column works inside an aggregate
  assert.equal(findSummary(ev, "cash_rows"), 2);
});

test("cross-sheet: quoted sheet names reach titles with spaces", () => {
  const other = parseSheet("```csv\nx\n40\n```\n\n```formulas\n```");
  const load = (n: string): SheetModel | FErr =>
    n.toLowerCase() === "port folio" ? other : ferr("no");
  const good = parseSheet("```csv\na\n1\n```\n\n```formulas\ng = SUM(\"Port Folio\".x)\n```");
  const ev = evaluateSheet(good, fx, { self: "Mine", load });
  assert.equal(findSummary(ev, "g"), 40);
});

test("cross-sheet: member precedence is summary > computed > data column", () => {
  // Distinct names, one per kind: a member resolves to whichever kind holds it.
  // (Precedence only ever *decided* anything when one name held two kinds, and
  // that is a collision on the source sheet, not a silent pick —
  // see the folded-name block below for that case.)
  const other = parseSheet("```csv\nd,b\n1,10\n2,20\n```\n\n```formulas\nc = b * 3\ns = SUM(b)\n```");
  const mine = parseSheet(
    "```csv\na\n1\n```\n\n```formulas\nfrom_summary = Other.s\nfrom_computed = SUM(Other.c)\nfrom_data = SUM(Other.d)\n```"
  );
  const ev = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  assert.equal(findSummary(ev, "from_summary"), 30);
  assert.equal(findSummary(ev, "from_computed"), 90);
  assert.equal(findSummary(ev, "from_data"), 3);
});

test("cross-sheet: missing sheet and unknown member are scoped errors", () => {
  const noSheet = parseSheet("```csv\na\n1\n```\n\n```formulas\nx = Nope.total\n```");
  const ev1 = evaluateSheet(noSheet, fx, { self: "Mine", load: loadCash });
  const v1 = findSummary(ev1, "x");
  assert.ok(isErr(v1) && v1.err.includes("no note named"), JSON.stringify(v1));

  const noMember = parseSheet("```csv\na\n1\n```\n\n```formulas\nx = Cash.nope\n```");
  const ev2 = evaluateSheet(noMember, fx, { self: "Mine", load: loadCash });
  const v2 = findSummary(ev2, "x");
  assert.ok(isErr(v2) && v2.err.includes("no column or summary"), JSON.stringify(v2));
});

test("cross-sheet: a whole column as a scalar value is an error", () => {
  const body = parseSheet("```csv\na\n1\n```\n\n```formulas\nbad = Cash.balance_eur\n```");
  const ev = evaluateSheet(body, fx, { self: "Mine", load: loadCash });
  const v = findSummary(ev, "bad");
  assert.ok(isErr(v) && v.err.includes("whole column"), JSON.stringify(v));
});

test("cross-sheet: LOOKUP reads a rates table, and is summary-class (SUB-741)", () => {
  const rates = parseSheet("```csv\ncode,rate\nUSD,0.8721\nGBP,1.1642\n```");
  const load = (n: string): SheetModel | FErr =>
    n.toLowerCase() === "rates" ? rates : ferr(`no note named “${n}”`);
  const mine = parseSheet(
    '```csv\nitem,price_usd\na,250\n```\n\n```formulas\n' +
      'usd_rate = LOOKUP("USD", Rates.code, Rates.rate)\n' +
      'eur_total = SUM(price_usd) * LOOKUP("USD", Rates.code, Rates.rate)\n' +
      "```"
  );
  // aggregate-class: both lines are summaries, neither is a per-row column
  assert.deepEqual(
    mine.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["usd_rate:agg", "eur_total:agg"]
  );
  const ev = evaluateSheet(mine, fx, { self: "Mine", load });
  assert.equal(findSummary(ev, "usd_rate"), 0.8721);
  assert.equal(findSummary(ev, "eur_total"), 250 * 0.8721);
  // a miss is an error, never a silent 0 — the whole point for money math
  const missing = parseSheet(
    '```csv\na\n1\n```\n\n```formulas\nr = LOOKUP("JPY", Rates.code, Rates.rate)\n```'
  );
  const v = findSummary(evaluateSheet(missing, fx, { self: "Mine", load }), "r");
  assert.ok(isErr(v) && v.err.includes("no row where"), JSON.stringify(v));
});

test("cross-sheet: a row-shaped LOOKUP key evaluates per row (SUB-748)", () => {
  const rates = parseSheet("```csv\ncode,rate\nUSD,0.8721\nGBP,1.1642\nCHF,1.0503\n```");
  const load = (n: string): SheetModel | FErr =>
    n.toLowerCase() === "rates" ? rates : ferr(`no note named “${n}”`);
  // the flagship shape: each row converts with its OWN currency's rate
  const mine = parseSheet(
    "```csv\nitem,price_usd,currency\na,250,USD\nb,100,GBP\nc,40,CHF\n```\n\n```formulas\n" +
      "eur = price_usd * LOOKUP(currency, Rates.code, Rates.rate)\n" +
      "total_eur = SUM(eur)\n" +
      "```"
  );
  // the row-shaped key flips classification: computed column, not summary
  assert.deepEqual(
    mine.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["eur:col", "total_eur:agg"]
  );
  const ev = evaluateSheet(mine, fx, { self: "Mine", load });
  const eur = ev.computed.find((c) => c.name === "eur")!;
  const cells = eur.cells as number[];
  assert.equal(cells.length, 3);
  assert.ok(Math.abs(cells[0] - 250 * 0.8721) < 1e-9, String(cells[0]));
  assert.ok(Math.abs(cells[1] - 100 * 1.1642) < 1e-9, String(cells[1]));
  assert.ok(Math.abs(cells[2] - 40 * 1.0503) < 1e-9, String(cells[2]));
  // the per-row column feeds an ordinary summary
  const total = findSummary(ev, "total_eur");
  assert.ok(
    typeof total === "number" &&
      Math.abs(total - (250 * 0.8721 + 100 * 1.1642 + 40 * 1.0503)) < 1e-9,
    JSON.stringify(total)
  );

  // a miss breaks ONLY its own row (the engine's row-error convention)
  const withMiss = parseSheet(
    "```csv\nitem,price_usd,currency\na,250,USD\nb,100,JPY\nc,40,CHF\n```\n\n```formulas\n" +
      "eur = price_usd * LOOKUP(currency, Rates.code, Rates.rate)\n" +
      "```"
  );
  const evMiss = evaluateSheet(withMiss, fx, { self: "Mine", load });
  const missCells = evMiss.computed.find((c) => c.name === "eur")!.cells;
  assert.ok(!isErr(missCells[0]), "row 1 is unaffected");
  const bad = missCells[1];
  assert.ok(isErr(bad) && bad.err.includes("no row where"), JSON.stringify(bad));
  assert.ok(!isErr(missCells[2]), "row 3 is unaffected");

  // a same-sheet table works too: the key is what is row-read, not the columns
  const local = parseSheet(
    "```csv\nprice,cur,code,rate\n250,usd,USD,0.8721\n100,gbp,GBP,1.1642\n```\n\n```formulas\n" +
      "eur = price * LOOKUP(cur, code, rate)\n" +
      "```"
  );
  assert.equal(local.formulas[0].aggregate, false);
  const localCells = evaluateSheet(local, fx).computed[0].cells as number[];
  assert.ok(Math.abs(localCells[0] - 250 * 0.8721) < 1e-9, String(localCells[0]));
  assert.ok(Math.abs(localCells[1] - 100 * 1.1642) < 1e-9, String(localCells[1]));
});

test("cross-sheet: LOOKUP keyed by a constant or a summary stays a summary (SUB-748)", () => {
  const rates = parseSheet("```csv\ncode,rate\nUSD,0.8721\nGBP,1.1642\n```");
  const load = (n: string): SheetModel | FErr =>
    n.toLowerCase() === "rates" ? rates : ferr(`no note named “${n}”`);
  // Semantics unchanged: constant key, and a key that is an earlier
  // summary — neither is row-shaped, so both lines stay summaries.
  const mine = parseSheet(
    "```csv\nitem,price_usd,currency\na,250,USD\nb,100,GBP\n```\n\n```formulas\n" +
      'base = "GBP"\n' +
      'usd_rate = LOOKUP("USD", Rates.code, Rates.rate)\n' +
      "base_rate = LOOKUP(base, Rates.code, Rates.rate)\n" +
      "```"
  );
  assert.deepEqual(
    mine.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["base:agg", "usd_rate:agg", "base_rate:agg"]
  );
  const ev = evaluateSheet(mine, fx, { self: "Mine", load });
  assert.equal(findSummary(ev, "usd_rate"), 0.8721);
  assert.equal(findSummary(ev, "base_rate"), 1.1642);
  assert.equal(ev.computed.length, 0, "no per-row columns");
});

test("cross-sheet: circular references error with the chain, no hang", () => {
  const sheetA = parseSheet("```csv\na\n1\n```\n\n```formulas\nx = SheetB.y + 1\n```");
  const sheetB = parseSheet("```csv\nb\n1\n```\n\n```formulas\ny = SheetA.x + 1\n```");
  const load = (n: string): SheetModel | FErr => {
    if (n.toLowerCase() === "sheeta") return sheetA;
    if (n.toLowerCase() === "sheetb") return sheetB;
    return ferr("no");
  };
  const ev = evaluateSheet(sheetA, fx, { self: "SheetA", load });
  const v = findSummary(ev, "x");
  assert.ok(isErr(v), "cycle must error, not hang");
  assert.match(v.err, /circular sheet reference: sheeta → sheetb → sheeta/);
});

test("cross-sheet: self-reference by name is a cycle", () => {
  const mine = parseSheet("```csv\na\n1\n```\n\n```formulas\nx = Mine.x + 1\n```");
  const ev = evaluateSheet(mine, fx, { self: "Mine", load: () => ferr("no") });
  assert.ok(isErr(findSummary(ev, "x")));
});

test("cross-sheet: errors on the other sheet propagate into aggregates", () => {
  const broken = parseSheet("```csv\na\n1\n```\n\n```formulas\nt = SUM(nope)\n```");
  const mine = parseSheet("```csv\na\n1\n```\n\n```formulas\ng = Other.t + SUM(Other.a)\n```");
  const ev = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? broken : ferr("no")),
  });
  assert.ok(isErr(findSummary(ev, "g")), "broken summary + good column still breaks");
});

test("updateSheetFormula edits a right side in place", () => {
  const next = updateSheetFormula(BODY, "rest", "rest", "total - etf");
  assert.ok(next.includes("Some prose that must survive edits."));
  assert.ok(next.includes("rest        = total - etf"), "alignment preserved");
  const ev = evaluateSheet(parseSheet(next), fx);
  near(findSummary(ev, "rest"), (findSummary(ev, "total") as number) - (findSummary(ev, "etf") as number));
  // missing line and empty right side are no-ops
  assert.equal(updateSheetFormula(BODY, "nope", "x", "1"), BODY);
  assert.equal(updateSheetFormula(BODY, "rest", "rest", "  "), BODY);
});

test("updateSheetFormula rename rewrites references, not string literals", () => {
  const next = updateSheetFormula(
    BODY,
    "value_eur",
    "val_eur",
    'value_usd * FX("USD","EUR")'
  );
  assert.ok(next.includes("val_eur = value_usd * FX"), "definition renamed");
  assert.ok(next.includes("total       = SUM(val_eur)"), "refs rewritten");
  assert.ok(next.includes('SUMIF(bucket, "crypto", val_eur)'), "string literal kept");
  const ev = evaluateSheet(parseSheet(next), fx);
  near(findSummary(ev, "total"), 300900 * 0.8721);
});

test("updateSheetFormula rejects name collisions and bad names", () => {
  assert.equal(updateSheetFormula(BODY, "total", "crypto", "SUM(value_eur)"), BODY, "formula clash");
  assert.equal(updateSheetFormula(BODY, "total", "UNITS", "SUM(value_eur)"), BODY, "data column clash");
  assert.equal(updateSheetFormula(BODY, "total", "not a name", "1"), BODY, "invalid ident");
});

test("updateSheetFormula case-only rename rewrites refs to the new casing", () => {
  const next = updateSheetFormula(BODY, "total", "TOTAL", "SUM(value_eur)");
  assert.ok(next.includes("TOTAL       = SUM(value_eur)"));
  assert.ok(next.includes("rest        = TOTAL - crypto"));
  const ev = evaluateSheet(parseSheet(next), fx);
  near(findSummary(ev, "total"), 300900 * 0.8721);
});

// ---------- fence parsing fixes ----------

test("setSheetCell round-trips a quoted cell containing ``` without ejecting rows (SUB-218)", () => {
  const body = "before\n\n```csv\nname,note\na,x\nb,y\n```\n\nafter\n";
  const next = setSheetCell(body, 0, 1, "line1\n```\nline2");
  const m = parseSheet(next);
  assert.equal(m.hasCsv, true);
  assert.deepEqual(m.rows, [
    ["a", "line1\n```\nline2"],
    ["b", "y"],
  ]);
  assert.ok(next.includes("\nafter\n"), "prose after the fence survives");
  // a second write over the quoted cell stays inside the fence too
  const again = setSheetCell(next, 1, 1, "z");
  const m2 = parseSheet(again);
  assert.deepEqual(m2.rows, [
    ["a", "line1\n```\nline2"],
    ["b", "z"],
  ]);
  assert.ok(again.includes("\nafter\n"));
});

test("CRLF body: the fence is found and a cell write round-trips (SUB-218)", () => {
  const body =
    "prose\r\n\r\n```csv\r\nname,note\r\na,x\r\nb,y\r\n```\r\n\r\n```formulas\r\ntotal = COUNT(name)\r\n```\r\nafter\r\n";
  const m = parseSheet(body);
  assert.equal(m.hasCsv, true, "fence found despite CRLF");
  assert.deepEqual(m.headers, ["name", "note"]);
  assert.deepEqual(m.rows, [
    ["a", "x"],
    ["b", "y"],
  ]);
  assert.deepEqual(
    m.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["total:agg"]
  );
  const next = setSheetCell(body, 1, 1, "z");
  const m2 = parseSheet(next);
  assert.deepEqual(m2.rows, [
    ["a", "x"],
    ["b", "z"],
  ]);
  // line endings outside the fence are not rewritten
  assert.ok(next.startsWith("prose\r\n\r\n```csv"), "before the fence untouched");
  assert.ok(
    next.endsWith("```\r\n\r\n```formulas\r\ntotal = COUNT(name)\r\n```\r\nafter\r\n"),
    "after the fence untouched"
  );
});

test("classification: forward references resolve against the whole fence (SUB-218)", () => {
  // a row mixing a summary with a LATER computed row stays a data row
  const m = parseSheet(
    "```csv\na\n1\n2\n```\n\n```formulas\ntotal = SUM(a)\nnet = total - doubled\ndoubled = a * 2\n```"
  );
  assert.deepEqual(
    m.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["total:agg", "net:col", "doubled:col"]
  );
  // a row referencing a LATER summary is still a summary
  const fwd = parseSheet(
    "```csv\na\n1\n2\n```\n\n```formulas\nrest = total - crypto\ntotal = SUM(a)\ncrypto = SUMIF(a, 1, a)\n```"
  );
  assert.deepEqual(
    fwd.formulas.map((f) => `${f.name}:${f.aggregate ? "agg" : "col"}`),
    ["rest:agg", "total:agg", "crypto:agg"]
  );
});

// ---------- ragged rows survive grid mutations ----------

const RAGGED = "```csv\nname,amount\nrent,1200,monthly,essential\nfood,400,weekly\n```\n";

test("setSheetCell keeps extra cells of ragged rows (SUB-227)", () => {
  // editing a cell in one ragged row keeps its own extras and the other row's
  const next = setSheetCell(RAGGED, 0, 1, "1250");
  assert.ok(next.includes("rent,1250,monthly,essential"), "edited row keeps overflow cells");
  assert.ok(next.includes("food,400,weekly"), "untouched ragged row intact");
  // the model still evaluates on the header-width view
  const m = parseSheet(next);
  assert.deepEqual(m.rows, [
    ["rent", "1250"],
    ["food", "400"],
  ]);
});

test("setSheetCell pads a short row instead of shifting cells (SUB-227)", () => {
  const body = "```csv\na,b,c\nx\n```\n";
  const next = setSheetCell(body, 0, 2, "z");
  assert.ok(next.includes("x,,z"), "cell lands in its own column");
});

test("addSheetRow keeps ragged rows intact (SUB-227)", () => {
  const next = addSheetRow(RAGGED);
  assert.ok(next.includes("rent,1200,monthly,essential"));
  assert.ok(next.includes("food,400,weekly"));
  assert.equal(parseSheet(next).rows.length, 3);
});

test("addSheetColumn surfaces a ragged row's first extra cell (SUB-227)", () => {
  const next = addSheetColumn(RAGGED, "cadence");
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["name", "amount", "cadence"]);
  assert.deepEqual(m.rows, [
    ["rent", "1200", "monthly"],
    ["food", "400", "weekly"],
  ]);
  assert.ok(next.includes("rent,1200,monthly,essential"), "cells beyond the new width still kept");
});

// ---------- row/column delete + reorder ----------

test("deleteSheetRow removes exactly one data row, out-of-range is a no-op", () => {
  const next = deleteSheetRow(BODY, 0);
  const m = parseSheet(next);
  assert.deepEqual(m.rows, [["BTC", "crypto", "4.1", "64200"]]);
  assert.equal(deleteSheetRow(BODY, 5), BODY);
  assert.equal(deleteSheetRow(BODY, -1), BODY);
});

test("deleteSheetRow keeps the other ragged row byte-intact (SUB-227 idiom)", () => {
  const next = deleteSheetRow(RAGGED, 1);
  assert.ok(next.includes("rent,1200,monthly,essential"));
  assert.ok(!next.includes("food"));
});

test("moveSheetRow swaps neighbors and refuses the edges", () => {
  const down = moveSheetRow(BODY, 0, 1);
  assert.deepEqual(parseSheet(down).rows[0][0], "BTC");
  const up = moveSheetRow(down, 1, -1);
  assert.deepEqual(parseSheet(up).rows[0][0], "GLOW");
  assert.equal(moveSheetRow(BODY, 0, -1), BODY);
  assert.equal(moveSheetRow(BODY, 1, 1), BODY);
});

test("deleteSheetColumn drops the header and each row's cell", () => {
  const next = deleteSheetColumn(BODY, "bucket");
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["asset", "units", "price_usd"]);
  assert.deepEqual(m.rows[0], ["GLOW", "1200", "31.4"]);
  // unknown name and the last remaining column are no-ops
  assert.equal(deleteSheetColumn(BODY, "nope"), BODY);
  const one = "```csv\nonly\nx\n```\n";
  assert.equal(deleteSheetColumn(one, "only"), one);
});

test("deleteSheetColumn on a ragged row shifts its overflow left with the row", () => {
  const next = deleteSheetColumn(RAGGED, "amount");
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["name"]);
  // header-width view narrows; raw extras stay in the file
  assert.ok(next.includes("rent,monthly,essential"));
});

test("moveSheetColumn swaps header + cells, pads short rows, refuses edges", () => {
  const next = moveSheetColumn(BODY, "bucket", -1);
  const m = parseSheet(next);
  assert.deepEqual(m.headers, ["bucket", "asset", "units", "price_usd"]);
  assert.deepEqual(m.rows[0], ["etf", "GLOW", "1200", "31.4"]);
  assert.equal(moveSheetColumn(BODY, "asset", -1), BODY);
  assert.equal(moveSheetColumn(BODY, "price_usd", 1), BODY);
  // a row shorter than the swap range pads so cells travel with columns
  const short = "```csv\na,b,c\nx\n```\n";
  const swapped = moveSheetColumn(short, "a", 1);
  assert.deepEqual(parseSheet(swapped).rows[0], ["", "x", ""]);
});

test("deleteSheetFormula removes one line; dangling refs error visibly, not silently", () => {
  const next = deleteSheetFormula(BODY, "value_usd");
  const m = parseSheet(next);
  assert.ok(!m.formulas.some((f) => f.name === "value_usd"));
  // value_eur still references value_usd — evaluates to an error, stays present
  const ev = evaluateSheet(m, fx);
  const eur = ev.computed.find((c) => c.name === "value_eur");
  assert.ok(eur && isErr(eur.cells[0]), "dangling reference surfaces as a cell error");
  assert.equal(deleteSheetFormula(BODY, "nope"), BODY);
});

// ---------- a backtick cell must be quoted, or it truncates the fence ----------

test("setSheetCell with a col-0 value starting with ``` keeps every row and the prose (SUB-681)", () => {
  const body = "before\n\n```csv\nname,note\na,x\nb,y\nc,z\n```\n\nafter\n";
  const next = setSheetCell(body, 0, 0, "```fenced");
  const m = parseSheet(next);
  assert.equal(m.hasCsv, true);
  assert.deepEqual(m.rows, [
    ["```fenced", "x"],
    ["b", "y"],
    ["c", "z"],
  ]);
  assert.ok(next.includes("\nafter\n"), "prose after the fence survives");
  // and a later write over the same sheet does not bake in a truncation
  const again = setSheetCell(next, 2, 1, "z2");
  const m2 = parseSheet(again);
  assert.deepEqual(m2.rows, [
    ["```fenced", "x"],
    ["b", "y"],
    ["c", "z2"],
  ]);
  assert.ok(again.includes("\nafter\n"));
});

test("addSheetRow after a backtick col-0 write keeps the sheet intact (SUB-681)", () => {
  const body = "```csv\nname,note\na,x\nb,y\n```\n\ntail prose\n";
  const withTick = setSheetCell(body, 1, 0, "```csv");
  const next = addSheetRow(withTick);
  const m = parseSheet(next);
  assert.deepEqual(m.rows, [
    ["a", "x"],
    ["```csv", "y"],
    ["", ""],
  ]);
  assert.ok(next.includes("\ntail prose\n"), "prose after the fence survives");
});

test("a mid-string backtick cell round-trips byte-stable (SUB-681)", () => {
  const rows = [
    ["name", "note"],
    ["a `code` b", "plain"],
    ["```", "x,y"],
  ];
  const csv = serializeCsv(rows);
  assert.equal(csv, 'name,note\n"a `code` b",plain\n"```","x,y"');
  assert.deepEqual(parseCsv(csv), rows);
  const body = "```csv\n" + csv + "\n```\n\nafter\n";
  const m = parseSheet(body);
  assert.deepEqual(m.rows, [
    ["a `code` b", "plain"],
    ["```", "x,y"],
  ]);
});

// ---------- formulas fence must not grow blank lines ----------

test("updateSheetFormula is byte-idempotent across repeated edits (SUB-683)", () => {
  const once = updateSheetFormula(BODY, "rest", "rest", "total - etf");
  const twice = updateSheetFormula(once, "rest", "rest", "total - etf");
  assert.equal(twice, once, "second identical edit changes nothing");
  const thrice = updateSheetFormula(twice, "rest", "rest", "total - etf");
  assert.equal(thrice, once, "no drift accumulates over further edits");
  assert.equal(
    once,
    BODY.replace("rest        = total - crypto", "rest        = total - etf"),
    "edit touches exactly the one line"
  );
  // the user's interior blank line inside the fence survives
  assert.ok(once.includes('FX("USD","EUR")\n\ntotal'), "interior blank line kept");
});

test("deleteSheetFormula leaves the remaining fence byte-stable (SUB-683)", () => {
  const next = deleteSheetFormula(BODY, "rest");
  assert.equal(next, BODY.replace("rest        = total - crypto\n", ""));
  // deleting again is a no-op, and the fence does not grow
  assert.equal(deleteSheetFormula(next, "rest"), next);
  const two = deleteSheetFormula(next, "etf");
  assert.equal(two, BODY.replace("etf         = SUMIF(bucket, \"etf\", value_eur)\n", "").replace("rest        = total - crypto\n", ""));
});

// ---------- unicode identifiers ----------

describe("SUB-753 unicode identifiers", () => {
  const UBODY = [
    "```csv",
    "Größe,价格",
    "10,3",
    "20,4",
    "```",
    "",
    "```formulas",
    "doppelt = Größe * 2",
    "wert = Größe * 价格",
    "märz_total = SUM(wert)",
    "```",
    "",
  ].join("\n");

  test("umlaut and CJK columns compute per row; umlaut summary aggregates", () => {
    const m = parseSheet(UBODY);
    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.headers, ["Größe", "价格"]);
    const ev = evaluateSheet(m, fx);
    assert.deepEqual(ev.computed.map((c) => c.name), ["doppelt", "wert"]);
    assert.deepEqual(ev.computed[0].cells, [20, 40]);
    assert.deepEqual(ev.computed[1].cells, [30, 80]);
    assert.equal(findSummary(ev, "märz_total"), 110);
  });

  test("summary name folds case across umlauts", () => {
    const ev = evaluateSheet(parseSheet(UBODY), fx);
    assert.equal(findSummary(ev, "MÄRZ_TOTAL"), 110);
    const body = UBODY.replace("doppelt = Größe * 2", "doppelt = größe * 2");
    const lower = evaluateSheet(parseSheet(body), fx);
    assert.deepEqual(lower.computed[0].cells, [20, 40]);
  });

  test("addSheetColumn accepts a unicode name, still refuses a digit start", () => {
    assert.ok(addSheetColumn(UBODY, "Höhe").includes("Größe,价格,Höhe"));
    assert.equal(addSheetColumn(UBODY, "2024"), UBODY);
  });

  test("updateSheetFormula renames a unicode summary and rewrites its refs", () => {
    const body = UBODY.replace("märz_total = SUM(wert)", "märz_total = SUM(wert)\nrest = märz_total - 10");
    const next = updateSheetFormula(body, "märz_total", "märz_summe", "SUM(wert)");
    assert.ok(next.includes("märz_summe = SUM(wert)"));
    assert.ok(next.includes("rest = märz_summe - 10"));
    assert.equal(findSummary(evaluateSheet(parseSheet(next), fx), "märz_summe"), 110);
  });

  test("deleteSheetFormula matches a unicode name", () => {
    const next = deleteSheetFormula(UBODY, "MÄRZ_TOTAL");
    assert.ok(!next.includes("märz_total"));
    assert.ok(next.includes("doppelt = Größe * 2"));
  });
});

// ---------- folded-name collisions ----------
// Names bind case-insensitively, so two distinct names can fold to one. The
// engine reports the ambiguity instead of letting the last binding win.

test("SUB-751: two data columns folding to one name error by name, everywhere", () => {
  const body = "```csv\nprice,PRICE,units\n10,999,2\n20,888,3\n```\n\n```formulas\nx = price * 2\nt = SUM(price)\n```\n";
  const m = parseSheet(body);
  assert.deepEqual(m.errors, ['two columns fold to “price” — rename one']);
  const ev = evaluateSheet(m, fx);
  // row scope: every cell of the referencing column names the collision
  for (const cell of ev.computed[0].cells) {
    assert.ok(isErr(cell) && /two columns fold to “price”/.test(cell.err), JSON.stringify(cell));
  }
  // summary scope: the aggregate reports it too, instead of summing column 2
  const t = findSummary(ev, "t");
  assert.ok(isErr(t) && /two columns fold to “price”/.test(t.err), JSON.stringify(t));
  // the sheet still loads and its data still renders — both columns visible
  assert.deepEqual(m.headers, ["price", "PRICE", "units"]);
  assert.deepEqual(ev.rows, [[10, 999, 2], [20, 888, 3]]);
  // the uninvolved column is untouched
  assert.equal(findSummary(evaluateSheet(parseSheet(body.replace("t = SUM(price)", "t = SUM(units)")), fx), "t"), 5);
});

test("SUB-751: two formula lines folding to one name error, later refs included", () => {
  const body = "```csv\na\n1\n2\n```\n\n```formulas\ntotal = SUM(a)\nTOTAL = SUM(a) * 10\nafter = total + 1\n```\n";
  const m = parseSheet(body);
  assert.deepEqual(m.errors, ['two formulas fold to “total” — rename one']);
  const ev = evaluateSheet(m, fx);
  // both lines keep their place in the summary bar, both carry the collision
  assert.deepEqual(ev.summaries.map((s) => s.name), ["total", "TOTAL", "after"]);
  for (const name of ["total", "TOTAL"]) {
    const v = findSummary(ev, name);
    assert.ok(isErr(v) && /two formulas fold to “total”/.test(v.err), `${name}: ${JSON.stringify(v)}`);
  }
  // a later reference reads the ambiguity, not 30 (nor 3)
  const after = findSummary(ev, "after");
  assert.ok(isErr(after) && /two formulas fold to “total”/.test(after.err), JSON.stringify(after));
});

test("SUB-751: a formula named like a data column collides instead of shadowing", () => {
  const body = "```csv\ntotal,x\n10,1\n20,2\n```\n\n```formulas\ntotal = x * 100\nt = SUM(total)\n```\n";
  const m = parseSheet(body);
  assert.deepEqual(m.errors, ['“total” is both a column and a formula name — rename one']);
  const ev = evaluateSheet(m, fx);
  // neither the computed 300 nor the data 30 is served under an ambiguous name
  const t = findSummary(ev, "t");
  assert.ok(isErr(t) && /both a column and a formula name/.test(t.err), JSON.stringify(t));
  for (const cell of ev.computed[0].cells) assert.ok(isErr(cell), JSON.stringify(cell));
  // the data is still there to read in the grid
  assert.deepEqual(ev.rows, [[10, 1], [20, 2]]);
});

test("SUB-751: collisions are case-fold-wide and reported once per folded name", () => {
  const body = "```csv\nPrice,pRiCe,price\n1,2,3\n```\n\n```formulas\nUnits = 1\nunits = 2\n```\n";
  const m = parseSheet(body);
  assert.deepEqual(m.errors, [
    'three columns fold to “price” — rename one',
    'two formulas fold to “units” — rename one',
  ]);
});

test("SUB-751: a row-scoped LOOKUP over an ambiguous table column errors too", () => {
  const body =
    "```csv\ncur,code,CODE,rate\nUSD,USD,EUR,2\nEUR,EUR,USD,3\n```\n\n```formulas\nr = LOOKUP(cur, code, rate)\n```\n";
  const m = parseSheet(body);
  assert.deepEqual(m.errors, ['two columns fold to “code” — rename one']);
  const ev = evaluateSheet(m, fx);
  for (const cell of ev.computed[0].cells) {
    assert.ok(isErr(cell) && /two columns fold to “code”/.test(cell.err), JSON.stringify(cell));
  }
});

// ---------- collisions cross the sheet boundary ----------
// The reader can't disambiguate what the source sheet left ambiguous, so a
// member off a folded name errors instead of serving the first binding.

test("SUB-756: a member off a dup-folded data column errors by name", () => {
  const other = parseSheet("```csv\nprice,PRICE,units\n10,999,2\n20,888,3\n```\n\n```formulas\n```");
  assert.deepEqual(other.errors, ['two columns fold to “price” — rename one']);
  const mine = parseSheet(
    "```csv\na\n1\n```\n\n```formulas\nt = SUM(Other.price)\nper_row = a + Other.price\n```"
  );
  const ev = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  // not 30 (first column) and not 1887 (second): the ambiguity, by name
  const t = findSummary(ev, "t");
  assert.ok(isErr(t) && /two columns fold to “price”/.test(t.err), JSON.stringify(t));
  // and in row scope too, rather than a whole-column-as-value complaint
  for (const cell of ev.computed[0].cells) {
    assert.ok(isErr(cell) && /two columns fold to “price”/.test(cell.err), JSON.stringify(cell));
  }
  // the uninvolved column on the same source sheet still reads fine
  const ok = parseSheet("```csv\na\n1\n```\n\n```formulas\nu = SUM(Other.units)\n```");
  const ev2 = evaluateSheet(ok, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  assert.equal(findSummary(ev2, "u"), 5);
});

test("SUB-756: a member off a colliding formula name already errors", () => {
  const other = parseSheet("```csv\na\n1\n2\n```\n\n```formulas\ntotal = SUM(a)\nTOTAL = SUM(a) * 10\n```");
  assert.deepEqual(other.errors, ['two formulas fold to “total” — rename one']);
  const mine = parseSheet("```csv\na\n1\n```\n\n```formulas\nx = Other.total + 1\n```");
  const ev = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  const x = findSummary(ev, "x");
  assert.ok(isErr(x) && /two formulas fold to “total”/.test(x.err), JSON.stringify(x));
});

test("SUB-756 control: ordinary cross-sheet member reads are unchanged", () => {
  const other = parseSheet("```csv\nd,b\n1,10\n2,20\n```\n\n```formulas\nc = b * 3\ns = SUM(b)\n```");
  assert.deepEqual(other.errors, []);
  const mine = parseSheet(
    "```csv\na\n1\n```\n\n```formulas\nfrom_summary = Other.s\nfrom_computed = SUM(Other.c)\nfrom_data = SUM(Other.d)\n```"
  );
  const ev = evaluateSheet(mine, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  assert.equal(findSummary(ev, "from_summary"), 30);
  assert.equal(findSummary(ev, "from_computed"), 90);
  assert.equal(findSummary(ev, "from_data"), 3);
  // an unknown member is still the unknown-member error, not a collision one
  const bad = parseSheet("```csv\na\n1\n```\n\n```formulas\nn = Other.nope\n```");
  const evb = evaluateSheet(bad, fx, {
    self: "Mine",
    load: (n) => (n.toLowerCase() === "other" ? other : ferr("no")),
  });
  const n = findSummary(evb, "n");
  assert.ok(isErr(n) && n.err.includes("no column or summary"), JSON.stringify(n));
});

test("SUB-751 control: an ordinary sheet is completely unchanged", () => {
  const m = parseSheet(BODY);
  assert.deepEqual(m.errors, []);
  const ev = evaluateSheet(m, fx);
  near(findSummary(ev, "total"), (1200 * 31.4 + 4.1 * 64200) * 0.8721);
  assert.deepEqual(ev.computed.map((c) => c.name), ["value_usd", "value_eur"]);
  for (const c of ev.computed) for (const cell of c.cells) assert.ok(!isErr(cell), JSON.stringify(cell));
  for (const s of ev.summaries) assert.ok(!isErr(s.value), s.name);
  // case-only *reuse* of one name (a header referenced in another casing) is
  // not a collision: one binding, two spellings, which has always worked.
  const same = parseSheet("```csv\nPrice\n2\n4\n```\n\n```formulas\nd = PRICE * 2\nt = SUM(pRiCe)\n```\n");
  assert.deepEqual(same.errors, []);
  const ev2 = evaluateSheet(same, fx);
  assert.deepEqual(ev2.computed[0].cells, [4, 8]);
  assert.equal(findSummary(ev2, "t"), 6);
});

describe("SUB-915 — de-DE input gate is earned per column, not assumed", () => {
  const model = (csv: string) => parseSheet("```csv\n" + csv + "\n```\n");

  test("a numeric column qualifies; its other rows are the evidence", () => {
    const m = model("asset,price\nGLOW,31.4\nBTC,64200\nARC,92.5");
    assert.equal(columnTakesNumberInput(m, 1, 0), true);
    // the text column next to it never does
    assert.equal(columnTakesNumberInput(m, 0, 0), false);
  });

  test("a text column with dotted values is left alone (192.168 stays)", () => {
    const m = model("host,port\nrouter,80\ngateway,443");
    // editing row 0 of `host`: the other host cell is text → no normalization
    assert.equal(columnTakesNumberInput(m, 0, 0), false);
  });

  test("a label column never qualifies even when every cell is a number", () => {
    const m = model("year,order_id,amount\n2024,48211,10\n2025,48212,20");
    assert.equal(columnTakesNumberInput(m, 0, 0), false);
    assert.equal(columnTakesNumberInput(m, 1, 0), false);
    assert.equal(columnTakesNumberInput(m, 2, 0), true);
  });

  test("no evidence (single row, or all-blank column) → verbatim", () => {
    const one = model("a,b\n1,2");
    assert.equal(columnTakesNumberInput(one, 1, 0), false); // only row is the edited one
    const blank = model("a,b\n1,\n2,");
    assert.equal(columnTakesNumberInput(blank, 1, 0), false);
    // blanks abstain rather than veto: numbers elsewhere still qualify
    const gappy = model("a,b\n1,5\n2,\n3,7");
    assert.equal(columnTakesNumberInput(gappy, 1, 1), true);
  });

  test("one non-numeric cell disqualifies the whole column", () => {
    const m = model("a,qty\nx,10\ny,n/a\nz,30");
    assert.equal(columnTakesNumberInput(m, 1, 0), false);
  });

  test("out-of-range column index is not numeric", () => {
    const m = model("a,b\n1,2\n3,4");
    assert.equal(columnTakesNumberInput(m, 9, 0), false);
  });
});

describe("SUB-939 — summary bar hierarchy, error rollup, FX stamp", () => {
  const sheet = (formulas: string, csv = "asset,bucket,units,price_usd\nGLOW,etf,1200,31.4\nBTC,crypto,4.1,64200") =>
    parseSheet("```csv\n" + csv + "\n```\n\n```formulas\n" + formulas + "\n```\n");
  const bar = (formulas: string, csv?: string) =>
    summaryBar(evaluateSheet(sheet(formulas, csv), fx).summaries);
  const names = (chips: { name: string }[]) => chips.map((c) => c.name);

  test("blank lines group the fence; runs, leading blanks and comments don't invent groups", () => {
    const m = sheet(
      "\n# helpers\nvalue_usd = units * price_usd\n\n\ntotal = SUM(value_usd)\n# a comment inside the block\nbig = MAX(value_usd)\n\nspare = 25000\n"
    );
    assert.deepEqual(
      m.formulas.map((f) => [f.name, f.group]),
      [
        ["value_usd", 0],
        ["total", 1],
        ["big", 1],
        ["spare", 2],
      ]
    );
  });

  test("a fence with no blank lines is one group — the bar is unchanged", () => {
    const b = bar("value_usd = units * price_usd\ntotal = SUM(value_usd)\nbig = MAX(value_usd)");
    assert.deepEqual(names(b.headline), ["total", "big"]);
    assert.deepEqual(b.rest, []);
    assert.deepEqual(b.rollups, []);
  });

  test("the headline is the first summary-bearing group, not group 0", () => {
    // the canonical shape: computed columns above the blank line, totals below
    const b = bar(
      "value_usd = units * price_usd\nvalue_eur = value_usd * FX(\"USD\",\"EUR\")\n\ntotal = SUM(value_eur)\ncrypto = SUMIF(bucket, \"crypto\", value_eur)"
    );
    assert.deepEqual(names(b.headline), ["total", "crypto"]);
    assert.deepEqual(b.rest, []);
  });

  test("later groups collapse behind the toggle, in definition order", () => {
    const b = bar(
      "total = SUM(units)\nbig = MAX(units)\n\navg = AVG(units)\nlow = MIN(units)\n\ncount = COUNT(units)"
    );
    assert.deepEqual(names(b.headline), ["total", "big"]);
    assert.deepEqual(names(b.rest), ["avg", "low", "count"]);
  });

  test("summaries failing from one root cause become a single rollup chip", () => {
    // `value_eur` is both a data column and a formula name: every
    // summary reading it carries the same collision message
    const b = bar(
      "value_usd = units * price_usd\nvalue_eur = value_usd * 2\n\ntotal = SUM(value_eur)\ncrypto = SUMIF(bucket, \"crypto\", value_eur)\netf = SUMIF(bucket, \"etf\", value_eur)",
      "asset,bucket,units,price_usd,value_eur\nGLOW,etf,1200,31.4,1\nBTC,crypto,4.1,64200,2"
    );
    assert.equal(b.rollups.length, 1);
    assert.match(b.rollups[0].message ?? "", /value_eur/);
    assert.deepEqual(b.rollups[0].names, ["total", "crypto", "etf"]);
    // the headline row stops being a row of `!` — the rolled-up ones move back
    assert.deepEqual(b.headline, []);
    assert.deepEqual(names(b.rest), ["total", "crypto", "etf"]);
  });

  test("a lone failure stays a chip in place — its name is the useful part", () => {
    const b = bar("total = SUM(units)\nnope = SUM(missing_column)");
    assert.deepEqual(b.rollups, []);
    assert.deepEqual(names(b.headline), ["total", "nope"]);
  });

  test("unrelated failures collapse into one untargeted chip once there are two", () => {
    const b = bar("total = SUM(units)\nnope = SUM(missing_a)\nalso = SUM(missing_b)");
    assert.equal(b.rollups.length, 1);
    assert.equal(b.rollups[0].message, null);
    assert.deepEqual(b.rollups[0].names, ["nope", "also"]);
    assert.deepEqual(names(b.headline), ["total"]);
    assert.deepEqual(names(b.rest), ["nope", "also"]);
  });

  test("an empty summary list is an empty bar", () => {
    const b = bar("value_usd = units * price_usd");
    assert.deepEqual(b, { headline: [], rest: [], rollups: [] });
  });

  test("the FX stamp asks whether this sheet converts currency", () => {
    assert.equal(sheetUsesFx(sheet("eur = units * price_usd * FX(\"USD\",\"EUR\")")), true);
    assert.equal(sheetUsesFx(sheet("total = ROUND(SUM(units * FX(\"USD\",\"EUR\")), 2)")), true);
    assert.equal(sheetUsesFx(sheet("total = SUM(units)\nbig = MAX(price_usd)")), false);
    // an unparsable line can't claim a rate either
    assert.equal(sheetUsesFx(sheet("total = SUM(")), false);
  });
});

describe("SUB-937 — totals row placement", () => {
  const place = (body: string) => {
    const t = totalsRow(parseSheet(body));
    return [...t.byColumn.entries()].map(([col, names]) => `${col}:${names.join(",")}`).sort();
  };
  // asset(0) bucket(1) units(2) price_usd(3) | value_usd(4) value_eur(5)
  test("a single-column aggregate lands under its column", () => {
    // total, crypto and etf are all sums OF value_eur; `rest` reads only
    // other summaries and stays in the footer
    assert.deepEqual(place(BODY), ["5:total,crypto,etf"]);
  });

  test("a filtered sum lands under the column it sums (SUB-1013)", () => {
    const t = totalsRow(parseSheet(BODY));
    // crypto/etf read bucket too, but they are sums OF value_eur — the
    // criteria column is a modifier, not what the number is about
    assert.equal(t.absorbed.has("crypto"), true);
    assert.equal(t.absorbed.has("etf"), true);
    assert.equal(t.absorbed.has("total"), true);
    assert.equal(t.absorbed.has("rest"), false, "reads only summaries → footer");
  });

  test("SUMIF placement follows its value argument, not its filters", () => {
    const csv = "```csv\nstatus,region,value_eur\nopen,eu,10\ndone,us,20\n```\n\n```formulas\n";
    // status(0) region(1) value_eur(2)
    // two-arg form sums the criteria column itself
    assert.deepEqual(place(csv + 'own = SUMIF(value_eur, ">5")\n```\n'), ["2:own"]);
    // three-arg form sums the third argument
    assert.deepEqual(place(csv + 'open = SUMIF(status, "open", value_eur)\n```\n'), ["2:open"]);
    // extra (column, match) pairs are more filters, not more value columns
    assert.deepEqual(
      place(csv + 'eu = SUMIF(status, "open", value_eur, region, "eu")\n```\n'),
      ["2:eu"]
    );
    // a criteria column that happens to be a ref is still only a filter
    assert.deepEqual(place(csv + "cmp = SUMIF(status, region, value_eur)\n```\n"), ["2:cmp"]);
  });

  test("COUNTIF still sits under the column it filters on", () => {
    const csv = "```csv\nstatus,region,value_eur\nopen,eu,10\n```\n\n```formulas\n";
    assert.deepEqual(place(csv + 'n = COUNTIF(status, "open")\n```\n'), ["0:n"]);
    // two filter columns describe it equally → no single column → footer
    assert.deepEqual(place(csv + 'n = COUNTIF(status, "open", region, "eu")\n```\n'), []);
  });

  test("a filtered sum combined with another column is still ambiguous", () => {
    const csv = "```csv\nstatus,a,b\nopen,1,2\n```\n\n```formulas\n";
    // one value column, arithmetic on top → still that column
    assert.deepEqual(place(csv + 'monthly = SUMIF(status, "open", a) / 12\n```\n'), ["1:monthly"]);
    // two different value columns → footer
    assert.deepEqual(place(csv + 'both = SUMIF(status, "open", a) + SUM(b)\n```\n'), []);
  });

  test("a summary reading only other summaries stays in the footer", () => {
    const body =
      "```csv\na,b\n1,2\n3,4\n```\n\n```formulas\nsa = SUM(a)\nsb = SUM(b)\nboth = sa + sb\n```\n";
    const t = totalsRow(parseSheet(body));
    assert.deepEqual([...t.byColumn.entries()], [[0, ["sa"]], [1, ["sb"]]]);
    assert.equal(t.absorbed.has("both"), false);
  });

  test("a constant summary has no column and stays in the footer", () => {
    const body = "```csv\na\n1\n```\n\n```formulas\nceiling = 25000\nannual = 2500 * 12\n```\n";
    const t = totalsRow(parseSheet(body));
    assert.equal(t.byColumn.size, 0);
    assert.equal(t.absorbed.size, 0);
  });

  test("a cross-sheet summary stays in the footer, mixed refs too", () => {
    const body =
      "```csv\nv\n1\n```\n\n```formulas\nt = SUM(v)\ng = SUM(v) + Cash.cash_total\nx = Cash.cash_total\n```\n";
    const t = totalsRow(parseSheet(body));
    // `g` reads one row-shaped column (v) plus a cross-sheet scalar — the
    // cross ref is stripped, so it still describes v and lands there.
    assert.deepEqual(t.byColumn.get(0), ["t", "g"]);
    assert.equal(t.absorbed.has("x"), false);
  });

  test("several summaries over one column stack in fence order", () => {
    const body =
      "```csv\ncost\n10\n20\n```\n\n```formulas\ns = SUM(cost)\na = AVG(cost)\nm = MAX(cost)\n```\n";
    assert.deepEqual(totalsRow(parseSheet(body)).byColumn.get(0), ["s", "a", "m"]);
  });

  test("a computed column's aggregate lands under the computed column", () => {
    const body =
      "```csv\nunits,price\n2,3\n4,5\n```\n\n```formulas\nline = units * price\ntotal = SUM(line)\n```\n";
    // grid order: units(0) price(1) | line(2)
    assert.deepEqual(totalsRow(parseSheet(body)).byColumn.get(2), ["total"]);
  });

  test("arithmetic on one column still describes that column", () => {
    const body = "```csv\ncost\n10\n```\n\n```formulas\nnet = SUM(cost) * 1.19\n```\n";
    assert.deepEqual(totalsRow(parseSheet(body)).byColumn.get(0), ["net"]);
  });

  test("an unparsable or ambiguous summary is never placed (SUB-751)", () => {
    const bad = "```csv\na\n1\n```\n\n```formulas\nt = SUM(a\n```\n";
    assert.equal(totalsRow(parseSheet(bad)).byColumn.size, 0);
    // two columns folding to one name: neither the name nor a reference to it
    // may resolve, so nothing lands in the totals row
    const amb = "```csv\nprice,PRICE\n1,2\n```\n\n```formulas\nt = SUM(price)\n```\n";
    assert.equal(totalsRow(parseSheet(amb)).byColumn.size, 0);
    // a summary whose own name is ambiguous is refused too
    const own = "```csv\na\n1\n```\n\n```formulas\nt = SUM(a)\nT = SUM(a)\n```\n";
    assert.equal(totalsRow(parseSheet(own)).byColumn.size, 0);
  });

  test("computed columns are never placed — only summaries", () => {
    const body = "```csv\nunits,price\n2,3\n```\n\n```formulas\nline = units * price\n```\n";
    assert.equal(totalsRow(parseSheet(body)).byColumn.size, 0);
  });

  test("a reference to nothing on this sheet places nothing", () => {
    const body = "```csv\na\n1\n```\n\n```formulas\nt = SUM(nope)\n```\n";
    assert.equal(totalsRow(parseSheet(body)).byColumn.size, 0);
  });
});

describe("SUB-937 — summary editor classification", () => {
  const body =
    "```csv\na,b\n1,2\n3,4\n```\n\n```formulas\ntotal = SUM(a)\nlater = SUM(b)\n```\n";

  test("rejects row-shaped formulas instead of creating computed columns", () => {
    assert.equal(
      summaryFormulaError(body, null, "doubled", "a * 2"),
      "that’s a column formula, not a summary"
    );
    assert.equal(
      summaryFormulaError(body, "total", "total", "a + b"),
      "that’s a column formula, not a summary"
    );
  });

  test("keeps the full summary language available", () => {
    assert.equal(summaryFormulaError(body, null, "filtered", 'SUMIF(a, ">1", b)'), null);
    assert.equal(summaryFormulaError(body, null, "constant", "2500 * 12"), null);
    assert.equal(summaryFormulaError(body, null, "cross", "Cash.cash_total + later"), null);
  });

  test("refuses a name the sheet already uses instead of silently dropping the add", () => {
    for (const taken of ["total", "TOTAL", "a"]) {
      const err = summaryFormulaError(body, null, taken, "SUM(b)");
      assert.ok(err && err.includes("already used"), err ?? `${taken} validated as free`);
    }
    // A rename onto its own name is not a collision.
    assert.equal(summaryFormulaError(body, "total", "total", "SUM(b)"), null);
  });

  test("reports syntax errors honestly instead of calling them column formulas", () => {
    const err = summaryFormulaError(body, null, "broken", "SUM(a");
    assert.ok(err && err !== "that’s a column formula, not a summary", err ?? "missing error");
  });
});

describe("SUB-944 — which Count a quick-pick prefills", () => {
  // The grid asks about a whole grid column, data or computed: the same value
  // list the cells render from.
  const gridColumn = (body: string, c: number) => {
    const ev = evaluateSheet(parseSheet(body), fx);
    const dataCols = ev.headers.length;
    return c < dataCols
      ? ev.rows.map((r) => r[c])
      : (ev.computed[c - dataCols]?.cells ?? []);
  };

  test("a column of text takes the wildcard COUNTIF", () => {
    assert.equal(countPickKind(["yes", "yes", "no"]), "COUNTIF");
  });

  test("a column with numbers keeps COUNT, mixed columns too", () => {
    assert.equal(countPickKind([10, 20, 30]), "COUNT");
    // one number is enough — COUNT still has something honest to report
    assert.equal(countPickKind(["n/a", 20, null]), "COUNT");
    // strings that parse strictly are what COUNT itself counts
    assert.equal(countPickKind(["12", "n/a"]), "COUNT");
    assert.equal(countPickKind(["1e3", "0x10"]), "COUNTIF", "those stay text");
  });

  test("an empty column keeps COUNT — no evidence, no switch", () => {
    assert.equal(countPickKind([]), "COUNT");
    assert.equal(countPickKind([null, undefined, "", "   "]), "COUNT");
    // errors are not type evidence; COUNT preserves aggregate error propagation
    assert.equal(countPickKind([ferr("boom"), null]), "COUNT");
    // …but one real text cell beside them is still evidence
    assert.equal(countPickKind([ferr("boom"), "eur"]), "COUNTIF");
  });

  test("booleans count as text, not as numbers", () => {
    assert.equal(countPickKind([true, false]), "COUNTIF");
  });

  test("over a real sheet: text data column vs numeric one", () => {
    const body = "```csv\nmonth,paid,rent\n2026-01,yes,1240\n2026-02,no,1290\n```\n";
    assert.equal(countPickKind(gridColumn(body, 0)), "COUNTIF"); // month
    assert.equal(countPickKind(gridColumn(body, 1)), "COUNTIF"); // paid
    assert.equal(countPickKind(gridColumn(body, 2)), "COUNT"); // rent
  });

  test("over a real sheet: computed columns are judged by their values", () => {
    const body =
      "```csv\nunits,price,tag\n2,3,a\n4,5,b\n```\n\n```formulas\n" +
      'line = units * price\nlabel = IF(units > 3, "big", "small")\n```\n';
    // grid order: units(0) price(1) tag(2) | line(3) label(4)
    assert.equal(countPickKind(gridColumn(body, 3)), "COUNT");
    assert.equal(countPickKind(gridColumn(body, 4)), "COUNTIF");
  });

  test("the wildcard COUNTIF it points at counts every non-blank cell", () => {
    const body =
      '```csv\npaid\nyes\nno\n\nyes\n```\n\n```formulas\npaid_count = COUNTIF(paid, "*")\n```\n';
    assert.equal(countPickKind(gridColumn(body, 0)), "COUNTIF");
    assert.equal(findSummary(evaluateSheet(parseSheet(body), fx), "paid_count"), 3);
  });
});

describe("SUB-937 — addSheetFormula", () => {
  test("appends to an existing fence, everything else byte-identical", () => {
    const next = addSheetFormula(BODY, "avg_eur", "AVG(value_eur)");
    assert.ok(next.includes("avg_eur = AVG(value_eur)"));
    assert.ok(next.includes("Some prose that must survive edits."));
    assert.ok(next.includes("rest        = total - crypto"), "existing lines untouched");
    const m = parseSheet(next);
    assert.deepEqual(m.errors, []);
    const last = m.formulas[m.formulas.length - 1];
    assert.equal(last.name, "avg_eur");
    assert.equal(last.aggregate, true);
  });

  test("creates the fence after the csv block when there is none", () => {
    const body = "intro\n\n```csv\na\n1\n2\n```\n\ntrailing prose\n";
    const next = addSheetFormula(body, "t", "SUM(a)");
    assert.ok(next.indexOf("```formulas") > next.indexOf("```csv"));
    assert.ok(next.includes("trailing prose"), "prose below the csv survives");
    const ev = evaluateSheet(parseSheet(next), fx);
    assert.equal(findSummary(ev, "t"), 3);
  });

  test("appends above trailing blank lines instead of growing a gap", () => {
    const body = "```csv\na\n1\n```\n\n```formulas\nx = SUM(a)\n\n```\n";
    const next = addSheetFormula(body, "y", "MAX(a)");
    assert.ok(next.includes("x = SUM(a)\ny = MAX(a)\n\n```"), next);
  });

  test("refuses collisions, bad names and empty right sides", () => {
    assert.equal(addSheetFormula(BODY, "total", "SUM(units)"), BODY, "formula clash");
    assert.equal(addSheetFormula(BODY, "UNITS", "SUM(units)"), BODY, "data column clash");
    assert.equal(addSheetFormula(BODY, "not a name", "1"), BODY, "invalid ident");
    assert.equal(addSheetFormula(BODY, "ok", "   "), BODY, "empty src");
  });

  test("round-trips with deleteSheetFormula", () => {
    const added = addSheetFormula(BODY, "avg_eur", "AVG(value_eur)");
    assert.equal(deleteSheetFormula(added, "avg_eur"), BODY);
  });
});

describe("SUB-937 — selectionStats", () => {
  test("sum/avg over numbers, count over everything non-blank", () => {
    const s = selectionStats([1, 2, 3]);
    assert.deepEqual([s.count, s.numeric, s.sum, s.avg], [3, 3, 6, 2]);
  });

  test("blanks are skipped, text counts but adds nothing", () => {
    const s = selectionStats([1, null, "", "  ", "etf", 3]);
    assert.equal(s.count, 3);
    assert.equal(s.numeric, 2);
    assert.equal(s.sum, 4);
    assert.equal(s.avg, 2);
  });

  test("an all-text selection has no sum to report", () => {
    const s = selectionStats(["a", "b"]);
    assert.deepEqual([s.count, s.numeric, s.avg], [2, 0, null]);
  });

  test("an error cell counts as a cell but contributes no number", () => {
    const s = selectionStats([10, ferr("boom"), 20]);
    assert.deepEqual([s.count, s.numeric, s.sum], [3, 2, 30]);
  });

  test("an empty selection is empty, not zero-averaged", () => {
    assert.deepEqual(selectionStats([]), { count: 0, numeric: 0, sum: 0, avg: null });
  });
});

describe("SUB-832 — the history seam through a sheet", () => {
  const sheet = (formulas: string, csv = "asset,units\nGLOW,1200\nBTC,4.1") =>
    parseSheet("```csv\n" + csv + "\n```\n\n```formulas\n" + formulas + "\n```\n");
  const today = () => "2026-03-01";
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 12).getTime();
  };

  // One vault, one lane: 84 kg from mid-January, 82 from mid-February, 81 now.
  // The oldest surviving snapshot is 2026-01-05 — before that is unknowable.
  const NOTES = [{ path: "Health/Weight.md", props: { weight: "81" } }];
  const LANE: FactLane = {
    path: "Health/Weight.md",
    key: "weight",
    points: [
      { commit: "aaa", ts_ms: at("2026-01-10"), value: "84", actor: { kind: "app" }, subject: "snapshot" },
      { commit: "bbb", ts_ms: at("2026-02-10"), value: "82", actor: { kind: "app" }, subject: "snapshot" },
      { commit: "ccc", ts_ms: at("2026-02-28"), value: "81", actor: { kind: "app" }, subject: "snapshot" },
    ],
    oldest_ts_ms: at("2026-01-05"),
  };

  /** What a pane does, in three lines: collect the sheet's past reads, fetch
      exactly those facts, hand the engine a resolver over what came back. A
      lane nobody asked for is NOT in it — which is how an unprefetchable read
      ends up reporting "not loaded" instead of quietly answering. */
  const paneResolver = (m: SheetModel): HistoryResolver => {
    const want = new Set(sheetHistoryRefs(m, today).map((r) => `${r.path}\u0000${r.key}`));
    return makeHistoryResolver(
      NOTES,
      [LANE].filter((l) => want.has(`${l.path}\u0000${l.key}`))
    );
  };
  const run = (m: SheetModel) => evaluateSheet(m, fx, undefined, today, paneResolver(m));

  test("the history stamp asks whether this sheet reads facts at all", () => {
    assert.equal(sheetUsesHistory(sheet('now = PROP("Health/Weight.md", "weight")')), true);
    assert.equal(
      sheetUsesHistory(sheet('then = AT("2026-02-15", PROP("Health/Weight.md", "weight"))')),
      true
    );
    assert.equal(sheetUsesHistory(sheet("total = SUM(units)")), false);
    // an unparsable line can't claim a lane either
    assert.equal(sheetUsesHistory(sheet("total = PROP(")), false);
  });

  test("the present tense collects no refs — it costs no revwalk", () => {
    assert.deepEqual(sheetHistoryRefs(sheet('now = PROP("Health/Weight.md", "weight")'), today), []);
  });

  test("past reads are collected as (path, key, date), deduped across lines", () => {
    const refs = sheetHistoryRefs(
      sheet(
        'a = AT("2026-02-15", PROP("Health/Weight.md", "weight"))\n' +
          'b = AT("2026-02-15", PROP("Health/Weight.md", "weight")) * 2\n' +
          'c = AT(TODAY(), PROP("Health/Weight.md", "weight"))'
      ),
      today
    );
    assert.deepEqual(refs, [
      { path: "Health/Weight.md", key: "weight", date: "2026-02-15" },
      { path: "Health/Weight.md", key: "weight", date: "2026-03-01" },
    ]);
  });

  test("the resolver reaches per-row cells and summaries alike", () => {
    const m = sheet(
      'gain = units + AT("2026-01-15", PROP("Health/Weight.md", "weight"))\n' +
        '\nnow = PROP("Health/Weight.md", "weight")\n' +
        'lost = AT("2026-01-15", PROP("Health/Weight.md", "weight")) - PROP("Health/Weight.md", "weight")'
    );
    const ev = run(m);
    assert.deepEqual(ev.computed[0].cells, [1284, 88.1]);
    assert.equal(findSummary(ev, "now"), 81);
    assert.equal(findSummary(ev, "lost"), 3);
  });

  test("today's PROP and AT(TODAY(), PROP) agree — same fact, same rendering", () => {
    const ev = run(
      sheet(
        'now = PROP("Health/Weight.md", "weight")\nthen = AT(TODAY(), PROP("Health/Weight.md", "weight"))'
      )
    );
    assert.equal(findSummary(ev, "now"), findSummary(ev, "then"));
  });

  test("a date before the oldest snapshot says so — never a blank, never a zero", () => {
    const ev = run(sheet('gone = AT("2025-06-01", PROP("Health/Weight.md", "weight"))'));
    const cell = findSummary(ev, "gone");
    assert.ok(isErr(cell));
    assert.match((cell as FErr).err, /no history before 2026-01-05/);
  });

  test("a row-dependent date can't be prefetched — the cell says so, it doesn't guess", () => {
    const m = sheet(
      'w = units + AT(bought, PROP("Health/Weight.md", "weight"))',
      "asset,units,bought\nGLOW,1200,2026-02-15"
    );
    assert.deepEqual(sheetHistoryRefs(m, today), []);
    const cell = run(m).computed[0].cells[0];
    assert.ok(isErr(cell));
    assert.match((cell as FErr).err, /not loaded/);
  });

  test("no resolver: the sheet still evaluates, those cells say history isn't loaded", () => {
    const ev = evaluateSheet(
      sheet('total = SUM(units)\n\nnow = PROP("Health/Weight.md", "weight")'),
      fx,
      undefined,
      today
    );
    assert.equal(findSummary(ev, "total"), 1204.1);
    assert.ok(isErr(findSummary(ev, "now")));
  });
});

describe("SUB-832 — AT(date, Sheet.member) re-evaluates the historical sheet", () => {
  const today = () => "2026-03-01";
  const sheet = (formulas: string, csv = "asset,units\nGLOW,1200") =>
    parseSheet("```csv\n" + csv + "\n```\n\n```formulas\n" + formulas + "\n```\n");

  // Holdings as it stood on 2026-02-15: fewer units, and a summary that is
  // COMPUTED, never a stored number — that is the point of re-evaluating.
  const HOLDINGS_THEN = [
    "---",
    "type: sheet",
    "title: Holdings",
    "---",
    "",
    "```csv",
    "asset,units,price",
    "GLOW,100,2",
    "BTC,1,50",
    "```",
    "",
    "```formulas",
    "value = units * price",
    "total = SUM(value)",
    "```",
    "",
  ].join("\n");

  const snap = (over: Partial<HistorySheetSnapshot> = {}): HistorySheetSnapshot => ({
    date: "2026-02-15",
    commit: "abc123",
    oldest: "2026-01-05",
    notes: [
      { path: "Money/Holdings.md", title: "Holdings", stem: "Holdings", body: HOLDINGS_THEN },
    ],
    ...over,
  });

  const run = (m: SheetModel, snaps: HistorySheetSnapshot[] = [snap()]) => {
    const hist = makeHistoryResolver([{ path: "Health/Weight.md", props: { weight: "81" } }], []);
    hist.sheetValue = makeHistorySheetValue(snaps, hist, fx, today);
    return evaluateSheet(m, fx, undefined, today, hist);
  };

  test("the days whole sheets are needed for are collected statically, deduped", () => {
    const m = sheet(
      'a = AT("2026-02-15", Holdings.total)\n' +
        'b = AT("2026-02-15", Holdings.total) * 2\n' +
        'c = AT(TODAY(), Holdings.total)\n' +
        'd = AT("2026-02-15", PROP("Health/Weight.md", "weight"))'
    );
    // the PROP-only line rides the fact lane, so it names no sheet day
    assert.deepEqual(sheetHistorySheetDates(m, today), ["2026-02-15", "2026-03-01"]);
  });

  test("a sheet with no AT collects no sheet days", () => {
    assert.deepEqual(sheetHistorySheetDates(sheet("total = SUM(units)"), today), []);
    assert.deepEqual(
      sheetHistorySheetDates(sheet('now = PROP("Health/Weight.md", "weight")'), today),
      []
    );
  });

  test("a summary off a past sheet is recomputed from that day's rows", () => {
    // 100*2 + 1*50 = 250 — a number that exists nowhere but in the recomputation
    const ev = run(sheet('then = AT("2026-02-15", Holdings.total)'));
    assert.equal(findSummary(ev, "then"), 250);
  });

  test("arithmetic composes past and present without either leaking into the other", () => {
    const ev = run(
      sheet('then = AT("2026-02-15", Holdings.total)\nnow = 300\ngrowth = now - then')
    );
    assert.equal(findSummary(ev, "growth"), 50);
  });

  test("a day below the trim boundary says so, and never reads as zero", () => {
    const ev = run(sheet('old = AT("2026-01-01", Holdings.total)'), [
      snap({ date: "2026-01-01", commit: null }),
    ]);
    const v = findSummary(ev, "old");
    assert.ok(isErr(v));
    assert.match((v as FErr).err, /no history before 2026-01-05/);
  });

  test("a day nobody prefetched reports that, rather than answering", () => {
    const ev = run(sheet('x = AT("2026-02-15", Holdings.total)'), []);
    const v = findSummary(ev, "x");
    assert.ok(isErr(v));
    assert.match((v as FErr).err, /not loaded yet/);
  });

  test("a sheet that did not exist on that day is named, not blank", () => {
    const ev = run(sheet('x = AT("2026-02-15", Ghost.total)'));
    const v = findSummary(ev, "x");
    assert.ok(isErr(v));
    assert.match((v as FErr).err, /no sheet .*ghost.* on 2026-02-15/);
  });

  test("this sheet's own values still refuse to be read in the past tense", () => {
    const m = sheet("total = SUM(units)\nx = AT(\"2026-02-15\", total)");
    const v = findSummary(run(m), "x");
    assert.ok(isErr(v));
    assert.match((v as FErr).err, /only PROP\(\) can be read as of a past date/);
  });

  test("a per-row date collects nothing and the cell says history is not loaded", () => {
    const m = sheet('x = AT(day, Holdings.total)', "asset,day\nGLOW,2026-02-15");
    assert.deepEqual(sheetHistorySheetDates(m, today), []);
    const v = findSummary(run(m, []), "x");
    assert.ok(isErr(v));
  });
});
