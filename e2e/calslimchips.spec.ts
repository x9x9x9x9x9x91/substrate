import { expect, test, type Page } from "@playwright/test";

// The month grid speaks Notion Calendar's line language now — a
// tinted identity bar + dim time + title per entry instead of the boxed
// icon-chip — plus the orientation marks that came with the same redesign:
// today's weekday header sharpens, the 1st names its month in-grid, and a
// done entry reads resolved (dimmed, struck) without leaving the surface.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openCalendar(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
}

test("month chips are lines: identity bar, no icon; timed entries keep their time", async ({
  page,
}) => {
  await openCalendar(page);
  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  await cell.locator(".cal-more").click();

  // the all-day event chip: a bar, a title, no type icon, no time
  const event = cell.locator(".cal-entry", { hasText: "Umbra listening session" });
  await expect(event.locator(".cal-entry-bar")).toBeVisible();
  await expect(event.locator(".type-icon")).toHaveCount(0);
  await expect(event.locator(".cal-entry-time")).toHaveCount(0);

  // the timed chip keeps its dim HH:MM after the bar
  const timed = cell.locator(".cal-entry", { hasText: "Label sync call" });
  await expect(timed.locator(".cal-entry-bar")).toBeVisible();
  await expect(timed.locator(".cal-entry-time")).toHaveText("14:00");

  // identity is per-database: an event bar and a task bar wear different hues
  const task = cell.locator(".cal-entry", { hasText: "Ship the patron download codes" });
  const eventBar = await event
    .locator(".cal-entry-bar")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const taskBar = await task
    .locator(".cal-entry-bar")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(eventBar).not.toEqual(taskBar);

  // a chip answers the pointer — the month grid's transparent base used to
  // swallow the shared hover and leave the surface dead under the cursor
  const idleBg = await event.evaluate((el) => getComputedStyle(el).backgroundColor);
  await event.hover();
  await expect
    .poll(() => event.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(idleBg);

  // week cards keep the icon language (the room argument cuts the other way)
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
  const card = page
    .locator(`.cal-grid.week .cal-day[data-iso="${isoDay(0)}"] .cal-entry`)
    .first();
  await expect(card.locator(".type-icon")).toBeVisible();
});

test("today orients twice: circled day number + sharpened weekday header", async ({
  page,
}) => {
  await openCalendar(page);
  // the circle (pre-change behavior, unchanged)
  await expect(
    page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-today`)
  ).toBeVisible();
  // the header mark, on exactly one weekday while today is on the grid
  await expect(page.locator(".cal-weekdays .cal-wd-today")).toHaveCount(1);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
  await expect(page.locator(".cal-weekdays .cal-wd-today")).toHaveText(wd);
  // paging away takes the mark with it. Two months, not one: today can sit
  // in the NEXT month's grid as an adjacent-day spill cell (a month-end
  // today), and the mark honestly stays while today is anywhere on the grid
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Meta+ArrowRight");
  await expect(page.locator(".cal-weekdays .cal-wd-today")).toHaveCount(0);
});

test("the 1st names its month in-grid; other days stay bare numbers", async ({ page }) => {
  await openCalendar(page);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // the grid always contains at least one month seam; find a 1st that isn't
  // today (today's circle deliberately wins the collision)
  const now = new Date();
  const next1 = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const p = (n: number) => String(n).padStart(2, "0");
  const nextIso = `${next1.getFullYear()}-${p(next1.getMonth() + 1)}-01`;
  // the next month's 1st sits on this month's grid unless the month ends
  // exactly on a Sunday — page forward once instead when it's missing
  let seam = page.locator(`.cal-day[data-iso="${nextIso}"] .cal-daynum`);
  if ((await seam.count()) === 0) {
    await page.keyboard.press("Meta+ArrowRight");
    seam = page.locator(`.cal-day[data-iso="${nextIso}"] .cal-daynum`);
  }
  await expect(seam).toHaveText(`${MONTHS[next1.getMonth()]} 1`);
  await expect(seam.locator(".cal-seam")).toBeVisible();
});

test("a done task reads resolved in the grid and Upcoming, still clickable", async ({
  page,
}) => {
  await openCalendar(page);
  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  await cell.locator(".cal-more").click();
  const chip = cell.locator(".cal-entry", { hasText: "Ship the patron download codes" });
  await expect(chip).not.toHaveClass(/\bdone\b/);

  // mark it done from the chip's context menu
  await chip.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Mark done" }).click();

  // the chip stays on the grid, now wearing the resolved treatment
  await expect(chip).toHaveClass(/\bdone\b/);
  await expect(chip.locator(".cal-entry-title")).toHaveCSS(
    "text-decoration-line",
    "line-through"
  );
  // …and the matching Upcoming row agrees
  const agendaRow = page.locator(".cal-ag-item", {
    hasText: "Ship the patron download codes",
  });
  await expect(agendaRow).toHaveClass(/\bdone\b/);

  // resolved is not gone: the chip still opens its peek
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
});
