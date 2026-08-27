import { expect, test } from "./fixtures";
import { todayBase } from "./clock";

// Optional time-of-day on date props: the mock vault seeds
// "Label sync call" today at 14:00 next to the all-day "Umbra listening
// session" — these specs assert the timed entry renders its 24h time and
// sorts after the all-day one on the calendar surfaces (the rebuilt Today
// surface asserts the same ordering in its Scheduled lane).

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = todayBase();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the list's first paint doubles as the "app is live" barrier (cold open
  // lands on Scratch — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Scratch");
});

test("calendar pill: the timed entry shows its time, the all-day one none", async ({ page }) => {
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();

  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  // the day holds more entries than the month cap — expand it first
  await cell.locator(".cal-more").click();

  const timed = cell.locator(".cal-entry", { hasText: "Label sync call" });
  await expect(timed).toBeVisible();
  await expect(timed.locator(".cal-entry-time")).toHaveText("14:00");

  const allDay = cell.locator(".cal-entry", { hasText: "Umbra listening session" });
  await expect(allDay).toBeVisible();
  await expect(allDay.locator(".cal-entry-time")).toHaveCount(0);

  // within the day, all-day entries sort ahead of timed ones
  const chips = await cell.locator(".cal-entry").allTextContents();
  const allDayIdx = chips.findIndex((t) => t.includes("Umbra listening session"));
  const timedIdx = chips.findIndex((t) => t.includes("Label sync call"));
  expect(allDayIdx).toBeGreaterThanOrEqual(0);
  expect(timedIdx).toBeGreaterThan(allDayIdx);

  // the upcoming agenda rows carry the time too
  const agendaItem = page.locator(".cal-ag-item", { hasText: "Label sync call" }).first();
  await expect(agendaItem.locator(".cal-entry-time")).toHaveText("14:00");
});

test("DateMenu: typing a timed value commits day + time, shown humanized", async ({ page }) => {
  // open the timed fixture from the upcoming agenda (month cells cap at 3)
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal-ag-item", { hasText: "Label sync call" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Label sync call");

  const dateChip = page
    .locator(".chip")
    .filter({ has: page.locator(".chip-key", { hasText: "date" }) });
  await dateChip.click();
  const input = page.locator(".datemenu .selmenu-input");
  await input.fill(`${isoDay(2)} 09:30`);
  await expect(page.locator(".datemenu-parse")).toContainText("09:30");
  await input.press("Enter");

  // the chip shows the humanized day with the time appended
  await expect(dateChip.locator(".chip-val")).toContainText("09:30");
  // …and the entry moved to the new day, time intact
  await page.keyboard.press("Meta+4");
  const moved = page.locator(".cal-ag-item", { hasText: "Label sync call" }).first();
  await expect(moved.locator(".cal-entry-time")).toHaveText("09:30");
});
