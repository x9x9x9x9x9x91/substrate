import { expect, test } from "@playwright/test";

// SUB-570: paging the calendar far back used to empty Today and Upcoming. The
// pane asked for ONE entries window spanning the grid AND the 14-day upcoming
// list, so paging back STRETCHED that window instead of moving it. Once the
// span passed the 1000-occurrence expansion cap, a daily series was truncated
// long before it reached today — the far-back grid still rendered its chips
// while the agenda beside it went blank. Two bounded windows now feed the same
// byDay map.

/** How far back to page. The cap bites at 1000 occurrences of a daily series,
    so the anchor has to sit more than ~1000 days behind today: 36 months is
    ~1096 days in every month of every year, with margin on both sides, so this
    spec never depends on which month the wall clock is in (SUB-547). */
const PAGE_BACK = 36;

test("a series anchored far back still fills Upcoming (SUB-570)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  // page back three years FIRST, then compose there — the anchor has to be
  // far behind today for the cap to matter
  for (let i = 0; i < PAGE_BACK; i++) {
    await page.locator(".cal-pager button[title^='Previous']").click();
  }
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  // the grid's first cell, not today (SUB-547) — today isn't on this grid at all
  const anchorIso = await page
    .locator(".cal-day")
    .first()
    .evaluate((el) => el.getAttribute("data-iso") ?? "");
  expect(anchorIso).toBeTruthy();
  const cell = page.locator(`.cal-day[data-iso="${anchorIso}"]`);
  await cell.locator(".cal-daynum").click();
  await page.locator(".cal-draft-input").fill("Far paging probe");
  await page.locator(".cal-draft-input").press("Enter");

  const chip = cell.locator(".cal-entry", { hasText: "Far paging probe" });
  await expect(chip).toBeVisible();
  await chip.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Repeat…" }).click();
  await page.locator(".selmenu-item", { hasText: "Daily" }).click();

  // the far-back grid fills with the series...
  await expect(
    page.locator(".cal-grid .cal-entry", { hasText: "Far paging probe" }).first()
  ).toBeVisible();

  // ...and so does Upcoming, which never moved off today. One occurrence per
  // day for the whole 14-day list.
  const agendaItems = page.locator(".cal-agenda .cal-ag-item", { hasText: "Far paging probe" });
  await expect(agendaItems).toHaveCount(14);
  await expect(page.locator(".cal-agenda .cal-hint")).toHaveCount(0);
});
