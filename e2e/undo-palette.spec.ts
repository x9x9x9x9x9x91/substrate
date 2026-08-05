import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Undo had no mouse path once the toast died. The toast that carries
// an Undo button is gone after 4s, and ⌘Z was the only way back after that —
// so the palette carries the same two moves as rows, named after what they
// would take back ("Undo Role → booking").

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

async function openPalette(page: Page) {
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeVisible();
}

function paletteRow(page: Page, label: string) {
  return page.locator(".palette-item", { has: page.locator(".palette-item-label", { hasText: label }) });
}

test("with nothing done yet the palette offers no undo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openPalette(page);
  await expect(paletteRow(page, "Undo ")).toHaveCount(0);
  await expect(paletteRow(page, "Redo ")).toHaveCount(0);
});

test("the palette undoes the last edit by name, then redoes it", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cell = () => row(page, "Gero").locator("td").nth(role);
  await expect(cell()).toHaveText("mix engineer");

  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("booking");

  // the row names the move it would make, so it reads like the toast did
  await openPalette(page);
  await paletteRow(page, "Undo Role → booking").click();
  await expect(page.locator(".palette-input")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(cell()).toHaveText("mix engineer");

  // and the way forward is a row too
  await openPalette(page);
  await paletteRow(page, "Redo Role → booking").click();
  await expect(page.locator(".toast")).toContainText("Redid Role → booking");
  await expect(cell()).toHaveText("booking");
});
