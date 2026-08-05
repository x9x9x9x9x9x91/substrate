import { expect, test } from "@playwright/test";

// All-databases manager: one surface listing EVERY database —
// homed and homeless, schema-only zero-note ones included — replacing the
// flat sidebar Databases section that only ever showed the homeless few.
// Runs against the deterministic mock backend (fresh page = fresh vault).

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("sidebar: persistent All databases entry, no flat Databases section", async ({ page }) => {
  const entry = page.locator(".side-item", { hasText: "All databases" });
  await expect(entry).toBeVisible();
  // the old section header (with its conditional render and + button) is gone
  await expect(page.locator(".side-label-row", { hasText: "Databases" })).toHaveCount(0);
  await expect(page.locator(".side-add")).toHaveCount(1); // only the Folders one

  await entry.click();
  await expect(page.locator(".list-title")).toHaveText("All databases");
  await expect(entry).toHaveClass(/active/);
});

test("manager lists every database with counts and home folders", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();

  // every mock database, one row each: the schema types, the used-but-
  // unschema'd ones (finance-doc, artist, diary), and the homed task db
  // alike; sheet is a functional type — surfaces never list here
  const names = [
    "Artist",
    "Catalog",
    "Contact",
    "Diary",
    "Event",
    "Finance-doc",
    "Gear",
    "Inventory",
    "Ledger",
    "Release",
    "Task",
    "Zhome",
  ];
  const rows = page.locator(".dbmgr-row");
  await expect(rows).toHaveCount(names.length);
  for (const n of names) await expect(rows.filter({ hasText: n })).toHaveCount(1);
  await expect(page.locator(".list-count")).toHaveText(String(names.length));

  // counts and homes read straight: task homed, release homeless —
  // a homeless row shows only its count, no dangling separator
  const releaseSub = rows.filter({ hasText: "Release" }).locator(".dbmgr-row-sub");
  await expect(releaseSub).toHaveText("5 entries");
  await expect(rows.filter({ hasText: "Task" })).toContainText("17 entries · Tasks");
  // zhome carries the reserved icon/home schema keys like a real schema.json
  await expect(rows.filter({ hasText: "Zhome" })).toContainText("1 entry · ZHome");

  // a row click opens the database
  await rows.filter({ hasText: "Release" }).click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
});

test("create via the manager: a zero-note database lists immediately (SUB-43, SUB-152)", async ({
  page,
}) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".db-new", { hasText: "New database" }).click();
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill("books");
  await form.locator(".selmenu-btn-primary").click();

  // create lands in the new database's (empty) view…
  await expect(page.locator(".list-title")).toHaveText("Books");
  // …and the manager lists it with zero entries — schema-only dbs stay visible
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: "books" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("0 entries");
});

test("rename and delete run through the manager's row menu", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();

  // rename via the row's ⋯ button — the existing dialog, same plumbing
  const gearRow = page.locator(".dbmgr-row", { hasText: "Gear" });
  await gearRow.locator(".dbmgr-menu").click();
  await page.locator(".ctx-item", { hasText: "Rename database…" }).click();
  const rename = page.locator(".dbform");
  await rename.locator(".dbform-input").fill("hardware");
  await rename.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".dbmgr-row", { hasText: "hardware" })).toBeVisible();
  await expect(page.locator(".dbmgr-row", { hasText: "Gear" })).toHaveCount(0);

  // delete (keep notes) via right-click — the row goes, the entries survive
  await page.locator(".dbmgr-row", { hasText: "hardware" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete database…" }).click();
  const del = page.locator(".dbform");
  await expect(del).toContainText("entr");
  await del.locator(".selmenu-btn", { hasText: "Remove database, keep" }).click();
  await expect(page.locator(".dbmgr-row", { hasText: "hardware" })).toHaveCount(0);
});

test("set home folder from the manager, clear it back out (SUB-85)", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const releaseRow = page.locator(".dbmgr-row", { hasText: "Release" });
  // homeless: the sub line is the bare count, no home segment
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");

  // Set home folder… → second-stage picker over the vault's folders
  await releaseRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Set home folder…" }).click();
  await page.locator(".ctx-item", { hasText: /^Projects$/ }).click();
  await expect(releaseRow).toContainText("Projects");
  await expect(page.locator(".toast")).toContainText("now lives in");

  // the database nests into the Folders tree as its home — the
  // row keeps the folder name and wears the DB chip
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Projects$/ }),
  }).filter({ has: page.locator(".side-db-chip") });
  await expect(treeRow).toBeVisible();

  // …and clearing the home is the exit path back to a stray
  await releaseRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Change home folder…" }).click();
  await page.locator(".ctx-item", { hasText: "Stop opening as database" }).click();
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");
  await expect(treeRow).toHaveCount(0);
});

test("a folder homing another db can't be picked as a second home (SUB-407)", async ({ page }) => {
  // the task db is seeded homed on Tasks/ — that folder must read as taken
  // in another db's picker, with the holder named
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const releaseRow = page.locator(".dbmgr-row", { hasText: "Release" });
  await releaseRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Set home folder…" }).click();
  const tasksItem = page.locator(".ctx-item", { hasText: /^Tasks/ });
  await expect(tasksItem).toHaveClass(/disabled/);
  await expect(tasksItem).toContainText("home of task");
  // clicking it is a no-op — the menu stays, nothing is claimed
  await tasksItem.click();
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");
});

test("palette navigates to the manager", async ({ page }) => {
  // let the app settle before the chord — nothing else in this test waits first
  await expect(page.locator(".side-item", { hasText: "All databases" })).toBeVisible();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("all databases");
  // the query also spawns a "New note …" capture row, so pick the nav row
  // explicitly rather than trusting the ranking
  await page.locator(".palette-item", { hasText: "Go to All databases" }).click();
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("All databases");
});
