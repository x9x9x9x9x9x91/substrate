import { expect, test, type Page } from "./fixtures";

// `by:` pivots one row measure into a series per distinct value —
// stacked bars, multi-line, and a legend that names the marks. The tooltip is
// the other half: hover or focus a column and the card states the x label and
// every band's exact value, so a stack is readable without a chart library.

const HOLDINGS = [
  "Portfolio tracker.",
  "",
  "```csv",
  "asset,bucket,quarter,value_eur",
  "AAA,etf,Q1,10",
  "BBB,crypto,Q1,20",
  "CCC,etf,Q2,30",
  "DDD,crypto,Q2,40",
  "```",
  "",
].join("\n");

const SPLIT = [
  "```chart",
  "source: {{Holdings}}",
  "x: quarter",
  "y: sum:value_eur",
  "by: bucket",
  "kind: bar",
  "title: Value by quarter",
  "```",
  "",
].join("\n");

// the same fence without the split: the control that must render exactly as
// it always did — one plain bar per x, no legend, no slices
const PLAIN = SPLIT.replace("by: bucket\n", "");

// a split naming a column that isn't there: the error must name the field
const BAD = SPLIT.replace("by: bucket", "by: sector");

async function openOverview(page: Page, overview: string, source = HOLDINGS) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([h, o]) => {
      window.__mockEditNote!("Holdings.md", h);
      window.__mockEditNote!("Dashboards/Overview.md", o);
    },
    [source, overview]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("by: stacks each x into one slice per value, with a legend (SUB-941)", async ({ page }) => {
  await openOverview(page, SPLIT);

  await expect(page.locator(".dash-section-label", { hasText: "Value by quarter" })).toBeVisible();
  await expect(page.locator(".dash-alert")).toHaveCount(0);

  // two x buckets, each a stack of the two series
  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0).locator(".dash-bar-time")).toHaveText("Q1");
  await expect(bars.nth(0).locator(".dash-bar-val")).toHaveText("30");
  await expect(bars.nth(0).locator(".dash-bar-slice")).toHaveCount(2);

  // the legend names both series in band order
  const legend = page.locator(".chart-legend .chart-legend-item");
  await expect(legend).toHaveCount(2);
  await expect(legend.nth(0)).toHaveText("etf");
  await expect(legend.nth(1)).toHaveText("crypto");

  // the sentence a screen reader gets carries both series and both values
  await expect(bars.nth(0)).toHaveAttribute("aria-label", "Q1 · etf: 10, crypto: 20");

  // hovering draws the same statement: x label, one row per band, a swatch each
  await bars.nth(1).hover();
  const tip = page.locator(".chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip.locator(".chart-tip-x")).toHaveText("Q2");
  await expect(tip.locator(".chart-tip-row")).toHaveCount(2);
  await expect(tip.locator(".chart-tip-name").nth(0)).toHaveText("etf");
  await expect(tip.locator(".chart-tip-val").nth(0)).toHaveText("30");
  await expect(tip.locator(".chart-swatch")).toHaveCount(2);
});

test("a chart without by: is untouched — no legend, no slices (SUB-941)", async ({ page }) => {
  await openOverview(page, PLAIN);

  await expect(page.locator(".dash-section-label", { hasText: "Value by quarter" })).toBeVisible();
  await expect(page.locator(".chart-legend")).toHaveCount(0);
  await expect(page.locator(".dash-bar-slice")).toHaveCount(0);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0).locator(".dash-bar-val")).toHaveText("30");
  await expect(bars.nth(0)).toHaveAttribute("aria-label", "Q1 · 30 · 2 rows");
});

test("a split line chart draws one path per series (SUB-941)", async ({ page }) => {
  await openOverview(page, SPLIT.replace("kind: bar", "kind: line"));

  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".chart-line-path")).toHaveCount(2);
  await expect(page.locator(".chart-legend .chart-legend-item")).toHaveCount(2);

  // the invisible per-x slot carries the reading and draws the card
  const slots = page.locator(".chart-line-slot");
  await expect(slots).toHaveCount(2);
  await expect(slots.nth(0)).toHaveAttribute("aria-label", "Q1 · etf: 10, crypto: 20");
  await slots.nth(0).hover();
  await expect(page.locator(".chart-tip-row")).toHaveCount(2);
});

