import { expect, test } from "@playwright/test";

// "Map a folder…" (SUB-672): point a database at a real folder on disk from
// inside the app — the mapping lands in .vault/folders.json through
// folder_dbs_add and the first scan runs on the spot, its FolderScanStats
// inline in the dialog instead of a toast. Both entry points: the
// All-databases manager's row menu and the sidebar Folders "+". Runs against
// the mock backend: its native-pick returns "~/Personal/Finance" (already
// mapped to finance-doc) and any typed path scans the same dozen fake files.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("manager row menu: prefilled type, inline scan stats, stubs land in the tree", async ({
  page,
}) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: "Catalog" });
  await row.locator(".dbmgr-menu").click();
  await page.locator(".ctx-item", { hasText: "Map a folder…" }).click();

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await expect(form).toContainText("Map a folder");
  // the row's database prefills the type field
  await expect(form.locator("input[list='mapfolder-dbtypes']")).toHaveValue("catalog");

  // an empty path is refused — the primary stays disabled until one lands
  const submit = form.locator(".selmenu-btn-primary");
  await expect(submit).toBeDisabled();
  await form.locator(".dbform-proprow .dbform-input").fill("~/Personal/Archives");
  await expect(submit).toBeEnabled();
  await submit.click();

  // the first scan reports inline: 12 new stubs from the mock's file set
  await expect(form).toContainText("~/Personal/Archives → catalog");
  await expect(form).toContainText("12 notes created, 0 updated, 0 missing");
  await form.locator(".selmenu-btn-primary", { hasText: "Done" }).click();
  await expect(form).toHaveCount(0);

  // the stubs are real notes now — their vault folder lists in the sidebar
  await expect(
    page.locator(".side-folder", {
      has: page.locator(".side-label-text", { hasText: /^Archives$/ }),
    })
  ).toBeVisible();
});

test("Folders + menu: native-pick lane, duplicate refusal, watch toggle", async ({ page }) => {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Map a folder…" }).click();

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  const submit = form.locator(".selmenu-btn-primary");
  // this entry prefills nothing — path AND type are both required
  await expect(form.locator("input[list='mapfolder-dbtypes']")).toHaveValue("");
  await expect(submit).toBeDisabled();

  // Choose… drives the (mocked) native folder picker
  await form.locator(".selmenu-btn", { hasText: "Choose…" }).click();
  await expect(form.locator(".dbform-proprow .dbform-input")).toHaveValue("~/Personal/Finance");
  await form.locator("input[list='mapfolder-dbtypes']").fill("finance-doc");

  // that exact mapping already exists — the refusal reports inline, no write
  await submit.click();
  await expect(form.locator(".dbform-err")).toContainText("already mapped");

  // same folder backing a different type maps fine; the watch toggle rides
  await form.locator("input[list='mapfolder-dbtypes']").fill("archive");
  await form.locator(".dbform-colrow").click();
  await expect(form.locator(".prop-check")).toHaveClass(/ on/);
  await submit.click();
  await expect(form).toContainText("~/Personal/Finance → archive");
  // dedupe is by the file prop: finance-doc's rescan claimed the files first
  await expect(form).toContainText("0 notes created, 0 updated, 1 missing");
  await form.locator(".selmenu-btn-primary", { hasText: "Done" }).click();

  // the write persisted: the same add is refused as a duplicate now
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Map a folder…" }).click();
  await form.locator(".dbform-proprow .dbform-input").fill("~/Personal/Finance");
  await form.locator("input[list='mapfolder-dbtypes']").fill("archive");
  await form.locator(".selmenu-btn-primary").click();
  await expect(form.locator(".dbform-err")).toContainText("already mapped");
});
