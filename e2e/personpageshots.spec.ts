import { expect, test, type Page } from "@playwright/test";

// Evidence run only: the person page's appearances rail on both
// grounds — screen (the app's own dark ramp) and paper (the print pass, the
// only light surface the app has) — plus the empty-handles prompt.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-1314-shots";

async function openPerson(page: Page, handles: string) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");
  await page.evaluate((value) => {
    window.__mockEditProp?.("Gero.md", "handles", value);
  }, handles);
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("Gero");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Gero");
  await page.waitForTimeout(1200);
}

test("shot: populated rail, screen ground", async ({ page }) => {
  await openPerson(page, "gero@umbra.example, Gero");
  await expect(page.locator(".backlinks.appearances").first()).toBeVisible();
  await page.locator(".backlinks.appearances").first().evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/rail-screen.png`, fullPage: false });
});

test("shot: a handle nothing in the vault names", async ({ page }) => {
  // the app has one runtime ground: the print pass (@media print) swaps the
  // whole app for #print-surface, which carries dashboards only — a note page
  // has no light variant to shoot. The third state is the honest second shot.
  await openPerson(page, "nobody@nowhere.example");
  await expect(page.locator(".appearances-hint")).toBeVisible();
  await page.locator(".appearances-hint").evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/no-match-screen.png`, fullPage: false });
});

test("shot: empty handles prompt", async ({ page }) => {
  await openPerson(page, "");
  await expect(page.locator(".appearances-hint")).toBeVisible();
  await page.locator(".backlinks.appearances").first().evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/empty-screen.png`, fullPage: false });
});
