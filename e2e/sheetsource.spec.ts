import { expect, test, type Page } from "./fixtures";

// Resolution — the "stale sheet source view" was live-preview
// concealment, not staleness. The original repro's element-center click
// landed the caret on the ```formulas fence delimiter line, so the marker
// was typed into the fence info string; on reopen the cursor sits elsewhere
// and live preview hides that line's raw text by design. Instrumented runs
// showed the reopened editor mounts with the fresh disk body every time.
// These specs pin both halves: reopen shows a normal-line edit, and a
// fence-delimiter edit is concealed-then-revealed, never lost.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

async function openHoldingsSource(page: Page) {
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("Holdings");
  await expect(page.locator(".palette-item.selected")).toContainText("Holdings");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await page.locator('.sheet-tool[title="View note source"]').click();
  await expect(page.locator(".sheet-src .cm-editor")).toBeVisible();
}

async function navigateAwayAndBack(page: Page) {
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await openHoldingsSource(page);
}

test("sheet source view shows a typed edit after navigate-away-and-back (SUB-795)", async ({
  page,
}) => {
  await boot(page);
  await openHoldingsSource(page);

  const marker = `E2E-SRC ${Date.now()}`;
  // a normal text line — the intro paragraph, not the fence delimiter
  await page.locator(".sheet-src .cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(marker);
  await expect
    .poll(() =>
      page.evaluate(([m]) => window.__mockBodyOf?.("Holdings.md")?.includes(m) ?? false, [marker])
    )
    .toBe(true);

  await navigateAwayAndBack(page);
  await expect(page.locator(".sheet-src .cm-content")).toContainText(marker);
});

test("an edit on the fence delimiter line is concealed on reopen, revealed under the cursor — never lost (SUB-795)", async ({
  page,
}) => {
  await boot(page);
  await openHoldingsSource(page);

  const marker = `E2E-FENCE ${Date.now()}`;
  // element-center click: this is the original repro's gesture, and
  // it puts the caret on the ```formulas fence delimiter line
  await page.locator(".sheet-src .cm-content").click();
  await page.keyboard.type(marker);
  await expect
    .poll(() =>
      page.evaluate(([m]) => window.__mockBodyOf?.("Holdings.md")?.includes(m) ?? false, [marker])
    )
    .toBe(true);

  await navigateAwayAndBack(page);
  // concealed: the cursor is outside the fence line, so its raw text is
  // hidden by live preview — this is the state the bug report read as "stale"
  await expect(page.locator(".sheet-src .cm-content")).not.toContainText(marker);

  // walk the cursor up onto the delimiter line — the raw text reveals
  await page.locator(".sheet-src .cm-line", { hasText: "value_usd = units" }).first().click();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowUp");
    const visible = await page
      .locator(".sheet-src .cm-content")
      .evaluate((el, [m]) => (el.textContent ?? "").includes(m), [marker]);
    if (visible) break;
  }
  await expect(page.locator(".sheet-src .cm-content")).toContainText(marker);
});
