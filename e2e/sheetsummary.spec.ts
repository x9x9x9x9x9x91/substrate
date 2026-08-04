import { expect, test, type Page } from "@playwright/test";

// SUB-939: the summary bar under a sheet used to render every named summary as
// one flat wrap — a finance sheet with a dozen of them read as a dump, a single
// cascading error printed a row of bare `!`, and the USD→EUR stamp showed under
// sheets holding no currency at all. These specs drive the three fixes through
// the real grid: blank-line groups, one rollup chip, a conditional stamp.

const FINANCE = `---
type: sheet
title: Holdings
---

\`\`\`csv
month,bucket,net_eur,vat_eur
2026-01,studio,4200,798
2026-02,studio,3100,589
2026-03,label,5400,1026
2026-04,label,2750,522
\`\`\`

\`\`\`formulas
gross_eur = net_eur + vat_eur

net_total = SUM(net_eur)
vat_total = SUM(vat_eur)
gross_total = SUM(gross_eur)

studio = SUMIF(bucket, "studio", net_eur)
label = SUMIF(bucket, "label", net_eur)
months = COUNT(net_eur)
avg_month = AVG(net_eur)
best_month = MAX(net_eur)
worst_month = MIN(net_eur)
\`\`\`
`;

// one name collision (a formula named like a data column, SUB-751) breaking
// every summary downstream of it — the reported Holdings case, reproduced
const CASCADE = `---
type: sheet
title: Holdings
---

\`\`\`csv
asset,bucket,units,price_usd,value_eur
GLOW,etf,1200,31.4,1
BTC,crypto,4.1,64200,2
ARC,etf,80,92.5,3
\`\`\`

\`\`\`formulas
value_usd = units * price_usd
value_eur = value_usd * 0.87

total = SUM(value_eur)
crypto = SUMIF(bucket, "crypto", value_eur)
etf = SUMIF(bucket, "etf", value_eur)
biggest = MAX(value_eur)
\`\`\`
`;

const WITH_FX = `---
type: sheet
title: Holdings
---

\`\`\`csv
asset,units,price_usd
GLOW,1200,31.4
BTC,4.1,64200
\`\`\`

\`\`\`formulas
usd = units * price_usd
eur = usd * FX("USD","EUR")
total = SUM(eur)
\`\`\`
`;

async function openSheet(page: Page, body: string) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => window.__mockEditNote?.("Holdings.md", b), body);
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".sheet-table")).toBeVisible();
}

test("the first group is the headline; the rest sit behind one toggle", async ({ page }) => {
  await openSheet(page, FINANCE);
  const chips = page.locator(".sheet-summary .sheet-sum");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("net_total");
  await expect(page.locator(".sheet-sum-rest")).toHaveCount(0);

  const more = page.locator(".sheet-sum-more");
  await expect(more).toHaveText("show all (6)");
  const controlledId = await more.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const details = page.locator(`[id="${controlledId}"]`);
  await expect(details.locator(".sheet-sum")).toHaveCount(6);
  await expect(details).toContainText("worst_month");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more).toHaveText("hide");

  await more.click();
  await expect(page.locator(".sheet-sum-rest")).toHaveCount(0);
});

test("summaries broken by one cause collapse into a single chip that expands", async ({ page }) => {
  await openSheet(page, CASCADE);
  const rollup = page.locator(".sheet-sum-rollup");
  await expect(rollup).toHaveCount(1);
  await expect(rollup).toContainText("value_eur");
  await expect(rollup).toContainText("broke 4 summaries");
  await expect(rollup).toHaveAccessibleName(/value_eur.*Broke 4 summaries.*total.*biggest/i);
  const controlledId = await rollup.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  await expect(rollup).toHaveAttribute("aria-expanded", "false");
  // no bare `!` chips left in the headline row
  await expect(page.locator(".sheet-summary .sheet-sum-val")).toHaveCount(0);

  await rollup.press("Enter");
  const details = page.locator(`[id="${controlledId}"]`);
  await expect(details.locator(".sheet-sum")).toHaveCount(4);
  await expect(details).toContainText("crypto");
  await expect(rollup).toHaveAttribute("aria-expanded", "true");
});

test("the USD→EUR stamp renders only where the sheet converts currency", async ({ page }) => {
  await openSheet(page, FINANCE);
  await expect(page.locator(".sheet-meta")).toContainText("4 rows");
  await expect(page.locator(".sheet-meta")).not.toContainText("USD");

  await openSheet(page, WITH_FX);
  await expect(page.locator(".sheet-meta")).toContainText("USD→EUR");
});
