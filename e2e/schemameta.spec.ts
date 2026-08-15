import { expect, test, type Page } from "@playwright/test";
import { openFilter } from "./nav";

// The zhome fixture's schema entry carries the reserved db-level icon/home
// keys exactly like a real schema.json. Two contracts ride on it:
//  (1) anything iterating a type's schema entries must skip non-prop values —
//      0.8.0 shipped a filterHint loop that did `schema.options[0]` on the
//      icon entry and blanked every db view on vaults with db icons;
//  (2) a homed db's saved views stay OUT of the sidebar tree —
//      they live as tabs inside the database view only.

async function openZhome(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  // the homed db's tree row keeps its FOLDER name, db icon + chip
  const row = page.locator(".side-folder", { hasText: "ZHome" });
  await expect(row).toHaveCount(1);
  await row.click();
  // the on-demand filter row opens via the toolbar's funnel
  await openFilter(page);
}

test("db pane renders when the schema carries icon/home metadata (0.8.0 crash)", async ({
  page,
}) => {
  await openZhome(page);
  // the pane, its rows and the schema-derived placeholder all render — before
  // the fix this whole tree unmounted on the icon entry
  await expect(page.locator(".db-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".db-filter-input")).toHaveAttribute(
    "placeholder",
    "Filter — try status:Active or folder:"
  );
});

test("a homed db's saved views stay out of the sidebar; the tab strip owns them (SUB-391)", async ({
  page,
}) => {
  await openZhome(page);

  // pin a filter — NO sidebar pin appears (no nested row, no section); the
  // saved view lands as a tab on the database instead
  await page.locator(".db-filter-input").fill("status:Active ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Active ones");
  await nameInput.press("Enter");
  await expect(page.locator(".db-tab", { hasText: "Active ones" })).toHaveCount(1);
  await expect(page.locator(".side-view")).toHaveCount(0);
  await expect(page.locator(".side-label-row", { hasText: "Saved views" })).toHaveCount(0);

  // opening the pin's tab renders the saved pane (this path hit the same
  // 0.8.0 crash) — the db title stays the db's, the pin rides the active tab
  // with its ⌘-digit (the tab is this pin's ONLY row anywhere)
  await page.locator(".db-tab", { hasText: "Active ones" }).click();
  await expect(page.locator(".list-title")).toHaveText("Zhome");
  await expect(page.locator(".db-tab.active")).toHaveText("Active ones⌘5");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(1);

  // leave to another view and come back through the sidebar row — the pin
  // survives as a tab, the sidebar stays pin-free
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".side-folder", { hasText: "ZHome" }).click();
  await expect(page.locator(".db-tab", { hasText: "Active ones" })).toHaveCount(1);
  await expect(page.locator(".side-view")).toHaveCount(0);
});
