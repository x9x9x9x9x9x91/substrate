import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Designed PDF templates: "Export one-sheet…" in the note menus
// builds the hero/facts/body layout into #print-surface; "Export PDF…" in a
// database's ⋯ menu prints the view as the table sheet. Same print
// mechanism as the generic note export — window.print is stubbed (the mock
// backend runs the dev-browser path) and the print-media pass is emulated.
// Fixtures (src/lib/tauri.ts): Vessel Songs carries a body embed of
// vessel-artwork.svg (a stored mock asset) so its one-sheet has a hero; the
// Release database backs the table sheet.

const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls);

const expectPrinted = async (page: Page) => {
  await expect.poll(() => printCalls(page)).toBe(1);
};

test.beforeEach(async ({ page }) => {
  // stub the hand-off: no dialog blocks, and afterprint never fires so the
  // surface stays populated for the assertions
  await page.addInitScript(() => {
    const w = window as unknown as { __printCalls: number };
    w.__printCalls = 0;
    window.print = () => {
      w.__printCalls += 1;
    };
  });
});

test("note one-sheet: hero, byline, fact rows and body fill the surface", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page
    .locator(".db-table tbody tr", { hasText: "Vessel Songs" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Vessel Songs");
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Export one-sheet…" }).click();

  const sheet = page.locator("#print-surface .print-onesheet");
  await expect(sheet).toHaveCount(1);
  await expect(sheet.locator(".os-title")).toHaveText("Vessel Songs");
  await expect(sheet.locator(".os-byline")).toHaveText("1k petals");
  // the artwork hero resolved from the body embed — and was hoisted, so the
  // body carries no second copy of it
  await expect(sheet.locator(".os-art")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await expect(sheet.locator(".os-body img")).toHaveCount(0);
  // press facts as label/value rows, catalog data present
  await expect(sheet.locator(".os-fact-label").first()).toHaveText("status");
  await expect(sheet.locator(".os-fact-value").first()).toHaveText("mastering");
  await expect(sheet.locator(".os-fact-value", { hasText: "SMP-029" })).toHaveCount(1);
  await expectPrinted(page);

  // the print-media pass: the sheet replaces the app
  await page.emulateMedia({ media: "print" });
  await expect(sheet.locator(".os-title")).toBeVisible();
  await expect(page.locator("#root")).toBeHidden();
});

test("database table sheet: the view's columns and rows print as the designed listing", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Export PDF…" }).click();

  const sheet = page.locator("#print-surface .print-sheet");
  await expect(sheet).toHaveCount(1);
  await expect(sheet.locator(".ts-title")).toHaveText("Release");
  await expect(sheet.locator(".ts-meta")).toContainText("entries");
  await expect(sheet.locator("th.ts-name")).toHaveText("Name");
  await expect(sheet.locator("td.ts-name", { hasText: "Vessel Songs" })).toHaveCount(1);
  await expectPrinted(page);

  await page.emulateMedia({ media: "print" });
  await expect(sheet.locator(".ts-title")).toBeVisible();
  // designed listing: rows separate on hairlines, not the generic bordered grid
  const td = sheet.locator("td.ts-name", { hasText: "Vessel Songs" });
  await expect(td).toHaveCSS("border-left-width", "0px");
  await expect(page.locator("#root")).toBeHidden();
});
