import { expect, test, type Page } from "@playwright/test";

// SUB-401: root folders in the Folders tree reorder (context-menu Move
// up/down here, drag covered by the shared reorderIds unit tests) and the
// order persists in `$sidebar.folders`. SUB-585: nested folders reorder the
// same way, each sibling group reading its own slice of that one flat list.

// the default mock vault's root folder rows in boot (alphabetical) order —
// home-db rows keep their FOLDER name (SUB-611); nested rows
// (Projects/Active, Projects/Archive) and hidden surfaces are filtered
// out of assertions below
const ROOTS = ["Calendar", "Field notes", "Finance", "Ideas", "Inbox", "Projects", "Tasks", "ZHome"];

async function rootOrder(page: Page): Promise<string[]> {
  const texts = await page.locator(".side-folder .side-label-text").allTextContents();
  return texts.filter((t) => ROOTS.includes(t));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-folder").first()).toBeVisible();
});

test("root folders: Move down via the context menu reorders the tree", async ({ page }) => {
  expect(await rootOrder(page)).toEqual(ROOTS);

  // the first root row's Move up is disabled; Move down swaps it one slot
  await page.locator(".side-folder", { hasText: "Calendar" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await page.locator(".ctx-item", { hasText: "Move down" }).click();
  expect(await rootOrder(page)).toEqual([
    "Field notes",
    "Calendar",
    "Finance",
    "Ideas",
    "Inbox",
    "Projects",
    "Tasks",
    "ZHome",
  ]);

  // …and back up again — the menu math follows the live order
  await page.locator(".side-folder", { hasText: "Calendar" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  expect(await rootOrder(page)).toEqual(ROOTS);
});

test("root folders: drag a root row onto another reorders the tree", async ({ page }) => {
  expect(await rootOrder(page)).toEqual(ROOTS);
  // Chromium's synthetic-mouse drag start slips the source to the row under
  // the pointer (verified: payload named the row below), so dispatch the
  // events with a real DataTransfer instead — the app's own dragstart /
  // dragover / drop handlers still do all the work
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(".side-folder", { hasText: "Calendar" }).dispatchEvent("dragstart", { dataTransfer });
  const finance = page.locator(".side-folder", { hasText: "Finance" });
  await finance.dispatchEvent("dragover", { dataTransfer });
  // drop in the row's upper half (clientY 0) — Calendar lands before Finance
  await finance.dispatchEvent("drop", { dataTransfer });
  expect(await rootOrder(page)).toEqual([
    "Field notes",
    "Calendar",
    "Finance",
    "Ideas",
    "Inbox",
    "Projects",
    "Tasks",
    "ZHome",
  ]);
});

test("nested folders reorder within their sibling group (SUB-585)", async ({ page }) => {
  // tree branches start expanded: Projects' children boot alphabetically
  const nested = page.locator(".side-folder", { hasText: "Active" });
  await expect(nested).toBeVisible();
  const nestedOrder = async () => {
    const texts = await page.locator(".side-folder .side-label-text").allTextContents();
    return texts.filter((t) => ["Active", "Archive"].includes(t));
  };
  expect(await nestedOrder()).toEqual(["Active", "Archive"]);

  // a nested row's menu carries the same Move lane as a root row, scoped to
  // its own sibling group
  await nested.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "New subfolder…" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await page.locator(".ctx-item", { hasText: "Move down" }).click();
  expect(await nestedOrder()).toEqual(["Archive", "Active"]);

  // …and the ROOT order is untouched by the nested reorder
  expect(await rootOrder(page)).toEqual(ROOTS);

  // back up again
  await nested.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  expect(await nestedOrder()).toEqual(["Active", "Archive"]);
});

// SUB-451: the folder menu creates a note in that folder — same scratch path
// ⌘N takes inside a folder view (title focused, pristine-abandon semantics)
test("folder menu: New note creates the note inside that folder", async ({ page }) => {
  const folder = page.locator(".side-folder", { hasText: "Field notes" });
  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New note" }).click();

  // the draft opens with the title focused, "Untitled" selected for typing
  const title = page.locator(".note-title");
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Untitled");
  await page.keyboard.type("Folder-born note");
  await page.keyboard.press("Enter");

  // …and it lives under the folder that spawned it
  await folder.click();
  await expect(page.locator(".list-title")).toHaveText("Field notes");
  await expect(page.locator('.row[data-path^="Field notes/"]', { hasText: "Folder-born note" })).toHaveCount(1);
});

test("folder menu: New note on a nested folder keeps the full path", async ({ page }) => {
  const nested = page.locator(".side-folder", { hasText: "Active" });
  await nested.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New note" }).click();
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.type("Nested draft");
  await page.keyboard.press("Enter");

  await nested.click();
  await expect(
    page.locator('.row[data-path^="Projects/Active/"]', { hasText: "Nested draft" })
  ).toHaveCount(1);
});