test("a by: naming nothing says which column is missing (SUB-941)", async ({ page }) => {
  await openOverview(page, BAD);

  const err = page.locator(".dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(
    "no column “sector” on Holdings (has: asset, bucket, quarter, value_eur)"
  );
  await expect(page.locator(".dash-bar-col")).toHaveCount(0);
});

test("keyboard walks the axis and the focused column states itself (SUB-941)", async ({ page }) => {
  await openOverview(page, SPLIT);

  const bars = page.locator(".dash-bar-col");
  await bars.nth(0).focus();
  await expect(page.locator(".chart-tip-x")).toHaveText("Q1");

  // one tab stop per chart: arrows move within it
  await page.keyboard.press("ArrowRight");
  await expect(bars.nth(1)).toBeFocused();
  await expect(page.locator(".chart-tip-x")).toHaveText("Q2");
  await page.keyboard.press("Home");
  await expect(bars.nth(0)).toBeFocused();
});

// The ramp carries five series, so the ceiling of two is
// gone. A split of four draws four distinct slices, four distinct legend
// swatches, and four distinct colours — cycling would repeat one.
const FOUR = [
  "Portfolio tracker.",
  "",
  "```csv",
  "asset,bucket,quarter,value_eur",
  "AAA,etf,Q1,10",
  "BBB,crypto,Q1,20",
  "CCC,cash,Q1,15",
  "DDD,bonds,Q1,25",
  "EEE,etf,Q2,30",
  "FFF,crypto,Q2,40",
  "GGG,cash,Q2,12",
  "HHH,bonds,Q2,18",
  "```",
  "",
].join("\n");

async function bandColors(page: Page, sel: string, prop: "backgroundColor" | "stroke") {
  return page.locator(sel).evaluateAll(
    (els, p) => els.map((el) => getComputedStyle(el)[p as "backgroundColor"]),
    prop
  );
}

test("four series each get their own colour, in both stacked bars and lines (SUB-952)", async ({
  page,
}) => {
  await openOverview(page, SPLIT, FOUR);

  await expect(page.locator(".dash-alert")).toHaveCount(0);
  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0).locator(".dash-bar-slice")).toHaveCount(4);

  const legend = page.locator(".chart-legend .chart-legend-item");
  await expect(legend).toHaveCount(4);
  await expect(legend.nth(0)).toHaveText("etf");
  await expect(legend.nth(3)).toHaveText("bonds");

  // four marks, four distinct fills — the ceiling is gone and nothing repeats
  const slices = await bandColors(page, ".dash-bar-col >> nth=0 >> .dash-bar-slice", "backgroundColor");
  expect(new Set(slices).size).toBe(4);
  const swatches = await bandColors(page, ".chart-legend .chart-swatch", "backgroundColor");
  expect(new Set(swatches).size).toBe(4);
  // the legend swatch and the slice for the same series agree
  expect(swatches).toEqual(slices);

  await openOverview(page, SPLIT.replace("kind: bar", "kind: line"), FOUR);
  await expect(page.locator(".chart-line-path")).toHaveCount(4);
  const strokes = await bandColors(page, ".chart-line-path", "stroke");
  expect(new Set(strokes).size).toBe(4);
});

// the ramp's screen weights, in token order
const RAMP = [
  "rgb(57, 135, 229)",
  "rgb(217, 89, 38)",
  "rgb(25, 158, 112)",
  "rgb(201, 133, 0)",
  "rgb(213, 81, 129)",
];

