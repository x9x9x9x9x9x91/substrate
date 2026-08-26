import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Retyping a property silently destroys schema facets: the save hands `[]`
// for every kind but select/multi and drops the format for anything but
// number, schema edits aren't undoable, and the editor re-reads the current
// schema on mount — so nothing can restore them. The editor names
// the loss before Save, live off the kind buttons; Save stays enabled.
// Fixtures (src/lib/tauri.ts): release `status` (select, 4 colored options),
// release `format` (multi, 3 colored options), inventory `price`
// (number + euro), inventory `in use` (checkbox).

/** open a column's schema editor through its header caret menu */
async function editSchema(page: Page, col: string) {
  await page.locator(".db-table th", { hasText: col }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Edit schema…" }).click();
  const editor = page.locator(".selmenu");
  await expect(editor).toBeVisible();
  return editor;
}

test("a select's options and colors are named before they're dropped (SUB-1227)", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  const editor = await editSchema(page, "status");
  // nothing is being destroyed while the draft kind is the stored one
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);

  await editor.locator(".selmenu-kind", { hasText: "Date" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveText(
    "Saving as Date removes 4 options and their colors"
  );
  // the line is a consent notice, not a gate
  await expect(editor.locator(".selmenu-btn-primary")).toBeEnabled();

  // multi keeps the option list (the save hands the draft through) — no warning
  await editor.locator(".selmenu-kind", { hasText: "Multi-select" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);

  // back on the stored kind it's gone again — the line tracks the draft live
  await editor.locator(".selmenu-kind", { hasText: "Select" }).first().click();
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);
});

test("a multi's options warn too, singular/plural per count (SUB-1227)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const editor = await editSchema(page, "format");

  await editor.locator(".selmenu-kind", { hasText: "Text" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveText(
    "Saving as Text removes 3 options and their colors"
  );

  // back on the stored kind the options are intact and unremarked
  await editor.locator(".selmenu-kind", { hasText: "Multi-select" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);
  await expect(editor.locator(".selmenu-editrow")).toHaveCount(3);
});

test("a number's euro format is named before it's dropped (SUB-1227)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const editor = await editSchema(page, "price");
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);

  await editor.locator(".selmenu-kind", { hasText: "Text" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveText(
    "Saving as Text removes the € format"
  );

  await editor.locator(".selmenu-kind", { hasText: "Number" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);
});

test("retyping to checkbox warns that a tick overwrites the value (SUB-1227)", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const editor = await editSchema(page, "price");

  await editor.locator(".selmenu-kind", { hasText: "Checkbox" }).click();
  const warns = editor.locator(".selmenu-warn");
  await expect(warns).toHaveCount(2);
  await expect(warns.first()).toHaveText("Saving as Checkbox removes the € format");
  await expect(warns.nth(1)).toHaveText(
    "Existing values will hide behind unchecked boxes — ticking one overwrites the value."
  );
});

test("a column that already is a checkbox warns about nothing (SUB-1227)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const editor = await editSchema(page, "in use");
  await editor.locator(".selmenu-kind", { hasText: "Checkbox" }).click();
  await expect(editor.locator(".selmenu-warn")).toHaveCount(0);
});
