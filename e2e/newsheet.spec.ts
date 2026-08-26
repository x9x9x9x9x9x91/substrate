import { expect, test } from "./fixtures";

// "New sheet" palette command — sheets are surfaces (no database),
// so the palette is their creation front door. The typed query becomes the
// title; the fresh sheet opens on its empty-grid state ("+ column" starts
// the csv block).

test("palette New sheet: query becomes the title, grid opens empty", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("Body Log");
  const cmd = page.locator(".palette-item", { hasText: "New sheet" });
  await expect(cmd).toContainText("New sheet “Body Log”");
  await cmd.click();

  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".note-title")).toHaveValue("Body Log");
  // empty state rides the shared shell — glyph, line, and the
  // grid starter — so the assertion is on `.empty`, not the bare pane class
  const sheetEmpty = page.locator(".empty.sheet-empty");
  await expect(sheetEmpty).toBeVisible();
  await expect(sheetEmpty.locator("svg")).toHaveCount(1);
  await expect(sheetEmpty.locator(".empty-hint")).toContainText("Add a column");
  await sheetEmpty.locator(".sheet-tool", { hasText: "+ column" }).click();
  await page.locator(".sheet-addcol-input").fill("weight_kg");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-table th", { hasText: "weight_kg" })).toBeVisible();
});

test("New sheet in a folder view lands the sheet in that folder", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  // open a plain folder from the mock's tree
  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Budget");
  await page.locator(".palette-item", { hasText: "New sheet" }).click();

  await expect(page.locator(".note-title")).toHaveValue("Budget");
  await expect(page.locator(".empty.sheet-empty")).toBeVisible();
});
