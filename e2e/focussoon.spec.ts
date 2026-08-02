import { expect, test, type Page } from "@playwright/test";

// SUB-765: ⌘N is the flagship capture moment — the user hits it and types
// immediately, faster than the ~80ms title-focus handoff. SUB-455 made that
// handoff cancel on any keydown, so those first characters went to
// document.body and vanished (the list has no type-ahead, SUB-392) and the
// note stayed unfocused and "Untitled" forever. Now a printable key pressed
// while nothing is focused fires the pending focus synchronously, in time for
// that same character to land in the title.
//
// The SUB-455 regressions this must not reawaken stay pinned in
// scratchabandon.spec.ts and rowcontrols.spec.ts; the third test here covers
// the list-focused arm directly.

async function openNotes(page: Page) {
  await page.goto("/");
  const notes = page.locator(".side-item", { hasText: /^Notes/ });
  await expect(notes).toBeVisible();
  await notes.click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".list .row").first()).toBeVisible();
}

test("⌘N then an immediate keystroke lands the char in the title", async ({ page }) => {
  await openNotes(page);
  // no settle: press and type inside the focus-handoff window
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("X");
  const title = page.locator(".note-title");
  await expect(title).toBeFocused();
  // the draft title was selected, so the typed char replaces it outright
  await expect(title).toHaveValue("X");
});

test("a fast-typed string after ⌘N lands whole, and titles the note", async ({ page }) => {
  await openNotes(page);
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("Riff idea", { delay: 4 });
  const title = page.locator(".note-title");
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Riff idea");
  // the title only reaches the row (and the vault) once Enter commits the
  // rename — until then the draft lives in the input
  await page.keyboard.press("Enter");
  await expect(page.locator(".row", { hasText: "Riff idea" })).toHaveCount(1);
  await expect(page.locator(".row", { hasText: "Untitled" })).toHaveCount(0);
});

test("with the list focused, a non-printable key after ⌘N is not yanked into the title (SUB-455)", async ({
  page,
}) => {
  await openNotes(page);
  // arrow-key selection active: the list, not the void, owns the keyboard
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("ArrowDown");
  const selected = page.locator(".list .row.selected");
  const before = await selected.getAttribute("data-path");

  await page.keyboard.press("Meta+n");
  await page.keyboard.press("ArrowDown");
  // the arrow belonged to the list; it must not have been swallowed by a
  // title that stole focus out from under it
  await expect(page.locator(".note-title")).not.toBeFocused();
  expect(await selected.getAttribute("data-path")).not.toBe(before);
});
