import { expect, test, type Page } from "@playwright/test";

// SUB-292: SheetGrid's vim-nav keydown mapped k/h/j/l without checking
// modifiers — e.key is "k" for ⌘K too — and stop()'d the event, so a focused
// grid cell swallowed ⌘K before App's window-level palette listener saw it.

// cold open lands on Today (SUB-92) — open the seeded sheet through the palette
async function openSheet(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();
}

// nth cell of a data row — data cells lead each row, computed trail them
function cell(page: Page, r: number, c: number) {
  return page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);
}

test("⌘K reaches the palette from a focused grid cell; bare k still navs (SUB-292)", async ({
  page,
}) => {
  await openSheet(page);

  // focus a data cell — a click lands DOM focus on the cell div
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toHaveClass(/focused/);
  await expect(cell(page, 1, 0)).toBeFocused();

  // ⌃K matches nothing at app level (the palette is ⌘-only) and must not be
  // read as vim `k` either: the cursor stays put, no palette opens
  await page.keyboard.press("Control+k");
  await expect(cell(page, 1, 0)).toHaveClass(/focused/);
  await expect(page.locator(".palette")).toHaveCount(0);

  // ⌘K bubbles past the grid to App's palette listener
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeVisible();

  // close it again — the palette closes on a 90ms timer (Palette.tsx close),
  // so wait for the overlay to really leave
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toHaveCount(0);

  // bare-letter vim nav is untouched: k moves the cell cursor up a row
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toBeFocused();
  await page.keyboard.press("k");
  await expect(cell(page, 0, 0)).toHaveClass(/focused/);
  await expect(cell(page, 0, 0)).toBeFocused();
});
