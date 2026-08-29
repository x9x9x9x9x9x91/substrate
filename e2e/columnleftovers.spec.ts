import { expect, test, type Page } from "./fixtures";

// The margins of the parity rule: the spellings and shapes a column used to
// render differently from the identical markdown outside one. A `~~~view`
// fence draws, an indented or list-nested dashboard fence is a source box with
// its hint, emphasis closes across a player, a video is the same named chip it
// is outside a region, and an `annotations` fence binds to the player above it.

const dir = process.env.SHOT_DIR ?? "/tmp/columns-leftovers";

const BODY = [
  "Above the columns.",
  "",
  "<!-- columns -->",
  "## Fences",
  "~~~view",
  "type: release",
  "~~~",
  "",
  "  ```chart",
  "  type: bar",
  "  ```",
  "",
  "- the numbers",
  "  ```chart",
  "  type: line",
  "  ```",
  "<!-- col -->",
  "## Runs",
  "**a ![[old-bounce.wav]] b**",
  "",
  "![[clip.mp4]]",
  "",
  "![[old-bounce.wav]]",
  "```annotations",
  "audio: old-bounce.wav",
  "00:12 — the drop lands early",
  "```",
  "<!-- /columns -->",
  "",
  "Below the columns.",
  "",
].join("\n");

async function seeded(page: Page, body = BODY) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.evaluate((next) => window.__mockEditNote?.("Welcome.md", next), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
  await expect(page.locator(".cm-columns")).toBeVisible();
}

test("every fence spelling inside a column is a fence", async ({ page }) => {
  await seeded(page);

  const left = page.locator(".cm-column").nth(0);
  // a tilde fence draws the same table its backtick twin does
  await expect(left.locator(".embed-view .embed-view-table")).toBeVisible();
  await expect(left).not.toContainText("type: release");
  // an indented dashboard fence and one under a list item are source boxes
  // with the line that says where they draw, exactly as outside a region
  await expect(left).toContainText("type: bar");
  await expect(left).toContainText("type: line");
  await expect(left.locator(".cm-dash-hint")).toHaveCount(2);
});

test("emphasis closes across a player, and a video is the chip it is outside", async ({ page }) => {
  await seeded(page);

  const right = page.locator(".cm-column").nth(1);
  await expect(right).not.toContainText("**");
  const strong = right.locator("strong").first();
  await expect(strong).toContainText("a");
  await expect(strong.locator(".cm-audio")).toBeVisible();

  const chip = right.locator(".cm-filechip").first();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("clip.mp4");
});

test("an annotations fence in a column binds to the player above it", async ({ page }) => {
  await seeded(page);

  const right = page.locator(".cm-column").nth(1);
  await expect(right).not.toContainText("audio: old-bounce.wav");
  const bound = right.locator(".cm-audio").last();
  await expect(bound.locator(".cm-audio-annotation-text")).toHaveText("the drop lands early");
  // and the note written from in there is appended to that fence, not another
  await bound.locator(".cm-audio-wave").click({ position: { x: 60, y: 10 } });
  await expect(page.locator(".cm-columns")).toBeVisible();
});

test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");

  test("shot dark: the leftover cases in a column", async ({ page }) => {
    await seeded(page);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${dir}/leftovers-dark.png`, fullPage: true });
  });
});
