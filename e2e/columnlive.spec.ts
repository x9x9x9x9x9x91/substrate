import { expect, test, type Page } from "./fixtures";

// What a column cell shows beyond static text: the same live widgets the
// identical markdown gets outside a region. A view fence draws through the
// app's own view widget, an audio embed gets the transport, any other file
// gets its chip — and clicks on those controls belong to them, while a click
// on the text around them is still the click that reveals the markdown.

const dir = process.env.SHOT_DIR ?? "/tmp/columns-live";

const BODY = [
  "Above the columns.",
  "",
  "<!-- columns -->",
  "## Releases",
  "```view",
  "type: release",
  "```",
  "<!-- col -->",
  "## Files",
  "![[old-bounce.wav]]",
  "",
  "![[some.docx]]",
  "<!-- /columns -->",
  "",
  "Below the columns.",
  "",
].join("\n");

const CHART = [
  "<!-- columns -->",
  "## Numbers",
  "```chart",
  "type: bar",
  "```",
  "<!-- col -->",
  "## Words",
  "Nothing special.",
  "<!-- /columns -->",
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

test("a view fence inside a column is the live view widget, not its source", async ({ page }) => {
  await seeded(page);

  const left = page.locator(".cm-column").nth(0);
  await expect(left).not.toContainText("type: release");
  const table = left.locator(".embed-view .embed-view-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr").first()).toBeVisible();
  // the header carries the same identity the live embed's does
  await expect(left.locator(".embed-view-name")).toHaveText("Release");

  // LIVE, the way the same fence is outside a region: the row-adding control
  // is there, and a click inside the widget belongs to the widget — a cell
  // click opens its editor in place and the grid never stands down under it
  await expect(left.locator(".embed-view-new")).toBeVisible();
  await left.locator("td.embed-view-cell").first().click();
  await expect(left.locator("td.editing")).toBeVisible();
  await expect(page.locator(".cm-columns")).toBeVisible();

  // while a click on the prose beside it is still the one that gives back
  // the markdown underneath
  await left.getByText("Releases").click();
  await expect(page.locator(".cm-columns")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("<!-- col -->");
});

test("audio and file embeds inside a column are the player and the chip", async ({ page }) => {
  await seeded(page);

  const right = page.locator(".cm-column").nth(1);
  await expect(right).not.toContainText("embedded file");
  const player = right.locator(".cm-audio");
  await expect(player).toBeVisible();
  await expect(player.locator(".cm-audio-name")).toHaveText("old-bounce.wav");
  const chip = right.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("some.docx");
  // the size lands from the same asset read the chip outside a column makes
  await expect(chip.locator(".cm-filechip-size")).toHaveText("17 B");

  // the transport is the player's own: a click on it seeks rather than
  // dropping the region back to markdown mid-listen
  await player.locator(".cm-audio-wave").click({ position: { x: 40, y: 10 } });
  await expect(page.locator(".cm-columns")).toBeVisible();
  // while the prose beside it still reveals the source on click
  await right.getByText("Files").click();
  await expect(page.locator(".cm-columns")).toHaveCount(0);
});

test("a dashboard fence inside a column stays source, with the same hint", async ({ page }) => {
  await seeded(page, CHART);

  const left = page.locator(".cm-column").nth(0);
  // a chart draws on a dashboard and nowhere else — inside a column it says
  // exactly that, rather than being more capable than the paragraph beside it
  await expect(left).toContainText("type: bar");
  await expect(left.locator(".cm-dash-hint")).toBeVisible();
});

test.describe("shots", () => {
  test.skip(!process.env.SHOTS, "evidence run only");

  test("shot dark: live column contents", async ({ page }) => {
    await seeded(page);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${dir}/live-dark.png`, fullPage: true });
  });

  test("shot dark: a dashboard fence in a column", async ({ page }) => {
    await seeded(page, CHART);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${dir}/dashfence-dark.png`, fullPage: true });
  });
});
