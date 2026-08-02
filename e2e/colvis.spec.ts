import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// SUB-326: property visibility + per-database sort memory. Both persist on
// the database's ViewPref (views.json in the real engine, mockViews here),
// so they survive navigating to another page and back — unlike the SUB-212
// pin curation, which stays a saved-view capture. Runs against the
// deterministic mock backend (fresh page = fresh vault).

async function openRelease(page: Page) {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
}

test("right-click on the table header opens the property checklist; toggles persist across pages", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);
  // full union: Name + 10 data columns + the add-property cell
  await expect(page.locator(".db-table thead th")).toHaveCount(12);

  // right-click the header row → the checklist, every prop checked
  await page.locator(".db-table thead").click({ button: "right" });
  const menu = page.locator(".propvis");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".propvis-item")).toHaveCount(10);
  await expect(menu.locator(".propvis-item .prop-check.on")).toHaveCount(10);

  // uncheck two — the table re-renders live, the menu stays open
  await menu.locator(".propvis-item", { hasText: "cat#" }).click();
  await menu.locator(".propvis-item", { hasText: "artist" }).click();
  await expect(menu.locator(".propvis-item .prop-check.on")).toHaveCount(8);
  await expect(page.locator(".db-table thead th")).toHaveCount(10);
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // leave, return: still hidden (persisted on the db pref)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openRelease(page);
  await expect(page.locator(".db-table thead th")).toHaveCount(10);
  await expect(page.locator(".db-table thead th", { hasText: "artist" })).toHaveCount(0);

  // "Show all" restores the union in one click
  await page.locator(".db-table thead").click({ button: "right" });
  await expect(menu.locator(".propvis-showall")).toBeVisible();
  await menu.locator(".propvis-showall").click();
  await expect(page.locator(".db-table thead th")).toHaveCount(12);
});

test("the column caret menu hides a property; the checklist brings it back", async ({ page }) => {
  await page.goto("/");
  await openRelease(page);

  const statusTh = page.locator(".db-table thead th", { hasText: "status" });
  await statusTh.hover();
  await statusTh.locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Hide property" }).click();
  await expect(page.locator(".db-table thead th", { hasText: "status" })).toHaveCount(0);

  // re-check it in the checklist
  await page.locator(".db-table thead").click({ button: "right" });
  const menu = page.locator(".propvis");
  await expect(menu.locator(".propvis-item", { hasText: "status" }).locator(".prop-check.on")).toHaveCount(0);
  await menu.locator(".propvis-item", { hasText: "status" }).click();
  await expect(page.locator(".db-table thead th", { hasText: "status" })).toHaveCount(1);
});

test("column visibility is per-layout: the table and the list curate independently (SUB-642)", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  // hide cat# in the TABLE
  await page.locator(".db-table thead").click({ button: "right" });
  const menu = page.locator(".propvis");
  await menu.locator(".propvis-item", { hasText: "cat#" }).click();
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // the LIST keeps its own memory: subtitles still read the notable set —
  // cat# included — not the table's curated N-1 prop list (pre-SUB-642 the
  // subtitle would have flipped to every shown prop, released/format and all)
  await page.locator("button[aria-label='List']").click();
  const slowBloom = page.locator(".db-list .row[aria-label='Slow Bloom EP']");
  await expect(slowBloom).toBeVisible();
  await expect(slowBloom.locator(".row-sub")).toContainText("SMP-030");
  await expect(slowBloom.locator(".row-sub")).toContainText("various");
  await expect(slowBloom.locator(".row-sub")).not.toContainText("Vinyl");

  // curate the LIST: uncheck artist in the Columns menu — subtitles drop it
  await page.locator("button[aria-label='Display columns']").click();
  await page.locator(".db-cols-item", { hasText: "artist" }).click();
  await expect(slowBloom.locator(".row-sub")).not.toContainText("various");
  await expect(slowBloom.locator(".row-sub")).toContainText("SMP-030");
  await page.keyboard.press("Escape");

  // back in the TABLE: its own memory is untouched — cat# still hidden,
  // artist still shown
  await page.locator("button[aria-label='Table']").click();
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);
  await expect(page.locator(".db-table thead th", { hasText: "artist" })).toHaveCount(1);

  // and the list's curation survives the layout round trip
  await page.locator("button[aria-label='List']").click();
  await expect(slowBloom.locator(".row-sub")).not.toContainText("various");
});

test("a header sort persists across pages and is captured by Save view", async ({ page }) => {
  await page.goto("/");
  await openRelease(page);

  // sort by Name descending (two clicks)
  const nameHead = page.locator(".db-th-title");
  await nameHead.click();
  await nameHead.click();
  await expect(nameHead.locator(".db-sort")).toHaveText("↓");
  const firstTitle = await page.locator(".db-table tbody tr .db-title").first().textContent();

  // navigate away and back: the sort survives (SUB-326 — it used to reset)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openRelease(page);
  await expect(nameHead.locator(".db-sort")).toHaveText("↓");
  await expect(page.locator(".db-table tbody tr .db-title").first()).toHaveText(firstTitle ?? "");

  // a third click clears it, and the cleared state persists too
  await nameHead.click();
  await expect(nameHead.locator(".db-sort")).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openRelease(page);
  await expect(nameHead.locator(".db-sort")).toHaveCount(0);
});

test("a pin keeps its own saved sort — the database's remembered sort never bleeds in", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  // remember a db sort: status ascending
  await page.locator(".db-th-label", { hasText: "status" }).click();
  await expect(page.locator(".db-th-label", { hasText: "status" }).locator(".db-sort")).toHaveText("↑");

  // pin the unsorted-by-name state under a name (sort rides the capture)
  const nameHead = page.locator(".db-th-title");
  await nameHead.click(); // title asc — this is what the pin should keep
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Alpha");
  await nameInput.press("Enter");

  // back on the db, re-sort by status desc; the pin still opens title-asc
  await page.locator(".db-th-label", { hasText: "status" }).click();
  await page.locator(".db-th-label", { hasText: "status" }).click();
  await page.locator(".db-tab", { hasText: "Alpha" }).click();
  await expect(nameHead.locator(".db-sort")).toHaveText("↑");
  await expect(
    page.locator(".db-th-label", { hasText: "status" }).locator(".db-sort")
  ).toHaveCount(0);
});
