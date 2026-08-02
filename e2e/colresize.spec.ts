import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// SUB-404: table column resize (header drag handles) + per-column wrap.
// Both persist on the database's ViewPref (views.json in the real engine,
// mockViews here), the SUB-326 channel — so they survive navigating to
// another page and back, like the remembered sort. Runs against the
// deterministic mock backend (fresh page = fresh vault).

async function openRelease(page: Page) {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
}

// a column's first data cell, located by its header position — the fixture's
// column order (COLUMN_ORDER leads, alphabet follows) stays out of the spec
async function firstCellTxt(page: Page, col: string) {
  const ths = page.locator(".db-table thead th");
  const n = await ths.count();
  for (let i = 0; i < n; i++) {
    // headers render display-cased ("Artist") — match like hasText, caselessly
    if ((await ths.nth(i).textContent())?.toLowerCase().includes(col.toLowerCase())) {
      return page.locator(".db-table tbody tr").first().locator("td").nth(i).locator(".db-cell-txt");
    }
  }
  throw new Error(`no ${col} column`);
}

test("drag a header handle to resize; the width persists across pages; double-click resets", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  const artistTh = page.locator(".db-table thead th", { hasText: "artist" });
  const handle = artistTh.locator(".db-th-resize");
  const before = (await artistTh.boundingBox())!;

  // drag the handle 60px right — the column follows
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = (await artistTh.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 40);

  // persists across a page switch (mock vault_views_set round-trip)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openRelease(page);
  const back = (await page.locator(".db-table thead th", { hasText: "artist" }).boundingBox())!;
  expect(Math.abs(back.width - after.width)).toBeLessThan(3);

  // double-click the handle resets to auto
  await page
    .locator(".db-table thead th", { hasText: "artist" })
    .locator(".db-th-resize")
    .dblclick();
  const reset = (await page.locator(".db-table thead th", { hasText: "artist" }).boundingBox())!;
  expect(Math.abs(reset.width - before.width)).toBeLessThan(3);
});

test("wrap toggle in the column caret menu; wrapped cells persist across pages", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  // the artist column clips by default (nowrap)
  await expect(await firstCellTxt(page, "artist")).toHaveCSS("white-space", "nowrap");

  // caret → Wrap text
  const artistTh = page.locator(".db-table thead th", { hasText: "artist" });
  await artistTh.locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Wrap text" }).click();
  await expect(await firstCellTxt(page, "artist")).toHaveCSS("white-space", "normal");

  // persists across a page switch, and the menu now offers Clip text
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openRelease(page);
  await expect(await firstCellTxt(page, "artist")).toHaveCSS("white-space", "normal");
  await page
    .locator(".db-table thead th", { hasText: "artist" })
    .locator(".db-th-caret")
    .click();
  await page.locator(".colmenu .dots-item", { hasText: "Clip text" }).click();
  await expect(await firstCellTxt(page, "artist")).toHaveCSS("white-space", "nowrap");
});

test("resize handle never triggers a sort", async ({ page }) => {
  await page.goto("/");
  await openRelease(page);
  const artistTh = page.locator(".db-table thead th", { hasText: "artist" });
  // a plain click on the handle (no drag) sorts nothing and commits nothing
  await artistTh.locator(".db-th-resize").click();
  await expect(artistTh.locator(".db-sort")).toHaveCount(0);
});
