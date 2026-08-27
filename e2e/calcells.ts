import { expect, type Locator } from "@playwright/test";

// Calendar cell density is a function of the calendar, not a constant.
// The mock vault dates most of its entries relative to the day the app opens
// (`day(0)` in src/lib/mockseeds.ts), but a handful of fixtures carry FIXED
// dates that drift onto today as the year runs — `Fern Palace` ships
// `released: "2026-08-23"`, and `released` is a date-kind prop, so on that one
// day the release lands in today's cell beside the seven relative ones. Specs
// that hard-coded "+5 more" / 7 expanded cards were green all year and red for
// everyone at once on that day — the same class of breakage as the calendar
// recurrence specs that assumed the next weekly occurrence was on screen, one
// surface over.
//
// So the count is READ, never assumed. Nothing downstream of the read is
// loosened: the caps below are product constants, the control has to name the
// exact number it shows, and expanding has to reveal exactly that many more
// entries — a wrong overflow label or a broken expand still fails.

/** Month cells show at most this many chips before "+N more"
    (`MONTH_CAP`, src/components/CalendarPane.tsx:119). */
export const MONTH_CAP = 4;
/** The week's all-day strip caps its cards lower — the canvas owns the
    vertical room, and the cap has to be what fits the strip at its worst
    case: a day of wrapping three-line titles sliced the third card and the
    "+N more" chip with it (`ALLDAY_CAP`, src/components/CalendarPane.tsx). */
export const ALLDAY_CAP = 2;

/** The N behind a collapsed cell's "+N more", read off the control itself.
    Asserts the cell is actually overflowing — a day that stopped overflowing
    fails here rather than passing vacuously. */
export async function overflowCount(cell: Locator): Promise<number> {
  const more = cell.locator('.cal-more[aria-expanded="false"]');
  await expect(more).toBeVisible();
  const label = ((await more.textContent()) ?? "").trim();
  const m = /^\+(\d+) more$/.exec(label);
  expect(
    m,
    `collapsed overflow control should read "+N more", got ${JSON.stringify(label)}`
  ).not.toBeNull();
  const n = Number(m![1]);
  expect(n).toBeGreaterThan(0);
  return n;
}

/** The calendar specs build their expected ISO/label strings from the same
    pinned day the page believes it is, and re-export it so a spec needs one
    import for cells and dates both. ./clock owns the pin. */
export { todayBase } from "./clock";
