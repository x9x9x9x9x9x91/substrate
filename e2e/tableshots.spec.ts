import { expect, test } from "./fixtures";

import { docEnd, docStart, mod } from "./keys";

// Evidence run only: SHOTS=1 npx playwright test e2e/tableshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = "/tmp/table-shots";

async function openNote(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press(docEnd);
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
  await page.keyboard.press(docStart);
  await expect(page.locator(".cm-md-table").last().locator("th")).toHaveCount(3);
  await page.locator(".cm-md-table-wrap").last().hover();
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/grow-after-column.png` });

  await page.locator(".cm-md-table-add-row").click();
  await page.keyboard.press(docStart);
  await page.locator(".cm-md-table-wrap").last().hover();
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/grow-after-row.png` });
});

test("after: the table menu, the in-place cell editor and an aligned column", async ({ page }) => {
  await openNote(page);
  await page.keyboard.type("| Track | Length |\n| --- | --- |\n| Slug It Out | 6:12 |\n| Nod | 5:01 |");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table").last()).toBeVisible();

  const cell = page.locator(".cm-md-table td").filter({ hasText: "6:12" }).first();
  await cell.click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/menu-on-cell.png`, fullPage: false });

  // the same menu on the header row, where deleting a row is refused
  await page.keyboard.press("Escape");
  await page.locator(".cm-md-table th").filter({ hasText: "Track" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/menu-on-header.png`, fullPage: false });

  await page.keyboard.press("Escape");
  await cell.click({ button: "right" });
  await page.locator(".ctx-item").filter({ hasText: "Edit cell" }).first().click();
  await expect(page.locator(".cm-md-table-cell-editing")).toBeVisible();
  await page.keyboard.type("7:40");
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/cell-editing.png` });
  await page.keyboard.press("Enter");

  await page.locator(".cm-md-table th").filter({ hasText: "Length" }).first().click({ button: "right" });
  await page.locator(".ctx-item").filter({ hasText: "Align right" }).first().click();
  await expect(page.locator(".cm-md-table").last()).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator(".cm-md-table-wrap").last().screenshot({ path: `${dir}/aligned-right.png` });

  // and the keyboard's way in: cursor in the table's source, no grid to click
  await page.locator(".cm-md-table td").filter({ hasText: "5:01" }).first().click();
  // the click collapses the grid to its source — wait for that before the
  // shortcut, or the menu anchors off a widget that is on its way out
  await expect(page.locator(".cm-table-line").first()).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+M`);
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/menu-from-keyboard.png`, fullPage: false });
});

test("after: the menu on a quoted table, refused across the board", async ({ page }) => {
  await openNote(page);
  // the quote continuation types the "> " on the following lines itself
  await page.keyboard.type("> | Track | Length |\n| --- | --- |\n| Nod | 5:01 |");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table").last()).toBeVisible();

  await page.locator(".cm-md-table td").filter({ hasText: "5:01" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/menu-on-quoted.png`, fullPage: false });
});
