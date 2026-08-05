import { expect, test, type Page } from "@playwright/test";
import { openDb as openDbRow } from "./nav";

// Edge fades reflect actual scrollability, driven by two gate
// classes on .db-body: .db-more-x paints the right-edge mask only while
// columns hide past the right edge, .db-scrolled-x paints the left-edge fade
// only while off the left stop. A table that fits its pane fades neither.
// Runs against the deterministic mock backend (fresh page = fresh vault).

async function openDb(page: Page, name: string) {
  await page.goto("/");
  await openDbRow(page, name);
  await expect(page.locator(".db-table")).toBeVisible();
}

test("wide table: right fade at scroll 0, both mid-scroll, none right at max", async ({
  page,
}) => {
  await openDb(page, "Ledger");
  const body = page.locator(".db-body");

  // the fixture must actually overflow, or this test proves nothing
  const dims = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeGreaterThan(dims.cw);

  // scroll 0: more columns to the right → right fade only
  await expect(body).toHaveClass(/db-more-x/);
  await expect(body).not.toHaveClass(/db-scrolled-x/);
  const maskAt0 = await body.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAt0).not.toBe("none");

  // mid-scroll: clipped columns on the left AND more on the right → both
  await body.evaluate((el) => {
    el.scrollLeft = 600;
  });
  await expect(body).toHaveClass(/db-scrolled-x/);
  await expect(body).toHaveClass(/db-more-x/);

  // max scroll: the last column renders crisp — right fade gone, left stays
  await body.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(body).toHaveClass(/db-scrolled-x/);
  await expect(body).not.toHaveClass(/db-more-x/);
});

test("board: right fade while columns hide, gone at max scroll (SUB-207)", async ({
  page,
}) => {
  await openDb(page, "Catalog");
  await page.locator(".db-switch button[title=\"Board\"]").click();
  const board = page.locator(".db-board");
  await expect(board).toBeVisible();

  // the fixture's five columns must actually overflow, or this proves nothing
  const dims = await board.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeGreaterThan(dims.cw);

  // scroll 0: more columns to the right → fade painted
  await expect(board).toHaveClass(/db-more-x/);
  const maskAt0 = await board.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAt0).not.toBe("none");

  // max scroll: the last column renders crisp — fade gone
  await board.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(board).not.toHaveClass(/db-more-x/);
  const maskAtMax = await board.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAtMax).toBe("none");
});

test("narrow table: no overflow, no fades ever", async ({ page }) => {
  await openDb(page, "Contact");
  const body = page.locator(".db-body");

  // this fixture fits the pane — no fade may paint
  const dims = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeLessThanOrEqual(dims.cw + 1);

  await body.evaluate((el) => {
    el.scrollLeft = 300;
  });
  await expect(body).not.toHaveClass(/db-scrolled-x/);
  await expect(body).not.toHaveClass(/db-more-x/);
  const mask = await body.evaluate((el) => getComputedStyle(el).maskImage);
  expect(mask).toBe("none");
});
