import { expect, test } from "./fixtures";
import { todayBase } from "./clock";

// PageUp/PageDown in the date picker page the MONTH — and the keyboard cursor
// must page with it. shiftMonth used to move only the displayed grid, so Enter
// after PageDown committed the old month's day: a date nowhere on screen.

/** ISO of today + offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = todayBase();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The cursor day paged one month forward: same day-of-month, clamped to the
    target month's length — mirror of the picker's own contract. */
function nextMonthClamped(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(ny, nm, 0).getDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ny}-${p(nm)}-${p(Math.min(d, last))}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
});

test("DateMenu: PageDown pages the cursor with the month, and Enter commits a visible day", async ({
  page,
}) => {
  // The timed calendar fixture opens the picker with its cursor on today.
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal-ag-item", { hasText: "Label sync call" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Label sync call");
  const chip = page
    .locator(".chip")
    .filter({ has: page.locator(".chip-key", { hasText: "date" }) });
  await chip.click();

  const menu = page.locator(".datemenu");
  await expect(menu).toBeVisible();

  const expected = nextMonthClamped(isoDay());
  await page.keyboard.press("PageDown");
  // the cursor moved into the displayed month — not left behind as an
  // out-of-month leftover
  await expect(menu.locator(".datemenu-day.cursor")).toHaveAttribute("data-iso", expected);

  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const [, m, d] = expected.split("-").map(Number);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  await expect(chip.locator(".chip-val")).toContainText(`${MONTHS[m - 1]} ${d}`);
});

test("DateMenu: PageUp pages the cursor back a month", async ({ page }) => {
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal-ag-item", { hasText: "Label sync call" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Label sync call");
  const chip = page
    .locator(".chip")
    .filter({ has: page.locator(".chip-key", { hasText: "date" }) });
  await chip.click();

  const menu = page.locator(".datemenu");
  await expect(menu).toBeVisible();

  // forward then back lands exactly where the cursor started
  const start = isoDay();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageUp");
  await expect(menu.locator(".datemenu-day.cursor")).toHaveAttribute("data-iso", start);
});
