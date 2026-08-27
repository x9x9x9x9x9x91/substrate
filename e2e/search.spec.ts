import { expect, test, type Page } from "./fixtures";

// Search pane flows against the mock backend (src/lib/tauri.ts — active
// whenever the app runs outside Tauri). The pane opens globally with ⌘⇧F.

async function openSearch(page: Page) {
  await page.goto("/");
  // the shortcut listener attaches on mount — key too early and it's lost
  await expect(page.locator(".side-item", { hasText: /^Scratch/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
}

test("zero results: single query-aware empty state, no stats bar (SUB-140)", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("zzqxwv");
  await expect(page.locator(".search-pane .empty")).toContainText("No results for “zzqxwv”");
  await expect(page.locator(".search-stats")).toHaveCount(0);
});

test("stats bar appears once results exist (SUB-140)", async ({ page }) => {
  await openSearch(page);
  // only Gero's body mentions Lisbon — one match in one note
  await page.locator(".search-input").fill("lisbon");
  await expect(page.locator(".search-stats")).toHaveText("1 match in 1 note");
});

test("machine-fence config lines are not content matches (SUB-261)", async ({ page }) => {
  await openSearch(page);
  // the Umbra hub mentions "mastering" ONLY inside its ```view fence
  // (query: status:mastering) — a filter definition, not prose
  await page.locator(".search-input").fill("mastering");
  await expect(page.locator(".search-group", { hasText: "Umbra" })).toHaveCount(0);
});

test("group header: type for db notes, no slot for loose notes (SUB-141)", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("lisbon");
  const group = page.locator(".search-group", { hasText: "Gero" });
  // capitalized like folder names — one taxonomy in the slot
  await expect(group.locator(".search-note-hint")).toHaveText("Contact");

  // Welcome and Capture anything are both loose notes — no hint slot at all,
  // even though Capture anything sits in the Inbox folder
  await page.locator(".search-input").fill("inbox");
  await expect(page.locator(".search-note-hint")).toHaveCount(0);
});

test("result rows carry the note context menu (SUB-378)", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("lisbon");
  const row = page.locator(".search-note-row", { hasText: "Gero" });
  await row.click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ctx-item", { hasText: "Move to folder" })).toBeVisible();
  await expect(menu.locator(".ctx-item", { hasText: "Move to Trash" })).toBeVisible();
  // Esc closes the menu without disturbing the search pane
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".search-note-row", { hasText: "Gero" })).toBeVisible();
});

test("a property-only hit shows the value that matched (SUB-1222)", async ({ page }) => {
  await openSearch(page);
  // "1k petals" is the artist prop on Vessel Songs — its body never says it
  await page.locator(".search-input").fill("petals");
  const group = page.locator(".search-group", { hasText: "Vessel Songs" });
  await expect(group).toBeVisible();
  const prop = group.locator(".search-prop-row");
  await expect(prop.locator(".search-prop-label")).toHaveText("properties");
  await expect(prop.locator("mark").first()).toHaveText(/petals/i);
  // it explains the hit, it does not pretend to be a line in the file
  await expect(group.locator(".search-match-row")).toHaveCount(0);

  // a body hit explains itself — no property row over it
  await page.locator(".search-input").fill("lisbon");
  await expect(page.locator(".search-group", { hasText: "Gero" })).toBeVisible();
  await expect(page.locator(".search-prop-row")).toHaveCount(0);
});
