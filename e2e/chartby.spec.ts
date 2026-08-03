import { expect, test, type Page } from "@playwright/test";

// SUB-941: `by:` pivots one row measure into a series per distinct value —
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
  await expect(page.locator(".chart-err")).toHaveCount(0);

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

  await expect(page.locator(".chart-err")).toHaveCount(0);
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

  const err = page.locator(".chart-err");
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

test("three neutral series stop honestly instead of repeating a gray (SUB-941)", async ({ page }) => {
  const threeBands = HOLDINGS.replace("DDD,crypto,Q2,40", "DDD,crypto,Q2,40\nEEE,cash,Q2,5");
  await openOverview(page, SPLIT, threeBands);

  await expect(page.locator(".chart-err")).toHaveText(
    "This split has 3 series; the current grayscale chart can distinguish 2."
  );
  await expect(page.locator(".chart-legend, .dash-chart")).toHaveCount(0);
});

test("a negative split cannot masquerade as a positive stacked bar (SUB-941)", async ({ page }) => {
  const negative = HOLDINGS.replace("BBB,crypto,Q1,20", "BBB,crypto,Q1,-20");
  await openOverview(page, SPLIT, negative);

  await expect(page.locator(".chart-err")).toHaveText(
    "Stacked bars cannot represent negative split values — use kind: line."
  );
  await expect(page.locator(".chart-legend, .dash-chart")).toHaveCount(0);
});

test("a zero-filled split bucket says that it has no rows (SUB-941)", async ({ page }) => {
  const dated = [
    "Date split.",
    "",
    "```csv",
    "asset,bucket,date,value_eur",
    "AAA,etf,2026-05-03,10",
    "BBB,crypto,2026-07-08,20",
    "```",
    "",
  ].join("\n");
  const byMonth = SPLIT.replace("x: quarter", "x: date:month");
  await openOverview(page, byMonth, dated);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(3);
  await expect(bars.nth(1)).toHaveAttribute("aria-label", "Jun 2026 · no rows");
  await expect(bars.nth(1).locator(".dash-bar.is-empty")).toHaveCount(1);
  await bars.nth(1).hover();
  await expect(page.locator(".chart-tip-x")).toHaveText("Jun 2026");
  await expect(page.locator(".chart-tip-n")).toHaveText("No rows");
});
