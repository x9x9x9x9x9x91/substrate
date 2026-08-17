import { expect, test } from "@playwright/test";

// Growing a rendered table: the "+" on its right edge adds a column, the one
// under it adds a row, and the cursor lands in the cell that just appeared.
// Before this, editing a table meant typing pipes by hand.

const NOTE = "Inbox/Capture anything.md";

/** Type a small table on a fresh last line and step off it so the widget
    renders — the source stays visible while the cursor is inside it. */
async function typeTable(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("| Track | Length |\n| --- | --- |\n| Slug It Out | 6:12 |");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table")).toBeVisible();
}

test("the row button adds an empty row and puts the cursor in it", async ({ page }) => {
  await typeTable(page);
  const table = page.locator(".cm-md-table").last();
  await expect(table.locator("tbody tr")).toHaveCount(1);

  await page.locator(".cm-md-table-add-row").click();

  // the cursor is inside the table now, so it shows as source — the new row is
  // the last line, and typing lands in its first cell without moving anything
  await page.keyboard.type("Nod");
  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("| Slug It Out | 6:12 |\n| Nod |  |");

  // step off and the grid has grown by exactly one row
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-md-table").last().locator("tbody tr")).toHaveCount(2);
});

test("the column button adds a column to every row, cursor in the new header", async ({ page }) => {
  await typeTable(page);
  await expect(page.locator(".cm-md-table").last().locator("th")).toHaveCount(2);

  await page.locator(".cm-md-table-add-column").click();
  await page.keyboard.type("BPM");

  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("| Track | Length | BPM |\n| --- | --- | --- |\n| Slug It Out | 6:12 |  |");

  await page.keyboard.press("Meta+ArrowUp");
  const table = page.locator(".cm-md-table").last();
  await expect(table.locator("th")).toHaveCount(3);
  await expect(table.locator("th").last()).toHaveText("BPM");
  await expect(table.locator("tbody tr td")).toHaveCount(3);
});

test("one undo takes the added row back out", async ({ page }) => {
  await typeTable(page);
  await page.locator(".cm-md-table-add-row").click();
  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("| Slug It Out | 6:12 |\n|  |  |");

  await page.keyboard.press("Meta+z");
  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .not.toContain("| Slug It Out | 6:12 |\n|  |  |");
});
