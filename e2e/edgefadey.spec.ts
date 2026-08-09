import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// The shared vertical edge fade. One gate — useEdgeFade() plus
// .edge-fade-y in styles.css — now serves the settings sheet, the calendar's
// Upcoming rail, the charts dashboard and the database manager, replacing what
// would otherwise have been four bespoke fades. Same contract as the table edges and the
// sidebar tree: .edge-more-y paints only while the scroller can move
// down, .edge-scrolled-y only while it is off the top stop, so the row at a
// stop always renders crisp and a surface that fits fades neither end.
// Runs against the deterministic mock backend (fresh page = fresh vault).

/** Scroll to the very bottom and let the onScroll gate settle. */
async function toBottom(page: Page, sel: string) {
  await page.locator(sel).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(sel)).toHaveClass(/edge-scrolled-y/);
}

test("settings sheet: fades down, never at the bottom stop", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  const body = page.locator(".shortcut-sheet-body");
  await expect(body).toBeVisible();

  // the sheet must actually overflow at this viewport, or this proves nothing
  const dims = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  // top: more below, nothing clipped above
  await expect(body).toHaveClass(/edge-more-y/);
  await expect(body).not.toHaveClass(/edge-scrolled-y/);

  // bottom stop: the last row ("Show app files") renders crisp — this is the
  // Defect itself, where the fade used to be unconditional
  await toBottom(page, ".shortcut-sheet-body");
  await expect(body).not.toHaveClass(/edge-more-y/);
  const maskAtBottom = await body.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAtBottom).toBe("linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)");

  // and the last row is inside the scroller's box, not clipped by it
  const clear = await body.evaluate((el) => {
    const last = el.lastElementChild;
    if (!last) return null;
    return last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  });
  expect(clear).not.toBeNull();
  expect(clear!).toBeLessThanOrEqual(1);
});

test("calendar Upcoming rail: fade gated on the rail's own overflow", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calendar" }).first().click();
  const rail = page.locator(".cal-agenda-body");
  await expect(rail).toBeVisible();

  const dims = await rail.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  await expect(rail).toHaveClass(/edge-more-y/);
  expect(await rail.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  await toBottom(page, ".cal-agenda-body");
  await expect(rail).not.toHaveClass(/edge-more-y/);
});

test("expanded month cell: fade gated on the cell's own overflow", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calendar" }).first().click();
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  // today's fixture day holds enough entries to overflow its cell once
  // expanded — that overflow is what the fade must mark
  await page.locator(".cal-more").first().click();
  const cell = page.locator(".cal-day.expanded");
  await expect(cell).toBeVisible();
  const dims = await cell.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  await expect(cell).toHaveClass(/edge-more-y/);
  expect(await cell.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  // bottom stop: the last entry row renders crisp
  await toBottom(page, ".cal-day.expanded");
  await expect(cell).not.toHaveClass(/edge-more-y/);
});

test("charts dashboard: bottom fade while charts continue past the pane", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item")
    .filter({ has: page.getByText("Overview", { exact: true }) })
    .first()
    .click();
  const note = page.locator(".note.edge-fade-y");
  await expect(note).toBeVisible();

  const dims = await note.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  await expect(note).toHaveClass(/edge-more-y/);
  await toBottom(page, ".note.edge-fade-y");
  await expect(note).not.toHaveClass(/edge-more-y/);
});

test("database manager: fades only at the heights where the list overflows", async ({ page }) => {
  // the list fits a 900px window and overflows a 600px one, so the same surface
  // proves both halves of the gate
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const body = page.locator(".dbmgr-body");
  await expect(body).toBeVisible();

  const dims = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);
  await expect(body).toHaveClass(/edge-more-y/);

  // scrolled: a top fade marks the rows above, and the bottom one is gone
  await toBottom(page, ".dbmgr-body");
  await expect(body).not.toHaveClass(/edge-more-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)",
  );

  // tall enough to fit: no fade at either end
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(body).not.toHaveClass(/edge-more-y/);
  await expect(body).not.toHaveClass(/edge-scrolled-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});