test("the ramp is walked from the top, in order, never cycled or offset (SUB-952)", async ({
  page,
}) => {
  // a split of four takes slots 1-4; a split of three takes 1-3. The ramp is
  // never rotated to fit and never wraps — slot i is the split's i-th series,
  // so a legend swatch and its stack slice always name the same token.
  await openOverview(page, SPLIT, FOUR);
  expect(await bandColors(page, ".chart-legend .chart-swatch", "backgroundColor")).toEqual(
    RAMP.slice(0, 4)
  );

  const three = FOUR.split("\n")
    .filter((l) => !l.includes(",etf,"))
    .join("\n");
  await openOverview(page, SPLIT, three);
  await expect(page.locator(".chart-legend .chart-legend-item")).toHaveCount(3);
  expect(await bandColors(page, ".chart-legend .chart-swatch", "backgroundColor")).toEqual(
    RAMP.slice(0, 3)
  );
});

test("a sixth series stops honestly instead of repeating a hue (SUB-952)", async ({ page }) => {
  const sixBands = FOUR.replace(
    "HHH,bonds,Q2,18\n",
    "HHH,bonds,Q2,18\nIII,reits,Q1,7\nJJJ,gold,Q1,9\n"
  );
  await openOverview(page, SPLIT, sixBands);

  await expect(page.locator(".dash-alert")).toHaveText(
    "This split has 6 series; the chart ramp distinguishes 5."
  );
  await expect(page.locator(".chart-legend, .dash-chart")).toHaveCount(0);
});

test("a negative split cannot masquerade as a positive stacked bar (SUB-941)", async ({ page }) => {
  const negative = HOLDINGS.replace("BBB,crypto,Q1,20", "BBB,crypto,Q1,-20");
  await openOverview(page, SPLIT, negative);

  await expect(page.locator(".dash-alert")).toHaveText(
    "Stacked bars cannot represent negative split values — use kind: line."
  );
  await expect(page.locator(".chart-legend, .dash-chart")).toHaveCount(0);
});

// a May and a July row with June empty between them: the bar axis zero-fills
// the gap, so the middle bucket is the empty one in both shapes
const DATED = [
  "Date split.",
  "",
  "```csv",
  "asset,bucket,date,value_eur",
  "AAA,etf,2026-05-03,10",
  "BBB,crypto,2026-07-08,20",
  "```",
  "",
].join("\n");

test("a zero-filled split bucket says that it has no rows (SUB-941)", async ({ page }) => {
  const byMonth = SPLIT.replace("x: quarter", "x: date:month");
  await openOverview(page, byMonth, DATED);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(3);
  await expect(bars.nth(1)).toHaveAttribute("aria-label", "Jun 2026 · no rows");
  await expect(bars.nth(1).locator(".dash-bar.is-empty")).toHaveCount(1);
  await bars.nth(1).hover();
  await expect(page.locator(".chart-tip-x")).toHaveText("Jun 2026");
  await expect(page.locator(".chart-tip-n")).toHaveText("No rows");
});

test("a real zero split bucket keeps an honest visible zero mark (SUB-954)", async ({ page }) => {
  const zeroRows = HOLDINGS.replace("AAA,etf,Q1,10", "AAA,etf,Q1,0").replace(
    "BBB,crypto,Q1,20",
    "BBB,crypto,Q1,0"
  );
  await openOverview(page, SPLIT, zeroRows);

  const splitCol = page.locator(".dash-bar-col").first();
  const splitZero = splitCol.locator(".dash-bar.is-stack.is-zero");
  await expect(splitCol).toHaveAttribute("aria-label", "Q1 · etf: 0, crypto: 0");
  await expect(splitZero).toHaveCount(1);
  await expect(splitZero.locator(".dash-bar-slice")).toHaveCount(0);
  const splitBox = (await splitZero.boundingBox())!;
  expect(splitBox.height).toBeGreaterThanOrEqual(3);
  const splitFill = await splitZero.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(splitFill).not.toBe("rgba(0, 0, 0, 0)");

  // The non-split form has always painted a real zero as its normal 3px bar.
  // The exact fill differs between shapes — a split slice wears its band, an
  // unsplit bar the one-series accent; the shared invariant is a visible,
  // painted, not-row-empty mark in both.
  await openOverview(page, PLAIN, zeroRows);
  const plainCol = page.locator(".dash-bar-col").first();
  const plainZero = plainCol.locator(".dash-bar:not(.is-empty)");
  await expect(plainCol).toHaveAttribute("aria-label", "Q1 · 0 · 2 rows");
  await expect(plainZero).toHaveCount(1);
  const plainBox = (await plainZero.boundingBox())!;
  expect(plainBox.height).toBeGreaterThanOrEqual(3);
  const plainFill = await plainZero.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(plainFill).not.toBe("rgba(0, 0, 0, 0)");
});

