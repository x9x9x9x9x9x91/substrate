import { test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Throwaway evidence run for the SUB-816 taste gate — not a gate itself.
//   SHOTS=1 npx playwright test e2e/onesheetshots.spec.ts
// Renders the designed templates to real PDFs (page.pdf applies the
// @media print rules) so the layout can be judged as the artifact it
// ships as, not a screenshot approximation.
test.skip(!process.env.SHOTS, "evidence run only");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // stub the hand-off so the surface stays populated for page.pdf
    window.print = () => {};
  });
});

const pdf = (page: Page, name: string) =>
  page.pdf({ path: `/tmp/onesheet-shots/${name}.pdf`, format: "A4" });

test("pdf: one-sheet with hero (Vessel Songs)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator(".db-table tbody tr", { hasText: "Vessel Songs" }).locator(".db-title").click();
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Export one-sheet…" }).click();
  await page.waitForTimeout(500);
  await pdf(page, "one-sheet-hero");
});

test("pdf: one-sheet without artwork (Slow Bloom EP)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator(".db-table tbody tr", { hasText: "Slow Bloom EP" }).locator(".db-title").click();
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Export one-sheet…" }).click();
  await page.waitForTimeout(500);
  await pdf(page, "one-sheet-no-art");
});

test("pdf: table sheet (Release database)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Export PDF…" }).click();
  await page.waitForTimeout(500);
  await pdf(page, "table-sheet-release");
});

test("pdf: table sheet, wide catalog (Catalog database)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Catalog");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Export PDF…" }).click();
  await page.waitForTimeout(500);
  await pdf(page, "table-sheet-catalog");
});
