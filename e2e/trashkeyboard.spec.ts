import { expect, test, type Page } from "@playwright/test";

// SUB-641: the panes that own the app's irreversible operations were
// pointer-only — the Trash row menu had no keyboard path, and every row's
// buttons announced identical names with no item context. Rows are now
// focusable with their title announced, Enter/Space runs the row's primary
// (safe) action, ContextMenu/Shift-F10 opens the Trash row menu, and every
// per-row button names its item, armed states included.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function openView(page: Page, query: string, label: string) {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill(query);
  await page.locator(".palette-item", { hasText: label }).first().click();
  await expect(page.locator(".palette")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
});

test("trash row: keyboard semantics, menu key, named buttons (SUB-641)", async ({ page }) => {
  // trash a note so the pane has a row
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();

  await openView(page, "Open Trash", "Open Trash");
  const trashRow = page.getByRole("button", { name: "Capture anything", exact: true });
  await expect(trashRow).toBeVisible();

  // every per-row button names its item, not a bare "Restore" / "Delete forever…"
  await expect(page.getByRole("button", { name: "Restore Capture anything" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Purge history of Capture anything" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete Capture anything forever" })
  ).toBeVisible();

  // the armed confirm states keep the item name too
  await page.getByRole("button", { name: "Purge history of Capture anything" }).click();
  await expect(
    page.getByRole("button", { name: "Purge history of Capture anything forever?" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete Capture anything forever" }).click();
  await expect(
    page.getByRole("button", { name: "Delete Capture anything forever?" })
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Also purge history of Capture anything" })
  ).toBeVisible();

  // the row menu is the pointer menu's twin — both keyboard openers reach it
  await trashRow.focus();
  await page.keyboard.press("ContextMenu");
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Restore" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Purge history…" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Delete forever…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await trashRow.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);

  // Enter on the row performs the primary action — restore (arming is ignored;
  // the safe action always wins over a half-armed destructive one)
  await trashRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await expect(row(page, "Capture anything")).toBeVisible();
});

test("assets rows: row semantics and named buttons (SUB-641)", async ({ page }) => {
  await openView(page, "orphaned", "Clean up orphaned assets");
  const assetRow = page.getByRole("button", { name: "stale-screenshot.png", exact: true });
  await expect(assetRow).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reveal stale-screenshot.png in Finder" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete stale-screenshot.png" })).toBeVisible();

  // armed state keeps the item name
  await page.getByRole("button", { name: "Delete stale-screenshot.png" }).click();
  await expect(
    page.getByRole("button", { name: "Move stale-screenshot.png to trash?" })
  ).toBeVisible();

  // Enter/Space on the row performs the primary action — Reveal. In the mock
  // backend the opener plugin is absent, so the call surfaces as the pane's
  // console.warn fallback; that warn IS the proof the keypress fired reveal.
  await assetRow.focus();
  for (const key of ["Enter", " "]) {
    const revealed = page.waitForEvent("console", {
      predicate: (m) => m.text().includes("reveal in Finder unavailable"),
    });
    await page.keyboard.press(key);
    await revealed;
  }
});
