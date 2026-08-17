import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_ERR_DISPLAY,
  evalLiveExpr,
  liveBindOptions,
  liveBindQuery,
  liveExprMatches,
  liveSheetNames,
} from "./livevalues.ts";
import { evaluateSheet, formatValue, parseSheet, type SheetModel } from "./sheet.ts";
import { ferr, type FxResolver, type FErr } from "./formula.ts";
import type { DashboardSheetState } from "./dashboardSheets.ts";

const fx: FxResolver = (from, to) => {
  if (from === to) return 1;
  if (from === "USD" && to === "EUR") return 0.9;
  return null;
};

const HOLDINGS = `\`\`\`csv
asset,bucket,units,price_eur
GLOW,etf,1200,31.4
BTC,crypto,4.1,64200
\`\`\`

\`\`\`formulas
value_eur = units * price_eur
total = SUM(value_eur)
positions = COUNT(units)
\`\`\`
`;

const CASH = `\`\`\`csv
account,balance_eur
Nordkasse,14200
TR,3800
\`\`\`

\`\`\`formulas
cash_total = SUM(balance_eur)
\`\`\`
`;

/** The sheet map a loaded dashboard hands over, keyed lowercased as
    dashboardSheets keys it. */
function sheets(): Map<string, DashboardSheetState> {
  const models = new Map<string, SheetModel>([
    ["holdings", parseSheet(HOLDINGS)],
    ["cash", parseSheet(CASH)],
  ]);
  const load = (name: string): SheetModel | FErr =>
    models.get(name.toLowerCase()) ?? ferr(`no note named “${name}”`);
  const out = new Map<string, DashboardSheetState>();
  for (const [name, model] of models) {
    out.set(name, { model, ev: evaluateSheet(model, fx, { self: name, load }) });
  }
  return out;
}

const shown = (expr: string, map = sheets()) => {
  const r = evalLiveExpr(expr, map, fx);
  assert.equal(r.err, undefined, `unexpected error: ${r.err}`);
  return r.display;
};

const failed = (expr: string, map = sheets()) => {
  const r = evalLiveExpr(expr, map, fx);
  assert.equal(r.display, LIVE_ERR_DISPLAY);
  assert.ok(r.err, "expected an error message");
  return r.err as string;
};

// ---------- finding the spans ----------

test("an inline code span starting with = is a live expression", () => {
  const body = "The label has `= Holdings.positions` releases.";
  assert.deepEqual(
    liveExprMatches(body).map((m) => [m.expr, body.slice(m.from, m.to)]),
    [["Holdings.positions", "`= Holdings.positions`"]]
  );
});

test("an ordinary code span is left alone", () => {
  assert.deepEqual(liveExprMatches("run `npm test` first"), []);
});

test("only the documented form matches — = then exactly one space", () => {
  // `=1+1` (no space), ` = 1+1` (leading space) and `=  1+1` (two) are all
  // ordinary code spans: the single space is the grammar.
  assert.deepEqual(liveExprMatches("a `=1+1` b ` = 2 + 2` c `=  3 + 3` d"), []);
  assert.deepEqual(
    liveExprMatches("only `= 4 + 4` here").map((m) => m.expr),
    ["4 + 4"]
  );
});

test("prose about spreadsheets stays prose", () => {
  // The whole point of requiring the space: an Excel sentence is text someone
  // wrote, and no form of it may be swallowed by the renderer.
  const forms = [
    "In Excel you write `=SUM(A1:A2)` to total two cells.",
    "Try `=A1+A2` or `=AVERAGE(B:B)` in the formula bar.",
    "The cell holds `=IF(A1>0,\"yes\",\"no\")`.",
    "Legacy sheets used `=VLOOKUP(A1,B:C,2,FALSE)`.",
    "Type `=NOW()` for the clock.",
  ];
  for (const body of forms) assert.deepEqual(liveExprMatches(body), [], body);
});

