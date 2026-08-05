import { expect, test, type Page } from "@playwright/test";

// SUB-939: the summary bar under a sheet used to render every named summary as
// one flat wrap — a finance sheet with a dozen of them read as a dump, a single
// cascading error printed a row of bare `!`, and the USD→EUR stamp showed under
// sheets holding no currency at all. These specs drive the three fixes through
// the real grid: blank-line groups, one rollup chip, a conditional stamp.

// The totals row (SUB-937) absorbs every summary that describes one column, so
// the summary bar under this sheet only ever holds the leftovers — the second
// group here is deliberately made of summaries no column can claim (over other
// summaries, over two columns, a bare constant), which is what keeps the
// blank-line grouping visible at all.
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
combined_total = SUM(net_eur) + SUM(vat_eur)

studio = SUMIF(bucket, "studio", net_eur)
label = SUMIF(bucket, "label", net_eur)
months = COUNT(net_eur)
avg_month = AVG(net_eur)
best_month = MAX(net_eur)
worst_month = MIN(net_eur)
spread = best_month - worst_month
vat_rate = SUM(vat_eur) / SUM(net_eur)
ceiling = 6000
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

// SUB-1084: a chip used to render headerless, so a total could contradict the
// column it sums. value_usd groups (it carries a five-digit value), and the
// mean is a quantity divided by a count — still money.
const CHIP_FORMAT = `---
type: sheet
title: Holdings
---

\`\`\`csv
asset,value_usd
BTC,37680
HEDGE,-30280
\`\`\`

\`\`\`formulas
total = SUM(value_usd)
rows = COUNT(value_usd)
mean = SUM(value_usd) / COUNT(value_usd)
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
  await expect(page.locator(".sheet-totals")).toContainText("net_total");
  const chips = page.locator(".sheet-summary .sheet-sum");
  await expect(chips).toHaveCount(1);
  await expect(chips.nth(0)).toContainText("combined_total");
  await expect(page.locator(".sheet-sum-rest")).toHaveCount(0);

  const more = page.locator(".sheet-sum-more");
  await expect(more).toHaveText("show all (3)");
  const controlledId = await more.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const details = page.locator(`[id="${controlledId}"]`);
  await expect(details.locator(".sheet-sum")).toHaveCount(3);
  await expect(details).toContainText("vat_rate");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more).toHaveText("hide");

  await more.click();
  await expect(page.locator(".sheet-sum-rest")).toHaveCount(0);
});

test("a summary renders in the grammar of the column it aggregates (SUB-1084)", async ({
  page,
}) => {
  await openSheet(page, CHIP_FORMAT);
  // every summary here describes value_usd alone, so the totals row absorbs it
  // and the grammar claim has to hold where it now renders, not in the footer
  const val = (name: string) =>
    page.locator(".sheet-total", { hasText: name }).locator(".sheet-total-val");
  // the column groups, so the total does too — headerless it rendered "7400"
  await expect(val("total")).toHaveText("7.400");
  // a count is dimensionless: no money grammar
  await expect(val("rows")).toHaveText("2");
  // ...but it scales rather than erases, so the mean stays money
  await expect(val("mean")).toHaveText("3.700");

  // and a four-digit column keeps its bare grammar all the way up into the
  // summary: net_eur renders 4200/3100/… ungrouped (SUB-633), so its sum too
  await openSheet(page, FINANCE);
  await expect(
    page.locator(".sheet-totals .sheet-total", { hasText: "net_total" }).locator(".sheet-total-val")
  ).toHaveText("15450");
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
