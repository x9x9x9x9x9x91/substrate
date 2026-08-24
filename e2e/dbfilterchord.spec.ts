import { expect, test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// ⌘F is the pane's find: it opens the on-demand filter row and puts the caret
// in it, so the next thing typed narrows the rows. The row is ephemeral — the
// query is pane state and only saving a view writes anything — so this is a
// keyboard route to what the funnel toggle already did, on every tab and every
// layout the pane has. Escape keeps its old job (clear, then close).

/** The chord, as the browser delivers it on either platform. */
async function findChord(page: import("@playwright/test").Page) {
  await page.keyboard.press("ControlOrMeta+f");
}

test("⌘F opens the filter row focused on the All tab, and narrows as you type", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  // the row starts closed — nothing typed, nothing focused
  await expect(page.locator(".db-filter-input")).toHaveCount(0);

  await findChord(page);
  const input = page.locator(".db-filter-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  await page.keyboard.type("status:live ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  // Escape still clears the query first, exactly as before the chord existed
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
});

test("⌘F reaches the filter in every layout", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  for (const layout of ["Board", "Gallery", "List", "Table"]) {
    await page.locator(`.db-layouts button[aria-label="${layout}"]`).click();
    await findChord(page);
    const input = page.locator(".db-filter-input");
    await expect(input, layout).toBeFocused();
    // close it again, so the next layout starts from a shut row
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
});

test("⌘F opens the filter inside a saved view's tab", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  // saving stays on the current tab; enter the pin through its own tab
  await page.locator(".db-tab", { hasText: "Live releases" }).click();
  await expect(page.locator(".db-tab.active")).toContainText("Live releases");

  // leave the row: Escape clears the pin's query, a second closes the row —
  // both handled by the input, so the caret goes there first (the tab click
  // parked focus on the tab button)
  await page.locator(".db-filter-input").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".db-filter-input")).toHaveCount(0);

  await findChord(page);
  await expect(page.locator(".db-filter-input")).toBeFocused();
  // still inside the pin, not bounced back to All
  await expect(page.locator(".db-tab.active")).toContainText("Live releases");
});

test("⌘F in a note's editor stays the editor's find, not the pane's", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  const editor = page.locator(".db-note .cm-content");
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");
  await editor.click();

  // same two-step the accent evidence run uses: ControlOrMeta is the portable
  // spelling, and a host that maps it the other way gets the ⌘ press
  const panel = page.locator(".db-note .cm-panel.cm-search");
  await findChord(page);
  if ((await panel.count()) === 0) await page.keyboard.press("Meta+f");
  // CodeMirror's search panel took it; the pane's row stayed shut
  await expect(panel, "the editor's search panel never opened").toBeVisible();
  await expect(page.locator(".db-filter-input")).toHaveCount(0);
});
