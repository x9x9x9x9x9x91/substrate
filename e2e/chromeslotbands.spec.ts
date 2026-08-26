import { expect, test, type Page } from "./fixtures";

// The chrome slot is a desktop-only reservation for the fixed
// keyboard button. Two widths get it wrong and neither is covered by the
// existing gates — chromeslot.spec.ts and keyhints.spec.ts both sit at the
// 1280px default, and the mobile specs sit at 375/390px where they only ever
// assert that the button is absent.
//
//  * 701-900px: the outline goes `position: fixed` in that band and
//    was inset to a bare 24px, landing under the button.
//  * <=700px: the button doesn't render at all, but the heads kept
//    reserving 40px for it.

async function chromeSlotRight(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const px = (name: string) => parseFloat(root.getPropertyValue(name));
    return px("--chrome-x") + px("--chrome-slot");
  });
}

test.describe("narrow desktop band", () => {
  test.use({ viewport: { width: 800, height: 800 } });

  test("the outline toggle clears the keyboard button at 800px", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".note-title")).toHaveValue("Welcome");

    // the outline only renders for a note with headings
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.type("\n\n# One\n\n## Two\n\n# Three\n");
    const outline = page.locator(".editor-outline");
    await expect(outline).toBeVisible();

    // the rail opens by default, and its toggle now lives in the tool row
    const toggle = page.locator(".note-tools .editor-outline-toggle");
    await expect(page.locator(".editor-outline-list")).toBeVisible();

    // the outline is fixed in this band, so it is positioned against the
    // viewport and takes no .main inset correction
    await expect(outline).toHaveCSS("position", "fixed");
    const slot = await chromeSlotRight(page);
    const box = (await outline.boundingBox())!;
    expect(Math.round(800 - (box.x + box.width))).toBe(Math.round(slot));

    // and the toggle itself no longer sits under the button
    const chip = (await page.locator(".keyhints-chip").boundingBox())!;
    const tog = (await toggle.boundingBox())!;
    expect(tog.x + tog.width).toBeLessThanOrEqual(chip.x);

    // the fixed rail starts below the note tool row, so it never covers the
    // toggle that closes it
    expect(box.y).toBeGreaterThanOrEqual(tog.y + tog.height);
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("slot-reserving heads hand the gutter back when the button is gone", async ({ page }) => {
    await page.goto("/");
    // the button is !mobile-gated — nothing to reserve for
    await expect(page.locator(".keyhints-chip")).toHaveCount(0);

    const slot = await chromeSlotRight(page);
    const reserved = `${slot - 9}px`;

    await page.locator(".mobile-menu").click();
    await page.locator(".side-item", { hasText: "All databases" }).click();
    const dbmgr = page.locator(".dbmgr .list-head");
    await expect(dbmgr).toBeVisible();
    await expect(dbmgr).not.toHaveCSS("padding-right", reserved);
    // the head's right-loaded action lands near the edge, not 40px in
    const head = (await dbmgr.boundingBox())!;
    const action = (await dbmgr.locator("button").last().boundingBox())!;
    expect(head.x + head.width - (action.x + action.width)).toBeLessThan(20);

    await page.locator(".mobile-menu").click();
    await page.locator(".side-item", { hasText: "Trash" }).click();
    const trash = page.locator(".trash .list-head");
    await expect(trash).toBeVisible();
    await expect(trash).not.toHaveCSS("padding-right", reserved);
  });
});
