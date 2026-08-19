import { expect, test } from "@playwright/test";

// The "+" that grows a table has to work on the very first click, before the
// editor has been touched at all. The button focuses the editor as part of
// growing the table, and until the editor counts as focused the table stays a
// rendered grid — a cursor placed inside it has no text to sit in, so the
// first characters typed used to land at the end of the note instead of in
// the cell that just appeared.

const NOTE = "Inbox/Capture anything.md";
const TABLE = "| Track | Length |\n| --- | --- |\n| Slug It Out | 6:12 |";

/** Open a note that already holds a table, WITHOUT clicking into the editor:
    the whole point is the state where nothing has taken focus yet. */
async function openTableNote(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(
    ([path, table]) => window.__mockEditNote!(path, `Set list.\n\n${table}\n`),
    [NOTE, TABLE] as const
  );
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-md-table")).toBeVisible();
  // nothing in the editor has focus — the click landed on the list row
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains("cm-content") ?? false)
  ).toBe(false);
}

test("the row button takes the first keystrokes into the new cell, unfocused editor", async ({
  page,
}) => {
  await openTableNote(page);
  await page.locator(".cm-md-table-add-row").click();
  // no waiting of any kind between the click and the typing
  await page.keyboard.type("Nod");

  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("| Slug It Out | 6:12 |\n| Nod |  |");
  // and nothing was appended past the table
  const body = await page.evaluate((p) => window.__mockBodyOf!(p), NOTE);
  expect(body.trimEnd().endsWith("Nod")).toBe(false);
});

test("the column button takes the first keystrokes into the new header, unfocused editor", async ({
  page,
}) => {
  await openTableNote(page);
  await page.locator(".cm-md-table-add-column").click();
  await page.keyboard.type("BPM");

  await expect
    .poll(() => page.evaluate((p) => window.__mockBodyOf!(p), NOTE))
    .toContain("| Track | Length | BPM |");
  const body = await page.evaluate((p) => window.__mockBodyOf!(p), NOTE);
  expect(body.trimEnd().endsWith("BPM")).toBe(false);
});
