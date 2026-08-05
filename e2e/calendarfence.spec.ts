import { expect, test, type Page } from "@playwright/test";

// Calendar fence (SUB-965): a ```calendar fence draws any database date
// property as a month grid — standalone on a one-fence dashboard note, or
// interleaved in a hub body. Entries sit on their day, a chip opens its note,
// repeating notes (vault-format §5.7) expand inside the drawn month, and a
// malformed fence errors in place without taking its siblings down.
//
// The fixture events (src/lib/tauri.ts) are day-relative, so every assertion
// here is wall-clock independent: three `type: event` notes land on TODAY
// (an all-day listening session, a 14:00 call, a 09:00–17:00 workshop) and
// one on tomorrow. The recurrence test pages FORWARD a month, where a daily
// series covers the whole grid whatever today's date is.

const GOOD = ["```calendar", "source: event", "date: date", "```"].join("\n");

// unknown key: the parser is strict, so this fence must name its own problem
const BROKEN = ["```calendar", "source: event", "date: date", "colour: red", "```"].join("\n");

const DASH = `Events this month.\n\n${GOOD}\n\n${BROKEN}\n`;

/** Stage `body` on the Overview dashboard note and open it. Overview carries
    `type: dashboard` with no `dashboard:` key, so DashboardPane dispatches on
    the body — calendar fences land on the calendar dashboard. */
async function openDash(page: Page, body: string) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => window.__mockEditNote!("Dashboards/Overview.md", b), body);
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("a standalone calendar fence draws the month with its entries on their days", async ({
  page,
}) => {
  await openDash(page, `Events this month.\n\n${GOOD}\n`);

  await expect(page.locator(".dash-section-label", { hasText: "Event by date" })).toBeVisible();

  // a month grid: 4–6 whole weeks, Monday first
  const cells = page.locator(".calfence .cal-day");
  const count = await cells.count();
  expect(count % 7).toBe(0);
  expect(count).toBeGreaterThanOrEqual(28);
  await expect(page.locator(".calfence .cal-weekdays span").first()).toHaveText("Mon");

  // today's cell carries today's fixture events — three chips, then the
  // dashboard grid's overflow affordance for the fourth
  const today = page.locator(".calfence .cal-day.today");
  await expect(today).toHaveCount(1);
  await expect(today.locator(".cal-entry")).toHaveCount(3);
  await expect(today.locator(".cal-entry", { hasText: "Umbra listening session" })).toHaveCount(1);
  await today.locator(".cal-more").click();
  await expect(today.locator(".cal-entry")).toHaveCount(4);
  // the timed ones keep their time, the all-day ones have none
  await expect(today.locator(".cal-entry-time", { hasText: "14:00" })).toHaveCount(1);
  await expect(
    today.locator(".cal-entry", { hasText: "Umbra listening session" }).locator(".cal-entry-time")
  ).toHaveCount(0);

  // the foot states the source it read and how much it found
  await expect(page.locator(".calfence .dash-foot")).toContainText("event · date");
  await expect(page.locator(".chart-err")).toHaveCount(0);
});

test("a malformed calendar fence errors in place and leaves its sibling standing", async ({
  page,
}) => {
  await openDash(page, DASH);

  // the bad fence names the key it does not know…
  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("colour");

  // …and the healthy calendar above it still drew its month
  await expect(page.locator(".dash-section-label", { hasText: "Event by date" })).toBeVisible();
  await expect(page.locator(".calfence .cal-day.today .cal-entry")).toHaveCount(3);
});

test("clicking an entry opens its note, and the chip is a real keyboard control", async ({
  page,
}) => {
  await openDash(page, `Events this month.\n\n${GOOD}\n`);

  const chip = page.locator(".calfence .cal-day.today .cal-entry", {
    hasText: "Umbra listening session",
  });
  expect(
    await chip.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });

  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");

  // and the plain click does the same thing
  await openDash(page, `Events this month.\n\n${GOOD}\n`);
  await page
    .locator(".calfence .cal-day.today .cal-entry", { hasText: "Mirror fauna vocal session" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Mirror fauna vocal session");
});

test("a repeating note expands across the drawn month, not just on its anchor", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => {
    window.__mockEditNote!("Dashboards/Overview.md", b);
    // vault-format §5.7: the anchor is today, so NEXT month is wholly inside
    // the series whatever today's date is
    window.__mockEditProp!("Calendar/Umbra listening session.md", "repeat", "daily");
  }, `Events this month.\n\n${GOOD}\n`);
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  // page forward one month: every cell of that grid is an occurrence
  await page.locator(".calfence").getByRole("button", { name: "Next month" }).click();

  const chips = page.locator(".calfence .cal-entry", { hasText: "Umbra listening session" });
  expect(await chips.count()).toBeGreaterThanOrEqual(28);
  // occurrences wear the repeat mark the Calendar pane uses
  await expect(chips.first().locator("svg")).toHaveCount(1);

  // paging back returns to the anchor month, entries intact
  await page.locator(".calfence").getByRole("button", { name: "Previous month" }).click();
  await expect(page.locator(".calfence .cal-day.today .cal-entry")).toHaveCount(3);
});

test("a bare calendar fence in a hub body renders live; a quoted or tailed one stays a code box", async ({
  page,
}) => {
  const hub = [
    "Label home.",
    "",
    "## Diary",
    "",
    GOOD,
    "",
    "## Tailed",
    "",
    // a tailed opener is prose: the calendar parser reads the bare form only,
    // and search keeps such a block indexed — so the hub must NOT mount it
    // live (SUB-965 review)
    "```calendar month",
    "source: event",
    "date: date",
    "```",
    "",
    "> A quoted calendar fence is quoted text, not a grid:",
    "> ```calendar",
    "> source: event",
    "> date: date",
    "> ```",
    "",
    "## Broken",
    "",
    BROKEN,
    "",
  ].join("\n");

  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => window.__mockEditNote!("Dashboards/Umbra Home.md", b), hub);
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  // the live fence draws its month where it was written, under its own heading
  const cal = page.locator(".hub-body .hub-calendar");
  await expect(cal).toHaveCount(2); // the good one and the broken one
  await expect(cal.first().locator(".cal-day.today .cal-entry")).toHaveCount(3);
  await expect(page.locator(".hub-body .dash-section-label", { hasText: "Diary" })).toBeVisible();

  // the quoted one and the tailed one are prose: code boxes, never live
  // surfaces — the tailed one because its config stays in the search index
  const pre = page.locator(".hub-body .hub-pre");
  await expect(pre).toHaveCount(2);
  await expect(pre.first()).toContainText("source: event");
  await expect(pre.last()).toContainText("source: event");

  // and the broken sibling errors in place without touching the live one
  await expect(page.locator(".hub-body .chart-err")).toHaveCount(1);
  await expect(cal.first().locator(".chart-err")).toHaveCount(0);

  // clicking through from the hub opens the note, same as standalone
  await cal
    .first()
    .locator(".cal-day.today .cal-entry", { hasText: "Umbra listening session" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");
});