test("an expression that does not parse is not a match at all", () => {
  // It keeps rendering as the literal code span it already is — the dash is
  // only ever for expressions that parse and then fail to evaluate.
  const body = "prose `= SUM(A1:A2)` and `= 1 +` and `= Holdings.total`";
  assert.deepEqual(
    liveExprMatches(body).map((m) => m.expr),
    ["Holdings.total"]
  );
});

test("a pathological expression falls out as a literal, never a throw", () => {
  // A 5000-term expression parses, then overflows the recursive evaluator's
  // stack. The RangeError must not escape into the caller (CodeMirror's
  // buildDecorations) — it comes back as a literal, so the span renders as the
  // text it is.
  const expr = "1" + "+1".repeat(5000);
  const r = evalLiveExpr(expr, sheets(), fx);
  assert.equal(r.literal, true);
  assert.equal(r.display, expr, "the literal answer is the input text verbatim");
  assert.notEqual(r.display, LIVE_ERR_DISPLAY);
  // and the whole-body paths survive it too
  const body = "a `= " + expr + "` b";
  assert.equal(liveExprMatches(body).length, 1);
  assert.deepEqual(liveSheetNames(body), []);
});

test("evalLiveExpr reports non-expressions as literal, not as the dash", () => {
  for (const expr of ["SUM(A1:A2)", "1 +", "Holdings."]) {
    const r = evalLiveExpr(expr, sheets(), fx);
    assert.equal(r.literal, true, expr);
    assert.equal(r.display, expr, expr);
    assert.notEqual(r.display, LIVE_ERR_DISPLAY, expr);
  }
});

test("a double-backtick span is the escape hatch for writing the syntax", () => {
  assert.deepEqual(liveExprMatches("write it as ``= Masters.count`` in prose"), []);
});

test("an empty expression is someone mid-keystroke, not a match", () => {
  assert.deepEqual(liveExprMatches("a `= ` b `=   ` c `=` d"), []);
});

test("spans inside an indented code block are shown, not run", () => {
  const body = [
    "before `= 1 + 1`",
    "",
    "    `= 2 + 2`",
    "    still indented `= 9 + 9`",
    "",
    "after `= 3 + 3`",
  ].join("\n");
  assert.deepEqual(
    liveExprMatches(body).map((m) => m.expr),
    ["1 + 1", "3 + 3"]
  );
});

test("a tab-indented code block is code too", () => {
  const body = ["intro", "", "\t`= 2 + 2`", "", "outro `= 3 + 3`"].join("\n");
  assert.deepEqual(
    liveExprMatches(body).map((m) => m.expr),
    ["3 + 3"]
  );
});

test("an indented list continuation is prose, not a code block", () => {
  // No blank line before it — it continues the list item, so its span computes.
  const body = ["- item", "    more of it `= 1 + 1`"].join("\n");
  assert.deepEqual(
    liveExprMatches(body).map((m) => m.expr),
    ["1 + 1"]
  );
});

test("spans inside a fenced block are shown, not run", () => {
  const body = ["before `= 1 + 1`", "", "```md", "`= 2 + 2`", "```", "", "after `= 3 + 3`"].join("\n");
  assert.deepEqual(
    liveExprMatches(body).map((m) => m.expr),
    ["1 + 1", "3 + 3"]
  );
});

test("offsets are exact, so the same expression twice yields two spans", () => {
  const body = "`= 1 + 1` and `= 1 + 1`";
  const ms = liveExprMatches(body);
  assert.equal(ms.length, 2);
  for (const m of ms) assert.equal(body.slice(m.from, m.to), "`= 1 + 1`");
  assert.notEqual(ms[0].from, ms[1].from);
});

test("liveSheetNames collects the sheets a body reaches, deduplicated", () => {
  const body = "`= Holdings.total` and `= Holdings.positions` and `= Cash.cash_total`";
  assert.deepEqual(liveSheetNames(body).sort(), ["cash", "holdings"]);
});

test("liveSheetNames ignores expressions that do not parse", () => {
  assert.deepEqual(liveSheetNames("`= Holdings.` and `= Cash.cash_total`"), ["cash"]);
});

// ---------- evaluating from note context ----------

