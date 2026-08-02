import { expect, test } from "@playwright/test";

// CSV import (SUB-274): palette action → file pick → column choices → a new
// database created through the same vault_create_type path as "New database",
// one vault_create per row. The browser flow picks via a hidden
// <input type=file> (the mock has no native dialog), driven here through
// Playwright's filechooser event.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Notes — Today is a destination, SUB-300)
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

const CSV = [
  "title,status,cat#,skip me",
  "Slow Bloom EP,in review,SMP-030,x",
  "Vessel Songs,mastering,SMP-031,y",
  ",,,", // an all-blank row — skipped by the import
].join("\n");

async function pickCsv(page: import("@playwright/test").Page, name: string, text: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-item", { hasText: "Import CSV" }).click();
  await (await chooser).setFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
}

test("import CSV as database: column choices, empty-row skip, entries land", async ({ page }) => {
  await pickCsv(page, "qa sheet.csv", CSV);

  const form = page.locator(".dbform");
  // a column row by its name cell (rows also carry the "title" marker text)
  const colRow = (name: string) =>
    form.locator(".dbform-colrow", { has: page.locator(".dbform-colname", { hasText: name }) });
  await expect(form).toBeVisible();
  // name prefilled from the filename; headers on → named columns, first is
  // marked as the title; the blank row never counts
  await expect(form.locator(".dbform-input")).toHaveValue("qa sheet");
  await expect(form.locator(".dbform-colrow")).toHaveCount(5); // toggle + 4 columns
  await expect(form.locator(".dbform-coltitle")).toHaveText("title");
  await expect(form.locator(".dbform-note")).toContainText("2 rows");

  // headers off: positional names and the header row becomes data
  await form.locator(".dbform-colrow", { hasText: "First row is headers" }).click();
  await expect(colRow("Column 1")).toBeVisible();
  await expect(form.locator(".dbform-note")).toContainText("3 rows");
  await form.locator(".dbform-colrow", { hasText: "First row is headers" }).click();

  // excluding the first column promotes the next one to title
  await colRow("title").click();
  await expect(colRow("status").locator(".dbform-coltitle")).toHaveText("title");
  await colRow("title").click();
  // drop the "skip me" column from the import
  await colRow("skip me").click();

  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".toast")).toContainText("Imported 2 entries");
  await expect(page.locator(".list-title")).toHaveText("Qa sheet");
  const rows = page.locator(".db-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Slow Bloom EP");
  await expect(rows.first()).toContainText("in review");
  // the excluded column is neither a schema prop nor a value
  await expect(page.locator(".db-table")).not.toContainText("skip me");
});

test("reserved and duplicate headers are renamed, shown, and land with their values (SUB-559/562)", async ({
  page,
}) => {
  // a routine spreadsheet export: `type` and `created` are the note's own
  // frontmatter fields (they used to import empty while the toast said
  // success), and the repeated `Notes` used to abort the whole import on
  // submit — after the user had already named the database and picked columns
  const csv = [
    "title,type,created,Notes,notes",
    "Slow Bloom EP,album,2026-01-04,first,second",
  ].join("\n");
  await pickCsv(page, "catalogue.csv", csv);

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  // the dialog shows the destination names, not the raw headers. `title` is the
  // title column so it keeps its name; the first `Notes` is neither reserved
  // nor yet taken, so it keeps its name too and only the second one moves
  await expect(form.locator(".dbform-colname")).toHaveText([
    "title",
    "type 2",
    "created 2",
    "Notes",
    "notes 2",
  ]);
  await expect(form.locator(".dbform-note")).toContainText("3 columns were renamed");

  await form.locator(".selmenu-btn-primary").click();
  // it imports at all (the duplicate no longer rejects) and every column has
  // its value (the reserved ones are no longer dropped on the way to disk)
  await expect(page.locator(".toast")).toContainText("Imported 1 entry");
  const row = page.locator(".db-table tbody tr").first();
  await expect(row).toContainText("Slow Bloom EP");
  await expect(row).toContainText("album");
  await expect(row).toContainText("2026-01-04");
  await expect(row).toContainText("first");
  await expect(row).toContainText("second");
});

test("a name that already exists keeps the dialog open with the engine's error", async ({ page }) => {
  await pickCsv(page, "release.csv", CSV); // the mock vault has a release db

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".selmenu-btn-primary").click();
  await expect(form.locator(".dbform-err")).toContainText("already exists");
  // still open — rename and retry works
  await form.locator(".dbform-input").fill("release 2");
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".toast")).toContainText("Imported 2 entries");
  await expect(page.locator(".list-title")).toHaveText("Release 2");
});
