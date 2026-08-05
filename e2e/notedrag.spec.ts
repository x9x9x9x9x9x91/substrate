import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// Database rows/cards are note-drag sources — any layout's entry
// drops onto a sidebar folder to move the file, like ListPane rows always
// could. The sidebar's folder drop target needs no per-layout changes: every
// layout carries the same NOTE_DRAG_MIME payload.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("table row drags onto a sidebar folder to move the note (SUB-402)", async ({ page }) => {
  await openDb(page, "Release");

  // title-scoped: the Fern Palace row's artist cell reads "glass havens"
  const row = page.locator(".db-table tbody tr", {
    has: page.locator(".db-title-txt", { hasText: "Glass Havens" }),
  });
  await expect(row).toHaveAttribute("draggable", "true");
  await row.dragTo(page.locator(".side-folder", { hasText: "Inbox" }));

  // the entry's rel path moved under Inbox (db membership follows the type
  // prop, so the row stays in the table with its new path)
  await expect(
    page.locator('.db-table [data-focus-path="Inbox/Glass Havens.md"]').first()
  ).toBeVisible();

  // and the Inbox folder view now lists the entry in its Release block
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  const block = page.locator(".row-dbblock", { hasText: "Release" });
  await expect(block).toBeVisible();
  await expect(block).toContainText("1 entry");
});

test("a table row hosting an open cell editor is not draggable (SUB-402)", async ({ page }) => {
  await openDb(page, "Release");

  const row = page.locator(".db-table tbody tr", {
    has: page.locator(".db-title-txt", { hasText: "Glass Havens" }),
  });
  await row.locator('.db-cell[data-fc="1"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".selmenu")).toBeVisible();
  await expect(row).toHaveAttribute("draggable", "false");

  // closing the editor hands the row back to the drag source
  await page.keyboard.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(row).toHaveAttribute("draggable", "true");
});

test("list layout row drags onto a sidebar folder (SUB-402)", async ({ page }) => {
  await openDb(page, "Release");
  await page.getByRole("button", { name: "List", exact: true }).click();

  const row = page.locator('.db-list [data-focus-path="Glass Havens.md"]');
  await expect(row).toHaveAttribute("draggable", "true");
  await row.dragTo(page.locator(".side-folder", { hasText: "Inbox" }));
  await expect(
    page.locator('.db-list [data-focus-path="Inbox/Glass Havens.md"]')
  ).toBeVisible();
});

test("gallery card drags onto a sidebar folder (SUB-402)", async ({ page }) => {
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Gallery", exact: true }).click();

  const card = page
    .locator(".db-gallery")
    .getByRole("button", { name: "Glass Havens", exact: true });
  await expect(card).toHaveAttribute("draggable", "true");
  await card.dragTo(page.locator(".side-folder", { hasText: "Inbox" }));
  await expect(
    page.locator('.db-gallery [data-focus-path="Inbox/Glass Havens.md"]')
  ).toBeVisible();
});

test("board card drags onto a sidebar folder without breaking column moves (SUB-402)", async ({
  page,
}) => {
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Board", exact: true }).click();

  // the same drag still moves columns: Glass Havens starts live, drops onto
  // the mastering column
  const board = page.locator(".db-board");
  const card = board.getByRole("button", { name: "Glass Havens", exact: true });
  await expect(card).toBeVisible();
  const mastering = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "mastering" }),
  });
  await card.dragTo(mastering);
  await expect(
    mastering.getByRole("button", { name: "Glass Havens", exact: true })
  ).toBeVisible();

  // …and carrying NOTE_DRAG_MIME means a sidebar folder accepts the card too
  await card.dragTo(page.locator(".side-folder", { hasText: "Inbox" }));
  await expect(board.locator('[data-focus-path="Inbox/Glass Havens.md"]')).toBeVisible();
});
