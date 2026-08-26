import { expect, test, type Page } from "./fixtures";

// Ableton projects on a mounted folder. A `.als` is one gzipped XML document,
// so the engine reads a set's tempo, key, track count and Live version out of
// it the same way it reads a PDF's page count — four columns the board has
// because the files have them. Two things ride along: the `ignore` list a
// person hand-writes into `.vault/mounts.json` (Live drops a dated copy of
// every set into `Backup/`, and a board of sets should not be half backups),
// and the row menu's hand-off to the OS.
//
// Against the mock backend, whose second "disk" is a pool of project folders:
// mounting a path that reads as a music pool shows two sets, their backups and
// one bounce.

const POOL = "~/Music/Album Pool";

/** Mount the project pool and land on its board. `ignore` is written before
    the mount exists, which is what editing `.vault/mounts.json` before a first
    scan does — the pruned files never enter the index at all. */
async function mountPool(page: Page, name: string, ignore?: string[]) {
  if (ignore) {
    await page.evaluate(
      ([n, pats]) => window.__mockSetMountIgnore?.(n as string, pats as string[]),
      [name, ignore] as const
    );
  }
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Mount a folder…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-proprow .dbform-input").fill(POOL);
  await form.locator('input[placeholder="Name…"]').fill(name);
  await form.locator(".selmenu-btn-primary").click();
  await expect(form).toContainText(`${POOL} → ${name}`);
  await form.locator(".selmenu-btn-primary", { hasText: "Done" }).click();
  await expect(form).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: name }).first().click();
}

/** One row's cell under a named column, found by header text — the board
    capitalises a column heading, so the lookup folds. */
async function cell(page: Page, rowText: string, column: string): Promise<string> {
  const i = await page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c: string) =>
        ths.findIndex((th) => (th.textContent ?? "").toLowerCase().includes(c)),
      column
    );
  expect(i).toBeGreaterThan(-1);
  return page
    .locator(".db-table tbody tr", { hasText: rowText })
    .first()
    .evaluate((tr, n: number) => tr.querySelectorAll("td")[n]?.textContent?.trim() ?? "", i);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a project's own columns arrive on the board beside the audio ones", async ({ page }) => {
  await mountPool(page, "Album Pool");

  // two sets, their two backups and one bounce
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // read out of the set itself: no sidecar, no schema, no typing
  for (const c of ["als_tempo", "als_key", "als_tracks", "als_version"]) {
    await expect(page.locator(".db-th-label", { hasText: c })).toBeVisible();
  }
  expect(await cell(page, "Bleed Cycle.als", "als_tempo")).toBe("132");
  expect(await cell(page, "Bleed Cycle.als", "als_key")).toBe("D# Minor");
  expect(await cell(page, "Bleed Cycle.als", "als_tracks")).toBe("24");
  expect(await cell(page, "Bleed Cycle.als", "als_version")).toBe("Ableton Live 12.1.5");

  // every field is independently optional: the 11.x set names no scale, and
  // its key cell is blank rather than the row dropping a column
  expect(await cell(page, "Nightwater.als", "als_tempo")).toBe("84.5");
  expect(await cell(page, "Nightwater.als", "als_key")).toBe("");

  // the prefix earns itself here: the bounce sitting in the same folder fills
  // the audio columns and none of the project ones
  expect(await cell(page, "rough.wav", "als_tempo")).toBe("");
  expect(await cell(page, "rough.wav", "duration")).not.toBe("");

});

test("what a set is built out of is searchable, not just what it is called", async ({ page }) => {
  await mountPool(page, "Album Pool");

  // "Granulator" is a device inside the set, not a word in any filename — the
  // extractor hands the track and device names over as the file's text, and a
  // mounted file's text is indexed beside the notes
  await page.keyboard.press("Meta+Shift+f");
  await page.locator(".search-input").fill("Granulator");
  const group = page.locator(".search-group", { hasText: "Bleed Cycle.als" });
  await expect(group).toHaveCount(1);
  await expect(group.locator(".search-note-hint")).toHaveText("Album Pool");
});

test("an ignore list written before the first scan keeps Live's backups off the board", async ({
  page,
}) => {
  // one pattern without a slash: the folder name at any depth, pruned whole
  await mountPool(page, "Sets", ["Backup"]);

  await expect(page.locator(".db-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".db-table tbody tr", { hasText: "[2026-" })).toHaveCount(0);
  await expect(page.locator(".db-table tbody tr", { hasText: "Bleed Cycle.als" })).toHaveCount(1);
});

test("an ignore list added later greys the rows it hides rather than forgetting them", async ({
  page,
}) => {
  await mountPool(page, "Album Pool");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // the file is edited, then a rescan — the two backups are still indexed, so
  // they stay as rows and grey out. Anything ever annotated about them lives
  // on their sidecars, and a rescan is no place to throw that away.
  await page.evaluate(() => window.__mockSetMountIgnore?.("Album Pool", ["Backup"]));
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Rescan");
  await page.locator(".palette-item", { hasText: "Rescan mounted folders" }).first().click();
  await expect(page.locator(".toast")).toContainText("missing");

  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
  await expect(page.locator(".db-table tbody tr.is-missing")).toHaveCount(2);
  await expect(
    page.locator(".db-table tbody tr.is-missing", { hasText: "[2026-08-10" })
  ).toHaveCount(1);
});

test("the row menu hands a set to the OS by its real path", async ({ page }) => {
  await mountPool(page, "Album Pool");
  await page.evaluate(() => window.__mockTraceCommands?.());

  const row = page.locator(".db-table tbody tr", { hasText: "Bleed Cycle.als" }).first();
  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Open file" }).click();

  // what happens after the call is the OS's business and nothing here can see
  // it — the assertion is that the app asked, and asked about the right file
  const opened = await page.evaluate(() => window.__mockReadCommandTrace?.() ?? []);
  expect(opened).toContainEqual(
    expect.objectContaining({ cmd: "file_open", path: `${POOL}/Bleed Cycle/Bleed Cycle.als` })
  );

  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Reveal in Finder" }).click();
  const revealed = await page.evaluate(() => window.__mockReadCommandTrace?.() ?? []);
  expect(revealed).toContainEqual(
    expect.objectContaining({ cmd: "file_reveal", path: `${POOL}/Bleed Cycle/Bleed Cycle.als` })
  );
});
