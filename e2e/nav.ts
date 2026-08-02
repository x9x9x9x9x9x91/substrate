import { expect, type Page } from "@playwright/test";

// Database navigation after SUB-159: the sidebar's flat Databases section
// (homeless dbs only) is gone — every database, homed or homeless, zero-note
// included, opens from the All databases manager.
export async function openDb(page: Page, name: string) {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  // the header proves the view swapped in any layout (a board/gallery pref
  // persists per page — a .db-table wait would lie there)
  await expect(page.locator(".list-title")).toHaveText(name);
}

// The database filter row is on-demand: an empty one only renders after the
// funnel toggle (a query/focus/the naming flow keep it on screen). Specs
// that type a filter open it here first.
export async function openFilter(page: Page) {
  const input = page.locator(".db-filter-input");
  if ((await input.count()) === 0) {
    await page.locator(".db-filter-toggle").click();
  }
  await expect(input).toBeVisible();
  return input;
}
