import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Grow-only column floors on a WINDOWED table. The table lays out auto, so a
// column is as wide as its widest painted cell — and a windowed tbody paints
// only the scroll viewport, so without the floors a column snaps narrower the
// moment its widest cell leaves the slice, taking scrollWidth (and with it the
// horizontal scroll position) along for the ride. The fixture is the perf
// plugin database: past WIN_MIN rows, and its Name/developer values differ
// enough in length that the window slide genuinely changes what "widest" means.

const PERF = "/?perfdb=140";

// widths of the data headers; the trailing ＋ add column is excluded because it
// is chrome rather than a column of the data, and carries its own fixed width
// Floored, not rounded, to match how the floors themselves are taken: a column
// that wants 187.6px floors at 187 and lays out at exactly 187 on a slice where
// the floor binds. Rounding here would read those two states as 188 and 187 and
// call the second a shrink.
const headWidths = (page: Page) =>
  page
    .locator(".db-table thead th:not(.db-th-add)")
    .evaluateAll((ths) => ths.map((t) => Math.floor(t.getBoundingClientRect().width)));

// a scroll step plus the frames React needs to re-window, re-measure and emit
async function scrollTo(page: Page, top: number) {
  await page.locator(".db-body").evaluate((el, y) => {
    el.scrollTop = y;
    el.dispatchEvent(new Event("scroll"));
  }, top);
  await page.waitForTimeout(120);
}

// the header right-click checklist: one click toggles one property
async function toggleCol(page: Page, name: string) {
  await page.locator(".db-table thead").click({ button: "right" });
  const menu = page.locator(".propvis");
  await expect(menu).toBeVisible();
  await menu.locator(".propvis-item", { hasText: name }).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.waitForTimeout(150);
}

const overflow = (page: Page) =>
  page.locator(".db-body").evaluate((el) => el.scrollWidth - el.clientWidth);

// The fixture is wider than any sane viewport with all nine properties on, and
// two of the tests here are about a table that FITS — so they thin it out first
// rather than skip themselves on a geometry they could have arranged. A skip
// would read as coverage while proving nothing.
async function openWindowedThatFits(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openWindowed(page);
  for (const c of ["link", "created", "version", "format"]) await toggleCol(page, c);
  await page.waitForTimeout(200);
  expect(await overflow(page), "the thinned fixture still overflows").toBeLessThanOrEqual(1);
}

async function openWindowed(page: Page) {
  await page.goto(PERF);
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  await page.waitForTimeout(200);
}

test("a windowed table's columns never narrow while scrolling, and a return sweep moves nothing", async ({
  page,
}) => {
  await openWindowed(page);

  let prev = await headWidths(page);
  expect(prev.length).toBeGreaterThan(2);
  const downs: number[][] = [prev];
  // well past a single window's worth of rows: WIN_ROW_H is 32, so each step
  // slides the painted slice several rows on
  for (const top of [400, 900, 1500, 2200, 3000, 3800]) {
    await scrollTo(page, top);
    const now = await headWidths(page);
    expect(now.length).toBe(prev.length);
    for (let i = 0; i < now.length; i++) {
      expect(
        now[i],
        `column ${i} narrowed from ${prev[i]} to ${now[i]} at scrollTop ${top}`
      ).toBeGreaterThanOrEqual(prev[i]);
    }
    downs.push(now);
    prev = now;
  }
  // at least one column actually had to grow, or the fixture proves nothing
  const first = downs[0];
  expect(prev.some((w, i) => w > first[i])).toBe(true);

  // the sweep has converged: coming back up re-paints slices already measured,
  // so nothing may move in either direction now
  const settled = prev;
  for (const top of [3000, 2200, 1500, 900, 400, 0]) {
    await scrollTo(page, top);
    expect(await headWidths(page)).toEqual(settled);
  }
});

// A shrinking column pulls scrollWidth in with it, and the browser clamps
// scrollLeft to whatever is left — the "jumps around and doesn't go properly to
// the left" half of the fault. Both a mid-range and a hard-right position are
// checked: only the right edge is actually clampable, so it is the sharper
// probe, while mid-range is the position a diagonal gesture passes through.
for (const [where, frac] of [
  ["mid-range", 0.5],
  ["at the right edge", 1],
] as const) {
  test(`vertical scrolling leaves a horizontal position ${where} alone`, async ({ page }) => {
    await openWindowed(page);

    const body = page.locator(".db-body");
    const target = await body.evaluate((el, f) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) * f);
      el.dispatchEvent(new Event("scroll"));
      return el.scrollLeft;
    }, frac);
    expect(target).toBeGreaterThan(0);
    await page.waitForTimeout(120);

    // the same sweep the width test uses, out and back: the widths that move
    // are the ones that move scrollWidth, so this is where a clamp would land
    for (const top of [400, 900, 1500, 2200, 3000, 3800, 2200, 900, 400, 0]) {
      await scrollTo(page, top);
      expect(
        await body.evaluate((el) => el.scrollLeft),
        `scrollLeft moved at scrollTop ${top}`
      ).toBe(target);
    }
  });
}

