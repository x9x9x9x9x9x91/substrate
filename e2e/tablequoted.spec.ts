import { expect, test } from "@playwright/test";

// A table inside a blockquote keeps its `> ` marks in the source slice. The
// widget scans each line behind them — before that, the quote marker rendered
// as a phantom ">" first column and every column index sat one off from what
// the reader sees — and the grow edits put the marks back, so a grown row
// stays inside the quote.

const NOTE = "Inbox/Capture anything.md";
const QUOTED = [
  "quoted table below",
  "",
  "> | Track | Length |",
  "> | --- | :-: |",
  "> | Slug It Out | 6:12 |",
  "",
].join("\n");

async function openQuotedTable(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((b) => window.__mockEditNote!("Inbox/Capture anything.md", b), QUOTED);
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-md-table")).toBeVisible();
  // focus the editor away from the table first — instant typing after a "+"
  // click in an unfocused editor lands at the doc end for unquoted tables
  // too (pre-existing focus race, not this fix's subject)
  await page.locator(".cm-line").first().click();
  await expect(page.locator(".cm-md-table")).toBeVisible();
}

test("a blockquoted table renders without a phantom quote column", async ({ page }) => {
  await openQuotedTable(page);
  const table = page.locator(".cm-md-table").last();
  // two real columns — the "> " marker is not a cell
  await expect(table.locator("th")).toHaveCount(2);
  await expect(table.locator("th").first()).toHaveText("Track");
  // the alignment row parses behind the marks too
  await expect(table.locator("tbody td").nth(1)).toHaveCSS("text-align", "center");
});

test("growing a quoted table keeps the new row inside the quote", async ({ page }) => {
  await openQuotedTable(page);
  await page.locator(".cm-md-table-add-row").click();
  // the cursor lands in the new row's first cell, past the quote mark
  await page.keyboard.type("Nod");
  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("> | Slug It Out | 6:12 |\n> | Nod |  |");
});

test("growing a quoted table by a column grows every quoted line", async ({ page }) => {
  await openQuotedTable(page);
  await page.locator(".cm-md-table-add-column").click();
  await page.keyboard.type("BPM");
  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("> | Track | Length | BPM |\n> | --- | :-: | --- |\n> | Slug It Out | 6:12 |  |");
});
