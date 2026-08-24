import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Evidence run only: photographs what ⌘K says about a live table selection,
// next to the bulk bar that selection already draws. Runs unchanged on a tree
// without the bulk section, so the same spec takes the before and the after.
//   SHOTS=1 SHOT_DIR=/tmp/palette-bulk-shots npx playwright test e2e/palettebulkshots.spec.ts
// One ground: the app has no runtime light theme, so every shot is the one
// theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/palette-bulk-shots";

function titleCell(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title }).locator(".db-title");
}

async function selectTwo(page: Page) {
  await page.goto("/");
  await openDb(page, "Contact");
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("2 selected");
}

test("shot: the bulk bar, and ⌘K over the same selection", async ({ page }) => {
  await selectTwo(page);

  // 1 — the bar the selection draws, on its own
  await page.locator(".bulkbar").screenshot({ path: `${OUT}/bulkbar.png` });
  // 2 — the whole table under it, so nothing is judged out of context
  await page.screenshot({ path: `${OUT}/table-selected.png` });

  // 3 — ⌘K over that selection
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette").screenshot({ path: `${OUT}/palette-selected.png` });
  await page.screenshot({ path: `${OUT}/palette-selected-full.png` });
});

test("shot: ⌘K with nothing selected", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette").screenshot({ path: `${OUT}/palette-unselected.png` });
});
