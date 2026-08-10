import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// number property kind: a schema'd number prop with euro format
// renders German-style (dot thousands, comma decimals — decimals only when
// the value has them, trailing " €") and right-aligned; editing shows and
// saves the raw stored string; junk values render exactly as typed.
// Fixtures: the inventory schema carries `price` (number, euro) — 11 numeric
// rows (199.5, 336, 747, 884.5, 1021, 1295, 1432, 1569.5, 1843, 1980, 2117),
// one junk row ("ask" on Pellas RP-2), three empty (src/lib/tauri.ts).

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
});

test("euro column renders German-formatted and right-aligned (SUB-188)", async ({ page }) => {
  // thousands get the dot, decimals the comma — integers stay decimal-free
  await expect(page.locator(".db-cell-txt.cell-num", { hasText: "1.295 €" })).toHaveCount(1);
  await expect(page.locator(".db-cell-txt.cell-num", { hasText: "199,50 €" })).toHaveCount(1);
  await expect(page.locator(".db-cell-txt.cell-num", { hasText: "336 €" })).toHaveCount(1);
  await expect(page.locator(".db-cell-txt.cell-num", { hasText: "1.569,50 €" })).toHaveCount(1);
  // numbers column-scan: every price cell right-aligns, text cells don't
  const cell = page.locator(".db-cell-txt.cell-num", { hasText: "1.295 €" });
  await expect(cell).toHaveCSS("text-align", "right");
  await expect(page.locator(".db-cell-txt.cell-num")).toHaveCount(15);
  await expect(page.locator(".db-title-txt").first()).not.toHaveCSS("text-align", "right");
});

test("editing a number cell shows the raw stored string and saves (SUB-188)", async ({ page }) => {
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }) });
  await expect(row.locator(".cell-num")).toHaveText("199,50 €");
  await row.locator(".cell-num").click();

  // the picker lists values in use raw — "199.5", never "199,50 €"
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("199.5");
  await expect(menu).not.toContainText("199,50 €");

  // type a new raw value, Enter commits — the cell re-renders formatted
  await menu.locator(".selmenu-input").fill("2599");
  await menu.locator(".selmenu-input").press("Enter");
  await expect(row.locator(".cell-num")).toHaveText("2.599 €");

  // re-navigate: the write persisted through the mock backend
  await openDb(page, "Contact");
  await openDb(page, "Inventory");
  await expect(row.locator(".cell-num")).toHaveText("2.599 €");
});

test("junk and empty number values render exactly as typed (SUB-188)", async ({ page }) => {
  // "ask" is not numeric — no € attached, no hiding, no mangling
  const junkRow = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Pellas RP-2" }) });
  await expect(junkRow.locator(".cell-num")).toHaveText("ask");
  // empty rows render an empty cell, not a placeholder
  const emptyRow = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Monocord 64" }) });
  await expect(emptyRow.locator(".cell-num")).toHaveText("");
});

test("note chip shows the formatted value (SUB-188)", async ({ page }) => {
  await page.locator(".db-title-txt", { hasText: "Falke F-3" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Falke F-3");

  const chip = page.locator(".chip", { hasText: "price" });
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chip-val")).toHaveText("1.295 €");
});
