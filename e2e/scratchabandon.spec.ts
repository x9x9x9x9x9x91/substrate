import { expect, test, type Page } from "./fixtures";

// A ⌘N scratch note that stays pristine (Untitled title, empty body,
// only the created prop) abandons itself on leave — Esc, selection change —
// instead of littering the vault. Content or a real title makes it stick.

async function openNotes(page: Page) {
  await page.goto("/");
  const notes = page.locator(".side-item", { hasText: /^Notes/ });
  await expect(notes).toBeVisible();
  await notes.click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
}

test("⌘N then Esc abandons the pristine Untitled, silently", async ({ page }) => {
  await openNotes(page);
  await page.keyboard.press("Meta+n");
  const untitled = page.locator(".row", { hasText: "Untitled" });
  await expect(untitled).toHaveCount(1);
  // ⌘N drops the cursor into the title with the draft selected
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(untitled).toHaveCount(0);
  // silent by design — no "Moved to Trash" toast for an abandon
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("leaving the fresh note abandons it only while it stayed pristine", async ({ page }) => {
  await openNotes(page);
  const capture = page.locator(".row", { hasText: "Capture anything" });

  // empty after leaving: selecting another note deletes it
  await page.keyboard.press("Meta+n");
  const untitled = page.locator(".row", { hasText: "Untitled" });
  await expect(untitled).toHaveCount(1);
  await capture.click();
  await expect(untitled).toHaveCount(0);

  // body content survives — even typed inside the save debounce window
  await page.keyboard.press("Meta+n");
  await expect(untitled).toHaveCount(1);
  await page.locator(".cm-content").click();
  await page.keyboard.type("a real thought");
  await capture.click();
  await expect(untitled).toHaveCount(1);
});

test("a renamed scratch note is a real note — leaving keeps it", async ({ page }) => {
  await openNotes(page);
  await page.keyboard.press("Meta+n");
  // "Untitled" is selected in the title input — typing replaces it
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.type("Kept idea");
  await page.keyboard.press("Enter");
  const kept = page.locator(".row", { hasText: "Kept idea" });
  await expect(kept).toHaveCount(1);
  await page.locator(".row", { hasText: "Capture anything" }).click();
  await expect(kept).toHaveCount(1);
});