test("board column body: fade gated on the column's own overflow (SUB-1211)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // 260 perf rows put ~87 cards in each status column — far past one screen
  await page.goto("/?perfdb=260");
  await openDb(page, "Plugin");
  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();

  const body = page.locator(".db-col-body").first();
  const dims = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  // top: more below, nothing clipped above
  await expect(body).toHaveClass(/edge-more-y/);
  await expect(body).not.toHaveClass(/edge-scrolled-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  // bottom stop: the last card (and the + New button) render crisp
  await toBottom(page, ".db-col-body >> nth=0");
  await expect(body).not.toHaveClass(/edge-more-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)",
  );

  // a column that fits (the draft-only view after filtering to nothing is
  // overkill here — assert on the mock's Release board instead, whose
  // columns hold a handful of cards each)
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();
  const relBody = page.locator(".db-col-body").first();
  await expect(relBody).toBeVisible();
  const relDims = await relBody.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(relDims.sh).toBeLessThanOrEqual(relDims.ch + 1);
  await expect(relBody).not.toHaveClass(/edge-more-y/);
  expect(await relBody.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});

test("list + gallery bodies: fade gated on the view's own overflow (SUB-1212)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // 260 perf rows overflow any viewport in both layouts
  await page.goto("/?perfdb=260");
  await openDb(page, "Plugin");
  await page.locator('.db-switch button[title="List"]').click();
  const list = page.locator(".db-body.db-list");
  await expect(list).toBeVisible();

  const listDims = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(listDims.sh).toBeGreaterThan(listDims.ch);

  // top: more below, nothing clipped above
  await expect(list).toHaveClass(/edge-more-y/);
  await expect(list).not.toHaveClass(/edge-scrolled-y/);
  expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  // bottom stop: the last row renders crisp
  await toBottom(page, ".db-body.db-list");
  await expect(list).not.toHaveClass(/edge-more-y/);
  expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)",
  );

  // gallery: same gate on the same fixture
  await page.locator('.db-switch button[title="Gallery"]').click();
  const gal = page.locator(".db-body.db-gallery");
  await expect(gal).toBeVisible();
  const galDims = await gal.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(galDims.sh).toBeGreaterThan(galDims.ch);
  await expect(gal).toHaveClass(/edge-more-y/);
  await toBottom(page, ".db-body.db-gallery");
  await expect(gal).not.toHaveClass(/edge-more-y/);

  // a list that fits its pane fades neither end (mock Contact db: 4 rows)
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator('.db-switch button[title="List"]').click();
  const small = page.locator(".db-body.db-list");
  await expect(small).toBeVisible();
  const smallDims = await small.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(smallDims.sh).toBeLessThanOrEqual(smallDims.ch + 1);
  await expect(small).not.toHaveClass(/edge-more-y/);
  expect(await small.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});

test("Today's day scroller: fade gated on the day's own overflow (SUB-1215)", async ({
  page,
}) => {
  // short window: the fixture day (three lanes, ~14 rows) overflows
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Today" }).click();
  const day = page.locator(".today-scroll");
  await expect(day).toBeVisible();

  const dims = await day.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  // top: more below, nothing clipped above
  await expect(day).toHaveClass(/edge-more-y/);
  await expect(day).not.toHaveClass(/edge-scrolled-y/);
  expect(await day.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  // bottom stop: the last lane renders crisp
  await toBottom(page, ".today-scroll");
  await expect(day).not.toHaveClass(/edge-more-y/);
  expect(await day.evaluate((el) => getComputedStyle(el).maskImage)).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)",
  );

  // a day that fits its window fades neither end
  await page.setViewportSize({ width: 1280, height: 1200 });
  await expect(day).not.toHaveClass(/edge-more-y/);
  await expect(day).not.toHaveClass(/edge-scrolled-y/);
  const fits = await day.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(fits.sh).toBeLessThanOrEqual(fits.ch + 1);
  expect(await day.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});