test("a cross-sheet summary evaluates and formats like the sheet does", () => {
  // 1200 * 31.4 + 4.1 * 64200 = 37680 + 263220 = 300900
  assert.equal(shown("Holdings.total"), "300.900");
});

test("a cross-sheet computed column reaches through an aggregate", () => {
  assert.equal(shown("SUM(Holdings.value_eur)"), "300.900");
});

test("a cross-sheet data column counts", () => {
  assert.equal(shown("COUNT(Cash.balance_eur)"), "2");
});

test("two sheets combine in one expression", () => {
  assert.equal(shown("Holdings.total + Cash.cash_total"), "318.900");
});

test("arithmetic on a cross-sheet value stays sheet arithmetic", () => {
  assert.equal(shown("ROUND(Holdings.total / Cash.cash_total, 2)"), "16,72");
});

test("a plain expression with no sheet at all still computes", () => {
  assert.equal(shown("2 + 2"), "4");
});

test("member precedence is summary, then computed, then data column", () => {
  const model = parseSheet(
    "```csv\nd,b\n1,10\n2,20\n```\n\n```formulas\nc = b * 3\ns = SUM(b)\n```"
  );
  const map = new Map<string, DashboardSheetState>([
    ["other", { model, ev: evaluateSheet(model, fx) }],
  ]);
  assert.equal(shown("Other.s", map), "30");
  assert.equal(shown("SUM(Other.c)", map), "90");
  assert.equal(shown("SUM(Other.d)", map), "3");
});

// ---------- unit-carrying values ----------

test("a unit-carrying value formats exactly as the sheet grid shows it", () => {
  // Sheet values carry their unit inside the value; the grid renders every
  // cell and summary through formatValue (SheetGrid.tsx), so a live value goes
  // through the same function — same text in a sentence as in the sheet, no
  // suffix invented or dropped on the way into prose.
  const model = parseSheet(
    "```csv\nasset,weight\nGLOW,5 kg\nBTC,2 kg\n```\n\n```formulas\nheaviest = \"5 kg\"\n```"
  );
  const ev = evaluateSheet(model, fx);
  const map = new Map<string, DashboardSheetState>([["kit", { model, ev }]]);
  const summary = ev.summaries.find((s) => s.name === "heaviest");
  assert.ok(summary);
  assert.equal(shown("Kit.heaviest", map), formatValue(summary.value));
  assert.equal(shown("Kit.heaviest", map), "5 kg");
  // and the raw cell the grid renders is the same text
  assert.equal(formatValue(ev.rows[0][ev.headers.indexOf("weight")]), "5 kg");
});

test("an FX conversion carries through with the sheet's own formatting", () => {
  const model = parseSheet(
    "```csv\nasset,price_usd\nGLOW,100\n```\n\n```formulas\neur = SUM(price_usd) * FX(\"USD\",\"EUR\")\n```"
  );
  const map = new Map<string, DashboardSheetState>([
    ["prices", { model, ev: evaluateSheet(model, fx) }],
  ]);
  assert.equal(shown("Prices.eur", map), "90");
});

// ---------- quiet failure ----------

test("an unknown sheet fails with the sheet's name, not a red wall", () => {
  assert.match(failed("Ghost.total"), /ghost/i);
});

test("a sheet that failed to load reports the loader's own reason", () => {
  const map = new Map<string, DashboardSheetState>([
    ["holdings", { error: "“Holdings” is not a sheet" }],
  ]);
  assert.match(failed("Holdings.total", map), /is not a sheet/);
});

test("an unknown member names the sheet it looked on", () => {
  assert.match(failed("Holdings.nope"), /no column or summary/i);
});

test("a bare column is not a sentence-shaped answer", () => {
  assert.match(failed("Holdings.units"), /whole column/i);
});

test("every evaluation failure shows the same dim dash calc lines use", () => {
  // Each of these PARSES and then fails to evaluate — that is what the dash is
  // for. Text that never parsed is a literal, covered above.
  for (const expr of ["Ghost.total", "Holdings.nope", "Holdings.units"]) {
    assert.equal(evalLiveExpr(expr, sheets(), fx).display, LIVE_ERR_DISPLAY, expr);
  }
});

