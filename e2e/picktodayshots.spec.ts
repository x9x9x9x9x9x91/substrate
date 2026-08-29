import { expect, test, type Page } from "./fixtures";

// Evidence run only: photographs the two new ways an EXISTING task reaches
// today — the suggestions under the Today capture line, and the Tasks row's
// right-click menu. Both were unreachable before this branch (the line was
// free text; the list rows had no menu at all), so the spec asserts only what
// it needs to frame the shot.
//   SHOTS=1 npx playwright test e2e/picktodayshots.spec.ts
// One ground: the app has no runtime light theme, so every shot is the one
// theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/pick-today-shots";

async function openTasks(page: Page) {
  await page.goto("/");
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await expect(page.locator(".dash-title")).toHaveText("Tasks");
}

test("shot: the add box suggests open tasks", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();

  const field = page.locator(".today-add-input");
  // before: the line as it was, nothing under it
  await page.screenshot({ path: `${OUT}/1-add-line-before.png` });

  await field.click();
  await field.type("a");
  await expect(page.locator(".today-suggest-row").first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/2-suggestions.png` });

  // the keyboard walk's highlight — the state Enter commits from
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".today-suggest-row.selected")).toBeVisible();
  await page.screenshot({ path: `${OUT}/3-suggestion-selected.png` });

  // and a query nothing matches draws no panel at all
  await field.fill("qqqq");
  await expect(page.locator(".today-suggest")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/4-no-matches.png` });
});

test("shot: a task row's Pick for today menu", async ({ page }) => {
  await openTasks(page);

  const row = page.locator(".tasks-row").first();
  await expect(row).toBeVisible();
  await page.screenshot({ path: `${OUT}/5-tasks-before.png` });

  const box = await row.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 120, (box?.y ?? 0) + 12);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(page.locator(".ctx-item").first()).toContainText("Pick for today");
  // the menu fades in; a frame taken on the first paint photographs an
  // opacity-0 menu that the assertions above still call visible
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/6-tasks-row-menu.png` });
  // the frame is only evidence if the menu was still open when it was taken
  await expect(page.locator(".ctx-menu")).toBeVisible();
});
