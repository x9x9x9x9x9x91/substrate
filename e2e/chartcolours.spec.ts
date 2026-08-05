import { expect, test, type Page } from "@playwright/test";

// SUB-1062: a `by:` split's ramp slots are keyed on the series' identity and on
// the chart's, so a series keeps its colour ACROSS renders — when the rows
// under it change, and when another chart fence on the same dashboard is
// deleted out from above it. The SUB-952 specs pin the ramp within one render
// (walked from the top, never cycled); these pin what happens between two, on a
// dashboard that stays open, which is how a person actually reads one.

// the ramp's screen weights, in token order (kept in step with chartby.spec.ts)
const RAMP = [
  "rgb(57, 135, 229)",
  "rgb(217, 89, 38)",
  "rgb(25, 158, 112)",
  "rgb(201, 133, 0)",
  "rgb(213, 81, 129)",
];

const rows = (...lines: string[]) =>
  ["Portfolio tracker.", "", "```csv", "asset,bucket,quarter,value_eur", ...lines, "```", ""].join(
    "\n"
  );

const ETF = ["AAA,etf,Q1,10", "EEE,etf,Q2,30"];
const REST = ["BBB,crypto,Q1,20", "CCC,cash,Q1,15", "DDD,bonds,Q1,25", "FFF,crypto,Q2,40"];

const FOUR = rows(...ETF, ...REST);
const NO_ETF = rows(...REST);
const ETF_LAST = rows(...REST, ...ETF);

const BY_BUCKET = [
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

// a second chart on the same source, split a different way: its own series, so
// its own colour memory
const BY_QUARTER = [
  "```chart",
  "source: {{Holdings}}",
  "x: bucket",
  "y: sum:value_eur",
  "by: quarter",
  "kind: bar",
  "title: Value by bucket",
  "```",
  "",
].join("\n");

async function openOverview(page: Page, overview: string, source = FOUR) {
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

/* Edit a note under the open dashboard, the way something outside the app
   would. An event within 1s of an app-initiated refresh reads as the own-write
   echo, so the window is waited out before the change is announced. The
   dashboard is never re-opened: remounting it would hand every chart a fresh
   memory, which is exactly the thing these specs must not do. */
async function editUnderneath(page: Page, path: string, body: string) {
  await page.evaluate(([p, b]) => window.__mockEditNote!(p, b), [path, body]);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));
}

const swatches = (page: Page) =>
  page
    .locator(".chart-legend .chart-swatch")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));

const legendNames = (page: Page) => page.locator(".chart-legend .chart-legend-item");

test("a series keeps its colour when the rows under it change (SUB-1062)", async ({ page }) => {
  await openOverview(page, BY_BUCKET);
  await expect(legendNames(page)).toHaveCount(4);
  expect(await swatches(page)).toEqual(RAMP.slice(0, 4));

  // every etf row deleted. Positional slots would move crypto into etf's blue
  // and re-letter everything behind it; the survivors keep what they wear.
  await editUnderneath(page, "Holdings.md", NO_ETF);
  await expect(legendNames(page)).toHaveCount(3);
  await expect(legendNames(page).nth(0)).toHaveText("crypto");
  expect(await swatches(page)).toEqual(RAMP.slice(1, 4));

  // and etf coming back — now the LAST series in the data — takes its own slot
  // back rather than the next free one
  await editUnderneath(page, "Holdings.md", ETF_LAST);
  await expect(legendNames(page)).toHaveCount(4);
  await expect(legendNames(page).nth(3)).toHaveText("etf");
  expect(await swatches(page)).toEqual([RAMP[1], RAMP[2], RAMP[3], RAMP[0]]);
});

test("a chart keeps its colours when the fence above it is deleted (SUB-1062)", async ({ page }) => {
  await openOverview(page, BY_BUCKET + BY_QUARTER);
  // four series in the first chart, two in the second — each walks the ramp
  // from the top, because each is its own chart
  await expect(legendNames(page)).toHaveCount(6);
  expect(await swatches(page)).toEqual([...RAMP.slice(0, 4), RAMP[0], RAMP[1]]);

  // the first fence is deleted from the note. The surviving chart slides up
  // into the deleted one's place on the page — its colours must not slide with
  // it, which is what a memory kept per position rather than per chart did.
  await editUnderneath(page, "Dashboards/Overview.md", BY_QUARTER);
  await expect(page.locator(".dash-section-label")).toHaveCount(1);
  await expect(page.locator(".dash-section-label")).toHaveText("Value by bucket");
  await expect(legendNames(page)).toHaveCount(2);
  await expect(legendNames(page).nth(0)).toHaveText("Q1");
  expect(await swatches(page)).toEqual([RAMP[0], RAMP[1]]);
});
