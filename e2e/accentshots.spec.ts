import { expect, test } from "@playwright/test";

// Evidence run only (SUB-932): BEFORE/AFTER shots of the metrics + charts
// panes on both grounds. The app has no runtime light theme — the only light
// surface is the print pass (@media print remaps the dark ramp), so "light"
// here means the print surface, captured by cloning the live pane into
// #print-surface and emulating print media. VARIANT tags the file names.
test.skip(!process.env.SHOTS, "evidence run only");

const variant = process.env.VARIANT || "current";
const dir = "/tmp/dash-accent";

for (const name of ["Portfolio", "Overview"]) {
  const slug = name.toLowerCase();

  test(`shot dark: ${name}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".side-item", { hasText: name }).click();
    await expect(page.locator(".dash-title")).toHaveText(name);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${variant}-${slug}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${name}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.goto("/");
    await page.locator(".side-item", { hasText: name }).click();
    await expect(page.locator(".dash-title")).toHaveText(name);
    await page.waitForTimeout(1500);
    await page
      .locator("#root .dash-actions")
      .getByRole("button", { name: "Print", exact: true })
      .click();
    await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${variant}-${slug}-light.png`, fullPage: true });
  });
}
