import { expect, test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// A filter that dead-ends at zero rows says why under "No matches" —
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

test("a word typed before the filter still reaches the suggestion (SUB-1277)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const input = await openFilter(page);
  // the leading bare word used to occupy the probe's first slot, so
  // "in review" was never tried and the row stayed hintless
  await input.fill("bloom status:in review");
  const fix = page.locator(".db .empty .empty-hint-fix");
  await expect(fix).toHaveText('did you mean status:"in review"?');
  await fix.click();
  // the leading word rides along, behind the corrected filter
  await expect(input).toHaveValue('status:"in review" bloom');
});

test("multi-value filter keeps its OR list in the suggestion (SUB-1278)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const input = await openFilter(page);
  // "in" is one OR alternative; the joined probe ("live in review") could
  // never match, so this hint never fired for multi-value filters
  await input.fill("status:live,in review");
  const fix = page.locator(".db .empty .empty-hint-fix");
  await expect(fix).toHaveText('did you mean status:live,"in review"?');
  await fix.click();
  await expect(input).toHaveValue('status:live,"in review"');
  await expect(page.locator(".db .empty")).toHaveCount(0);
});
