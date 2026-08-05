import { expect, test, type Page } from "@playwright/test";

// ⌘I over a bold word used to eat one asterisk off each `**` pair —
// toggleInlineMark compared exactly `mark.length` chars and never checked that
// those chars were a whole delimiter, so `**bold**` became `*bold*` (bold
// destroyed, italic in its place) on both unwrap paths: selection inside the
// markers, and selection including them. Correct behavior is to nest:
// `***bold***`.

/** Fresh note with the caret in its body — a blank doc per test, so what the
    assertions read back is only what this spec typed. The note keeps its
    Untitled name: renaming flushes and remounts the editor, which would drop
    the focus this helper just established. */
async function blankNote(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await page.locator(".cm-content").click();
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
}

/** The editor's whole text. `.cm-content` renders one div per line, and the
    inline decorations keep the raw markdown in the text layer, so textContent
    is the document source. */
async function docText(page: Page) {
  return (await page.locator(".cm-content").innerText()).trim();
}

/** Select `word` inside the current line by walking the caret: the doc is one
    short line, so Home + ArrowRight×n + Shift+ArrowRight×len is exact and
    avoids double-click's word-boundary guesswork around `*`. */
async function selectRange(page: Page, offset: number, length: number) {
  await page.keyboard.press("Home");
  for (let i = 0; i < offset; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < length; i += 1) await page.keyboard.press("Shift+ArrowRight");
}

test("⌘I inside a bold word nests instead of eating the ** (SUB-654)", async ({ page }) => {
  await blankNote(page);
  await page.keyboard.type("**bold**");
  await expect(page.locator(".cm-content")).toContainText("bold");

  // select just `bold` — the markers sit outside the selection, which is the
  // "chars on both sides match the mark" unwrap path
  await selectRange(page, 2, 4);
  await page.keyboard.press("Meta+i");

  expect(await docText(page)).toBe("***bold***");
});

test("⌘I over a whole bold span nests instead of eating the ** (SUB-654)", async ({ page }) => {
  await blankNote(page);
  await page.keyboard.type("**bold**");
  await expect(page.locator(".cm-content")).toContainText("bold");

  // select `**bold**` including both markers — the startsWith/endsWith path
  await selectRange(page, 0, 8);
  await page.keyboard.press("Meta+i");

  expect(await docText(page)).toBe("***bold***");
});

test("⌘I still wraps and unwraps a plain word (SUB-654)", async ({ page }) => {
  await blankNote(page);
  await page.keyboard.type("word");

  await selectRange(page, 0, 4);
  await page.keyboard.press("Meta+i");
  expect(await docText(page)).toBe("*word*");

  // the selection survives the wrap and still covers `word` — toggling again
  // must strip the pair back off (inner unwrap path)
  await page.keyboard.press("Meta+i");
  expect(await docText(page)).toBe("word");

  // and from the outside, markers included
  await selectRange(page, 0, 4);
  await page.keyboard.press("Meta+i");
  expect(await docText(page)).toBe("*word*");
  await selectRange(page, 0, 6);
  await page.keyboard.press("Meta+i");
  expect(await docText(page)).toBe("word");
});

test("⌘B still wraps an italic word and unwraps a bold one (SUB-654)", async ({ page }) => {
  await blankNote(page);
  await page.keyboard.type("*ital*");

  // the reverse direction was always safe — the 2-char probe cannot match a
  // lone `*` — but the run-length gate must not have broken it
  await selectRange(page, 1, 4);
  await page.keyboard.press("Meta+b");
  expect(await docText(page)).toBe("***ital***");

  // and ⌘B on that triple run takes the bold back off, leaving the italic
  await selectRange(page, 3, 4);
  await page.keyboard.press("Meta+b");
  expect(await docText(page)).toBe("*ital*");
});
