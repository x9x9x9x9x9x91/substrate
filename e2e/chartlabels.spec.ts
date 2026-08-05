import { expect, test, type Page } from "@playwright/test";

// Long categorical labels and low bars used to change each column's
// total height. That lifted some bar baselines, wrapped date/category tokens,
// and put small values into the axis-label band. This fixture keeps the chart
// deliberately narrow and mixes long labels with a 45x value range.
// The label policy that answers it: categorical axes never thin (a bar
// without its name is anonymous — every label stays, ellipsized per column),
// time axes thin and render kept tokens whole into the freed room, and small
// bars keep their value label (the collision was position, not
// existence).

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

// A text column of pre-bucketed month keys — the Spending importer's shape.
// Despite the null bucket this must read as a time axis: thinned whole labels,
// no categorical series ramp.
const MONTHLY = `---
type: sheet
title: Monthly
---

\`\`\`csv
month,total
2025-01,9200
2025-02,11800
2025-03,13400
2025-04,7100
2025-05,15200
2025-06,10300
2025-07,12600
2025-08,9900
2025-09,8400
2025-10,10900
2025-11,13800
2025-12,11200
2026-01,16800
2026-02,24100
2026-03,41500
2026-04,8800
2026-05,21900
2026-06,12400
2026-07,17606
2026-08,1200
\`\`\`
`;

const OVERVIEW = `\`\`\`chart
source: {{Holdings}}
x: category
y: sum:amount
kind: bar
title: Where it goes
\`\`\`

\`\`\`chart
source: {{Monthly}}
x: month
y: sum:total
kind: bar
title: Total spend by month
\`\`\`
`;

async function openOverview(page: Page) {
  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([sheet, monthly, overview]) => {
      window.__mockEditNote!("Holdings.md", sheet);
      window.__mockCloneNote!("Holdings.md", "Monthly.md");
      window.__mockEditNote!("Monthly.md", monthly);
      window.__mockEditNote!("Dashboards/Overview.md", overview);
    },
    [SPEND, MONTHLY, OVERVIEW]
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-section-label", { hasText: "Where it goes" })).toBeVisible();
}

function chartOf(page: Page, title: string) {
  return page.locator(".dash-section-label", { hasText: title }).locator("xpath=..").locator(".dash-chart");
}

test("categorical bars keep one aligned axis band and every label", async ({ page }) => {
  await openOverview(page);

  const bars = chartOf(page, "Where it goes").locator(".dash-bar-col");
  await expect(bars).toHaveCount(10);
  const labels = bars.locator(".dash-bar-time");
  await expect(labels).toHaveCount(10);
  await expect(labels.first()).toHaveAttribute("title", "Food & Delivery");
  await expect(labels.last()).toHaveAttribute("title", "Miscellaneous Costs");
  await expect(labels.first()).toHaveCSS("white-space", "nowrap");

  // a category label is a name, not a tick — none may be thinned away
  await expect
    .poll(() => labels.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility !== "hidden").length))
    .toBe(10);

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

  // Small bars keep their exact reading everywhere it lives: value label,
  // focus/tooltip contract — the fixed axis band holds it clear of the labels.
  await expect(bars.nth(4)).toHaveAttribute("aria-label", "Insurance & Fees · 90");
  await expect(bars.nth(4).locator(".dash-bar-val")).toHaveText("90");
  await expect(bars.nth(2).locator(".dash-bar-val")).toHaveText("4.000");
});

test("pre-bucketed month keys read as a time axis: thinned whole labels, one series", async ({ page }) => {
  await openOverview(page);

  const chart = chartOf(page, "Total spend by month");
  const bars = chart.locator(".dash-bar-col");
  await expect(bars).toHaveCount(20);
  const labels = bars.locator(".dash-bar-time");

  // thinning happens — and every kept token renders whole, not "2025-…"
  await expect
    .poll(() => labels.evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).visibility !== "hidden").length))
    .toBeLessThan(20);
  // Measure the PAINTED text, never a model of it: a roomy label's box and its
  // glyphs are not the same rect, and inline content that overflows its box
  // always spills to the inline end whatever text-align says — so a computed
  // "where the text should be" passes while the text draws outside the plot
  // (review). Range.selectNodeContents gives the real ink.
  const kept = await labels.evaluateAll((nodes) =>
    nodes
      .filter((node) => getComputedStyle(node).visibility !== "hidden")
      .map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const ink = range.getBoundingClientRect();
        return {
          text: node.textContent,
          clip: getComputedStyle(node).textOverflow,
          left: ink.left,
          right: ink.right,
        };
      })
  );
  const plot = await chart.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  expect(kept.length).toBeGreaterThan(2);
  expect(kept[0].text).toBe("2025-01");
  expect(kept[kept.length - 1].text).toBe("2026-08");
  // whole tokens: clip (never ellipsis), and no two kept labels overlap
  expect(kept.every((k) => k.clip === "clip")).toBe(true);
  for (let i = 1; i < kept.length; i++) expect(kept[i].left).toBeGreaterThan(kept[i - 1].right);
  // and nothing paints past the plot — the edge labels are the ones at risk
  for (const k of kept) {
    expect(k.left).toBeGreaterThanOrEqual(plot.left - 0.5);
    expect(k.right).toBeLessThanOrEqual(plot.right + 0.5);
  }

  // one series: a time axis never wears the categorical ramp
  const tinted = await bars.evaluateAll((nodes) =>
    nodes.filter((node) => (node.querySelector(".dash-bar") as HTMLElement).style.getPropertyValue("--bar") !== "").length
  );
  expect(tinted).toBe(0);
});
