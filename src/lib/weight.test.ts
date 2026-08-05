import { test } from "node:test";
import assert from "node:assert/strict";
import { KG_MAX, KG_MIN, kgInRange, MIN_SPAN_KG, parseWeightRows, weightSeries } from "./weight.ts";

function bodyWith(rows: string[], header = "date,kg"): string {
  return ["Morning weigh-ins.", "", "```csv", header, ...rows, "```", ""].join("\n");
}

const WINDOW = [
  "2026-07-20",
  "2026-07-21",
  "2026-07-22",
  "2026-07-23",
  "2026-07-24",
  "2026-07-25",
  "2026-07-26",
];

test("parseWeightRows: typed rows, log order", () => {
  const rows = parseWeightRows(bodyWith(["2026-07-24,68.0", "2026-07-31,67.4"]));
  assert.deepEqual(rows, [
    { date: "2026-07-24", kg: 68 },
    { date: "2026-07-31", kg: 67.4 },
  ]);
});

test("parseWeightRows: de-DE typed kg reads (SUB-923)", () => {
  // hand edits type the app's own display dialect — "72,5" is 72.5
  const rows = parseWeightRows(bodyWith(['2026-08-01,"72,5"']));
  assert.deepEqual(rows, [{ date: "2026-08-01", kg: 72.5 }]);
});

test("parseWeightRows: header order is free and case-insensitive", () => {
  const rows = parseWeightRows(bodyWith(["76.2,2026-07-24"], "KG,Date"));
  assert.deepEqual(rows, [{ date: "2026-07-24", kg: 76.2 }]);
});

test("parseWeightRows: malformed date, non-numeric or out-of-range kg are skipped", () => {
  const rows = parseWeightRows(
    bodyWith([
      "yesterday,68.0",
      "2026-07-22,",
      "2026-07-23,abc",
      "2026-07-24,7e1", // strict parse: exponent notation is text, not 70
      "2026-07-25,724", // digit slip, out of the sanity bound
      "2026-07-26,67.4",
    ])
  );
  assert.deepEqual(rows, [{ date: "2026-07-26", kg: 67.4 }]);
});

test("parseWeightRows: no fence, no csv rows, or a missing kg column reads as empty", () => {
  assert.deepEqual(parseWeightRows("Just prose, no fence.\n"), []);
  assert.deepEqual(parseWeightRows("```csv\n```\n"), []);
  assert.deepEqual(parseWeightRows(bodyWith(["2026-07-24,68.0"], "date,weight")), []);
});

test("kgInRange: bounds are inclusive, non-finite rejected", () => {
  assert.equal(kgInRange(KG_MIN), true);
  assert.equal(kgInRange(KG_MAX), true);
  assert.equal(kgInRange(KG_MIN - 0.1), false);
  assert.equal(kgInRange(KG_MAX + 0.1), false);
  assert.equal(kgInRange(NaN), false);
  assert.equal(kgInRange(Infinity), false);
});

test("weightSeries: one point per logged day, columns index the window", () => {
  const s = weightSeries(bodyWith(["2026-07-21,68.0", "2026-07-25,67.4"]), WINDOW);
  assert.ok(s);
  assert.equal(s.points.length, 2);
  assert.deepEqual(
    s.points.map((p) => [p.day, p.kg, p.col]),
    [
      ["2026-07-21", 68, 1],
      ["2026-07-25", 67.4, 5],
    ]
  );
  assert.equal(s.min, 67.4);
  assert.equal(s.max, 68);
});

test("weightSeries: rows outside the window are ignored", () => {
  const s = weightSeries(bodyWith(["2026-01-02,75.0", "2026-07-22,67.0"]), WINDOW);
  assert.ok(s);
  assert.deepEqual(
    s.points.map((p) => p.day),
    ["2026-07-22"]
  );
  assert.equal(s.max, 67);
});

test("weightSeries: null when nothing in the window is logged", () => {
  assert.equal(weightSeries(bodyWith(["2026-01-02,75.0"]), WINDOW), null);
  assert.equal(weightSeries("no fence here", WINDOW), null);
});

test("weightSeries: a day logged twice keeps the last row", () => {
  const s = weightSeries(bodyWith(["2026-07-22,68.0", "2026-07-22,67.8"]), WINDOW);
  assert.ok(s);
  assert.equal(s.points.length, 1);
  assert.equal(s.points[0].kg, 67.8);
});

test("weightSeries: own scale — a real cut move spans most of the plot", () => {
  const s = weightSeries(bodyWith(["2026-07-21,70.0", "2026-07-25,68.0"]), WINDOW);
  assert.ok(s);
  const ys = s.points.map((p) => p.y);
  // 2 kg span > the floor, so padding is the only widening: 2 * 1.4 = 2.8,
  // and the move covers 2/2.8 ≈ 71% of the plot
  assert.ok(Math.abs(ys[0] - ys[1] - 2 / 2.8) < 1e-9, `span ${ys[0] - ys[1]}`);
  // heavier day sits higher, and both stay inside the plot
  assert.ok(ys[0] > ys[1]);
  for (const y of ys) assert.ok(y > 0 && y < 1, `y ${y} inside plot`);
});

test("weightSeries: a real 0.6 kg move reads as a move, not a flat line", () => {
  // the case: 68.0 → 67.4 across the window. Under MIN_SPAN_KG, so
  // the floor span applies — 0.6 / 1.4 ≈ 43% of the plot, unmistakably not flat
  const s = weightSeries(bodyWith(["2026-07-21,68.0", "2026-07-25,67.4"]), WINDOW);
  assert.ok(s);
  const gap = s.points[0].y - s.points[1].y;
  assert.ok(Math.abs(gap - 0.6 / (MIN_SPAN_KG * 1.4)) < 1e-9, `gap ${gap}`);
  assert.ok(gap > 0.25, `gap ${gap} clearly visible`);
});

test("weightSeries: a single point (or a flat window) sits mid-plot, no divide by zero", () => {
  const one = weightSeries(bodyWith(["2026-07-22,67.4"]), WINDOW);
  assert.ok(one);
  assert.equal(one.points[0].y, 0.5);
  assert.equal(one.min, 67.4);
  assert.equal(one.max, 67.4);

  const flat = weightSeries(bodyWith(["2026-07-21,67.4", "2026-07-25,67.4"]), WINDOW);
  assert.ok(flat);
  for (const p of flat.points) assert.equal(p.y, 0.5);
});

test("weightSeries: a sub-minimum span still uses the floor span, not the raw one", () => {
  // 0.2 kg apart, well under MIN_SPAN_KG — the padded scale uses the floor,
  // so the move reads as a small move rather than filling the plot
  const s = weightSeries(bodyWith(["2026-07-21,67.6", "2026-07-25,67.4"]), WINDOW);
  assert.ok(s);
  const gap = s.points[0].y - s.points[1].y;
  assert.ok(
    Math.abs(gap - 0.2 / (MIN_SPAN_KG * 1.4)) < 1e-9,
    `gap ${gap}`
  );
});
