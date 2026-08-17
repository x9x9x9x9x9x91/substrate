import { expect, test } from "@playwright/test";

// Evidence run only: SHOTS=1 npx playwright test e2e/tableshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = "/tmp/table-shots";

async function openNote(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
}

test("before: the palette without a table entry is only reachable by typing pipes", async ({
  page,
}) => {
  await openNote(page);
  await page.keyboard.type("| Track | Length |");
  await page.keyboard.press("Enter");
  await page.keyboard.type("| --- | --- |");
  await page.keyboard.press("Enter");
  await page.keyboard.type("| Slug It Out | 6:12 |");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/before-raw-pipes.png`, fullPage: false });
});

test("after: /table in the palette", async ({ page }) => {
  await openNote(page);
  await page.keyboard.type("/tab");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/after-menu.png`, fullPage: false });
});

test("after: the scaffold, then the rendered grid", async ({ page }) => {
  await openNote(page);
  await page.keyboard.type("/table");
  await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected="true"]')).toContainText(
    "/table"
  );
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/after-scaffold-empty.png`, fullPage: false });

  await page.keyboard.type("Track");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/after-scaffold-typing.png`, fullPage: false });

  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table").last()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/after-rendered.png`, fullPage: false });
});

test("after: the grow buttons, idle and hovered", async ({ page }) => {
  await openNote(page);
  await page.keyboard.type("| Track | Length |\n| --- | --- |\n| Slug It Out | 6:12 |");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
  const table = page.locator(".cm-md-table").last();
  await expect(table).toBeVisible();
  await page.waitForTimeout(300);
  await table.screenshot({ path: `${dir}/grow-idle.png` });

  const wrap = page.locator(".cm-md-table-wrap").last();
  await wrap.hover();
  await page.waitForTimeout(300);
  await wrap.screenshot({ path: `${dir}/grow-hover.png` });

  await page.locator(".cm-md-table-add-column").hover();
  await page.waitForTimeout(200);
  await wrap.screenshot({ path: `${dir}/grow-hover-column.png` });

  await page.locator(".cm-md-table-add-column").click();
  await page.keyboard.type("BPM");
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-md-table").last().locator("th")).toHaveCount(3);
  await page.locator(".cm-md-table-wrap").last().hover();
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/grow-after-column.png` });

  await page.locator(".cm-md-table-add-row").click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.locator(".cm-md-table-wrap").last().hover();
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/grow-after-row.png` });
});
