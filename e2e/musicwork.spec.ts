import { expect, test, type Page } from "@playwright/test";

// Music work board flows over the mock seed: Dashboards/Music
// Work.md (index: Work Index) + the Work Index sheet — 8 jobs across 3 years,
// 3 categories and 6 artists, one flagged row, one 0 MB job.

async function openBoard(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Music Work" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Music Work");
}

test("music-work: the year view leads, newest year first with its anchors", async ({ page }) => {
  await openBoard(page);
  await expect(page.locator(".dash-state")).toContainText("8 jobs");
  await expect(page.locator(".mw-scanned")).toHaveText("scanned 2026-07-30 00:10");
  // three years, newest first
  await expect(page.locator(".mw-grouplabel")).toHaveText(["2026", "2025", "2024"]);
  const y2026 = page.locator(".mw-group").first();
  // 2026: 5 jobs — 23949 + 340 + 14324 + 0 + 280 MB
  await expect(y2026.locator(".mw-groupsum")).toContainText("5 jobs");
  await expect(y2026.locator(".mw-groupsum")).toContainText("38,0 GB");
  // categories A–Z inside the year
  await expect(y2026.locator(".mw-sublabel")).toHaveText(["MASTERING", "MIXING", "OWN WORK"]);
  // newest last_active first inside a category
  await expect(y2026.locator(".mw-sub").first().locator(".mw-name").first()).toContainText(
    "Voss Signal",
  );
  // a 0 MB job renders as dust, not a zero
  await expect(page.locator(".mw-job", { hasText: "mira adjust" }).locator(".mw-size")).toHaveText("—");
});

test("music-work: the switcher repivots the same rows", async ({ page }) => {
  await openBoard(page);
  await page.locator(".mw-views button", { hasText: "artist" }).click();
  // artists A–Z; the year view's year headers are gone
  await expect(page.locator(".mw-grouplabel").first()).toHaveText("Ada Voss");
  await expect(page.locator(".mw-grouplabel")).toContainText(["Halo Ferry"]);
  // Mira has three jobs across two years, newest year first
  const mira = page.locator(".mw-group", { hasText: "Mira" }).first();
  await expect(mira.locator(".mw-groupsum")).toContainText("3 jobs");
  await expect(mira.locator(".mw-sublabel")).toHaveText(["2026", "2025"]);

  await page.locator(".mw-views button", { hasText: "category" }).click();
  await expect(page.locator(".mw-grouplabel")).toHaveText(["MASTERING", "MIXING", "OWN WORK"]);
  await expect(page.locator(".mw-group").first().locator(".mw-sublabel")).toHaveText([
    "2026",
    "2025",
  ]);
});

test("music-work: the filter narrows rows and the group totals with them", async ({ page }) => {
  await openBoard(page);
  await page.locator(".mw-filter").fill("mira");
  // client match + job-name match, case-insensitive
  await expect(page.locator(".dash-state")).toContainText("3 shown");
  await expect(page.locator(".mw-grouplabel")).toHaveText(["2026", "2025"]);
  await expect(page.locator(".mw-group").first().locator(".mw-groupsum")).toContainText("2 jobs");
  // a job name nobody has
  await page.locator(".mw-filter").fill("zzzz");
  await expect(page.locator(".dash-empty")).toContainText("No job matches 'zzzz'");
  await expect(page.locator(".mw-job")).toHaveCount(0);
});

test("music-work: uncertain dating is a chip on the job, with the reason in the tooltip", async ({
  page,
}) => {
  await openBoard(page);
  // exactly one seeded row disagrees about its year
  await expect(page.locator(".mw-flag")).toHaveCount(1);
  await expect(page.locator(".mw-job", { hasText: "Fern Static" }).locator(".mw-flag")).toHaveAttribute(
    "title",
    "Uncertain dating — name 2025 vs files 2026",
  );
});

test("music-work: the board fills its pane rather than sitting in a narrow column", async ({
  page,
}) => {
  await openBoard(page);
  const board = (await page.locator(".mw-board").boundingBox())!;
  // `.dash-inner` is the pane the board lives in; its own padding is the only
  // gap that belongs there, so the board is compared against the content box
  const pane = (await page.locator(".dash-inner").boundingBox())!;
  const padding = await page.locator(".dash-inner").evaluate((el) => {
    const s = getComputedStyle(el);
    return parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
  });
  const content = pane.width - padding;
  // an earlier `max-width: 760px` left oceans of side space at this viewport;
  // rounding is the only slack allowed, not a cap
  expect(board.width).toBeGreaterThan(content - 1);
});

test("music-work: a missing index sheet reads as a calm empty state", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.__mockDeleteNote?.("Work Index.md"));
  await page.locator(".side-item", { hasText: "Music Work" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Music Work");
  await expect(page.locator(".dash-state")).toContainText("index missing");
  await expect(page.locator(".dash-empty")).toContainText("No 'Work Index' sheet yet");
  // no error banner on a missing sheet
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".mw-job")).toHaveCount(0);
});
