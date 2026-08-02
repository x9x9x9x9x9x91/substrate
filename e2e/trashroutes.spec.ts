import { expect, test, type Page } from "@playwright/test";

// SUB-278: the trash surfaces outside the note pane (list-row context menu,
// palette, calendar) share App's post-trash handler — flush of the open
// note's pending debounced save, then the SUB-263 "Moved to Trash" toast
// with Undo and neighbor selection. These flows cover the list-row menu.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Notes scratch list (Today is a destination, SUB-300)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("row-menu trash: undo toast, Undo restores the note (SUB-278)", async ({ page }) => {
  // right-click a non-open row → Move to Trash
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();

  // shared post-trash feedback: toast offers Undo, the row leaves the list
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to Trash");
  await expect(row(page, "Capture anything")).toHaveCount(0);

  // Undo restores through the trash IPC and re-selects the note
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(row(page, "Capture anything")).toBeVisible();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
});

test("row-menu trash of the open note flushes the pending save first (SUB-278)", async ({
  page,
}) => {
  // type into the open note, then trash it from its row inside the 500ms
  // debounce window — without the flush the edit never reaches the trashed
  // file, and Undo would bring back the pre-edit body
  const marker = `E2E-FLUSH ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await row(page, "Welcome").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();

  // selection lands on the neighbor row (SUB-263), toast offers Undo
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to Trash");
  await expect(page.locator(".note-title")).not.toHaveValue("Welcome");

  // Undo brings the note back with the just-typed body — the flush ran
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".cm-content")).toContainText(marker);
});

// SUB-478: the toast's Undo restores by the trash id vault_delete returned.
// Trash a title, recreate it, trash it again — the trash then holds two
// entries at the same path, and the second toast's Undo must bring back the
// SECOND version. The old path-scan restore took whichever entry listed
// first, which is the wrong one.
test("Undo after a double trash restores the newer version (SUB-478)", async ({ page }) => {
  const makeNote = async (body: string) => {
    await page.keyboard.press("Meta+n");
    const title = page.locator(".note-title");
    await expect(title).toHaveValue("Untitled");
    await expect(title).toBeFocused();
    await page.keyboard.type("Twice Trashed");
    await page.keyboard.press("Enter");
    await row(page, "Twice Trashed").click();
    await expect(page.locator(".note-title")).toHaveValue("Twice Trashed");
    await page.locator(".cm-content").click();
    await page.keyboard.type(body);
  };

  // first version → trash, dismissing its toast so the second one is
  // unambiguous (the toast is a single slot keyed by id)
  await makeNote("FIRST VERSION");
  await row(page, "Twice Trashed").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to Trash");
  await expect(row(page, "Twice Trashed")).toHaveCount(0);

  // second version at the same title/path → trash again
  await makeNote("SECOND VERSION");
  await row(page, "Twice Trashed").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(toast).toContainText("Moved to Trash");

  // both deletions sit in the trash under one path
  await expect(row(page, "Twice Trashed")).toHaveCount(0);

  // Undo the second deletion — the SECOND version comes back, not the first
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Twice Trashed");
  await expect(page.locator(".cm-content")).toContainText("SECOND VERSION");
  await expect(page.locator(".cm-content")).not.toContainText("FIRST VERSION");

  // the first deletion is still recoverable from the Trash pane
  await page.locator(".side-item", { hasText: "Trash" }).click();
  await expect(page.locator(".trash-row", { hasText: "Twice Trashed" })).toHaveCount(1);
});

// SUB-488: the sharper version of the case above. When both deletions come
// from the toast lane the newest entry is also the one the toast holds, so a
// path scan accidentally agrees with id-threading. It only diverges when a
// SILENT trash lands at the same path while an older toast is still live —
// the ⌘N scratch abandon (SUB-264) does exactly that. Undo must then restore
// the entry the toast was created for, not whatever is newest at that path.
test("Undo restores its own entry when a silent trash lands at the same path (SUB-488)", async ({
  page,
}) => {
  // a ⌘N scratch with a body is a real note at Untitled.md — trash it from
  // its row, keeping the toast (and its trash id) live
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await page.locator(".cm-content").click();
  await page.keyboard.type("KEPT BODY");
  await row(page, "Untitled").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to Trash");
  await expect(row(page, "Untitled")).toHaveCount(0);

  // a second ⌘N reoccupies the freed Untitled.md and is left pristine, so the
  // abandon lane trashes it silently — a NEWER trash entry at the same path,
  // with no toast of its own
  await page.keyboard.press("Meta+n");
  await expect(row(page, "Untitled")).toHaveCount(1);
  await row(page, "Capture anything").click();
  await expect(row(page, "Untitled")).toHaveCount(0);
  await expect(toast).toContainText("Moved to Trash"); // the FIRST toast, still live

  // Undo restores the toast's own entry — the one with the body. A path scan
  // takes the newest entry at Untitled.md instead: the empty abandoned one.
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(page.locator(".cm-content")).toContainText("KEPT BODY");
});

test("trash rows carry a context menu: restore + armed destructives (SUB-378)", async ({
  page,
}) => {
  // put a note in the trash, then open the Trash pane
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await page.locator(".side-item", { hasText: "Trash" }).click();
  const trashRow = page.locator(".trash-row", { hasText: "Capture anything" });
  await expect(trashRow).toBeVisible();

  // destructive pick only ARMS the row's existing confirm — nothing deleted
  await trashRow.click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await menu.locator(".ctx-item", { hasText: "Delete forever" }).click();
  await expect(trashRow.locator(".trash-danger", { hasText: "Forever?" })).toBeVisible();
  await expect(trashRow).toBeVisible();

  // restore via the menu brings the note back
  await trashRow.click({ button: "right" });
  await page.locator(".ctx-menu .ctx-item", { hasText: "Restore" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
});
