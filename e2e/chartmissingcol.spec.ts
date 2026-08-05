import { expect, test, type Page } from "@playwright/test";

// A binding whose property vanished names it. Renaming a sheet column
// rewrites the sheet's own formulas, but a chart fence in ANOTHER note keeps
// pointing at the old name — every row then skips for the same absent column
// and the chart used to read the generic "No rows matched — check the source
// and property names.", which is the app knowing the answer and not saying it.
// The engine's convention is honest named errors (a LOOKUP miss, a `series:`
// binding to a non-summary), and row bindings now meet it.

// Holdings after the rename the issue describes: value_usd → usd, with the
// same-fence dependants rewritten the way the grid's header edit rewrites them
const RENAMED = [
  "Portfolio tracker.",
  "",
  "```csv",
  "asset,bucket,units,price_usd",
  "GLOW,etf,1200,31.4",
  "BTC,crypto,4.1,64200",
  "```",
  "",
  "```formulas",
  "usd = units * price_usd",
  "```",
  "",
].join("\n");

// the stale fence: still bound to the pre-rename column name
const OVERVIEW = [
  "```chart",
  "source: {{Holdings}}",
  "x: bucket",
  "y: sum:value_usd",
  "kind: bar",
  "title: Value by bucket",
  "```",
  "",
].join("\n");

// same source, a column that is really there — the control
const OVERVIEW_OK = OVERVIEW.replace("y: sum:value_usd", "y: sum:usd");

// a column that exists but whose cells never plot: a genuine zero-match, which
// must keep the neutral empty state rather than accuse a column that is there
const ALL_UNPARSEABLE = [
  "Portfolio tracker.",
  "",
  "```csv",
  "asset,bucket,value_usd",
  "GLOW,etf,n/a",
  "BTC,crypto,tbd",
  "```",
  "",
].join("\n");

async function openOverview(page: Page, holdings: string, overview: string) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([h, o]) => {
      window.__mockEditNote!("Holdings.md", h);
      window.__mockEditNote!("Dashboards/Overview.md", o);
    },
    [holdings, overview]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("a renamed column is named by the chart, not hidden behind 'No rows matched' (SUB-749)", async ({
  page,
}) => {
  await openOverview(page, RENAMED, OVERVIEW);

  await expect(page.locator(".dash-section-label", { hasText: "Value by bucket" })).toBeVisible();

  // the error says which column, on which sheet, and what the sheet does have
  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(
    "no column “value_usd” on Holdings (has: asset, bucket, units, price_usd, usd)"
  );

  // and the generic notice is gone — one statement, not two
  await expect(page.getByText("No rows matched")).toHaveCount(0);
  await expect(page.locator(".dash-bar-col")).toHaveCount(0);
});

test("a real column still plots — the error is about absence, not emptiness (SUB-749)", async ({
  page,
}) => {
  await openOverview(page, RENAMED, OVERVIEW_OK);

  await expect(page.locator(".chart-err")).toHaveCount(0);
  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0).locator(".dash-bar-time")).toHaveText("etf");
});

test("a present column whose rows all skip keeps the neutral empty state (SUB-749)", async ({
  page,
}) => {
  await openOverview(page, ALL_UNPARSEABLE, OVERVIEW);

  // value_usd IS there; its cells simply don't parse. Naming it would be a lie.
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await expect(page.getByText("No rows matched")).toBeVisible();
  await expect(page.locator(".dash-foot", { hasText: "2 rows skipped" })).toBeVisible();
});

test("a metric card names the summary it can't find (SUB-749)", async ({ page }) => {
  // the same class one surface over: the Portfolio board binds
  // {{Holdings.total}}, the sheet renames that summary to net_worth, and the
  // card used to read "—" with the reason buried in a hover tooltip
  const renamedSummary = [
    "Portfolio tracker.",
    "",
    "```csv",
    "asset,bucket,value_eur",
    "GLOW,etf,41000",
    "BTC,crypto,263220",
    "```",
    "",
    "```formulas",
    "net_worth = SUM(value_eur)",
    "crypto    = SUMIF(bucket, \"crypto\", value_eur)",
    "```",
    "",
  ].join("\n");

  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((body) => window.__mockEditNote!("Holdings.md", body), renamedSummary);
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");

  const card = page.locator(".metrics-cards .dash-card", {
    has: page.locator(".dash-label", { hasText: /^Total value$/ }),
  });
  await expect(card.locator(".dash-card-eur")).toHaveText("—");
  await expect(card.locator(".dash-card-miss")).toHaveText("no summary “total” on Holdings");
  // the inventory is too long for a card, so hover carries it
  await expect(card).toHaveAttribute(
    "title",
    "{{Holdings.total}} — no summary “total” on Holdings (has: net_worth, crypto)"
  );

  // a card whose summary survived the rename still reads its value
  const kept = page.locator(".metrics-cards .dash-card", {
    has: page.locator(".dash-label", { hasText: /^Crypto$/ }),
  });
  await expect(kept.locator(".dash-card-miss")).toHaveCount(0);
  await expect(kept.locator(".dash-card-eur")).not.toHaveText("—");
});
