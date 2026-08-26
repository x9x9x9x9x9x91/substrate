import { expect, test, type Page } from "./fixtures";

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

// "+ row" opens a row the note does not carry yet: nothing is written until a
// cell is filled, so tapping it and walking away can no longer leave a row of
// blanks behind — the shape that made per-row formulas derive over empty
// cells and took a dashboard card down. The row still has to LOOK like a row:
// with every cell empty there is no text to give it height.
test("+ row: a placeholder row, full height, written only once a cell is filled", async ({
  page,
}) => {
  await openSheet(page);
  const rows = page.locator(".sheet-table tbody tr");
  const dataRow = rows.nth(3); // ETH, the last row the note carries
  const dataHeight = (await dataRow.boundingBox())!.height;

  await page.locator(".sheet-addrow button", { hasText: "+ row" }).click();
  const placeholder = rows.nth(4);
  await expect(placeholder.locator(".sheet-cell").first()).toHaveText("");
  // the derived columns stay blank rather than deriving over the empty cells
  await expect(placeholder.locator(".sheet-cell.sheet-computed").first()).toHaveText("");
  const placeholderHeight = (await placeholder.boundingBox())!.height;
  expect(Math.abs(placeholderHeight - dataHeight)).toBeLessThanOrEqual(1);

  // nothing was written: the source still ends at the row the note carries
  await page.locator(".sheet-toolbar .sheet-tool[title='View note source']").click();
  await expect(page.locator(".sheet-src")).toContainText("ETH,crypto,9,3050");
  await expect(page.locator(".sheet-src .cm-content")).not.toContainText("\n,,,\n");
});
