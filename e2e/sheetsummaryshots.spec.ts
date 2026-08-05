import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run for the sheet summary row — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/sub939-after npx playwright test e2e/sheetsummaryshots.spec.ts
// Renders the three cases the issue names (a finance sheet with many
// summaries, one cascading error, a sheet with no currency in it) so the bar
// can be judged before and after.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub939-shots";

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
  await page.waitForTimeout(250);
}

const shots = async (page: Page, name: string) => {
  await page.screenshot({ path: `${dir}/${name}-page.png` });
  await page.locator(".sheet-summary").screenshot({ path: `${dir}/${name}-bar.png` });
};

test("shot: finance sheet with many summaries", async ({ page }) => {
  await openSheet(page, FINANCE);
  await shots(page, "finance");
  const more = page.locator(".sheet-sum-more");
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(150);
    await shots(page, "finance-expanded");
  }
});

test("shot: one collision cascading through every summary", async ({ page }) => {
  await openSheet(page, CASCADE);
  await shots(page, "cascade");
});

test("shot: sheet that does convert currency (stamp belongs here)", async ({ page }) => {
  await openSheet(page, WITH_FX);
  await shots(page, "withfx");
});
