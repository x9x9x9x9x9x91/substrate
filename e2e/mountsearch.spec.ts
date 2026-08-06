import { expect, test, type Page } from "@playwright/test";
import { openFilter } from "./nav";

// What a mounted file SAYS is searchable, not just what it is
// called. Against the mock backend the "finance-doc" mount carries two files
// with body text: the January invoice, read whole, and the 34-page
// Steuererklärung, read only to its cap. A hit inside either goes home to the
// board — a mount row has no note until someone annotates it.

async function search(page: Page, q: string) {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill(q);
}

test("a phrase inside a mounted document finds its file", async ({ page }) => {
  // "Leistung" appears nowhere in the vault's notes and nowhere in any file
  // NAME — only inside the invoice's text. Before this, the answer was "no
  // results", which read as the vault not having the invoice at all.
  await search(page, "Leistung");
  const group = page.locator(".search-group", { hasText: "2026-01 Invoice Acme Mastering" });
  await expect(group).toHaveCount(1);
  // the matched line is shown, so the hit is readable without opening it
  await expect(group.locator(".search-snippet").first()).toContainText("Mastering von vier Titeln");
  // the mount's name is the row's type, exactly as on its board
  await expect(group.locator(".search-note-hint")).toHaveText("Finance-doc");
  // a page holding a file row counts "results", not "notes" — calling a PDF a
  // note in the one place the pane states a number is a small lie
  await expect(page.locator(".search-stats")).toContainText("result");
});

test("opening the hit lands on the mount board, on that row", async ({ page }) => {
  await search(page, "Leistung");
  await page.locator(".search-group", { hasText: "2026-01 Invoice Acme Mastering" }).click();

  // the board itself, not the editor: the file has no note to open
  const rows = page.locator(".db-table tbody tr");
  await expect(rows).toHaveCount(13);
  // and the board arrived ON the row — a board of a thousand files that
  // merely opens has shown nobody anything
  const open = page.locator(".db-table tbody tr.db-open");
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("2026-01 Invoice Acme Mastering");
});

test("the arrival mark follows what the board opens next", async ({ page }) => {
  // The mark answers "which file am I in" — so it belongs to the last row
  // opened, not to the row a search happened to arrive on hours ago. Before
  // this it was written once and never moved: an arrival left the board
  // pointing at that row for the rest of the session, through every file
  // opened after it.
  await search(page, "Leistung");
  await page.locator(".search-group", { hasText: "2026-01 Invoice Acme Mastering" }).click();
  const open = page.locator(".db-table tbody tr.db-open");
  await expect(open).toContainText("2026-01 Invoice Acme Mastering");

  await page
    .locator(".db-table tbody tr", { hasText: "Rechnung Umbra" })
    .locator(".db-title")
    .click();
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("Rechnung Umbra");
});

test("a document read only to its cap says so, in the results and on the board", async ({
  page,
}) => {
  // "Sonderausgaben" is on the last line the reader got to. The pages beyond
  // it were never read, so a miss further down means nothing — the row has to
  // stop the opening of a 34-page filing from passing for the whole of it.
  await search(page, "Sonderausgaben");
  const group = page.locator(".search-group", { hasText: "2025 Steuererklärung" });
  await expect(group.locator(".search-partial")).toHaveText("partly read");
  await expect(group.locator(".search-note-row")).toHaveAttribute(
    "aria-label",
    /only the beginning of this file was read/
  );

  // the invoice was read whole, and claims nothing of the sort
  await search(page, "Leistung");
  await expect(page.locator(".search-partial")).toHaveCount(0);
});

test("the document's opening line previews its row on the board", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Finance-doc" }).click();

  const rows = page.locator(".db-table tbody tr");
  await expect(rows).toHaveCount(13);

  // the row's excerpt is the document's opening line now, and the board's own
  // filter reads excerpts: a quoted phrase from inside the file narrows the
  // board to it. (The table renders columns, not the excerpt — the preview
  // itself is visible in the search results, above; bare words stay
  // title-only, which this lane did not change.)
  // "Rechnung 2026-01" is the invoice's opening line and appears in no file
  // name here — the sister file "2026-07 Rechnung Umbra.pdf" does not match it
  await (await openFilter(page)).fill('"Rechnung 2026-01"');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("2026-01 Invoice Acme Mastering");
});
