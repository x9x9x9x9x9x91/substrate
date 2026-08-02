import { expect, test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// SUB-266: a filter that dead-ends at zero rows says why under "No matches" —
// an unknown property key, or a value the query split apart (`status:in` +
// the word "review" → the real value "in review"), clickable to apply.

test("unknown filter key names the missing property", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await (await openFilter(page)).fill("statsu:live");
  const empty = page.locator(".db .empty");
  await expect(empty).toContainText("No matches");
  await expect(empty.locator(".empty-hint")).toHaveText('no property "statsu"');
  // no suggestion to click — the key itself is wrong
  await expect(empty.locator(".empty-hint-fix")).toHaveCount(0);
});

test("split value suggests the quoted form, click applies it", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const input = await openFilter(page);
  // Slow Bloom EP is status "in review" — the bare word "review" must hit
  // its title, so this query dead-ends at zero rows
  await input.fill("status:in review");
  const fix = page.locator(".db .empty .empty-hint-fix");
  await expect(fix).toHaveText('did you mean status:"in review"?');
  await fix.click();
  await expect(input).toHaveValue('status:"in review"');
  await expect(page.locator(".db .empty")).toHaveCount(0);
  await expect(page.locator(".db", { hasText: "Slow Bloom EP" }).first()).toBeVisible();
});
