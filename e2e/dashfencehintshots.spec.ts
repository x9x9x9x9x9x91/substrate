import { expect, test, type Page } from "./fixtures";

// Evidence run only: photographs a dashboard fence sitting in a plain note.
// Before this branch it was a code box and nothing else — the config plainly
// written, no picture, and nothing on screen saying which of the two had gone
// wrong. The frames are the same note on both builds, so the spec ASSERTS
// nothing about the hint: it has to run green on the commit that has no hint
// to photograph.
//   SHOTS=1 npx playwright test e2e/dashfencehintshots.spec.ts
// One ground: the app has no runtime light theme (the only light surface is
// the print pass), so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/dash-fence-hint-shots";

/** Three blocks, one of each answer the note can give: a heatmap that draws
    only on a board, a `view` that embeds its table right here, and a shell
    block that is a code box everywhere on purpose. One frame tells the whole
    rule apart. */
const BODY =
  "Notes on the sessions this year.\n\n" +
  "```heatmap\nsource: Session\ndate: date\n```\n\n" +
  "```view\ntype: Release\n```\n\n" +
  "```sh\nnpm test\n```\n";

async function seed(page: Page, body: string) {
  await page.evaluate((next) => window.__mockEditNote?.("Welcome.md", next), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
}

test("shot: a dashboard fence in a plain note", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await seed(page, BODY);

  // the ```view embed is the slowest of the three to arrive; waiting on it
  // keeps the frame from catching a half-painted note
  await expect(page.locator(".embed-view")).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("source: Session");
  // the caret starts in the buffer on some routes — park it off the fences so
  // no active-line tint lands on one block and not the others
  await page.locator(".note-title").click();
  await page.screenshot({ path: `${OUT}/1-plain-note.png` });

  // the same three blocks with the note pane scrolled to sit them together in
  // frame, cropped to the reading column
  const note = page.locator(".note");
  await note.screenshot({ path: `${OUT}/2-note-column.png` });
});
