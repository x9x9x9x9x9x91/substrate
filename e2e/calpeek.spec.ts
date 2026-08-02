import { expect, test } from "@playwright/test";

// Entry peek: clicking a month chip or week card opens a Notion-Calendar-style
// popover anchored at the entry — title (rename), date (DateMenu on the drag's
// write path), time (HH:MM, empty = all-day), status (schema options), repeat
// (the existing picker) — with the note itself a double-click or "Open note ↗"
// away. Virtual series occurrences trade the date/time rows for the series
// actions. Runs against the same deterministic mock backend as smoke.spec.ts.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** the humanized form of an ISO day ("Jul 18, 2026") — mirrors
    dates.formatDateHuman (short month names), which the peek's Date row
    rides via display.ts */
function humanFull(iso: string): string {
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the list's first paint doubles as the "app is live" barrier
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  // today's cell overflows the 3-chip month cap — expand it to reach every chip
  await page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-more`).click();
});

test("the peek opens BESIDE the clicked chip, not over its day (SUB-792)", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click();
  const peek = page.locator(".cal-peek");
  await expect(peek).toBeVisible();

  const chipBox = await chip.boundingBox();
  const peekBox = await peek.boundingBox();
  expect(chipBox).toBeTruthy();
  expect(peekBox).toBeTruthy();
  // fully to one side of the chip — never stacked on the day being edited
  const right = peekBox!.x >= chipBox!.x + chipBox!.width;
  const left = peekBox!.x + peekBox!.width <= chipBox!.x;
  expect(right || left).toBe(true);
  // top-aligned with the chip — or nudged UP by the on-screen clamp when
  // today rides the grid's last row (date-dependent geometry, SUB-547
  // lesson) — but never dropped BELOW it like the old under-the-anchor
  // placement, and never off the top of the screen
  expect(peekBox!.y).toBeLessThanOrEqual(chipBox!.y + 8);
  expect(peekBox!.y).toBeGreaterThanOrEqual(8);
});

test("the click that dismisses the peek never opens a composer where it lands (SUB-792)", async ({
  page,
}) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();

  // click ANOTHER day's cell to get out of the box — the peek closes and
  // that is ALL the click does: no new-entry composer on the day it hit.
  // Target an EMPTY non-today cell, picked from the live grid rather than a
  // fixed isoDay offset: a future offset can be off-grid when today rides
  // the grid's last cell, and yesterday's dense fixtures can fill a cell to
  // the edges (the SUB-547 date-dependent-geometry lesson). The fixtures
  // only populate ~14 distinct days, so an empty cell always exists.
  const empty = page
    .locator(`.cal-day:not([data-iso="${isoDay(0)}"])`)
    .filter({ hasNot: page.locator(".cal-entry") })
    .first();
  await empty.click();
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);

  // …the day's number button is also consumed by the dismissal
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await empty.locator(".cal-daynum").click();
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);

  // …and with nothing open, the same click composes exactly as before
  await empty.locator(".cal-daynum").click();
  await expect(page.locator(".cal-draft-input")).toBeFocused();
});

test("click opens the peek over the entry; Open note navigates", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click();

  const peek = page.locator(".cal-peek");
  await expect(peek).toBeVisible();
  await expect(peek.locator(".cal-peek-title")).toHaveValue("Umbra listening session");
  // date row humanized, time row empty (all-day), repeat None — and an
  // event's schema has no status prop, so there is no status row
  await expect(peek.locator(".cal-peek-key", { hasText: "Date" })).toHaveCount(1);
  await expect(peek.locator(".cal-peek-row", { hasText: "Date" })).toContainText(
    humanFull(isoDay(0))
  );
  await expect(peek.locator(".cal-peek-time")).toHaveValue("");
  await expect(peek.locator(".cal-peek-row", { hasText: "Repeat" })).toContainText("None");
  await expect(peek.locator(".cal-peek-key", { hasText: "Status" })).toHaveCount(0);
  // no navigation yet — the note is one explicit step away
  await expect(page.locator(".note-title")).toHaveCount(0);

  await peek.locator(".cal-peek-open").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");
});

test("double-click opens the note directly, skipping the peek", async ({ page }) => {
  await page
    .locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
      hasText: "Umbra listening session",
    })
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");
});

test("editing the time from the peek retimes the entry; clearing makes it all-day", async ({
  page,
}) => {
  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const chip = cell.locator(".cal-entry", { hasText: "Label sync call" });
  await expect(chip.locator(".cal-entry-time")).toHaveText("14:00");

  await chip.click();
  const peek = page.locator(".cal-peek");
  const time = peek.locator(".cal-peek-time");
  await expect(time).toHaveValue("14:00");

  // free-typed HH:MM, committed with Enter — the chip picks the new time up
  await time.fill("09:30");
  await time.press("Enter");
  await expect(chip.locator(".cal-entry-time")).toHaveText("09:30");
  await expect(peek).toBeVisible(); // same day, peek stays

  // empty = all-day: the value drops its time part
  await time.fill("");
  await time.press("Enter");
  await expect(cell.locator(".cal-entry", { hasText: "Label sync call" })).toBeVisible();
  await expect(
    cell.locator(".cal-entry", { hasText: "Label sync call" }).locator(".cal-entry-time")
  ).toHaveCount(0);
});

test("flipping status from the peek covers done-from-the-calendar", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Ship the patron download codes",
  });
  await chip.click();

  const peek = page.locator(".cal-peek");
  const statusRow = peek.locator(".cal-peek-row", { hasText: "Status" });
  await expect(statusRow).toContainText("todo");

  // the schema's options ride the shared SelectMenu
  await statusRow.click();
  await page.locator(".selmenu-item", { hasText: "done" }).click();
  await expect(statusRow).toContainText("done");
  await expect(peek).toBeVisible();
});

test("editing the date from the peek moves the entry and closes the peek", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click();

  const peek = page.locator(".cal-peek");
  await peek.locator(".cal-peek-row", { hasText: "Date" }).click();
  const input = page.locator(".datemenu .selmenu-input");
  await input.fill(isoDay(2));
  await input.press("Enter");

  // the entry left today — the peek's live-entry lookup misses and closes it
  await expect(peek).toHaveCount(0);
  await expect(
    page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
      hasText: "Umbra listening session",
    })
  ).toHaveCount(0);
  // …and rides the new day in the upcoming agenda
  await expect(
    page.locator(".cal-ag-item", { hasText: "Umbra listening session" })
  ).toBeVisible();
});

test("Escape and click-outside dismiss the peek", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-peek")).toHaveCount(0);

  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await page.locator(".cal-agenda-head").click();
  await expect(page.locator(".cal-peek")).toHaveCount(0);
});

test("the clicked entry stays highlighted while its peek is open (SUB-609)", async ({
  page,
}) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await expect(chip).not.toHaveClass(/selected/);

  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  // the chip the popover edits carries the selected tint — and only it
  await expect(chip).toHaveClass(/selected/);
  await expect(page.locator(".cal-entry.selected")).toHaveCount(1);

  // dismissing the peek releases the highlight
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await expect(chip).not.toHaveClass(/selected/);
});

test("the context menu's target entry highlights too (SUB-609)", async ({ page }) => {
  const chip = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await chip.click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(chip).toHaveClass(/selected/);

  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await expect(chip).not.toHaveClass(/selected/);
});

test("the title field renames the note", async ({ page }) => {
  // compose a probe on today so the rename never touches fixtures
  await page.locator(".cal .db-new", { hasText: "New" }).click();
  await page.locator(".cal-draft-input").fill("Peek rename probe");
  await page.locator(".cal-draft-input").press("Enter");

  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  await cell.locator(".cal-entry", { hasText: "Peek rename probe" }).click();
  const title = page.locator(".cal-peek-title");
  await title.fill("Renamed probe");
  await title.press("Enter");

  // the rename moves the path — the peek closes, the chip wears the new title
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await expect(cell.locator(".cal-entry", { hasText: "Renamed probe" })).toBeVisible();
  await expect(cell.locator(".cal-entry", { hasText: "Peek rename probe" })).toHaveCount(0);
});

test("a virtual occurrence gets series actions instead of date/time rows", async ({ page }) => {
  // Compose the probe on the grid's FIRST cell, not on today. The month grid
  // renders only the weeks that intersect the month (monthGridDays — "never a
  // dead trailing row"), so anchoring on today puts the next weekly occurrence
  // off-screen whenever today falls in the last week: on 2026-07-27 the grid
  // ended Aug 2 and today+7 was Aug 3, so the .nth(1) below matched nothing and
  // this spec was red for the last week of the month (SUB-547). Row one is
  // always on screen, and the grid is always >= 4 weeks, so anchor+7 always
  // lands in row two.
  const anchorIso = await page
    .locator(".cal-day")
    .first()
    .evaluate((el) => el.getAttribute("data-iso") ?? "");
  expect(anchorIso).toBeTruthy();
  const cell = page.locator(`.cal-day[data-iso="${anchorIso}"]`);
  await cell.locator(".cal-daynum").click();
  await page.locator(".cal-draft-input").fill("Peek series probe");
  await page.locator(".cal-draft-input").press("Enter");
  const anchorChip = cell.locator(".cal-entry", { hasText: "Peek series probe" });
  await anchorChip.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Repeat…" }).click();
  await page.locator(".selmenu-item", { hasText: "Weekly" }).click();

  // the anchor keeps the date/time rows
  await anchorChip.click();
  let peek = page.locator(".cal-peek");
  await expect(peek.locator(".cal-peek-key", { hasText: "Date" })).toHaveCount(1);
  await expect(peek.locator(".cal-peek-row", { hasText: "Repeat" })).toContainText("Weekly");
  await page.keyboard.press("Escape");

  // a later occurrence: series actions instead, delete reads as delete-all
  const later = page.locator(".cal-grid .cal-entry", { hasText: "Peek series probe" }).nth(1);
  const iso = await later.evaluate((el) => el.closest(".cal-day")?.getAttribute("data-iso"));
  expect(iso).toBeTruthy();
  await later.click();
  peek = page.locator(".cal-peek");
  await expect(peek.locator(".cal-peek-key", { hasText: "Date" })).toHaveCount(0);
  await expect(peek.locator(".cal-peek-time")).toHaveCount(0);
  await expect(peek.locator(".cal-peek-act", { hasText: "Skip this occurrence" })).toBeVisible();
  await expect(peek.locator(".cal-peek-del")).toHaveText("Delete all occurrences");

  // skip it: the occurrence vanishes, the anchor stays, the peek closes
  await peek.locator(".cal-peek-act", { hasText: "Skip this occurrence" }).click();
  await expect(peek).toHaveCount(0);
  await expect(
    page.locator(`.cal-day[data-iso="${iso}"] .cal-entry`, { hasText: "Peek series probe" })
  ).toHaveCount(0);
  await expect(anchorChip).toBeVisible();
});
