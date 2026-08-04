import { expect, test, type Page } from "@playwright/test";

// SUB-979: long categorical labels and low bars used to change each column's
// total height. That lifted some bar baselines, wrapped date/category tokens,
// and put small values into the axis-label band. This fixture keeps the chart
// deliberately narrow and mixes long labels with a 45x value range.

const SPEND = `---
type: sheet
title: Spending
---

\`\`\`csv
category,amount
Food & Delivery,1200
AI & Coding,835.4
VV Immobilien,4000
Studio Equipment,1582.4
Insurance & Fees,90
Travel & Hotels,2000
Subscriptions,450
Tax Advisors,3500
Office Supplies,100
Miscellaneous Costs,700
\`\`\`
`;

const OVERVIEW = `\`\`\`chart
source: {{Holdings}}
x: category
y: sum:amount
kind: bar
title: Where it goes
\`\`\`
`;

async function openOverview(page: Page) {
  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([sheet, overview]) => {
      window.__mockEditNote!("Holdings.md", sheet);
      window.__mockEditNote!("Dashboards/Overview.md", overview);
    },
    [SPEND, OVERVIEW]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-section-label", { hasText: "Where it goes" })).toBeVisible();
}

test("bar labels keep one aligned axis band and thin by measured width", async ({ page }) => {
  await openOverview(page);

  const bars = page.locator(".dash-bar-col");
  await expect(bars).toHaveCount(10);
  const labels = bars.locator(".dash-bar-time");
  await expect(labels).toHaveCount(10);
  await expect(labels.first()).toHaveAttribute("title", "Food & Delivery");
  await expect(labels.last()).toHaveAttribute("title", "Miscellaneous Costs");
  await expect(labels.first()).toHaveCSS("white-space", "nowrap");

  await expect
    .poll(() => labels.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility !== "hidden").length))
    .toBeLessThan(10);

  const geometry = await bars.evaluateAll((nodes) =>
    nodes.map((node) => {
      const bar = node.querySelector(".dash-bar")!.getBoundingClientRect();
      const label = node.querySelector(".dash-bar-time")!.getBoundingClientRect();
      const value = node.querySelector(".dash-bar-val")!.getBoundingClientRect();
      return { barBottom: bar.bottom, labelTop: label.top, labelHeight: label.height, valueBottom: value.bottom };
    })
  );
  expect(Math.max(...geometry.map((g) => g.barBottom)) - Math.min(...geometry.map((g) => g.barBottom))).toBeLessThan(1);
  expect(Math.max(...geometry.map((g) => g.labelTop)) - Math.min(...geometry.map((g) => g.labelTop))).toBeLessThan(1);
  expect(geometry.every((g) => g.labelHeight <= 14 && g.valueBottom < g.labelTop)).toBe(true);

  // The 90/100-height marks keep their exact reading in the focus/tooltip
  // contract, but no value text is squeezed against the axis.
  await expect(bars.nth(4)).toHaveAttribute("aria-label", "Insurance & Fees · 90");
  await expect(bars.nth(4).locator(".dash-bar-val")).toHaveText("");
  await expect(bars.nth(2).locator(".dash-bar-val")).toHaveText("4.000");
});
