import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// property descriptions: a schema'd prop may carry a one-line
// description that shows as a quiet muted hint where values are entered —
// the cell picker popup and the note-side chip editor. Undescribed props
// render nothing. The schema editor's draft UI edits it (any kind), and
// writes persist through the mock backend.
// Fixtures: inventory `price` (number, euro) carries
// "Approximate is fine — current resale value." (src/lib/tauri.ts).

const HINT = "Approximate is fine — current resale value.";

/** the data-column index of a prop, read off the table header (title first) —
    headers render display-capitalized, so match case-insensitively */
async function colIndex(page: import("@playwright/test").Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
});

test("described prop shows the hint in its cell editor (SUB-191)", async ({ page }) => {
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }) });
  await row.locator(".cell-num").click();

  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  const hint = menu.locator(".selmenu-prophint");
  await expect(hint).toHaveText(HINT);
  // one quiet muted line: nowrap + ellipsis, full text rides the tooltip
  await expect(hint).toHaveCSS("white-space", "nowrap");
  await expect(hint).toHaveAttribute("title", HINT);
});

test("undescribed prop shows no hint (SUB-191)", async ({ page }) => {
  // `link` is a schema'd url kind with no description — the picker opens
  // with no hint element at all (no layout jump)
  const linkCol = await colIndex(page, "link");
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  await row.locator("td").nth(linkCol).click();

  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".selmenu-prophint")).toHaveCount(0);
});

test("setting a description via the schema editor persists (SUB-191)", async ({ page }) => {
  // the link column's schema editor rides the column caret menu
  await page.locator(".db-table th", { hasText: "link" }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Edit schema…" }).click();

  const editor = page.locator(".selmenu");
  await expect(editor).toBeVisible();
  const desc = editor.locator('input[placeholder="Description — shown as an entry hint"]');
  await expect(desc).toHaveValue("");
  await desc.fill("Product page — prices move fast.");
  await editor.locator(".selmenu-btn-primary").click();
  await expect(editor).toHaveCount(0);

  // the link cell editor now shows the hint
  const linkCol = await colIndex(page, "link");
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  await row.locator("td").nth(linkCol).click();
  await expect(page.locator(".selmenu-prophint")).toHaveText("Product page — prices move fast.");
  await page.keyboard.press("Escape");

  // re-navigate: the write persisted through the mock backend
  await openDb(page, "Contact");
  await openDb(page, "Inventory");
  await row.locator("td").nth(linkCol).click();
  await expect(page.locator(".selmenu-prophint")).toHaveText("Product page — prices move fast.");
});

test("note-side chip editor shows the hint (SUB-191)", async ({ page }) => {
  await page.locator(".db-title-txt", { hasText: "Falke F-3" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Falke F-3");

  await page.locator(".chip", { hasText: "price" }).click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".selmenu-prophint")).toHaveText(HINT);
});
