import { expect, test, type Page } from "@playwright/test";

/* First-run onboarding (SUB-436). The mock vault always exists, so the
   no-vault state is staged through __mockFirstRun before the module loads —
   boot resolution happens on mount and can't be flipped after the fact.

   The load-bearing assertion here is the negative one: with the flag unset
   (every other spec in this suite, and every machine that already has a
   vault) the app boots straight into the notes list and this screen never
   appears. */

async function bootFirstRun(page: Page) {
  await page.addInitScript(() => {
    window.__mockFirstRun = true;
  });
  await page.goto("/");
  await expect(page.getByTestId("onboarding")).toBeVisible();
}

test("a machine with a vault never sees onboarding", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.getByTestId("onboarding")).toHaveCount(0);
});

test("first run explains the file model and offers three doors", async ({ page }) => {
  await bootFirstRun(page);
  // the plain-file-model paragraph, not a wizard
  await expect(page.locator(".onboarding-lede")).toContainText("Markdown files in a folder you own");
  await expect(page.locator(".onboarding-option-title")).toHaveText([
    "Create a new vault",
    "Open an existing folder",
    "Just looking",
  ]);
  // no app chrome behind it — the vault isn't open yet
  await expect(page.locator(".side-item")).toHaveCount(0);
});

test("creating a vault stores the choice and asks for a restart", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByLabel("Parent folder").fill("/tmp/onb");
  await page.getByLabel("Vault folder name").fill("Fresh");
  await page.getByRole("button", { name: "Create" }).click();

  const done = page.getByTestId("onboarding-done");
  await expect(done).toBeVisible();
  await expect(done).toContainText("/tmp/onb/Fresh");
  // the app can't open it until it restarts, and says so rather than
  // pretending the running instance switched underneath
  expect(await page.evaluate(() => window.__mockRelaunched!())).toBe(false);
  await page.getByRole("button", { name: "Restart now" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mockRelaunched!()))
    .toBe(true);
});

test("opening an existing vault offers open, not initialize", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/Vault");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand).toContainText("/home/me/Vault");
  await expect(cand.getByRole("button")).toHaveText("Open vault");
  await expect(cand.locator(".onboarding-warning")).toHaveCount(0);
});

test("a folder holding other files demands consent before initializing", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/Downloads");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand.locator(".onboarding-warning")).toContainText("already holds other files");
  await expect(cand.getByRole("button")).toHaveText("Initialize anyway");
  // and consenting is what lets it through — the backend refuses without it
  await cand.getByRole("button").click();
  await expect(page.getByTestId("onboarding-done")).toContainText("/home/me/Downloads");
});

test("a checkout with one stray note is not silently opened as a vault", async ({ page }) => {
  // SUB-436 review #4: one top-level .md used to be enough for any picked
  // folder to count as a vault, so ~/Documents or a code checkout opened
  // straight through and got .vault/ written into it
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/vault-checkout");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand.getByRole("button")).toHaveText("Initialize anyway");
  await expect(cand.locator(".onboarding-warning")).toContainText("already holds other files");
});

test("the demo vault is a one-click way in", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByRole("button", { name: "Try the demo vault" }).click();
  await expect(page.getByTestId("onboarding-done")).toContainText("Substrate Demo");
});

test("a build without the demo vault says so instead of opening nothing", async ({ page }) => {
  // SUB-436 review #3: the missing-resource fallback used to create an empty
  // .vault/ and report success, so this door opened onto an empty app
  await page.addInitScript(() => {
    window.__mockFirstRun = true;
    window.__mockNoDemoVault = true;
  });
  await page.goto("/");
  await expect(page.getByTestId("onboarding")).toBeVisible();

  await page.getByRole("button", { name: "Try the demo vault" }).click();
  await expect(page.locator(".onboarding-error")).toContainText("no demo vault bundled");
  await expect(page.getByTestId("onboarding-done")).toHaveCount(0);
});

test("switch vault reopens the picker from Settings", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  await page.keyboard.press("Meta+Comma");
  const settings = page.locator(".settings-sheet");
  await expect(settings).toBeVisible();
  await expect(settings.locator(".settings-vault-path")).toContainText("Vault (mock)");

  await page.getByTestId("switch-vault").click();
  const sheet = page.getByTestId("vault-switch");
  await expect(sheet).toBeVisible();
  // switch mode drops the demo door and the first-run explainer
  await expect(sheet.locator(".onboarding-lede")).toContainText("Nothing moves");
  await expect(sheet.getByRole("button", { name: "Try the demo vault" })).toHaveCount(0);

  // esc backs out without touching the open vault
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(settings).toBeVisible();
});
