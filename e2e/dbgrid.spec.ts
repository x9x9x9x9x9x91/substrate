import { expect, test, type Page } from "@playwright/test";
import { settingsTab } from "./settings";
import { openDb } from "./nav";

// Vertical grid lines in database tables. Default ON via the global
// `db-grid` setting; a database's ⋯ menu pins an override on its ViewPref
// (`grid`), which wins over the global and clears itself when toggled back
// to the global value. Runs against the deterministic mock backend.

function gridTable(page: Page) {
  return page.locator(".db-table.db-grid");
}

async function toggleViaMenu(page: Page, label: RegExp) {
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: label }).click();
}

test("grid lines are on by default and a database can opt out; the choice persists", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(gridTable(page)).toBeVisible();

  // the ⋯ menu states the action: grid is on, so it offers to hide
  await toggleViaMenu(page, /Hide grid lines/);
  await expect(gridTable(page)).toHaveCount(0);
  await expect(page.locator(".db-table")).toBeVisible();

  // the override rides the ViewPref channel — it survives navigating away
  await openDb(page, "Gear");
  await expect(gridTable(page)).toBeVisible();
  await openDb(page, "Release");
  await expect(gridTable(page)).toHaveCount(0);

  // and back on: the menu now offers to show
  await toggleViaMenu(page, /Show grid lines/);
  await expect(gridTable(page)).toBeVisible();
});

test("the global setting turns grids off everywhere, but a database override wins (SUB-607)", async ({
  page,
}) => {
  // the settings toggle writes Settings.md; the watcher echo is what re-reads
  // the flag — the mock mirrors that cadence on request, the same opt-in
  // own-write echo the editor's own-echo test drives
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));

  await page.keyboard.press("Meta+,");
  await settingsTab(page, "appearance");
  const row = page.locator(".settings-row", { hasText: "Table grid lines" });
  await expect(row).toBeVisible();
  const sw = row.locator(".settings-switch");
  // default ON — the switch reads as enabled before anyone touches it
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  // once the echo lands, tables everywhere drop the grid
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(gridTable(page)).toHaveCount(0);

  // a per-database "Show grid lines" beats the global off
  await toggleViaMenu(page, /Show grid lines/);
  await expect(gridTable(page)).toBeVisible();
  await openDb(page, "Gear");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(gridTable(page)).toHaveCount(0);
});
