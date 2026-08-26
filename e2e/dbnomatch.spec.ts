import { expect, test, type Page } from "./fixtures";
import { openDb, openFilter } from "./nav";

// The dead-end "No matches" state is one message about the whole pane, so
// every layout has to hand it the whole pane. The board already did; the
// gallery dropped it into the grid's first cell, where it rendered as a
// ~188px fragment against the top-left corner.

async function emptyBox(page: Page, layout: string, scroller: string) {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator(`.db-switch button[title="${layout}"]`).click();
  const body = page.locator(scroller);
  await expect(body).toBeVisible();

  const input = await openFilter(page);
  await input.fill("zzzznothingmatchesthis");

  const empty = body.locator(".empty", { hasText: "No matches" });
  await expect(empty).toBeVisible();
  const box = await empty.boundingBox();
  const pane = await body.boundingBox();
  expect(box).not.toBeNull();
  expect(pane).not.toBeNull();
  // a state sized to the padding box would leave the scroller scrollable by
  // its own padding, with nothing under the fold to scroll to
  const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
  return { box: box!, pane: pane! };
}

// the state claims the pane's width and its centre line -- a fragment in the
// first grid cell sits at ~1/8 the width, hard against the left edge
function expectsPaneWide(box: { x: number; width: number }, pane: { x: number; width: number }) {
  expect(box.width).toBeGreaterThan(pane.width * 0.8);
  expect(box.x + box.width / 2).toBeCloseTo(pane.x + pane.width / 2, 0);
}

test("gallery: the no-match state fills the pane instead of the first cell (SUB-1228)", async ({
  page,
}) => {
  const { box, pane } = await emptyBox(page, "Gallery", ".db-gallery");
  expectsPaneWide(box, pane);
  // and it takes real height: the grid's max-content rows used to crush the
  // shell's height:100% to the glyph plus two lines
  expect(box.height).toBeGreaterThan(pane.height * 0.8);
});

test("list: the no-match state fills the pane instead of the first row (SUB-1228)", async ({
  page,
}) => {
  const { box, pane } = await emptyBox(page, "List", ".db-list");
  expectsPaneWide(box, pane);
  expect(box.height).toBeGreaterThan(pane.height * 0.8);
});
