import { expect, test, type Page } from "@playwright/test";

// SUB-520: every calendar day cell names itself. Before this, only the little
// day-number button inside a cell had a label — which names the button ("New
// entry on Jul 20"), not the day it sits in, so a screen reader walking the
// month grid or the week's all-day strip hit anonymous divs full of entries.
// The week canvas column already did this right (SUB-512); the strip and the
// month grid now match it, without becoming tab stops.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Mon, Jul 20" — the name the surface's own headings spell out */
const NAME = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w{3} \d{1,2}/;

async function openCalendar(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
}

test("month cells are named groups, and none of them is a tab stop", async ({ page }) => {
  await openCalendar(page);
  const cells = page.locator(".cal-grid.month .cal-day");
  const count = await cells.count();
  expect(count).toBeGreaterThanOrEqual(28);

  for (let i = 0; i < count; i++) {
    const cell = cells.nth(i);
    await expect(cell).toHaveAttribute("role", "group");
    const label = await cell.getAttribute("aria-label");
    expect(label, `month cell ${i} names itself`).toBeTruthy();
    expect(label!).toMatch(NAME);
  }

  // naming a region is not the same decision as making it focusable — the
  // month grid still has no day-level tab stops (SUB-512 left that open)
  await expect(page.locator(".cal-grid.month .cal-day[tabindex]")).toHaveCount(0);

  // and the name is the day it holds: today's cell is reachable by role+name,
  // and it is the cell today's entries live in
  const todayName = await page.locator(`.cal-day[data-iso="${isoDay()}"]`).getAttribute("aria-label");
  const today = page.getByRole("group", { name: todayName!, exact: true });
  await expect(today).toHaveCount(1);
  await expect(
    today.getByRole("button", { name: "Mirror fauna vocal session", exact: true })
  ).toBeVisible();
});

test("all-day strip cells name themselves, distinct from the canvas column", async ({ page }) => {
  await openCalendar(page);
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();

  const strip = page.locator(".cal-grid.week .cal-day");
  await expect(strip).toHaveCount(7);

  for (let i = 0; i < 7; i++) {
    const cell = strip.nth(i);
    await expect(cell).toHaveAttribute("role", "group");
    const label = await cell.getAttribute("aria-label");
    expect(label, `strip cell ${i} names itself`).toBeTruthy();
    // "All-day, Mon, Jul 20" — the same day name the canvas column carries,
    // prefixed so the two halves of one day don't read identically
    expect(label!).toMatch(/^All-day, /);
    expect(label!.replace(/^All-day, /, "")).toMatch(NAME);
  }

  // the strip stays a non-focusable region: the week's single tab stop is
  // still the canvas rover (SUB-512), not a second one up in the strip
  await expect(page.locator(".cal-grid.week .cal-day[tabindex]")).toHaveCount(0);
  await expect(page.locator('.cal-wk-col[tabindex="0"]')).toHaveCount(1);

  // both halves of today are reachable by name, and they are different names
  const iso = isoDay();
  const stripLabel = await page.locator(`.cal-grid.week .cal-day[data-iso="${iso}"]`).getAttribute("aria-label");
  const colLabel = await page.locator(`.cal-wk-col[data-iso="${iso}"]`).getAttribute("aria-label");
  expect(stripLabel).not.toBe(colLabel);
  expect(stripLabel).toBe(`All-day, ${colLabel}`);
});
