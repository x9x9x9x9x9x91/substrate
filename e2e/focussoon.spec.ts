import { expect, test, type Page } from "./fixtures";
import { pinnedInstant } from "./clock";

// ⌘N is the flagship capture moment — the user hits it and types
// immediately, faster than the ~80ms title-focus handoff. An earlier fix made that
// handoff cancel on any keydown, so those first characters went to
// document.body and vanished (the list has no type-ahead) and the
// note stayed unfocused and "Untitled" forever. Now a printable key pressed
// while nothing is focused fires the pending focus synchronously, in time for
// that same character to land in the title.
//
// The regressions this must not reawaken stay pinned in
// scratchabandon.spec.ts and rowcontrols.spec.ts; the third test here covers
// the list-focused arm directly.

async function openScratch(page: Page) {
  await page.goto("/");
  const notes = page.locator(".side-item", { hasText: /^Scratch/ });
  await expect(notes).toBeVisible();
  await notes.click();
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await expect(page.locator(".list .row").first()).toBeVisible();
}

test("⌘N then an immediate keystroke lands the char in the title", async ({ page }) => {
  await openScratch(page);
  // no settle: press and type inside the focus-handoff window
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("X");
  const title = page.locator(".note-title");
  await expect(title).toBeFocused();
  // the draft title was selected, so the typed char replaces it outright
  await expect(title).toHaveValue("X");
});

test("a fast-typed string after ⌘N lands whole, and titles the note", async ({ page }) => {
  await openScratch(page);
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
  // This test used to race the real 80ms handoff timer — on a
  // saturated machine the arrow arrived after the timer had fired, and the
  // title taking focus then is the *intended* idle-user behavior, not a bug.
  // Fake time removes the race: the handoff timer cannot fire while the
  // clock is paused, so the arrow provably lands inside the window, and
  // advancing the clock afterwards proves the focus was cancelled outright
  // rather than merely not yet due. On a pinned run the fixture's clock is
  // already installed and flowing — installing again with no time would
  // silently re-seed it at the wall clock — so only a live run installs.
  if (!pinnedInstant()) await page.clock.install();
  await openScratch(page);
  // arrow-key selection active: the list, not the void, owns the keyboard
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("ArrowDown");
  const selected = page.locator(".list .row.selected");
  const before = await selected.getAttribute("data-path");

  // read off the page, not the runner: the suite's clock started on the
  // pinned day and has been flowing since, so a runner-side stamp is already
  // behind it and pauseAt refuses to travel backwards
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(pageNow + 1000);
  await page.keyboard.press("Meta+n");
  // let the mock create resolve (≤25ms of fake time) without coming near
  // the 80ms handoff; the seeded row appearing proves the deferred focus
  // is armed before the arrow is sent
  await page.clock.runFor(30);
  await expect(page.locator(".row", { hasText: "Untitled" })).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  // the arrow belonged to the list; it must not have been swallowed by a
  // title that stole focus out from under it
  await expect(page.locator(".note-title")).not.toBeFocused();
  expect(await selected.getAttribute("data-path")).not.toBe(before);

  // past where the handoff would have fired: still cancelled, not pending
  await page.clock.runFor(200);
  await expect(page.locator(".note-title")).not.toBeFocused();
});
