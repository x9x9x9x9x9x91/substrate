import { expect, test, type Page } from "./fixtures";

// Deleting an orphaned asset used to unlink it — the one delete in the
// app with no recovery path. Now it moves into `.trash/<ms>/.assets/<name>`,
// lists in the Trash pane as its own kind, and restores back into `.assets/`.

async function openView(page: Page, query: string, label: string) {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill(query);
  await page.locator(".palette-item", { hasText: label }).first().click();
  await expect(page.locator(".palette")).toHaveCount(0);
}

test("orphaned asset deletes to the trash and restores (SUB-479)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");

  await openView(page, "orphaned", "Clean up orphaned assets");
  await expect(page.locator(".list-title")).toHaveText("Orphaned assets");
  const row = page.locator(".trash-row", { hasText: "stale-screenshot.png" });
  await expect(row).toBeVisible();

  // armed two-click — copy now promises the trash, not permanence
  await row.locator(".trash-danger", { hasText: "Delete…" }).click();
  await row.locator(".trash-danger", { hasText: "Move to trash?" }).click();
  await expect(page.locator(".trash-row", { hasText: "stale-screenshot.png" })).toHaveCount(0);

  await openView(page, "Open Trash", "Open Trash");
  await expect(page.locator(".list-title")).toHaveText("Trash");
  const trashed = page.locator(".trash-row", { hasText: "stale-screenshot.png" });
  await expect(trashed).toBeVisible();
  // distinguishable from a trashed note at a glance
  await expect(trashed.locator(".trash-row-tag")).toHaveText("asset");
  // assets carry no history, so only the delete-forever button rides along —
  // no "Purge history…" affordance
  await expect(trashed.locator(".trash-danger")).toHaveCount(1);
  await expect(trashed.locator(".trash-danger")).toHaveText("Delete forever…");

  await trashed.locator(".trash-restore").click();
  await expect(page.locator(".trash-row", { hasText: "stale-screenshot.png" })).toHaveCount(0);

  // back in `.assets/`, orphaned again — the round trip lost nothing
  await openView(page, "orphaned", "Clean up orphaned assets");
  await expect(page.locator(".trash-row", { hasText: "stale-screenshot.png" })).toBeVisible();
});
