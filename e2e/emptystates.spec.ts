import { expect, test } from "@playwright/test";

// Every empty state renders through one shell — a glyph from the
// existing icon set, the line, the quiet hint, and where the hint names a
// verb, that verb as a button. The button never invents a command: it fires
// the same one the hint's shortcut fires, under that command's own label.

test("front door: the empty list's button creates a note where you are", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  // a folder with nothing in it — the front door for a view that has no rows
  await page.locator(".side-folder", { hasText: "Archive" }).first().click();

  const empty = page.locator(".list-body .empty");
  await expect(empty).toContainText("Nothing here");
  // the shell, in full: glyph, line, hint, action
  await expect(empty.locator("svg")).toHaveCount(1);
  // the hint names what ⌘N does HERE: in a folder the note is born in the
  // folder, not captured into the Inbox
  await expect(empty.locator(".empty-hint")).toContainText("⌘N creates a note in this folder");
  const action = empty.locator(".empty-action");
  await expect(action).toHaveText("New note");

  // the hint's verb, clicked — the same command ⌘N runs
  await action.click();
  await expect(page.locator(".note-title")).toBeVisible();
  await expect(page.locator(".list-body .empty")).toHaveCount(0);
});

test("no selection: the empty note pane's button opens the palette", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  // a view with no rows drops the selection — the note pane's front door
  await page.locator(".side-folder", { hasText: "Archive" }).first().click();

  const empty = page.locator(".note .empty");
  await expect(empty).toContainText("No note selected");
  await expect(empty.locator("svg")).toHaveCount(1);
  await expect(empty.locator(".empty-hint")).toContainText("⌘K");

  await empty.locator(".empty-action", { hasText: "Command palette" }).click();
  await expect(page.locator(".palette-input")).toBeVisible();
});

test("an empty day collapses the three lanes into one state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  // the mock's day is always populated, so the empty day is staged: every note
  // goes, which empties all four lanes (leftovers, scheduled, due, picked) at
  // once — the only state in which the collapse is supposed to fire
  await page.evaluate(() => {
    const w = window as unknown as {
      __mockNotesDump: () => { path: string }[];
      __mockDeleteNote: (p: string) => void;
      __mockEmit: (e: string, payload?: unknown) => void;
    };
    const paths = w.__mockNotesDump().map((n) => n.path);
    for (const p of paths) w.__mockDeleteNote(p);
    w.__mockEmit("vault:changed", paths);
  });

  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
  await expect(page.locator(".today-row")).toHaveCount(0);

  const empty = page.locator(".today-pane .empty");
  await expect(empty).toContainText("Nothing on today");
  await expect(empty.locator("svg")).toHaveCount(1);
  // one state, not three quiet lines under three eyebrows
  await expect(page.locator(".today-quiet")).toHaveCount(0);
  await expect(page.locator(".today-section")).toHaveCount(0);
  // the day's one verb stays in the head
  await expect(page.locator(".today-journal")).toBeVisible();
});
