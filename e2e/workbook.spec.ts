import { expect, test, type Page } from "./fixtures";

// Workbook pages: a dashboard with a `pages:` frontmatter list
// renders an Excel-style tab strip at the bottom of the pane. Fixture:
// Dashboards/Label Books.md (src/lib/tauri.ts) — metrics page 0 (one card
// bound to Cash.cash_total), a sheet page (Cash), a view page (release
// status:live), and a deliberately broken entry. Mock backend.

async function openWorkbook(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".wb-tabs")).toBeVisible();
}

test("tab strip renders all pages, page 0 is the note's own metrics kind", async ({ page }) => {
  await openWorkbook(page);
  const tabs = page.locator(".wb-tab");
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toHaveText("Overview");
  await expect(tabs.nth(1)).toHaveText("Cash");
  await expect(tabs.nth(2)).toHaveText("Releases");
  await expect(tabs.nth(3)).toHaveText("Broken");
  await expect(tabs.nth(0)).toHaveClass(/active/);
  // page 0 = the metrics dashboard itself
  await expect(page.locator(".dash-card .dash-label", { hasText: "Cash total" })).toBeVisible();
});

test("a note page renders the editable sheet grid", async ({ page }) => {
  await openWorkbook(page);
  await page.locator(".wb-tab", { hasText: "Cash" }).click();
  // the Cash sheet's grid, editable — its csv fence has Nordkasse / Brokerhaus
  await expect(page.locator(".sheet")).toBeVisible();
  await expect(page.locator(".sheet-cell", { hasText: "Nordkasse" })).toBeVisible();
});

test("a view page renders the database cut read-only with click-through", async ({ page }) => {
  await openWorkbook(page);
  await page.locator(".wb-tab", { hasText: "Releases" }).click();
  const table = page.locator(".wb-view-table");
  await expect(table).toBeVisible();
  // live releases from the mock vault land as rows (Static Bouquet is live)
  await expect(table.locator(".dash-link", { hasText: "Static Bouquet" })).toBeVisible();
  // row count in the head
  await expect(page.locator(".dash-state")).toContainText("rows");
});

test("a view page accepts YAML-list columns with the natural Title leader", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.__mockEditProp?.("Dashboards/Label Books.md", "pages", [
      {
        label: "Projection",
        view: "release",
        query: "status:live",
        columns: ["title", "artist"],
      },
    ]);
    window.__mockEmit?.("vault:changed");
  });

  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await page.locator(".wb-tab", { hasText: "Projection" }).click();
  await expect(page.locator(".note .dash-alert")).toHaveCount(0);
  await expect(page.locator(".wb-view-table thead th")).toHaveText(["Title", "artist"]);
  await expect(page.locator(".wb-view-table .dash-link", { hasText: "Static Bouquet" })).toBeVisible();
});

test("a broken entry is an error page in place — siblings unaffected", async ({ page }) => {
  await openWorkbook(page);
  await page.locator(".wb-tab", { hasText: "Broken" }).click();
  await expect(page.locator(".note .dash-alert")).toContainText("No Such Sheet");
  // switching back still works
  await page.locator(".wb-tab", { hasText: "Cash" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
});

test("⌃⇥ / ⌃⇧⇥ steps pages, wrapping", async ({ page }) => {
  await openWorkbook(page);
  await page.keyboard.press("Control+Tab");
  await expect(page.locator(".wb-tab", { hasText: "Cash" })).toHaveClass(/active/);
  await page.keyboard.press("Control+Shift+Tab");
  await page.keyboard.press("Control+Shift+Tab");
  // wrapped backwards from page 0 to the last tab
  await expect(page.locator(".wb-tab", { hasText: "Broken" })).toHaveClass(/active/);
});

test("dashboards without pages: keep the plain pane — no strip", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");
  await expect(page.locator(".wb-tabs")).toHaveCount(0);
});
