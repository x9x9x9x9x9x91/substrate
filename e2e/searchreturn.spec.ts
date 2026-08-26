import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// A search hit opens in its home context — its database's side
// split, else its folder view, else All notes — and one Esc from there
// returns to the search with query and picked row intact. The stash is
// one-shot: navigation or the return itself spends it.

async function openSearch(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
}

test("a db entry hit lands in its database, Esc returns to the results", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("lisbon");
  await expect(page.locator(".search-note-row", { hasText: "Gero" })).toBeVisible();
  await page.keyboard.press("Enter");
  // home context: the Contact database with Gero open in the side split
  await expect(page.locator(".list-title")).toHaveText("Contact");
  await expect(page.locator(".db-note")).toBeVisible();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");

  await page.keyboard.press("Escape");
  // back in the search: query and the picked row intact
  await expect(page.locator(".search-input")).toHaveValue("lisbon");
  await expect(page.locator(".search-note-row.selected")).toContainText("Gero");
  // Esc in the search leaves to the pre-search view, not the detour
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-pane")).toHaveCount(0);
});

// Leaving the search WITHOUT picking a hit puts back what was there,
// side split included — a database's open entry lives in dbNote alone, so a
// stash of view+selected would land back in the grid with the note gone.
test("Esc out of a search restores the database's open side note", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");

  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(page.locator(".search-pane")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("Contact");
  await expect(page.locator(".db-note")).toBeVisible();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");
});

// The same widen for ⌫. A search hit landing somewhere new bridges
// the detour into the view history — that entry has to carry the database's
// open note too, or walking back lands in the grid with the side split shut.
test("⌫ back into a database restores its open side note", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");

  // leave via a search hit that lands in a different view — the bridge push
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill("inbox");
  const hit = page.locator(".search-note-row", { hasText: "Capture anything" });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");

  // ⌫ from a list surface (not a text edit) walks back to the database
  await page.locator(".list .row", { hasText: "Capture anything" }).click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".list-title")).toHaveText("Contact");
  await expect(page.locator(".db-note")).toBeVisible();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");
});

test("a folder note hit lands in its folder view", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("inbox");
  const hit = page.locator(".search-note-row", { hasText: "Capture anything" });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-input")).toHaveValue("inbox");
});

test("a root note hit lands in All notes; navigating spends the return", async ({ page }) => {
  await openSearch(page);
  await page.locator(".search-input").fill("inbox");
  const hit = page.locator(".search-note-row", { hasText: "Welcome" });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  // selecting another note spends the stash — plain Esc must not jump back
  await page.locator(".row", { hasText: "Capture anything" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-pane")).toHaveCount(0);
});
