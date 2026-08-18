import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run that photographs each new sub-grammar popup for
// review — not a gate.
//   SHOTS=1 npx playwright test e2e/subgrammarshots.spec.ts
// One pass, not a light/dark pair: styles.css carries no prefers-color-scheme
// block and the app has no theme switch, so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const menu = ".cm-tooltip-autocomplete";
const OUT = "/tmp/sub1254-shots";

/** Notes → Welcome, then a fresh last line to type on. */
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".cm-content").click();
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
}

test("shot: the anchor list — a target note's outline", async ({ page }) => {
  // from a note that is NOT Welcome — the popup reads the TARGET's outline.
  // (A target with no headings offers nothing at all, correctly.)
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("See [[Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/anchor-other-note.png` });
});

test("shot: the anchor list for this note", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("back to [[");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/anchor-this-note.png` });
});

test("shot: the alias suggestions past a pipe", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("See [[Welcome#The basics");
  await page.keyboard.press("Escape");
  await page.keyboard.type("|");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/alias.png` });
});

test("shot: an embed's display modifiers", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("![[vessel-artwork.svg");
  await page.keyboard.press("Escape");
  await page.keyboard.type("|");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/embed-modifier.png` });
});

test("shot: the callout kinds", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("> [!");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/callout-kind.png` });
});

test("shot: the ten accents behind a kind's pipe", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("> [!note|");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/callout-accent.png` });
});

test("shot: an accented callout as it renders", async ({ page }) => {
  // the short Inbox note, so the finished callout sits in open space rather
  // than clipped against the bottom of a long one
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("> [!warn|teal] Mind the gap\n> An accented callout.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-callout-line").last()).toBeVisible();
  await page.screenshot({ path: `${OUT}/callout-rendered.png` });
});