test("a resize drag still wins over the floor, in both directions, and reset returns", async ({
  page,
}) => {
  await openWindowed(page);
  // one sweep so the column carries a real floor before the drag. The Name
  // column is the one to drag: its header label is short, so nothing but the
  // floor is holding it wide — a property header's own nowrap label pins its
  // column well above MIN_COL_W and would mask the thing under test.
  const atRest = (await page.locator(".db-table thead th").first().boundingBox())!.width;
  await scrollTo(page, 2000);
  await scrollTo(page, 0);

  const th = page.locator(".db-table thead th").first();
  const floored = (await th.boundingBox())!.width;
  // the sweep left the column wider than the first paint did, so what the drag
  // below is fighting really is a floor and not just the column's own content
  expect(floored).toBeGreaterThan(atRest);

  // drag NARROWER than the floor — the committed width outranks it
  const handle = th.locator(".db-th-resize");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 50, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const narrowed = (await th.boundingBox())!.width;
  expect(narrowed).toBeLessThan(floored - 30);

  // and it stays narrow across further window slides — no floor creeps under it
  await scrollTo(page, 2600);
  expect(Math.abs((await th.boundingBox())!.width - narrowed)).toBeLessThan(3);

  // the other direction, which the floor has no quarrel with but which a
  // committed width could still get wrong: drag it back out past the floor
  const wideFrom = (await th.locator(".db-th-resize").boundingBox())!;
  await page.mouse.move(wideFrom.x + wideFrom.width / 2, wideFrom.y + wideFrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(wideFrom.x + wideFrom.width / 2 + 120, wideFrom.y + wideFrom.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const widened = (await th.boundingBox())!.width;
  expect(widened).toBeGreaterThan(floored);
  await scrollTo(page, 1200);
  expect(Math.abs((await th.boundingBox())!.width - widened)).toBeLessThan(3);

  // double-click resets to auto; the column re-enters the floor set instead of
  // bouncing between the two rules
  await scrollTo(page, 0);
  await th.locator(".db-th-resize").dblclick();
  await page.waitForTimeout(200);
  const reset = (await th.boundingBox())!.width;
  expect(reset).toBeGreaterThan(narrowed);
  for (const top of [1500, 2600, 0]) {
    await scrollTo(page, top);
    expect((await th.boundingBox())!.width).toBeGreaterThanOrEqual(reset);
  }
});

test("narrowing the pane lets the columns reflow instead of overflowing forever", async ({
  page,
}) => {
  // Widen first, so the floors are taken at a size the narrow pane cannot
  // afford: a table that already overflows has its columns at their content
  // widths, and narrowing the pane below that legitimately changes nothing.
  // Widening hands every column a share of the surplus, and those inflated
  // widths are exactly what must NOT survive the pane shrinking again.
  await page.setViewportSize({ width: 1500, height: 800 });
  await openWindowed(page);
  await scrollTo(page, 2400);
  await scrollTo(page, 0);
  const wide = await headWidths(page);

  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400);
  const narrow = await headWidths(page);
  expect(
    narrow.some((w, i) => w < wide[i]),
    "no column reflowed — the floors outlived the pane width they were measured at"
  ).toBe(true);

  // and the fresh floors hold from there
  await scrollTo(page, 1600);
  const slid = await headWidths(page);
  for (let i = 0; i < slid.length; i++) expect(slid[i]).toBeGreaterThanOrEqual(narrow[i]);
});

test("hiding a column and bringing it back does not leave the table overflowing", async ({
  page,
}) => {
  // Hiding hands the freed width to the survivors, which floor at the inflated
  // size; without dropping the floors on a change of column SET, the returning
  // column would have nowhere to go and the table would overflow for good.
  await openWindowedThatFits(page);

  await scrollTo(page, 2400);
  await toggleCol(page, "developer");
  await scrollTo(page, 3200);
  await scrollTo(page, 0);
  await toggleCol(page, "developer"); // the same click checks it back on
  await page.waitForTimeout(250);

  const over = await overflow(page);
  expect(over, `${over}px of overflow survived the column coming back`).toBeLessThanOrEqual(1);
});

test("a table under the windowing threshold emits no floors at all", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(page.locator(".db-win-spacer")).toHaveCount(0);
  await page.waitForTimeout(200);

  // the pane's only stylesheet is the committed widths/wrap one, and an
  // untouched fixture has committed neither — so a short table renders no
  // <style> at all, floors or otherwise
  await expect(page.locator(".db-body style")).toHaveCount(0);
});

test("a windowed table that fits its pane does not gain overflow from the floors", async ({
  page,
}) => {
  // A floor that sits even a fraction above the width it was measured at is a
  // constraint the layout does not meet, and enough columns of that pushes a
  // table which exactly fits into a scrollbar it never needed. This is the
  // guard that caught rounding up (3px) and would catch it coming back.
  await openWindowedThatFits(page);

  // A long sweep on purpose. While the table fits, its spare width is shared
  // out among the columns, so what a column is MEASURED at is wider than what
  // it needs — and taking a per-column maximum over many slices can in
  // principle add up widths that never coexisted in one layout. Every slice of
  // the table gets a look, so an alternating widest-column pattern has room to
  // show itself rather than being ruled out by three samples.
  const height = await page.locator(".db-body").evaluate((el) => el.scrollHeight);
  for (let i = 0; i <= 16; i++) {
    const top = Math.round((height * i) / 16);
    await scrollTo(page, top);
    const over = await overflow(page);
    expect(over, `gained ${over}px of overflow at scrollTop ${top}`).toBeLessThanOrEqual(1);
  }
  // and back, where the accumulated floors are all in force at once
  for (let i = 16; i >= 0; i -= 2) {
    await scrollTo(page, Math.round((height * i) / 16));
    const over = await overflow(page);
    expect(over, `gained ${over}px of overflow returning`).toBeLessThanOrEqual(1);
  }
});
