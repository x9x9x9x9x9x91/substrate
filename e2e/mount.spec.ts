import { expect, test } from "@playwright/test";

// "Mount a folder…" (SUB-888): show a real folder on disk as a database —
// every matching file is a row read from a live index, nothing is imported and
// no note is written until a row is annotated. Against the mock backend: one
// folder is already mounted ("finance-doc" → ~/Personal/Finance, 12 files plus
// one the index remembers and the disk no longer has), the native picker
// returns "~/Personal/Finance", and any typed path scans the same dozen files.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("mount a folder from the sidebar: name prefills, first scan reports inline", async ({
  page,
}) => {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Mount a folder…" }).click();

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await expect(form).toContainText("Mount a folder");

  // path AND name are both required — the primary stays disabled until both
  const submit = form.locator(".selmenu-btn-primary");
  await expect(submit).toBeDisabled();

  // Choose… drives the (mocked) native folder picker, and the name field
  // tracks the folder's own name until the user types one of their own
  await form.locator(".selmenu-btn", { hasText: "Choose…" }).click();
  await expect(form.locator(".dbform-proprow .dbform-input")).toHaveValue("~/Personal/Finance");
  await expect(form.locator('input[placeholder="Name…"]')).toHaveValue("Finance");
  await expect(submit).toBeEnabled();

  // the watch toggle rides along
  await form.locator(".dbform-colrow").click();
  await expect(form.locator(".prop-check")).toHaveClass(/ on/);
  await submit.click();

  // the first scan reports inline: 12 rows from the mock's file set, and not
  // one note was created — a mount indexes, it does not import
  await expect(form).toContainText("~/Personal/Finance → Finance");
  await expect(form).toContainText("12 files");
  await form.locator(".selmenu-btn-primary", { hasText: "Done" }).click();
  await expect(form).toHaveCount(0);

  // the mount lists as a database, wearing the mount glyph and its folder
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: "Finance" }).first();
  await expect(row.locator(".dbmgr-mount")).toBeVisible();
});

test("a duplicate name is refused, and an empty one never submits", async ({ page }) => {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Mount a folder…" }).click();

  const form = page.locator(".dbform");
  const submit = form.locator(".selmenu-btn-primary");
  await form.locator(".dbform-proprow .dbform-input").fill("~/Personal/Archives");
  // typing a name of your own stops the folder-name tracking
  await form.locator('input[placeholder="Name…"]').fill("finance-doc");
  await submit.click();
  await expect(form.locator(".dbform-err")).toContainText("already mounted");

  // clearing the name disables the primary again — no nameless mount
  await form.locator('input[placeholder="Name…"]').fill("");
  await expect(submit).toBeDisabled();
});

test("the mount board: file rows, a missing one, a sidecar's props on its row", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Finance-doc" }).click();

  // the rows are the folder's files — 12 on disk plus the one the index
  // remembers and the disk no longer has, which greys out instead of vanishing
  const rows = page.locator(".db-table tbody tr");
  await expect(rows).toHaveCount(13);
  await expect(page.locator(".db-table tbody tr.is-missing")).toHaveCount(1);
  await expect(rows.filter({ hasText: "2026-07 Rechnung Umbra" })).toHaveCount(1);

  // the sidecar's annotations ride its row: the missing file keeps everything
  // ever written about it
  await expect(rows.filter({ hasText: "2025-11 Invoice Old Vendor" })).toContainText("booked");
});

test("unmount from the manager row menu keeps the notes", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: "Finance-doc" });
  await expect(row.locator(".dbmgr-mount")).toBeVisible();

  await row.locator(".dbmgr-menu").click();
  // a mounted folder gets the unmount lanes where a database gets its home one
  await expect(page.locator(".ctx-item", { hasText: "Set home folder…" })).toHaveCount(0);
  await page.locator(".ctx-item", { hasText: /^Unmount$/ }).click();
  await expect(page.locator(".toast")).toContainText("its notes stay in the vault");

  // the folder is forgotten and the glyph with it; the notes it wrote stay,
  // as an ordinary database of ordinary notes
  await expect(row.locator(".dbmgr-mount")).toHaveCount(0);
  await expect(row).toContainText("entry");
});

test("unmount and trash its notes double-confirms before writing", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page.locator(".dbmgr-row", { hasText: "Finance-doc" });
  await row.locator(".dbmgr-menu").click();
  await page.locator(".ctx-item", { hasText: "Unmount and trash its notes…" }).click();

  // the confirm names what is NOT touched — no file on disk is ever at risk
  const card = page.locator(".dbform");
  await expect(card).toContainText("is not touched");
  await card.locator(".selmenu-btn-danger").click();
  await expect(page.locator(".toast")).toContainText("moved its notes to Trash");
  await expect(page.locator(".dbmgr-row", { hasText: "Finance-doc" })).toHaveCount(0);
});
