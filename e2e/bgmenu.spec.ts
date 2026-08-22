import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Right-click on empty space answers with a contextual create menu
// instead of falling through to the webview's stock Reload menu. Rows, chips
// and cards keep their own menus — they preventDefault first, and the
// background handlers stand down on e.defaultPrevented.

function ctxItem(page: Page, label: string | RegExp) {
  return page.locator(".ctx-item", { hasText: label });
}

test("list background: New note creates a scratch note in the open folder", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Ideas");

  // the pane's whitespace below the rows, not a row
  await page.locator(".list-body").click({ button: "right", position: { x: 40, y: 380 } });
  await expect(ctxItem(page, "New note")).toBeVisible();
  await expect(ctxItem(page, "New subfolder…")).toBeVisible();
  await expect(ctxItem(page, "Reveal in Finder")).toBeVisible();
  await ctxItem(page, "New note").click();

  // an untitled scratch lands selected in this folder, title focused
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(page.locator(".list-title")).toHaveText("Ideas");
});

test("list rows keep their own menu — the background menu stands down", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".list .row", { hasText: "Welcome" }).click({ button: "right" });
  // the row menu (Open/Rename/…), not the background create menu
  await expect(ctxItem(page, "Rename…")).toBeVisible();
  await expect(ctxItem(page, "New subfolder…")).toHaveCount(0);
});

test("database background: New entry opens the draft row", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  // below the table (9 mock rows ≈ 330px) — true pane whitespace
  await page.locator(".db-body").click({ button: "right", position: { x: 60, y: 560 } });
  await expect(ctxItem(page, "New entry")).toBeVisible();
  await ctxItem(page, "New entry").click();
  await expect(page.locator(".db-draft-input")).toBeFocused();
});

test("database background: Save view opens the naming field", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  // below the table (9 mock rows ≈ 330px) — true pane whitespace
  await page.locator(".db-body").click({ button: "right", position: { x: 60, y: 560 } });
  await ctxItem(page, "Save view…").click();
  await expect(page.locator(".db-filter input.inline-edit")).toBeVisible();
});

test("calendar day cell: New entry composes on that date; chips keep their menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  const cell = page.locator(".cal-grid.month .cal-day").nth(10);
  const iso = await cell.getAttribute("data-iso");
  await cell.click({ button: "right", position: { x: 8, y: 40 } });
  await expect(ctxItem(page, /^New entry on /)).toBeVisible();
  await expect(ctxItem(page, "Open daily note")).toBeVisible();
  await ctxItem(page, /^New entry on /).click();
  // the composer opens inside that same cell
  await expect(
    page.locator(`.cal-day[data-iso="${iso}"] .cal-draft-input`)
  ).toBeFocused();

  // an entry chip's right-click still opens the entry menu, not the day menu
  await page.keyboard.press("Escape");
  await page.locator(".cal-entry").first().click({ button: "right" });
  await expect(ctxItem(page, "Open")).toBeVisible();
  await expect(ctxItem(page, /^New entry on /)).toHaveCount(0);
});

test("carve-outs: editor and property chips never get the app fallback menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // a typed entry with schema'd chips (same walk as the smoke chip test)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");

  // the editor keeps the native menu (spellcheck/copy live there): right-click
  // must not raise any custom menu
  await page.locator(".cm-content").click({ button: "right" });
  await expect(page.locator(".ctx-overlay")).toHaveCount(0);

  // a select chip claims its right-click — its own edit menu, not the app menu
  await page
    .locator(".chip", { has: page.locator(".chip-key", { hasText: "status" }) })
    .locator(".chip-primary")
    .click({ button: "right" });
  await expect(page.locator(".selmenu")).toBeVisible();
  await expect(page.locator(".ctx-overlay")).toHaveCount(0);
});

test("week canvas: right-click composes at the clicked slot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();

  // EMPTY canvas, picked by content — a block's own menu wins over the
  // column's by design (canvasBlock preventDefaults, same contract the chip
  // case above asserts), so the click must miss every block. A fixed column
  // index does not guarantee that: the seeded timed entries all land on
  // `day(0)`, and today's column index moves with the weekday, so nth(2) was
  // empty canvas on a Tuesday and the 09:00–17:00 workshop block on the
  // Wednesday after (red on main overnight with no code change).
  const col = page
    .locator(".cal-wk-col")
    .filter({ hasNot: page.locator(".cal-wk-block") })
    .first();
  // mid-column ≈ midday; the menu names the snapped slot and the draft
  // composes timed, like the double-click path on the same surface
  const box = (await col.boundingBox())!;
  await col.click({ button: "right", position: { x: 10, y: box.height / 2 } });
  const item = page.locator(".ctx-item", { hasText: /^New entry at \d{2}:\d{2}/ });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(".cal-wk-draft .cal-draft-input")).toBeFocused();
});

test("app chrome fallback: sidebar whitespace gets the app menu, not Reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // the sidebar's bottom padding, measured — an absolute y has only the
  // padding's ~10px of slack before the next seed that lengthens the sidebar
  // puts a row (with its own menu) under the click
  const side = (await page.locator(".sidebar").boundingBox())!;
  await page
    .locator(".sidebar")
    .click({ button: "right", position: { x: 100, y: side.height - 4 } });
  await expect(ctxItem(page, "New note")).toBeVisible();
  await expect(ctxItem(page, "Search")).toBeVisible();
  await expect(ctxItem(page, "Today’s journal")).toBeVisible();
  await ctxItem(page, "Search").click();
  await expect(page.locator(".search-input")).toBeFocused();
});
