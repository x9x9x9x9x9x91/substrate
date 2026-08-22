/** What a metric card says about a sheet whose data disagrees with itself.

    Three ways a card used to read as a measurement when it was nothing of the
    kind: a total over rows with the wrong number of cells (the missing ones
    read as empty, so the sum is arithmetically fine and factually a guess), a
    total over a sheet with no rows at all ("0 €" reads as a balance someone
    took), and a formula over a column that does not exist (a bare "—" with the
    reason parked in a hover title). All three now put the reason on the card,
    under the number, where the same surface already names a missing summary.

    Imported through the component harness for its loader — `readBind` lives in
    a `.tsx` and node will not execute one unaided. */

import assert from "node:assert/strict";
import { test } from "node:test";
import "./componentHarness.ts";
import { evaluateSheet, parseSheet } from "./sheet.ts";
import type { SheetModel } from "./sheet.ts";

const fx = () => null;

function sheets(body: string, name = "Ledger") {
  const model: SheetModel = parseSheet(body);
  return new Map([[name.toLowerCase(), { model, ev: evaluateSheet(model, fx) }]]);
}

const csv = (rows: string) =>
  "```csv\n" + rows + "\n```\n\n```formulas\ncash_total = SUM(balance_eur)\n```\n";

async function readBind() {
  return (await import("../components/MetricCards.tsx")).readBind;
}

test("a total over ragged rows keeps its number and says the rows disagree", async () => {
  const read = await readBind();
  const r = read(
    sheets(csv("account,balance_eur\nNordkasse,14200,extra\nShort\nBrokerhaus,3800")),
    "{{Ledger.cash_total}}"
  );

  assert.equal(r.value, 18000);
  assert.equal(r.miss, "2 ragged rows");
  assert.match(r.title ?? "", /row 1 has 3, row 2 has 1/);
});

test("a total over a sheet with no rows says so instead of reading as zero", async () => {
  const read = await readBind();
  const r = read(sheets(csv("account,balance_eur")), "{{Ledger.cash_total}}");

  assert.equal(r.value, 0);
  assert.equal(r.miss, "Ledger has no rows");
});

test("a formula over a column that isn't there names the column on the card", async () => {
  const read = await readBind();
  const body =
    "```csv\naccount,balance_eur\nNordkasse,14200\n```\n\n```formulas\nbad_col = SUM(no_such_column)\n```\n";
  const r = read(sheets(body), "{{Ledger.bad_col}}");

  assert.match(r.miss ?? "", /no_such_column/);
});

test("a sheet that agrees with itself says nothing at all", async () => {
  const read = await readBind();
  const r = read(
    sheets(csv("account,balance_eur\nNordkasse,14200\nBrokerhaus,3800")),
    "{{Ledger.cash_total}}"
  );

  assert.equal(r.value, 18000);
  assert.equal(r.miss, undefined);
});
