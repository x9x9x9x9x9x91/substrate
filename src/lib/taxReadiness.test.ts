import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupTaxMissing,
  parseTaxMissing,
  sortTaxMissing,
  taxCategories,
  taxFreshnessLabel,
  taxReadinessState,
  snapshotFreshness,
} from "./taxReadiness.ts";

const NOW = Date.parse("2026-08-03T12:00:00Z");
const fresh = (exported: unknown, staleHours = 240) =>
  snapshotFreshness(exported, NOW, staleHours);
const FRESH = fresh("2026-08-03T09:00:00Z");

function missingSheet(csv: string): string {
  return `Derived snapshot.\n\n\`\`\`csv\n${csv}\n\`\`\`\n`;
}

test("missing rows parse with free header order and case-insensitive names", () => {
  const items = parseTaxMissing(
    missingSheet(
      [
        "Missing,NAME,Sheet, date ",
        "Receipt no.,Studio rent — March,Expenses,2026-03-01",
        "Document Filed; Receipt,Interface repair,Expenses,2026-05-14",
      ].join("\n")
    )
  );
  assert.deepEqual(items, [
    {
      sheet: "Expenses",
      name: "Studio rent — March",
      date: "2026-03-01",
      missing: ["Receipt no."],
    },
    {
      sheet: "Expenses",
      name: "Interface repair",
      date: "2026-05-14",
      missing: ["Document Filed", "Receipt"],
    },
  ]);
});

test("malformed rows are skipped, never thrown (parseFoodRows policy)", () => {
  const items = parseTaxMissing(
    missingSheet(
      [
        "sheet,name,date,missing",
        "Income,,2026-02-02,Receipt no.", // no name
        "Income,No fields,2026-02-02,", // no missing fields
        "Income,Only separators,2026-02-02,\" ; ; \"", // nothing but separators
        "Income,Kept,2026-02-02,Receipt no.",
      ].join("\n")
    )
  );
  assert.deepEqual(
    items.map((i) => i.name),
    ["Kept"]
  );
});

test("an unparseable date degrades to empty rather than dropping the row", () => {
  const items = parseTaxMissing(
    missingSheet(
      [
        "sheet,name,date,missing",
        "Rental Ledger,Bad month,2026-13-40,Receipt",
        "Rental Ledger,Not a date,soon,Receipt",
        "Rental Ledger,No date,,Receipt",
      ].join("\n")
    )
  );
  assert.equal(items.length, 3, "a missing document is never hidden by a bad date");
  assert.deepEqual(
    items.map((i) => i.date),
    ["", "", ""]
  );
});

test("no csv fence, no required headers, and a header-only sheet all read as empty", () => {
  assert.deepEqual(parseTaxMissing("Just prose, no fence.\n"), []);
  assert.deepEqual(parseTaxMissing(missingSheet("sheet,name,date\nA,B,2026-01-01")), []);
  assert.deepEqual(parseTaxMissing(missingSheet("sheet,name,date,missing")), []);
});

test("sort is sheet A–Z, then date ascending with undated last, then name", () => {
  const input = parseTaxMissing(
    missingSheet(
      [
        "sheet,name,date,missing",
        "Rental Ledger,Studio roof,2026-01-09,Receipt",
        "Expenses,Later,2026-06-01,Receipt",
        "Expenses,Undated B,,Receipt",
        "Expenses,Undated A,,Receipt",
        "Expenses,Earlier,2026-02-01,Receipt",
        "asset ledger,Lowercase sheet,2026-03-01,Receipt",
      ].join("\n")
    )
  );
  const before = structuredClone(input);
  // sheet order folds case, so "asset ledger" leads rather than trailing
  // the capitals the way a raw codepoint sort would put it
  assert.deepEqual(
    sortTaxMissing(input).map((i) => i.name),
    ["Lowercase sheet", "Earlier", "Later", "Undated A", "Undated B", "Studio roof"]
  );
  assert.deepEqual(input, before, "sorting does not mutate its input");

  // deterministic through a shuffled export: same rows, same order
  const shuffled = [...input].reverse();
  assert.deepEqual(
    sortTaxMissing(shuffled).map((i) => i.name),
    sortTaxMissing(input).map((i) => i.name)
  );
});

test("grouping follows the sorted order, one group per sheet", () => {
  const groups = groupTaxMissing(
    parseTaxMissing(
      missingSheet(
        [
          "sheet,name,date,missing",
          "Rental Ledger,Roof,2026-01-09,Receipt",
          "Expenses,Rent,2026-03-01,Receipt no.",
          "Rental Ledger,Boiler,2026-02-09,Receipt",
        ].join("\n")
      )
    )
  );
  assert.deepEqual(
    groups.map((g) => [g.sheet, g.items.map((i) => i.name)]),
    [
      ["Expenses", ["Rent"]],
      ["Rental Ledger", ["Roof", "Boiler"]],
    ]
  );
});

