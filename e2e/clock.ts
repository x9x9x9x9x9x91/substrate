import { type Page } from "@playwright/test";

/** The day the whole e2e suite treats as today.

    The mock vault mixes two kinds of fixture date: relative ones that date
    themselves off `Date.now()` at module eval (`day(0)` in
    src/lib/mockseeds.ts), and a handful of ABSOLUTE ones — the release arc
    is `created: 2026-07-17` with releases on 2026-05-30 / 06-19 / 08-01 /
    08-23. Anything the app draws by comparing today against an absolute
    fixture therefore has a shelf life: the hub timeline draws its today
    marker only while today falls inside the fixture-derived span, and that
    span ended on 2026-08-25. The spec that asserts the marker was green for
    a year and red for everyone at once the morning after — at that commit
    and at every commit before it, because nothing in the tree had changed.

    So the suite states its own today instead of borrowing the calendar's.
    The day below is chosen to satisfy every absolute fixture at once: inside
    the hub timeline's padded span (2026-07-15 – 2026-08-25) with room on both
    sides, after the yield board's fourteen fixed snapshots (through
    2026-07-30) so a snapshot added during a test is still the newest, and off
    the release days themselves so no fixture lands ON today by accident.
    Relative fixtures move with it and keep meaning what they meant. Moving
    the pin means re-checking that list. The screenshot specs sit outside it:
    they freeze their own earlier day (`FIXED_TIME`, 2026-06-17) on top of
    this pin, so their baselines show no today marker and don't move when
    this pin does.

    `E2E_TODAY=2026-02-28 npx playwright test e2e/weekview.spec.ts` runs the
    suite as if that were today — the date-independence probe the calendar
    specs earned the hard way. `E2E_TODAY=live` hands the wall clock back for
    a one-off comparison. */
export const PINNED_TODAY = "2026-08-04";

/** Local noon, not midnight: far enough from either edge that no local/UTC
    slice in the app or the fixture lands on the neighbouring day. */
function atNoon(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** The instant the page clock is pinned to, or null when the run asked for
    the wall clock (`E2E_TODAY=live`). */
export function pinnedInstant(): Date | null {
  const raw = process.env.E2E_TODAY?.trim();
  if (raw === "live") return null;
  if (!raw) return atNoon(PINNED_TODAY);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`E2E_TODAY must be YYYY-MM-DD or "live", got ${JSON.stringify(raw)}`);
  }
  return atNoon(raw);
}

/** The day the spec side should build its expected ISO/label strings from —
    the same day the page believes it is. A fresh Date every call: callers
    mutate it. */
export function todayBase(): Date {
  return pinnedInstant() ?? new Date();
}

/** Pin one page's clock explicitly, the same way ./fixtures pins every
    context it hands out — installed and resumed, so the date is fixed but
    durations still elapse (a frozen Date is a different app). Only for a
    page a spec opened itself off a raw browser/context; fixture pages are
    already pinned. */
export async function applyFakeToday(page: Page): Promise<void> {
  const at = pinnedInstant();
  if (at) {
    await page.clock.install({ time: at });
    await page.clock.resume();
  }
}
