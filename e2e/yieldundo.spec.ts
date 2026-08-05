import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Yield board undo history: ⌘Z / ⌘⇧Z step board mutations —
// snapshot adds and claims — through the same write paths the mutations
// used, so the csv body and the claimed_usd prop stay in step.
// Runs against the deterministic mock Yield APR fixture (14 rows, last 232).

async function openYield(page: Page) {
  await page.locator(".side-item", { hasText: "Yield APR" }).click();
  await expect(page.locator(".dash-add")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openYield(page);
});

const lastRow = (page: import("@playwright/test").Page) =>
  page.locator(".dash-table tbody tr").first(); // table renders newest first

test("⌘Z removes an added snapshot, ⌘⇧Z brings it back", async ({ page }) => {
  await page.locator(".dash-form input").nth(1).fill("250");
  await page.locator(".dash-add").click();
  await expect(lastRow(page)).toContainText("250,00 $");

  await page.keyboard.press("Meta+z");
  await expect(lastRow(page)).toContainText("232,00 $");

  await page.keyboard.press("Meta+Shift+z");
  await expect(lastRow(page)).toContainText("250,00 $");
});

test("⌘Z reverts a claim — the claimed split leaves the Accrued metric", async ({ page }) => {
  const accrued = page.locator(".dash-metric", { hasText: "Accrued" });
  // two-click claim
  await page.locator(".dash-claim").click();
  await page.locator(".dash-claim").click();
  await expect(accrued).toContainText("claimed");

  await page.keyboard.press("Meta+z");
  await expect(accrued).not.toContainText("claimed");
  await expect(page.locator(".dash-claim")).toBeEnabled();

  await page.keyboard.press("Meta+Shift+z");
  await expect(accrued).toContainText("claimed");
});

// The two ⌘Z owners used to both answer one press. App's window
// listener registers first (bubble phase, at mount), so the board's
// preventDefault could not suppress it: one keystroke rewrote the board note
// AND undid an unrelated session edit, toasting only the latter. The registry
// entries now gate on live board history. The earlier specs miss this because
// their session stack is empty — this one seeds it first.
test("⌘Z on the board leaves the session undo stack alone", async ({ page }) => {
  // seed a session entry: a property edit on an unrelated note
  await openDb(page, "Contact");
  const role = await page
    .locator(".db-table thead th")
    .evaluateAll((ths) =>
      ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith("role"))
    );
  const cell = () => page.locator(".db-table tbody tr", { hasText: "Gero" }).locator("td").nth(role);
  await expect(cell()).toHaveText("mix engineer");
  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell()).toHaveText("booking");

  // onto the board, and add a snapshot by CLICKING — the click leaves focus on
  // .dash-add, a non-typing target, which is exactly the collision case
  await openYield(page);
  await page.locator(".dash-form input").nth(1).fill("250");
  await page.locator(".dash-add").click();
  await expect(lastRow(page)).toContainText("250,00 $");

  await page.keyboard.press("Meta+z");
  // the board's own stack answered...
  await expect(lastRow(page)).toContainText("232,00 $");
  // ...and only it: no session-undo toast, because the entry never ran
  await expect(page.locator(".toast")).toHaveCount(0);

  // the unrelated note's property is untouched — one keystroke, one file
  await openDb(page, "Contact");
  await expect(cell()).toHaveText("booking");
});

test("⌘Z on a fresh board falls through to session undo (SUB-726)", async ({ page }) => {
  // Seed a session entry, then remount Yield without making a board edit.
  await openDb(page, "Contact");
  const role = await page
    .locator(".db-table thead th")
    .evaluateAll((ths) =>
      ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith("role"))
    );
  const cell = () => page.locator(".db-table tbody tr", { hasText: "Gero" }).locator("td").nth(role);
  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell()).toHaveText("booking");

  await openYield(page);
  await page.keyboard.press("Meta+z");

  await openDb(page, "Contact");
  await expect(cell()).toHaveText("mix engineer");
});

test("undo works with focus still in the cleared form field", async ({ page }) => {
  const yieldInput = page.locator(".dash-form input").nth(1);
  await yieldInput.fill("250");
  await yieldInput.press("Enter");
  await expect(lastRow(page)).toContainText("250,00 $");
  // Enter left focus in the (now empty) input — ⌘Z must undo the ADD
  await page.keyboard.press("Meta+z");
  await expect(lastRow(page)).toContainText("232,00 $");
});
