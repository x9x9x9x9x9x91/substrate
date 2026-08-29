import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Frozen Name column: on the wide Ledger fixture (16
// props + Name + the ＋ column) the first column pins to the pane's left
// edge under horizontal scroll and carries its freeze cue only while
// scrolled; a narrow table never flips the gate. With grid lines on
// (the default) the first column always shows the SOFT lattice line — the
// freeze cue is the STRONGER --line-panel twin when scrolled, so the two
// states stay distinguishable by weight. Runs against the
// deterministic mock backend (fresh page = fresh vault).

// the grid hairline (--line-panel-soft) vs the freeze cue (--line-panel) —
// asserted by computed value so a token swap that erases the distinction
// fails here
const GRID_EDGE = "rgb(30, 30, 31) -1px 0px 0px 0px inset";
const FREEZE_EDGE = "rgb(38, 38, 38) -1px 0px 0px 0px inset";

async function openDbFresh(page: Page, name: string) {
  await page.goto("/");
  await openDb(page, name);
}

const firstTh = (page: Page) => page.locator(".db-table th").first();
const secondTh = (page: Page) => page.locator(".db-table th").nth(1);
const firstTd = (page: Page) => page.locator(".db-table tbody tr").first().locator("td").first();

test("wide table: the Name column stays pinned and gains its cue after scrolling right", async ({
  page,
}) => {
  await openDbFresh(page, "Ledger");
  const body = page.locator(".db-body");

  // the fixture must actually overflow, or this test proves nothing
  const dims = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeGreaterThan(dims.cw);

  // at scroll 0 the gate is closed: only the soft grid hairline, no freeze cue
  await expect(body).not.toHaveClass(/db-scrolled-x/);
  const shadowAt0 = await firstTh(page).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadowAt0).toBe(GRID_EDGE);

  const paneLeft = (await body.boundingBox())!.x;
  const pinnedX0 = (await firstTd(page).boundingBox())!.x;
  const secondX0 = (await secondTh(page).boundingBox())!.x;
  const title = (await firstTd(page).textContent())!.trim();
  expect(title.length).toBeGreaterThan(0);

  await body.evaluate((el) => {
    el.scrollLeft = 600;
  });

  // the gate flips and the stronger freeze line replaces the grid hairline
  await expect(body).toHaveClass(/db-scrolled-x/);
  const shadow = await firstTh(page).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toBe(FREEZE_EDGE);

  // the first column never moved — still in view at the pane's left edge,
  // showing its own content rather than a sliver of the next column
  const pinnedBox = (await firstTd(page).boundingBox())!;
  expect(pinnedBox.x).toBeGreaterThanOrEqual(paneLeft - 0.5);
  expect(Math.abs(pinnedBox.x - pinnedX0)).toBeLessThan(1);
  await expect(firstTd(page)).toHaveText(title);

  // and the scroll really happened beneath the pin: the second column's
  // header slid ~600px left of where it started
  const secondX1 = (await secondTh(page).boundingBox())!.x;
  expect(secondX1).toBeLessThan(secondX0 - 500);
});

test("narrow table: no overflow, no gate, no edge cue", async ({ page }) => {
  await openDbFresh(page, "Contact");
  const body = page.locator(".db-body");

  // this fixture fits the pane — the freeze must stay invisible
  const dims = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeLessThanOrEqual(dims.cw + 1);

  // a scroll attempt clamps to 0: the gate never flips, the freeze cue never
  // paints — the edge stays the soft grid hairline
  await body.evaluate((el) => {
    el.scrollLeft = 300;
  });
  await expect(body).not.toHaveClass(/db-scrolled-x/);
  const shadow = await firstTh(page).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toBe(GRID_EDGE);
});
