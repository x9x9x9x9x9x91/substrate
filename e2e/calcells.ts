import { expect, type Locator, type Page } from "@playwright/test";

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
    vertical room (`ALLDAY_CAP`, src/components/CalendarPane.tsx:123). */
export const ALLDAY_CAP = 3;

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

/** Opt-in date travel for the calendar specs: `E2E_TODAY=2026-02-28 npx
    playwright test e2e/weekview.spec.ts` runs the whole spec as if that were
    today — the date-independence probe these specs earned the hard way.
    Everything moves together: `applyFakeToday` pins the page's clock, so the
    seeds date themselves around the fake day (they read `Date.now()` at module
    eval), and `todayBase()` gives the spec side the same day to build its
    expected ISO/label strings from. Unset — every gate run — both are the
    plain wall clock and this file is inert.

    Local noon, not midnight: far enough from either edge that no local/UTC
    slice in the app or the fixture lands on the neighbouring day. */
function fakeToday(): Date | null {
  const iso = process.env.E2E_TODAY?.trim();
  if (!iso) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`E2E_TODAY must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** The day the spec should treat as today — the faked one under E2E_TODAY,
    else now. A fresh Date every call: callers mutate it. */
export function todayBase(): Date {
  return fakeToday() ?? new Date();
}

export async function applyFakeToday(page: Page): Promise<void> {
  const fake = fakeToday();
  if (fake) await page.clock.setFixedTime(fake);
}