// The same empty bucket without a `by:` — one reading for both
// shapes. It used to claim a value of 0, which is a different statement from
// "nothing landed here".
test("a zero-filled plain bucket reads as empty, exactly like a split one (SUB-954)", async ({
  page,
}) => {
  const byMonth = PLAIN.replace("x: quarter", "x: date:month");
  await openOverview(page, byMonth, DATED);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(3);
  await expect(bars.nth(1)).toHaveAttribute("aria-label", "Jun 2026 · no rows");
  await expect(bars.nth(1).locator(".dash-bar.is-empty")).toHaveCount(1);
  // the buckets that do have rows keep their own reading, and no empty mark
  await expect(bars.nth(0)).toHaveAttribute("aria-label", "May 2026 · 10");
  await expect(bars.nth(0).locator(".dash-bar.is-empty")).toHaveCount(0);

  await bars.nth(1).hover();
  await expect(page.locator(".chart-tip-x")).toHaveText("Jun 2026");
  await expect(page.locator(".chart-tip-n")).toHaveText("No rows");
  await expect(page.locator(".chart-tip-row")).toHaveCount(0);
});

// The generic hover rule already outweighs `.dash-bar.is-empty`; the
// explicit empty-state rule is load-bearing for keyboard focus. Exercise the
// split shape too so a later stack override cannot silently erase either
// response. Assert the change, not a literal colour — tokens are free to move.
for (const [shape, fence] of [
  ["split", SPLIT],
  ["plain", PLAIN],
] as const) {
  test(`an empty ${shape} bucket still answers hover and focus (SUB-954)`, async ({ page }) => {
    await openOverview(page, fence.replace("x: quarter", "x: date:month"), DATED);

    const col = page.locator(".dash-bar-col").nth(1);
    const bar = col.locator(".dash-bar.is-empty");
    await expect(bar).toHaveCount(1);
    const fill = () => bar.evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.mouse.move(0, 0);
    const rest = await fill();
    expect(rest).not.toBe("rgba(0, 0, 0, 0)");

    // polled, not read once: the fill is transitioned, so an immediate read
    // still returns the resting colour mid-animation
    await col.hover();
    await expect.poll(fill).not.toBe(rest);

    // keyboard focus lands on the column and must light the same mark
    await page.mouse.move(0, 0);
    await expect.poll(fill).toBe(rest);
    await page.locator(".dash-bar-col").first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(col).toBeFocused();
    await expect.poll(fill).not.toBe(rest);
  });
}

// The card flips below its anchor near the top of the plot so it
// never covers the legend. Asserted geometrically — a class name alone does
// not prove the box moved.
test("a tall bar's card opens downward, a short one's opens upward (SUB-954)", async ({ page }) => {
  const skewed = HOLDINGS.replace("CCC,etf,Q2,30", "CCC,etf,Q2,3000").replace(
    "DDD,crypto,Q2,40\n",
    ""
  );
  await openOverview(page, PLAIN, skewed);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);
  const tip = page.locator(".chart-tip");

  // the full-height bar starts near the top of the plot: its card hangs below
  await bars.nth(1).hover();
  await expect(tip).toHaveClass(/is-below/);
  const tallBar = (await bars.nth(1).locator(".dash-bar").boundingBox())!;
  const below = (await tip.boundingBox())!;
  expect(below.y).toBeGreaterThanOrEqual(tallBar.y - 1);

  // the short bar sits at the baseline, far from the legend: card above, and
  // clear of the mark rather than on top of it
  await page.mouse.move(0, 0);
  await bars.nth(0).hover();
  await expect(tip).toHaveClass(/is-above/);
  const shortBar = (await bars.nth(0).locator(".dash-bar").boundingBox())!;
  const above = (await tip.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(shortBar.y + 1);
  // each card is placed against its own anchor, so the two cards are not
  // comparable to each other in page coordinates — a baseline bar's upward
  // card can still sit lower than a full-height bar's downward one.
});

