import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendSnapshotToBody,
  computeIntervals,
  fmtAtHuman,
  fmtMoney,
  fmtMoneyMagnitude,
  fmtWindow,
  parseAt,
  parseSnapshotsFromBody,
  readClaimedUsd,
  metricsColumns,
  sharpCardIndices,
} from "./dashboard.ts";

/** Local wall-clock ms for explicit components — what every row must parse
    to, computed the way dates.ts builds local dates. */
function localMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
}

function bodyWith(rows: string[]): string {
  return ["# dash", "", "```csv", "at,yield_usd,principal_usd", ...rows, "```", ""].join("\n");
}

test("parseSnapshotsFromBody: bare dates and datetimes are both local (SUB-233)", () => {
  const { snapshots } = parseSnapshotsFromBody(
    bodyWith(["2026-07-17,1,100", "2026-07-17 06:00,1.5,100"])
  );
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].at.getTime(), localMs(2026, 7, 17));
  assert.equal(snapshots[1].at.getTime(), localMs(2026, 7, 17, 6, 0));
});

test("mixed bare-date + datetime rows produce the correct interval (SUB-233)", () => {
  // bare date = local midnight; datetime = local noon next day → 36 h, never
  // skewed by the UTC/local split new Date() gives the two formats
  const { snapshots } = parseSnapshotsFromBody(
    bodyWith(["2026-07-17,1,100", "2026-07-18 12:00,2.5,100"])
  );
  const [iv] = computeIntervals(snapshots);
  const expectedMin = (localMs(2026, 7, 18, 12, 0) - localMs(2026, 7, 17)) / 60000;
  assert.equal(expectedMin, 36 * 60);
  assert.equal(iv.minutes, expectedMin);
  assert.equal(iv.gainUsd, 1.5);
});

test("sort stays chronological across mixed formats (SUB-233)", () => {
  // file order puts the datetime row first; the bare date is the same local
  // day at 00:00 and must sort before it
  const { snapshots } = parseSnapshotsFromBody(
    bodyWith(["2026-07-17 06:00,1.5,100", "2026-07-17,1,100"])
  );
  assert.deepEqual(
    snapshots.map((s) => s.atRaw),
    ["2026-07-17", "2026-07-17 06:00"]
  );
});

test("parseSnapshotsFromBody: unparseable rows are skipped", () => {
  const { snapshots } = parseSnapshotsFromBody(
    bodyWith(["not-a-date,1,100", "2026-13-40,1,100", "2026-07-17,1,100"])
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].atRaw, "2026-07-17");
});

test("fmtAtHuman: datetime drops the year, keeps the clock (SUB-250)", () => {
  assert.equal(fmtAtHuman("2026-07-17 14:18"), "Jul 17, 14:18");
  assert.equal(fmtAtHuman("2026-07-17T14:18"), "Jul 17, 14:18");
  assert.equal(fmtAtHuman("2026-01-05 09:05:30"), "Jan 5, 09:05");
});

test("fmtAtHuman: bare date gets the full human form (SUB-250)", () => {
  assert.equal(fmtAtHuman("2026-07-17"), "Jul 17, 2026");
  assert.equal(fmtAtHuman("2026-12-31"), "Dec 31, 2026");
});

test("fmtAtHuman: non-ISO raws pass through untouched (SUB-250)", () => {
  assert.equal(fmtAtHuman("not-a-date"), "not-a-date");
  assert.equal(fmtAtHuman("2026-13-40 14:18"), "2026-13-40 14:18");
  assert.equal(fmtAtHuman("yesterday"), "yesterday");
});

const snap = { atRaw: "2026-07-18 12:00", yieldUsd: 2.5, principalUsd: 100 };
const ROW = "2026-07-18 12:00,2.5,100";

test("appendSnapshotToBody: fence with trailing newline gains the row", () => {
  const out = appendSnapshotToBody(bodyWith(["2026-07-17,1,100"]), snap);
  assert.ok(out.includes(`2026-07-17,1,100\n${ROW}\n\`\`\``), out);
  assert.equal(parseSnapshotsFromBody(out).snapshots.length, 2);
});

test("appendSnapshotToBody: fence without trailing newline still gains the row (SUB-231)", () => {
  // a fence whose last row hugs the closing ``` used to no-op silently
  const body = "# dash\n\n```csv\nat,yield_usd,principal_usd\n2026-07-17,1,100```";
  const out = appendSnapshotToBody(body, snap);
  assert.ok(out.includes(`2026-07-17,1,100\n${ROW}\n\`\`\``), out);
  assert.equal(parseSnapshotsFromBody(out).snapshots.length, 2);
});

test("appendSnapshotToBody: no fence creates the csv block", () => {
  const out = appendSnapshotToBody("# dash\n", snap);
  assert.ok(out.includes(`\`\`\`csv\nat,yield_usd,principal_usd\n${ROW}\n\`\`\``), out);
  assert.equal(parseSnapshotsFromBody(out).snapshots.length, 1);
});

test("parseAt: form input validates as local wall-clock (SUB-251)", () => {
  assert.equal(parseAt("2026-07-17 14:18").getTime(), localMs(2026, 7, 17, 14, 18));
  assert.equal(parseAt("2026-07-17T14:18").getTime(), localMs(2026, 7, 17, 14, 18));
  assert.equal(parseAt("2026-07-17").getTime(), localMs(2026, 7, 17));
  for (const bad of ["", "2026-13-17 14:18", "2026-07-17 25:18", "next friday", "2026-07-17 14"]) {
    assert.ok(isNaN(parseAt(bad).getTime()), bad);
  }
});

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