const AGG_BODY = `Tax year aggregates.

\`\`\`csv
category,sheet,rows,amount_eur,basis
Income,Income,42,38400,Business
Business expenses,Expenses,31,12750.5,Business
Equipment,Expenses,0,0,Business
Bad counts,Expenses,-3,1.2e3,Business
\`\`\`

\`\`\`formulas
income_ytd = SUM(amount_eur)
expenses_ytd = 12750.5
\`\`\`
`;

test("category rows keep zero rows, drop nameless ones, and stay strict about numbers", () => {
  const categories = taxCategories(AGG_BODY);
  assert.deepEqual(
    categories.map((c) => [c.category, c.sheet, c.rows, c.amountEur]),
    [
      ["Income", "Income", 42, 38400],
      ["Business expenses", "Expenses", 31, 12750.5],
      // a zero row is information — nothing booked in that category yet
      ["Equipment", "Expenses", 0, 0],
      // negative count → 0; exponent notation is not a euro figure
      ["Bad counts", "Expenses", 0, null],
    ]
  );
  assert.equal(categories[0].basis, "Business");
});

test("a sheet with no csv, no category column or no note at all is an empty table", () => {
  // the board's cards are frontmatter bindings, so a summaries-only sheet
  // still has to read as "no category rows" rather than as a failure
  assert.deepEqual(taxCategories("```formulas\nincome_ytd = 5\n```\n"), []);
  assert.deepEqual(taxCategories("```csv\nsheet,rows\nIncome,3\n```\n"), []);
  assert.deepEqual(taxCategories(""), []);
});

test("verdict: clean + fresh is green, outstanding documents are amber", () => {
  const ready = taxReadinessState(0, FRESH);
  assert.deepEqual(
    [ready.verdict, ready.color, ready.label],
    ["ready", "var(--ok)", "ready — nothing missing"]
  );

  const one = taxReadinessState(1, FRESH);
  assert.deepEqual([one.verdict, one.color, one.label], ["missing", "var(--opt-yellow)", "1 document missing"]);
  assert.equal(taxReadinessState(4, FRESH).label, "4 documents missing");
});

test("verdict: an unreadable or stale snapshot reddens, outranking the document count", () => {
  const unreadable = taxReadinessState(0, null);
  assert.deepEqual(
    [unreadable.verdict, unreadable.color, unreadable.label],
    ["unavailable", "var(--danger)", "snapshot unavailable"]
  );
  for (const [exported, label] of [
    [undefined, "export stamp missing"],
    ["not a stamp", "export stamp invalid"],
    ["2026-08-04T09:00:00Z", "export stamp is in the future"],
    ["2026-07-01T09:00:00Z", "snapshot 33d old"],
  ] as const) {
    const state = taxReadinessState(9, fresh(exported));
    assert.equal(state.verdict, "unavailable", `${String(exported)} should redden`);
    assert.equal(state.color, "var(--danger)");
    assert.equal(state.label, label);
  }
});

test("freshness passes through the shared snapshot helper, default 240h", () => {
  // exactly at the 240h boundary stays fresh; a minute past is stale
  const at = snapshotFreshness("2026-07-24T12:00:00Z", NOW, 240);
  assert.equal(at.kind, "fresh");
  assert.equal(taxReadinessState(0, at).verdict, "ready");
  const past = snapshotFreshness("2026-07-24T11:59:00Z", NOW, 240);
  assert.equal(past.kind, "stale");
  assert.equal(taxReadinessState(0, past).verdict, "unavailable");

  assert.equal(taxFreshnessLabel(snapshotFreshness("2026-08-03T11:30:00Z", NOW, 240)), "snapshot 30m old");
  assert.equal(taxFreshnessLabel(snapshotFreshness("2026-08-02T12:00:00Z", NOW, 240)), "snapshot 24h old");
});

test("freshness covers valid boundary, stale, missing, invalid and future exports", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");
  assert.deepEqual(snapshotFreshness("2026-08-01T11:00:00Z", now, 36), {
    kind: "fresh", exported: "2026-08-01T11:00:00Z", ageMs: 3_600_000, stale: false,
  });
  assert.equal(snapshotFreshness("2026-07-31T00:00:00Z", now, 36).kind, "fresh");
  assert.equal(snapshotFreshness("2026-07-30T23:59:59Z", now, 36).kind, "stale");
  assert.equal(snapshotFreshness(undefined, now).kind, "missing");
  assert.equal(snapshotFreshness("yesterday", now).kind, "invalid");
  assert.equal(snapshotFreshness("2026-02-30T00:00:00Z", now).kind, "invalid");
  assert.equal(snapshotFreshness("2026-08-01T24:00:00Z", now).kind, "invalid");
  assert.equal(snapshotFreshness("2026-08-01T10:00:00+24:00", now).kind, "invalid");
  assert.equal(snapshotFreshness("2026-08-01T10:00:00+02:60", now).kind, "invalid");
  assert.equal(snapshotFreshness("2026-08-01T12:00:01Z", now).kind, "future");
  assert.equal(snapshotFreshness("2026-08-01T12:00:01Z", now).stale, true);
});
