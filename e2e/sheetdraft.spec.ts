import { expect, test, type Page } from "@playwright/test";

// An uncommitted SheetGrid cell draft vs an external change to the
// sheet's own body. The vault:changed lane (NotePane) only guards on
// pending/saving — an open cell draft is neither — and SheetGrid used to
// register no docRef, so adoptDiskBody remounted the grid: the focused input
// unmounted without a blur, commitEdit never fired, the draft died silently.
// The grid now adopts in place like the plain editor, so the edit session
// (input, focus, draft) must survive and the commit must land on the adopted
// body.

// cold open lands on Today — open the seeded sheet through the palette
async function openSheet(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo — wait the window out before emitting (same as mockfail) */
async function emitChanged(page: Page) {
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

// nth cell of a data row — data cells lead each row, computed trail them
function cell(page: Page, r: number, c: number) {
  return page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);
}

test("uncommitted cell draft survives an external change to the sheet (SUB-288)", async ({
  page,
}) => {
  // two-phase flow (adopt, then commit + reopen) — needs headroom past 20s
  test.setTimeout(30_000);
  await openSheet(page);
  // start a cell edit, type an uncommitted draft
  await cell(page, 0, 0).dblclick();
  const input = page.locator(".sheet-input");
  await expect(input).toBeVisible();
  await input.fill("999draft");

  // the sheet's own body diverges on disk while the draft is open (BTC units
  // 4.1 → 5; same shape, so the edited cell still exists)
  await page.evaluate(() => {
    window.__mockEditNote(
      "Holdings.md",
      "Portfolio tracker — rows are data; the formulas block computes columns and totals.\n\n```csv\nasset,bucket,units,price_usd\nGLOW,etf,1200,31.4\nBTC,crypto,5,64200\nARC,etf,80,92.5\nETH,crypto,9,3050\n```\n\n```formulas\nvalue_usd = units * price_usd\nvalue_eur = value_usd * FX(\"USD\",\"EUR\")\n\ntotal     = SUM(value_eur)\n```\n"
    );
  });
  await emitChanged(page);

  // the session survives the adopt: same input, draft text, focus — and the
  // disk change shows underneath (row 1 = BTC, col 2 = units)
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("999draft");
  await expect(input).toBeFocused();
  await expect(cell(page, 1, 2)).toHaveText("5");
  // a clean buffer adopts silently — no conflict banner
  await expect(page.locator(".note-banner")).toHaveCount(0);

  // commit: the draft lands on top of the adopted body
  await input.press("Enter");
  await expect(cell(page, 0, 0)).toHaveText("999draft");

  // the merged body really reached disk: leave + reopen re-reads the store.
  // In-app navigation only — a page.goto reload would reseed the whole mock
  // world (the store lives in the page's JS context), erasing both writes.
  // Focus the title first: a focused grid swallows Meta+k as vim `k` nav.
  await page.waitForTimeout(600); // autosave debounce (NotePane onBodyChange)
  await page.locator(".note-title").click();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Welcome");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  // the palette closes on a 90ms timer (Palette.tsx close) — ⌘K inside that
  // window toggles it shut again, so wait for the overlay to really leave
  await expect(page.locator(".palette")).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();
  await expect(cell(page, 0, 0)).toHaveText("999draft");
  await expect(cell(page, 1, 2)).toHaveText("5");
});