test("fmtMoneyMagnitude picks the unit by magnitude, so a small principal keeps its digits (SUB-1183)", () => {
  // the old fixed /1e6 divisor rendered a 13.690 € principal as "0,01M €"
  assert.equal(fmtMoneyMagnitude(13690, "€"), "13.690 €");
  assert.equal(fmtMoneyMagnitude(202.33, "€"), "202 €");
  assert.equal(fmtMoneyMagnitude(0, "€"), "0 €");
  assert.equal(fmtMoneyMagnitude(999999, "€"), "999.999 €");
  // a million and up keeps the compact suffix the header strip was built for
  assert.equal(fmtMoneyMagnitude(1000000, "€"), "1,00M €");
  assert.equal(fmtMoneyMagnitude(3961234, "€"), "3,96M €");
  assert.equal(fmtMoneyMagnitude(2500000, "$"), "2,50M $");
});

test("fmtMoneyMagnitude renders a dash for missing or non-finite values", () => {
  assert.equal(fmtMoneyMagnitude(null, "€"), "—");
  assert.equal(fmtMoneyMagnitude(Infinity, "€"), "—");
  assert.equal(fmtMoneyMagnitude(NaN, "€"), "—");
});

test("parseSnapshotsFromBody: CRLF body finds the fence and parses rows (SUB-277)", () => {
  // the old regex required \n right after ```csv — CRLF bodies silently had
  // "no data" and an append would write a second fence
  const body =
    "# dash\r\n\r\n```csv\r\nat,yield_usd,principal_usd\r\n2026-07-17,1,100\r\n2026-07-18,2.5,100\r\n```\r\n";
  const { snapshots, fence } = parseSnapshotsFromBody(body);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].yieldUsd, 2.5);
  assert.ok(fence);
  const slice = body.slice(fence.from, fence.to);
  assert.ok(slice.startsWith("```csv\r\n"), slice);
  assert.ok(slice.endsWith("\r\n```"), slice);
});

test("appendSnapshotToBody: CRLF fence round-trips without touching prose (SUB-277)", () => {
  const body =
    "# dash\r\n\r\n```csv\r\nat,yield_usd,principal_usd\r\n2026-07-17,1,100\r\n```\r\n\r\nkeep me\r\n";
  const out = appendSnapshotToBody(body, snap);
  assert.ok(out.startsWith("# dash\r\n\r\n```csv\r\n"), out);
  assert.ok(out.endsWith("```\r\n\r\nkeep me\r\n"), out);
  assert.equal(out.split("```csv").length - 1, 1); // appended, not a second fence
  assert.equal(parseSnapshotsFromBody(out).snapshots.length, 2);
});

test("parseSnapshotsFromBody: ``` inside a quoted cell does not end the fence (SUB-277)", () => {
  // the lazy regex stopped at the in-cell ```, so fence.to pointed into row
  // data and an append spliced the new row into the middle of the fence
  const body = [
    "# dash",
    "",
    "```csv",
    "at,yield_usd,principal_usd",
    "2026-07-17,1,100",
    '"note',
    "```",
    'still data",9,9',
    "2026-07-18,2.5,100",
    "```",
    "",
    "after",
  ].join("\n");
  const { snapshots, fence } = parseSnapshotsFromBody(body);
  assert.ok(fence);
  assert.ok(body.slice(fence.from, fence.to).endsWith("100\n```"));
  assert.equal(snapshots.length, 2); // the quoted-cell lines are skipped rows, not a fence end
  const out = appendSnapshotToBody(body, snap);
  assert.ok(out.endsWith("```\n\nafter"), out);
  assert.equal(out.split("```csv").length - 1, 1);
  assert.equal(parseSnapshotsFromBody(out).snapshots.length, 3);
});

// ---------- claimed_usd ----------

test("readClaimedUsd: number, numeric string, missing, junk, negative", () => {
  assert.equal(readClaimedUsd({ claimed_usd: 232 }), 232);
  assert.equal(readClaimedUsd({ claimed_usd: "232.5" }), 232.5);
  assert.equal(readClaimedUsd({}), 0);
  assert.equal(readClaimedUsd({ claimed_usd: "abc" }), 0);
  assert.equal(readClaimedUsd({ claimed_usd: -5 }), 0);
  assert.equal(readClaimedUsd({ claimed_usd: true }), 0);
});

test("claim flow: rows stay cumulative — entered venue balance + claimed offset", () => {
  const body = bodyWith(["2026-07-17 10:00,0,1000000", "2026-07-17 11:00,60,1000000"]);
  // a claim at 60 sets claimed_usd to the last row's total
  const claimed = parseSnapshotsFromBody(body).snapshots.slice(-1)[0].yieldUsd;
  assert.equal(claimed, 60);
  // the venue now shows 15 fresh yield — the stored row is 60 + 15
  const out = appendSnapshotToBody(body, {
    atRaw: "2026-07-17 12:00",
    yieldUsd: 15 + claimed,
    principalUsd: 1000000,
  });
  const { snapshots } = parseSnapshotsFromBody(out);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[snapshots.length - 1].yieldUsd, 75);
  // series stays monotone across the claim — interval math never sees a reset
  for (let i = 1; i < snapshots.length; i++) {
    assert.ok(snapshots[i].yieldUsd >= snapshots[i - 1].yieldUsd);
  }
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

test("a cased Claimed_USD key still counts (SUB-921)", () => {
  assert.equal(readClaimedUsd({ Claimed_USD: 120 }), 120);
});
