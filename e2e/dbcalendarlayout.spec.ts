import { expect, test, type Page } from "./fixtures";

// The database pane's calendar layout: a fifth layout beside list, table,
// board and gallery, drawing the pane's own rows on a month grid by one of the
// database's date properties. The pref write goes through the mock engine's
// set_view_pref and is read back from it, so the layout and its date binding
// have to survive a round trip through the persisted views config. Which
// layout NAMES the engine accepts is not tested here — the mock stores what it
// is given; that refusal lives in the Rust engine's own views.rs unit test.
//
// The fixture events are day-relative, so every assertion here is wall-clock
// independent: four `type: event` notes land on TODAY (an all-day listening
// session, a 14:00 call, a 09:00–17:00 workshop and a vocal session) and one
// on tomorrow.

/** Open the seeded `event` database — the one fixture database with a date
    property, so it is the one with a calendar to draw. */
async function enterEvents(page: Page) {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page
    .locator(".dbmgr-row")
    .filter({ has: page.locator(".dbmgr-row-title", { hasText: /^Event$/ }) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".list-title")).toHaveText("Event");
}

/** A fresh app, then the events database. The reload is deliberate: a spec
    that re-enters the database mid-run must NOT reload, or the mock vault's
    prefs go with it. */
async function openEvents(page: Page) {
  await page.goto("/");
  await enterEvents(page);
}

async function toCalendar(page: Page) {
  await page.locator('.db-layouts button[aria-label="Calendar"]').click();
  await expect(page.locator(".db-calendar")).toBeVisible();
}

test("a database switches to the calendar layout and its rows land on their date-prop days", async ({
  page,
}) => {
  await openEvents(page);
  await toCalendar(page);

  // a month grid: 4–6 whole weeks, Monday first — the same grid vocabulary
  // the Calendar pane and the dashboard fence draw
  const cells = page.locator(".db-calendar .cal-day");
  const count = await cells.count();
  expect(count % 7).toBe(0);
  expect(count).toBeGreaterThanOrEqual(28);
  await expect(page.locator(".db-calendar .cal-weekdays span").first()).toHaveText("Mon");

  // the binding is stated, not guessed at by the reader
  await expect(page.locator(".db-calbind")).toHaveText("by date");

  // today's cell carries today's fixture events; the timed ones keep their
  // time and the all-day ones have none
  const today = page.locator(".db-calendar .cal-day.today");
  await expect(today).toHaveCount(1);
  await expect(today.locator(".cal-entry")).toHaveCount(4);
  await expect(today.locator(".cal-entry", { hasText: "Umbra listening session" })).toHaveCount(1);
  await expect(today.locator(".cal-entry-time", { hasText: "14:00" })).toHaveCount(1);
  await expect(
    today.locator(".cal-entry", { hasText: "Umbra listening session" }).locator(".cal-entry-time")
  ).toHaveCount(0);

  // and a chip is a real control: it opens its note
  await today.locator(".cal-entry", { hasText: "Umbra listening session" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");
});

test("the month pager moves the drawn month and comes back to today's", async ({ page }) => {
  await openEvents(page);
  await toCalendar(page);

  const month = page.locator(".db-calmonth");
  const start = await month.textContent();
  await expect(page.locator(".db-calendar .cal-day.today")).toHaveCount(1);

  await page.getByRole("button", { name: "Next month" }).click();
  await expect(month).not.toHaveText(start ?? "");
  // a month away from today has no today cell to highlight
  await expect(page.locator(".db-calendar .cal-day.today")).toHaveCount(0);

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(month).toHaveText(start ?? "");
  await expect(page.locator(".db-calendar .cal-day.today .cal-entry")).toHaveCount(4);
});

test("a repeating row expands through the shared expander, not a second cadence", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  // vault-format §5.7: the anchor is today, so NEXT month is wholly inside
  // the series whatever today's date is
  await page.evaluate(() =>
    window.__mockEditProp!("Calendar/Umbra listening session.md", "repeat", "daily")
  );
  await enterEvents(page);
  await toCalendar(page);

  await page.getByRole("button", { name: "Next month" }).click();
  const chips = page.locator(".db-calendar .cal-entry", { hasText: "Umbra listening session" });
  expect(await chips.count()).toBeGreaterThanOrEqual(28);
  // occurrences wear the repeat mark every other calendar surface uses
  await expect(chips.first().locator("svg")).toHaveCount(1);
});

test("the calendar pref persists across leaving the database and coming back", async ({ page }) => {
  await openEvents(page);
  await toCalendar(page);
  await expect(page.locator('.db-layouts button[aria-label="Calendar"]')).toHaveClass(/active/);

  // leave for another database entirely, then come back: the pref is per
  // database and was written through the engine's set_view_pref
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-row").first()).toBeVisible();
  await enterEvents(page);

  await expect(page.locator(".db-calendar")).toBeVisible();
  await expect(page.locator('.db-layouts button[aria-label="Calendar"]')).toHaveClass(/active/);
  await expect(page.locator(".db-calendar .cal-day.today .cal-entry")).toHaveCount(4);
});
