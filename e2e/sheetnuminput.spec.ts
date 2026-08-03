import { expect, test, type Page } from "@playwright/test";

// SUB-915: the sheet grid was the one commit boundary SUB-636 missed —
// German-typed numbers went into the csv verbatim, so "1.234" evaluated as
// the float 1.234 (a 1000× money error that still renders as money) and
// "1.234,56" fell out of SUM entirely. commitEdit now routes the draft
// through normalizeNumberInput like the DB cell/chip/view-fence boundaries.

async function openSheet(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();
}

// nth cell of a data row — data cells lead each row, computed trail them
function cell(page: Page, r: number, c: number) {
  return page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);
}

async function commitCell(page: Page, r: number, c: number, text: string) {
  await cell(page, r, c).dblclick();
  const input = page.locator(".sheet-input");
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press("Enter");
}

test("sheet cells normalize German-typed numbers at commit (SUB-915)", async ({ page }) => {
  await openSheet(page);
  // GLOW row: units=1200 (col 2), price_usd=31.4 (col 3), value_usd computed (col 4)

  // full de-DE shape: dot grouping + comma decimal → canonical 1234.56
  await commitCell(page, 0, 3, "1.234,56");
  await expect(cell(page, 0, 3)).toHaveText("1.234,56");
  // value_usd = 1200 × 1234.56 — only right if the comma form became a number
  await expect(cell(page, 0, 4)).toHaveText("1.481.472");

  // grouped integer: the shape the app itself renders → 1234, NOT 1.234
  await commitCell(page, 0, 3, "1.234");
  await expect(cell(page, 0, 3)).toHaveText("1234");
  await expect(cell(page, 0, 4)).toHaveText("1.480.800");

});

test("a dotted value in a text column survives open+Enter verbatim (SUB-915)", async ({ page }) => {
  await openSheet(page);
  // `bucket` (col 1) is text by evidence — etf/crypto/etf/crypto. A dotted
  // string here is an address or an identifier, never a de-DE number, so the
  // grid must NOT normalize it: the review case is 192.168 → 192168 on Enter.
  // Assert the stored csv, not the rendered cell: "192.168" happens to parse
  // as a JS float, so the grid displays it de-DE ("192,17") while the source
  // of truth stays the string the user typed.
  const body = () => page.evaluate(() => window.__mockBodyOf?.("Holdings.md") ?? "");

  await commitCell(page, 0, 1, "192.168");
  await expect.poll(body).toContain("GLOW,192.168,");

  // reopening and committing again (Enter is also the move-down key) is the
  // exact destructive path — the value must be byte-identical afterwards
  await cell(page, 0, 1).dblclick();
  await expect(page.locator(".sheet-input")).toHaveValue("192.168");
  await page.locator(".sheet-input").press("Enter");
  await expect.poll(body).toContain("GLOW,192.168,");

  // a year-shaped label is the same class (SUB-633): 2.026 is a name, not 2026
  await commitCell(page, 0, 1, "2.026");
  await expect.poll(body).toContain("GLOW,2.026,");
});
