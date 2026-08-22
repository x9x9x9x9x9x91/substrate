import { expect, test, type Page } from "@playwright/test";

// Evidence run only: the panes outside the dashboards where a caught failure
// was printed with its class name still attached. The mock rejects the pane's
// own load command with a real Error, which is the shape the backend produces
// for a refused read — before, the strip under the pane read
// "Error: mock failure: vault_trash_list"; after, it reads the message alone.
// The app has no runtime light theme and neither of these panes has a print
// surface, so each state is shot dark only.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/errsweep-shots";

async function openView(page: Page, query: string, label: string, title: string) {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill(query);
  await page.locator(".palette-item", { hasText: label }).first().click();
  await expect(page.locator(".palette")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText(title);
}

const states: { slug: string; cmd: string; open: (page: Page) => Promise<void> }[] = [
  {
    slug: "trash-load-refused",
    cmd: "vault_trash_list",
    open: (page) => openView(page, "Open Trash", "Open Trash", "Trash"),
  },
  {
    slug: "doctor-scan-refused",
    cmd: "vault_doctor",
    open: (page) => openView(page, "vault doctor", "Vault doctor", "Vault doctor"),
  },
];

for (const state of states) {
  test(`shot dark: ${state.slug}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".list-title")).toBeVisible();
    await page.evaluate((cmd) => {
      window.__mockFail = new Set([cmd]);
    }, state.cmd);
    await state.open(page);
    await expect(page.locator(".trash-error")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${state.slug}-dark.png`, fullPage: true });
  });
}
