import { expect, test, type Page } from "./fixtures";

// Slice 2: the structural actions are on the app's undo stack
// (docs/undo.md §6.3). Trash and rename each record an inverse, the trash
// toast's Undo and ⌘Z are the SAME entry (one pre-minted id, not two
// lookalike closures), and a rename undo refuses once anything it rewrote —
// including a third-party note the link sweep touched — changed on disk.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

/** open a note via the palette, keeping focus out of editable fields first
    (app shortcuts stay out of them) — same shape as backlinks.spec.ts */
async function openNote(page: Page, title: string) {
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(page.locator(".palette-item.selected")).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue(title);
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Scratch list (Today is a destination)
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("⌘Z after a trash restores the note", async ({ page }) => {
  await row(page, "Capture anything").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".toast")).toContainText("Moved to Trash");
  await expect(row(page, "Capture anything")).toHaveCount(0);

  await page.keyboard.press("Meta+z");
  await expect(row(page, "Capture anything")).toBeVisible();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
});

// the id-keyed half, now via the keyboard: the stack entry closes
// over the trash id vault_delete returned, so ⌘Z restores the version it was
// recorded for even when an older deletion sits at the same path
test("⌘Z after a double trash restores the newer version, not whatever is at that path", async ({
  page,
}) => {
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

  await makeNote("FIRST VERSION");
  await row(page, "Twice Trashed").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".toast")).toContainText("Moved to Trash");
  await expect(row(page, "Twice Trashed")).toHaveCount(0);

  await makeNote("SECOND VERSION");
  await row(page, "Twice Trashed").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".toast")).toContainText("Moved to Trash");
  await expect(row(page, "Twice Trashed")).toHaveCount(0);

  // ⌘Z, not the toast button — same entry, same id
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".note-title")).toHaveValue("Twice Trashed");
  await expect(page.locator(".cm-content")).toContainText("SECOND VERSION");
  await expect(page.locator(".cm-content")).not.toContainText("FIRST VERSION");

  // and the older deletion is still sitting in the Trash, untouched
  await page.locator(".side-item", { hasText: "Trash" }).click();
  await expect(page.locator(".trash-row", { hasText: "Twice Trashed" })).toHaveCount(1);
});

test("⌘Z after a rename puts the title back", async ({ page }) => {
  await row(page, "Welcome").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  const input = page.locator("input.inline-edit");
  await expect(input).toBeVisible();
  await input.fill("Renamed 515");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Renamed 515");

  // out of the title field so ⌘Z is the vault's undo, not text undo
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Rename");
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "Renamed 515")).toHaveCount(0);
});

// THE point of the slice. Renaming rewrites [[links]] in OTHER notes; the
// entry names those notes too, so an outside edit to one of them refuses the
// undo instead of taking its rewrite back over the top of someone else's work.
test("a rename undo is refused after an external edit to a link-rewritten note", async ({
  page,
}) => {
  // "Static Bouquet" links [[Slow Bloom EP]] — rename the target and the
  // sweep rewrites that third-party note
  await openNote(page, "Slow Bloom EP");
  const title = page.locator(".note-title");
  await title.fill("Slow Bloom EP II");
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("Slow Bloom EP II");

  await openNote(page, "Static Bouquet");
  await expect(page.locator(".cm-content")).toContainText("Slow Bloom EP II");

  // An outside edit to a note the rename did NOT touch must leave the
  // entry alone — it arrives on the same kind of event as the one below and
  // used to be indistinguishable from it.
  await page.evaluate(() => {
    window.__mockEditNote!("Vessel Songs.md", "Somebody else's note, somebody else's edit.\n");
    window.__mockEmit!("vault:changed", ["Vessel Songs.md"]);
  });

  // someone else edits the link-rewritten note itself. The rename wrote that
  // path too, so wait out ITS echo window — inside it the app is
  // right to read the event as its own sweep coming back.
  await page.waitForTimeout(1100);
  await page.evaluate(() => {
    window.__mockEditNote!("Static Bouquet.md", "Edited outside — [[Slow Bloom EP II]] stays.\n");
    window.__mockEmit!("vault:changed", ["Static Bouquet.md"]);
  });
  await expect(page.locator(".cm-content")).toContainText("Edited outside");

  // ⌘Z belongs to the app only outside editable fields
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("changed on disk");
  // the rename stands and the outside edit survives — no clobber
  await expect(page.locator(".cm-content")).toContainText("Edited outside");
  await expect(page.locator(".cm-content")).toContainText("Slow Bloom EP II");
});

/* The other half: the same rename, the same kind of external edit —
   but to a note the rename never touched. Before the event carried paths, any
   outside write invalidated the whole stack and this ⌘Z was refused too. */
test("a rename undo survives an external edit to an unrelated note", async ({ page }) => {
  await openNote(page, "Slow Bloom EP");
  const title = page.locator(".note-title");
  await title.fill("Slow Bloom EP II");
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("Slow Bloom EP II");

  // "Vessel Songs" is neither the renamed note nor a link-rewritten one
  await page.evaluate(() => {
    window.__mockEditNote!("Vessel Songs.md", "Somebody else's note, somebody else's edit.\n");
    window.__mockEmit!("vault:changed", ["Vessel Songs.md"]);
  });

  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Rename");
  await openNote(page, "Slow Bloom EP");
});
