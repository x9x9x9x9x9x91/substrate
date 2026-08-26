import { expect, test, type Page } from "./fixtures";

// Evidence run, not a gate:
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test e2e/syncpassphraseshots.spec.ts
// Shoots the Sync pane in both themes: the unconfigured setup form, the pane
// after a first-device hosted enrollment, the open change-passphrase form, and
// the warning that arms before a hosted vault is saved onto a plain remote.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/sync-passphrase-shots";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(150);
}

async function shoot(page: Page, name: string, scrollTo?: string) {
  if (scrollTo) {
    // Waited for, not skipped past: a shot named after a surface that is not
    // there is the one outcome an evidence run must not report as a pass. The
    // whole point of these files is that someone can look at what shipped.
    const target = page.locator(scrollTo).first();
    await expect(target, `${name}: nothing matched ${scrollTo} to photograph`).toBeVisible();
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  }
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/${name}-${theme}.png`, fullPage: true });
  }
}

async function openSync(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Vault sync" }).first().click();
  await page.locator(".vault-sync-form").first().waitFor();
  await page.waitForTimeout(300);
}

test("sync pane, hosted lifecycle", async ({ page }) => {
  await openSync(page);
  await shoot(page, "setup");

  const url = page.locator('input[inputmode="url"]');
  await url.fill("blob+https://drop.example/blob");
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("test-token-0123456789");
  await passwords.nth(1).fill("correct horse battery staple");
  await passwords.nth(2).fill("correct horse battery staple");
  await shoot(page, "hosted-form");

  await page.locator("button:has-text('Save remote')").click();
  await page.waitForTimeout(500);
  await shoot(page, "enrolled");
  await shoot(page, "enrolled-created", ".vault-sync-created");

  // The change card is the reason this spec exists: if a hosted enrollment
  // does not produce one, the run has to say so rather than quietly shoot
  // everything else and finish green.
  const change = page.locator(".vault-sync-passphrase-change");
  await expect(change, "the enrolled vault offered no change-passphrase card").toBeVisible();
  await change.click();
  await page.locator(".vault-sync-passphrase-current").fill("correct horse battery staple");
  await page.locator(".vault-sync-passphrase-next").fill("the second passphrase");
  await page.locator(".vault-sync-passphrase-next-again").fill("the second passphrase");
  await shoot(page, "change-passphrase");
  await shoot(page, "change-passphrase-foot", ".vault-sync-passphrase-next-again");

  await url.fill("https://sync.example.com/vault.git");
  await page.locator('input[type="password"]').first().fill("test-token-0123456789");
  await page.locator("button:has-text('Save remote')").click();
  await page.waitForTimeout(400);
  // Same for the armed state: an unarmed Save button here would mean the
  // second-press guard is gone, which is exactly what these shots evidence.
  await expect(
    page.locator(".vault-sync-save.danger"),
    "saving a plain URL over a hosted vault armed no confirmation",
  ).toBeVisible();
  await shoot(page, "downgrade-armed", ".vault-sync-downgrade");
  await shoot(page, "downgrade-button", ".vault-sync-save.danger");
});