// Hover slots partition the plot at the MIDPOINTS between dots, so
// an irregular time axis hands each point the space nearest to it — and no
// pixel of the plot belongs to nobody.
test("line hover slots partition the plot at dot midpoints (SUB-954)", async ({ page }) => {
  const irregular = [
    "Snapshots.",
    "",
    "```csv",
    "asset,bucket,date,value_eur",
    "AAA,etf,2026-01-01,10",
    "BBB,etf,2026-01-02,20",
    "CCC,etf,2026-01-20,30",
    "DDD,etf,2026-01-25,40",
    "```",
    "",
  ].join("\n");
  const daily = PLAIN.replace("x: quarter", "x: date:day").replace("kind: bar", "kind: line");
  await openOverview(page, daily, irregular);

  const plot = (await page.locator(".chart-line-plot").boundingBox())!;
  const dots = await page.locator(".chart-dot").all();
  const slots = await page.locator(".chart-line-slot").all();
  expect(dots).toHaveLength(4);
  expect(slots).toHaveLength(4);

  const centers: number[] = [];
  for (const d of dots) {
    const b = (await d.boundingBox())!;
    centers.push(b.x + b.width / 2);
  }
  const boxes = [];
  for (const s of slots) boxes.push((await s.boundingBox())!);

  // the irregular gaps really are irregular — otherwise this asserts nothing
  expect(centers[1] - centers[0]).toBeLessThan((centers[2] - centers[1]) / 2);

  // ends pinned to the plot, no gaps or overlaps in between, every boundary
  // on the midpoint of the two dots it separates
  expect(Math.abs(boxes[0].x - plot.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[3].x + boxes[3].width - (plot.x + plot.width))).toBeLessThanOrEqual(1);
  for (let i = 0; i < 3; i++) {
    const edge = boxes[i].x + boxes[i].width;
    expect(Math.abs(edge - boxes[i + 1].x)).toBeLessThanOrEqual(1);
    expect(Math.abs(edge - (centers[i] + centers[i + 1]) / 2)).toBeLessThanOrEqual(1);
  }
  // and each dot is inside its own slot, not its neighbour's
  for (let i = 0; i < 4; i++) {
    expect(centers[i]).toBeGreaterThanOrEqual(boxes[i].x - 1);
    expect(centers[i]).toBeLessThanOrEqual(boxes[i].x + boxes[i].width + 1);
  }
});

// The per-slot band lookup is indexed by key now; a band that has no
// row at an x must still be absent from that x's card rather than reading as
// a zero or as its neighbour's value.
test("a split line names only the bands present at each x (SUB-954)", async ({ page }) => {
  const gappy = HOLDINGS.replace("DDD,crypto,Q2,40\n", "");
  await openOverview(page, SPLIT.replace("kind: bar", "kind: line"), gappy);

  const slots = page.locator(".chart-line-slot");
  await expect(slots).toHaveCount(2);
  await expect(slots.nth(0)).toHaveAttribute("aria-label", "Q1 · etf: 10, crypto: 20");
  await expect(slots.nth(1)).toHaveAttribute("aria-label", "Q2 · etf: 30");

  await slots.nth(1).hover();
  await expect(page.locator(".chart-tip-row")).toHaveCount(1);
  await expect(page.locator(".chart-tip-name")).toHaveText("etf");
  await expect(page.locator(".chart-tip-val")).toHaveText("30");
});
