import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmtMoney,
  fmtWindow,
  metricsColumns,
  sharpCardIndices,
} from "./dashboard.ts";

test("fmtMoney renders de-DE with the symbol trailing (SUB-245)", () => {
  assert.equal(fmtMoney(1234.56, "€", 2), "1.234,56 €");
  assert.equal(fmtMoney(1234567, "$"), "1.234.567 $");
  assert.equal(fmtMoney(42, "€"), "42 €");
  assert.equal(fmtMoney(0, "$", 2), "0,00 $");
  assert.equal(fmtMoney(1.5, "€", 2), "1,50 €");
});

test("fmtMoney renders a dash for missing or non-finite values", () => {
  assert.equal(fmtMoney(null, "€"), "—");
  assert.equal(fmtMoney(Infinity, "$"), "—");
  assert.equal(fmtMoney(NaN, "€", 2), "—");
});

// ---------- fmtWindow ----------

test("fmtWindow: two largest units, zero remainders dropped", () => {
  assert.equal(fmtWindow(42), "42 min");
  assert.equal(fmtWindow(59.6), "1 h"); // rounds to 60 min first
  assert.equal(fmtWindow(60), "1 h");
  assert.equal(fmtWindow(320), "5 h 20 min");
  assert.equal(fmtWindow(24 * 60), "1 d");
  assert.equal(fmtWindow(6448), "4 d 11 h"); // the live board's window
  assert.equal(fmtWindow(0), "0 min");
});

// contrast discipline (design principle 11) — which cards keep the sharp voice
test("sharpCardIndices: flagged cards win, in card order", () => {
  const cards = [{}, { emph: true }, {}, { emph: true }];
  assert.deepEqual([...sharpCardIndices(cards)].sort(), [1, 3]);
});

test("sharpCardIndices: caps at two — the first two flagged in card order", () => {
  const cards = [{ emph: true }, { emph: true }, { emph: true }, { emph: true }];
  assert.deepEqual([...sharpCardIndices(cards)].sort(), [0, 1]);
});

test("sharpCardIndices: no flag → the first card anchors the board", () => {
  assert.deepEqual([...sharpCardIndices([{}, {}, {}])], [0]);
});

test("sharpCardIndices: an empty board has nothing to sharpen", () => {
  assert.equal(sharpCardIndices([]).size, 0);
});

test("metricsColumns: small boards stay one row", () => {
  assert.equal(metricsColumns(1), 1);
  assert.equal(metricsColumns(3), 3);
  assert.equal(metricsColumns(4), 4);
});

test("metricsColumns: an empty board still has a track", () => {
  assert.equal(metricsColumns(0), 1);
});

test("metricsColumns: wraps without leaving a lone orphan tile", () => {
  for (let n = 5; n <= 24; n++) {
    const cols = metricsColumns(n);
    assert.ok(cols >= 2 && cols <= 4, `${n} cards → ${cols} columns out of range`);
    const lastRow = (c: number) => (n % c === 0 ? c : n % c);
    // some counts orphan at every width (13 leaves one over 4, 3 and 2 alike);
    // there the widest strip is the fallback, and only then is an orphan ok
    const avoidable = [4, 3, 2].some((c) => lastRow(c) >= 2);
    if (avoidable) {
      assert.ok(lastRow(cols) >= 2, `${n} cards over ${cols} columns orphans one avoidably`);
    } else {
      assert.equal(cols, 4, `${n} cards orphan at every width — expected the widest strip`);
    }
  }
});

test("metricsColumns: the Portfolio board (7 cards) splits 4 + 3", () => {
  assert.equal(metricsColumns(7), 4);
});
