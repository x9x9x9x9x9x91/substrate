import { expect, test } from "@playwright/test";

// SUB-452: the in-app release history. The button lives beside the info-view
// ? in the lower-left cluster; the pane is read-only and vault-free.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("the changelog button sits next to the info-view ? and opens the pane", async ({ page }) => {
  const tools = page.locator(".side-tools");
  await expect(tools.locator(".info-view-toggle")).toBeVisible();

  const button = page.getByRole("button", { name: "What's new" });
  await expect(button).toBeVisible();
  // same cluster, not somewhere else in the sidebar
  await expect(tools.getByRole("button", { name: "What's new" })).toHaveCount(1);

  await button.click();
  await expect(page.locator(".dash-title")).toHaveText("What's new");
  // SUB-682: the "substrate / changelog" kicker is gone — the title carries it
  await expect(page.locator(".dash-kicker")).toHaveCount(0);
});

test("the pane shows the current version and the release history", async ({ page }) => {
  await page.getByRole("button", { name: "What's new" }).click();

  const header = page.locator(".dash-head .dash-state");
  // the label voice uppercases in CSS, so read the DOM text, not the rendering
  await expect(header).toHaveText(/^version \d+\.\d+\.\d+$/);
  const version = ((await header.textContent()) ?? "").replace("version", "").trim();

  // the newest section is the shipped version
  const sections = page.locator(".chlog-release");
  await expect(sections.first().locator(".dash-section-label")).toContainText(version);
  expect(await sections.count()).toBeGreaterThanOrEqual(5);

  // every section carries items, and the first one is legible
  await expect(sections.first().locator(".chlog-item")).not.toHaveCount(0);
  await expect(sections.first().locator(".chlog-text").first()).not.toBeEmpty();
});

test("a release leads with its headline and groups the rest by kind (SUB-817)", async ({
  page,
}) => {
  await page.getByRole("button", { name: "What's new" }).click();

  // the newest release (0.19.0+) always flags a headline; it renders before
  // the kind groups and carries the larger voice
  const first = page.locator(".chlog-release").first();
  await expect(first.locator(".chlog-headline")).not.toHaveCount(0);
  await expect(first.locator(".chlog-headline-text").first()).not.toBeEmpty();

  // group labels carry the kind dot and the New/Improved/Fixed word
  const labels = first.locator(".chlog-group-label");
  await expect(labels).not.toHaveCount(0);
  const texts = await labels.allTextContents();
  for (const text of texts) {
    expect(["New", "Improved", "Fixed"]).toContain(text.trim());
  }
  // group order is fixed: New before Improved before Fixed
  const rank = (t: string) => ["New", "Improved", "Fixed"].indexOf(t.trim());
  for (let i = 1; i < texts.length; i++) {
    expect(rank(texts[i])).toBeGreaterThan(rank(texts[i - 1]));
  }
  // items inside groups no longer repeat the dot — it lives on the label
  await expect(first.locator(".chlog-item .dash-dot")).toHaveCount(0);
});

test("the pane is read-only — no inputs, no editor", async ({ page }) => {
  await page.getByRole("button", { name: "What's new" }).click();
  const pane = page.locator(".main");
  await expect(pane.locator(".dash-title")).toHaveText("What's new");
  await expect(pane.locator(".dash-kicker")).toHaveCount(0);

  await expect(pane.getByRole("textbox")).toHaveCount(0);
  await expect(pane.locator("input, textarea, select, [contenteditable='true']")).toHaveCount(0);
  await expect(pane.locator(".cm-content")).toHaveCount(0);
});
