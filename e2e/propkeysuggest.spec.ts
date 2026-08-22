import { expect, test } from "@playwright/test";

// The + property chip suggests the keys the note can actually use: the schema
// keys of its own database first, then the frontmatter keys the app itself
// reads (dashboard:, pages:, repeat: …), each with a line saying what it does.
// Before this, every one of those was reachable only by knowing its name —
// the editor below the chips never sees the frontmatter block.

test("the chip offers the note's database keys, then the app's own", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");

  await page.locator(".chip-add").click();
  const rows = page.locator(".chip-suggest-row");
  await expect(rows.first()).toBeVisible();
  // every row says what the key is for — the list is a door into the docs
  await expect(rows.first().locator(".chip-suggest-hint")).not.toBeEmpty();
  // a key the note already carries is not offered again
  await expect(page.locator(".chip-suggest-key", { hasText: /^status$/ })).toHaveCount(0);

  const input = page.locator(".chip-input");
  await input.fill("repeat");
  await expect(page.locator(".chip-suggest-key")).toHaveText([
    "repeat",
    "repeat_until",
    "repeat_skip",
  ]);

  // clicking a suggestion leaves the key typed with the value half open
  await page.locator(".chip-suggest-row", { hasText: "repeat_until" }).click();
  await expect(input).toHaveValue("repeat_until: ");
  await expect(page.locator(".chip-suggest")).toHaveCount(0);
  await input.pressSequentially("2026-12-31");
  await input.press("Enter");
  await expect(page.locator(".chip", { hasText: "repeat_until" })).toContainText("2026-12-31");
});

test("arrows pick a suggestion, and Enter still commits what was typed", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();

  await page.locator(".chip-add").click();
  const input = page.locator(".chip-input");
  await input.fill("dash");
  await expect(page.locator(".chip-suggest-row.active")).toHaveCount(0);
  await input.press("ArrowDown");
  await expect(page.locator(".chip-suggest-row.active")).toContainText("dashboard");
  await input.press("Enter");
  await expect(input).toHaveValue("dashboard: ");

  // nothing arrowed to: Enter belongs to the draft, as it always did
  await input.press("Escape");
  await page.locator(".chip-add").click();
  await input.fill("est_price: ~€500");
  await input.press("Enter");
  await expect(page.locator(".chip", { hasText: "est_price" })).toContainText("~€500");
});
