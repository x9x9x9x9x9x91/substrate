import { expect, test, type Page } from "@playwright/test";

// SUB-671: a chart over a sheet whose computed column reads ANOTHER sheet.
// ChartsDashboard used to call evaluateSheet without the cross-sheet loader,
// so `net_eur = value_usd + Cash.cash_total` evaluated to an error in every
// cell: an errored y skipped every row ("No rows matched"), an errored
// categorical x stringified into one "[object Object]" bar. The loader now
// walks the transitive closure the metrics dashboard already walked, and
// cellString refuses to label a non-scalar.
//
// Fixtures are rewritten in-page before the dashboard opens (mock backend):
//   Cash      → cash_total = 300
//   Holdings  → value_usd = units * price_usd, net_eur = value_usd + Cash.cash_total
//   Overview  → one bar chart, x: bucket, y: sum:net_eur
// so etf = 10 + 300 = 310 and crypto = 20 + 300 = 320.

const CASH = [
  "Cash accounts.",
  "",
  "```csv",
  "account,balance_eur",
  "Nordkasse,100",
  "Brokerhaus,200",
  "```",
  "",
  "```formulas",
  "cash_total = SUM(balance_eur)",
  "```",
  "",
].join("\n");

const HOLDINGS = [
  "Portfolio tracker.",
  "",
  "```csv",
  "asset,bucket,units,price_usd",
  "AAA,etf,1,10",
  "BBB,crypto,1,20",
  "```",
  "",
  "```formulas",
  "value_usd = units * price_usd",
  "net_eur   = value_usd + Cash.cash_total",
  "```",
  "",
].join("\n");

const OVERVIEW = [
  "Charts over the label databases and sheets.",
  "",
  "```chart",
  "source: {{Holdings}}",
  "x: bucket",
  "y: sum:net_eur",
  "kind: bar",
  "title: Net by bucket",
  "```",
  "",
].join("\n");

async function openOverview(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([cash, holdings, overview]) => {
      window.__mockEditNote!("Cash.md", cash);
      window.__mockEditNote!("Holdings.md", holdings);
      window.__mockEditNote!("Dashboards/Overview.md", overview);
    },
    [CASH, HOLDINGS, OVERVIEW]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("a chart over a cross-referencing sheet plots real values (SUB-671)", async ({ page }) => {
  await openOverview(page);

  await expect(page.locator(".dash-section-label", { hasText: "Net by bucket" })).toBeVisible();
  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(2);

  // the cross-sheet summary reached every row: 10 + 300 and 20 + 300
  await expect(bars.nth(0).locator(".dash-bar-time")).toHaveText("etf");
  await expect(bars.nth(0).locator(".dash-bar-val")).toHaveText("310");
  await expect(bars.nth(0)).toHaveAttribute("title", "etf · 310");
  await expect(bars.nth(1).locator(".dash-bar-time")).toHaveText("crypto");
  await expect(bars.nth(1).locator(".dash-bar-val")).toHaveText("320");
  await expect(bars.nth(1)).toHaveAttribute("title", "crypto · 320");

  // none of the pre-fix failure modes: no all-rows-skipped notice, no error
  // banner, no stringified error object as a bar label, no skipped rows
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await expect(page.getByText("No rows matched")).toHaveCount(0);
  await expect(page.getByText("object Object")).toHaveCount(0);
  await expect(page.locator(".dash-foot", { hasText: "rows skipped" })).toHaveCount(0);
  await expect(page.locator(".dash-foot", { hasText: "sheet: Holdings · 2 points" })).toBeVisible();
});
