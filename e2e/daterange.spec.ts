import { expect, test } from "./fixtures";
import { todayBase } from "./clock";

// Date ranges: a date prop may carry an end — `start/end` — and the
// picker draws one. These specs walk the whole path: toggle Range in the date
// menu, click two days, and assert the committed value, the collapsed chip
// text, the multi-day span on the calendar, and that clearing the end puts a
// plain single date back.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = todayBase();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
});

/** Open "Call with Gero" (tomorrow, all-day) and return its date chip. */
async function openGeroDateChip(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal-ag-item", { hasText: "Call with Gero" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Call with Gero");
  const chip = page
    .locator(".chip")
    .filter({ has: page.locator(".chip-key", { hasText: "date" }) });
  await chip.click();
  return chip;
}

test("DateMenu: Range picks a start and an end, and the chip collapses it", async ({ page }) => {
  const chip = await openGeroDateChip(page);
  const menu = page.locator(".datemenu");
  await expect(menu).toBeVisible();

  // off by default — one click would commit a single date
  const range = menu.locator(".selmenu-btn", { hasText: "Range" });
  await expect(range).not.toHaveClass(/\bon\b/);
  await range.click();
  await expect(range).toHaveClass(/\bon\b/);

  // the value's own day is armed as the start; click three days later to close
  await expect(menu.locator(".datemenu-parse")).toContainText("pick the end day");
  await menu.locator(`.datemenu-day[data-iso="${isoDay(4)}"]`).click();
  await expect(menu).toHaveCount(0);

  // the chip shows one collapsed range, not two dates
  await expect(chip.locator(".chip-val")).toContainText("–");
});

test("a range spans every day it covers on the calendar", async ({ page }) => {
  const chip = await openGeroDateChip(page);
  const menu = page.locator(".datemenu");
  await menu.locator(".selmenu-btn", { hasText: "Range" }).click();
  // start on tomorrow (already armed), close on the day after next
  await menu.locator(`.datemenu-day[data-iso="${isoDay(2)}"]`).click();
  await expect(menu).toHaveCount(0);
  await expect(chip.locator(".chip-val")).toContainText("–");

  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  // every covered day carries a chip, tagged by its position in the span
  for (const [offset, pos] of [
    [1, "start"],
    [2, "end"],
  ] as const) {
    const cell = page.locator(`.cal-day[data-iso="${isoDay(offset)}"]`);
    const more = cell.locator(".cal-more");
    if (await more.count()) await more.click();
    const entry = cell.locator(".cal-entry", { hasText: "Call with Gero" });
    await expect(entry).toHaveClass(new RegExp(`\\bspan\\b.*\\b${pos}\\b`));
  }
});

test("turning Range off reverts the value to a plain single date", async ({ page }) => {
  const chip = await openGeroDateChip(page);
  const menu = page.locator(".datemenu");
  await menu.locator(".selmenu-btn", { hasText: "Range" }).click();
  await menu.locator(`.datemenu-day[data-iso="${isoDay(3)}"]`).click();
  await expect(chip.locator(".chip-val")).toContainText("–");

  // re-open: a range value opens the picker already in range mode
  await chip.click();
  const range = page.locator(".datemenu .selmenu-btn", { hasText: "Range" });
  await expect(range).toHaveClass(/\bon\b/);
  await range.click();
  // the end is dropped, the start stands alone
  await expect(chip.locator(".chip-val")).not.toContainText("–");
});

// On a SAME-DAY range the two endpoints can be written out of order
// (a timed start against a day-only end sorts as reversed), which made
// splitDateRange reject the value and the note disappear from every calendar
// surface. This walks the two same-day write paths a user can reach from the
// UI — closing a range on the day it starts, then timing it from the peek —
// and asserts the entry survives both.
test("a same-day range survives being timed from the peek (SUB-631)", async ({ page }) => {
  await openGeroDateChip(page);
  const menu = page.locator(".datemenu");
  await menu.locator(".selmenu-btn", { hasText: "Range" }).click();
  // close the range on the very day it starts — a one-day range
  await menu.locator(`.datemenu-day[data-iso="${isoDay(1)}"]`).click();
  await expect(menu).toHaveCount(0);

  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  const cell = page.locator(`.cal-day[data-iso="${isoDay(1)}"]`);
  const more = cell.locator(".cal-more");
  if (await more.count()) await more.click();
  const entry = cell.locator(".cal-entry", { hasText: "Call with Gero" });
  await expect(entry).toBeVisible();

  // the peek's Time row on a one-day range used to write `day 09:00/day`
  await entry.click();
  const peek = page.locator(".cal-peek");
  const time = peek.locator(".cal-peek-time");
  await expect(time).toHaveValue("");
  await time.fill("09:00");
  await time.press("Enter");

  // still on the calendar, now timed — not vanished
  await expect(cell.locator(".cal-entry", { hasText: "Call with Gero" })).toBeVisible();
  await expect(
    cell.locator(".cal-entry", { hasText: "Call with Gero" }).locator(".cal-entry-time")
  ).toHaveText("09:00");
});

// The peek used to read "not the span's first day" as "virtual series
// occurrence" and offer Skip / Delete-this-and-following on a plain date range.
// Both wrote repeat_skip / repeat_until onto a note with no `repeat:` — nothing
// re-rendered, but the keys stayed, ready to hole a series added later.
test("a range's continuation day gets date/time rows, not series actions", async ({ page }) => {
  await openGeroDateChip(page);
  const menu = page.locator(".datemenu");
  await menu.locator(".selmenu-btn", { hasText: "Range" }).click();
  // start tomorrow (already armed), close two days later — day 2 is a tail
  await menu.locator(`.datemenu-day[data-iso="${isoDay(3)}"]`).click();
  await expect(menu).toHaveCount(0);

  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  const cell = page.locator(`.cal-day[data-iso="${isoDay(2)}"]`);
  const more = cell.locator(".cal-more");
  if (await more.count()) await more.click();
  const entry = cell.locator(".cal-entry", { hasText: "Call with Gero" });
  await expect(entry).toHaveClass(/\bspan\b.*\bmid\b/);

  // the peek on that mid day: the ordinary rows, no series verbs
  await entry.click();
  const peek = page.locator(".cal-peek");
  await expect(peek.locator(".cal-peek-key", { hasText: "Date" })).toHaveCount(1);
  await expect(peek.locator(".cal-peek-time")).toHaveCount(1);
  await expect(peek.locator(".cal-peek-act", { hasText: "Skip this occurrence" })).toHaveCount(0);
  await expect(
    peek.locator(".cal-peek-act", { hasText: "Delete this and following" })
  ).toHaveCount(0);
  // no series, so the delete reads as the plain one
  await expect(peek.locator(".cal-peek-del")).toHaveText("Delete");
  // the Date row shows the whole stored range, read through the start
  await expect(peek.locator(".cal-peek-row", { hasText: "Date" })).toContainText("–");
  await page.keyboard.press("Escape");

  // and the note carries no repeat bookkeeping — the stale keys never landed
  await page.locator(".cal-ag-item", { hasText: "Call with Gero" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Call with Gero");
  for (const key of ["repeat_skip", "repeat_until"]) {
    await expect(page.locator(".chip-key", { hasText: key })).toHaveCount(0);
  }
});