// ---------- the member rule agrees with the sheet engine ----------

test("memberOf resolves exactly as a sheet's own cross-sheet ref does", () => {
  // livevalues re-derives sheet.ts's private `memberValue` precedence. Nothing
  // but this test holds the two together, so one fixture exercises every
  // branch through both paths and asserts they agree.
  const model = parseSheet(HOLDINGS);
  const via = new Map<string, DashboardSheetState>([
    ["holdings", { model, ev: evaluateSheet(model, fx) }],
  ]);
  // the sheet engine's own answer for the same names, through a sheet that
  // cross-references Holdings rather than through a note body
  const CONSUMER = [
    "```formulas",
    "s = Holdings.total",
    "c = SUM(Holdings.value_eur)",
    "d = COUNT(Holdings.asset)",
    "```",
    "",
  ].join("\n");
  const consumer = parseSheet(CONSUMER);
  const ev = evaluateSheet(consumer, fx, {
    self: "consumer",
    load: (n) => (n.toLowerCase() === "holdings" ? model : ferr(`no note named “${n}”`)),
  });
  const engine = (name: string) => {
    const s = ev.summaries.find((x) => x.name === name);
    assert.ok(s, `sheet engine produced no summary ${name}`);
    return formatValue(s.value as never);
  };
  assert.equal(shown("Holdings.total", via), engine("s")); // summary
  assert.equal(shown("SUM(Holdings.value_eur)", via), engine("c")); // computed column
  assert.equal(shown("COUNT(Holdings.asset)", via), engine("d")); // data column
});

test("liveBindQuery: the two stages of a name, and the fragment under the cursor", () => {
  assert.deepEqual(liveBindQuery("The label has `= "), { sheet: null, query: "" });
  assert.deepEqual(liveBindQuery("The label has `= Mas"), { sheet: null, query: "Mas" });
  assert.deepEqual(liveBindQuery("`= Masters."), { sheet: "Masters", query: "" });
  assert.deepEqual(liveBindQuery("`= Masters.rev"), { sheet: "Masters", query: "rev" });
  // a name inside an expression still completes — the fragment is end-anchored
  assert.deepEqual(liveBindQuery("`= SUM(Masters.fe"), { sheet: "Masters", query: "fe" });
  assert.deepEqual(liveBindQuery("`= 2 * "), { sheet: null, query: "" });
});

test("liveBindQuery: no popup where a live value cannot be", () => {
  // no open span at all
  assert.equal(liveBindQuery("plain prose"), null);
  // the closed span is done
  assert.equal(liveBindQuery("`= Masters.count`"), null);
  // not the documented one-space form
  assert.equal(liveBindQuery("`=Mas"), null);
  // double backticks are the escape hatch for writing the syntax in prose
  assert.equal(liveBindQuery("write ``= Mas"), null);
  // a number is not a name in waiting
  assert.equal(liveBindQuery("`= 12"), null);
});

test("liveBindOptions: fuzzy, deduped, and only names the grammar can reference", () => {
  const names = ["Masters", "Ledger", "masters", "Q3 Masters", ""];
  assert.deepEqual(liveBindOptions("", names), ["Masters", "Ledger"]);
  assert.deepEqual(liveBindOptions("mas", names), ["Masters"]);
  // spaced titles are unreferenceable: cross-sheet refs parse as ident.ident
  assert.ok(!liveBindOptions("q3", names).includes("Q3 Masters"));
});

test("liveBindOptions: caller order survives a tie, so summaries lead the members", () => {
  // what NotePane hands over for one sheet: summaries, then computed, then
  // data columns. An empty query scores every name alike, and the sentence
  // wants the summary — alphabetical would put the "account" column on top.
  const members = ["cash_total", "accounts", "monthly_eur", "account", "balance_eur"];
  assert.deepEqual(liveBindOptions("", members), members);
  // a typed fragment still wins over position
  assert.equal(liveBindOptions("bal", members)[0], "balance_eur");
});
