import { expect, test, type Page } from "@playwright/test";

// Sheet row/column delete + reorder via context menu. The mock's
// Holdings sheet: data columns asset,bucket,units,price_usd; rows GLOW,
// BTC, ARC, ETH; computed value_usd/value_eur.

async function openSheet(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();
}

function cell(page: Page, r: number, c: number) {
  return page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);
}

test("row menu: move down swaps neighbors, delete removes the row", async ({ page }) => {
  await openSheet(page);
  await expect(cell(page, 0, 0)).toHaveText("GLOW");

  await cell(page, 0, 0).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move down" }).click();
  await expect(cell(page, 0, 0)).toHaveText("BTC");
  await expect(cell(page, 1, 0)).toHaveText("GLOW");

  // first row's Move up is disabled
  await cell(page, 0, 0).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await page.keyboard.press("Escape");

  await cell(page, 0, 0).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete row" }).click();
  await expect(cell(page, 0, 0)).toHaveText("GLOW");
  await expect(page.locator(".sheet-meta")).toContainText("3 rows");
});

test("column menu: move right swaps columns with cells, delete drops the column", async ({
  page,
}) => {
  await openSheet(page);
  const headers = page.locator(".sheet-table thead th");
  await expect(headers.nth(0)).toHaveText("asset");

  await headers.nth(0).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move right" }).click();
  await expect(headers.nth(0)).toHaveText("bucket");
  await expect(headers.nth(1)).toHaveText("asset");
  await expect(cell(page, 0, 0)).toHaveText("etf");
  await expect(cell(page, 0, 1)).toHaveText("GLOW");

  await headers.nth(0).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete column" }).click();
  await expect(headers.nth(0)).toHaveText("asset");
  // computed columns still evaluate (bucket only fed SUMIF summaries)
  await expect(cell(page, 0, 0)).toHaveText("GLOW");
});

test("computed header menu: delete removes the formula column", async ({ page }) => {
  await openSheet(page);
  const computed = page.locator(".sheet-table thead th.sheet-computed");
  await expect(computed).toHaveCount(2);

  await computed.nth(1).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete column" }).click();
  await expect(computed).toHaveCount(1);
  await expect(computed.nth(0)).toHaveText("value_usd");
});
