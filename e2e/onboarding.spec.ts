import { expect, test, type Page } from "@playwright/test";
import { settingsTab } from "./settings";

/* First-run onboarding. The mock vault always exists, so the
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

test("the ready screen offers the agent step; a chip wires the terminal (SUB-804)", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByLabel("Parent folder").fill("/tmp/onb");
  await page.getByLabel("Vault folder name").fill("Fresh");
  await page.getByRole("button", { name: "Create" }).click();

  const agent = page.getByTestId("onboarding-agent");
  await expect(agent).toContainText("⌘⇧T");
  // nothing chosen yet → nothing written
  expect(await page.evaluate(() => window.__mockAgentCommand!())).toBe(null);

  await agent.getByRole("button", { name: "claude", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mockAgentCommand!()))
    .toBe("claude");
  // re-clicking the active chip un-picks it — the key is cleared, not left
  await agent.getByRole("button", { name: "claude", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAgentCommand!())).toBe("");

  // the free-typed command lands too (pi, aider, …)
  await agent.getByLabel("Other agent command").fill("pi");
  await agent.getByLabel("Other agent command").press("Enter");
  await expect.poll(() => page.evaluate(() => window.__mockAgentCommand!())).toBe("pi");
});

test("switching vaults never shows the agent step", async ({ page }) => {
  // switch mode reuses the ready screen; the agent question is a first-run
  // thing — a switcher has settings already
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.keyboard.press("Meta+Comma");
  await settingsTab(page, "vault");
  await page.getByTestId("switch-vault").click();
  const sheet = page.getByTestId("vault-switch");
  await sheet.getByLabel("Existing folder").fill("/home/me/Vault");
  await sheet.getByLabel("Existing folder").press("Enter");
  await page.getByTestId("onboarding-candidate").getByRole("button").click();
  await expect(page.getByTestId("onboarding-done")).toBeVisible();
  await expect(page.getByTestId("onboarding-agent")).toHaveCount(0);
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

test("the picker says which files it will add before you commit", async ({ page }) => {
  // adoption writes files of its own into the folder. Learning that
  // from unfamiliar files appearing after the restart is the wrong way to
  // learn it. The list here has to be the whole add-set from
  // docs/user/import.md, not just the visible root files.
  // The folder is a marker-less one: two loose notes earn "Open vault",
  // and adopting it does write the whole set.
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/loose-vault");
  await page.getByLabel("Existing folder").press("Enter");
  await expect(page.getByTestId("onboarding-candidate").getByRole("button")).toHaveText(
    "Open vault"
  );

  const adds = page.getByTestId("onboarding-adds");
  await expect(adds).toContainText("Settings.md");
  await expect(adds).toContainText("AGENTS.md");
  await expect(adds).toContainText("CLAUDE.md");
  await expect(adds).toContainText("Inbox/");
  await expect(adds).toContainText(".vault/");
  await expect(adds).toContainText(".claude/");
  await expect(adds).toContainText(".git/");
  await expect(adds).toContainText("Your own notes are never moved or changed");
  // the line this replaced promised three files and nothing else — the exact
  // surprise the disclosure exists to prevent
  await expect(adds).not.toContainText("Nothing else is moved or changed");
});

test("reopening a vault is not promised files it already has", async ({ page }) => {
  // The gate was "not init", so this line rendered on the plain
  // reopen of an already-adopted vault too — where `.vault/` and the setup
  // files are already on disk and "Substrate will add its own files here" is
  // false. Honest wording, and never both lines at once.
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/Vault");
  await page.getByLabel("Existing folder").press("Enter");

  await expect(page.getByTestId("onboarding-candidate").getByRole("button")).toHaveText(
    "Open vault"
  );
  await expect(page.getByTestId("onboarding-adds")).toHaveCount(0);
  const already = page.getByTestId("onboarding-already");
  await expect(already).toContainText("already a Substrate vault");
  await expect(already).toContainText("adds nothing new");
  await expect(already).not.toContainText("Substrate will add its own files here");
});

test("creating a fresh vault does not make the three-file promise", async ({ page }) => {
  // Review: a missing or empty folder is the `init` verb, which
  // runs the starter seed — Welcome.md, the example notes, the dashboards —
  // roughly a dozen files. Saying "Settings.md, AGENTS.md and CLAUDE.md…
  // nothing else" there would be exactly the surprise this line prevents on
  // the adoption path.
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/fresh");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand.getByRole("button")).toHaveText("Create vault here");
  await expect(page.getByTestId("onboarding-adds")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-already")).toHaveCount(0);
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
  // Review #4: one top-level .md used to be enough for any picked
  // folder to count as a vault, so ~/Documents or a code checkout opened
  // straight through and got .vault/ written into it
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/vault-checkout");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand.getByRole("button")).toHaveText("Initialize anyway");
  await expect(cand.locator(".onboarding-warning")).toContainText("already holds other files");
});

test("a folder-organised notes vault is asked politely, not warned about", async ({ page }) => {
  // notes only in subfolders (Daily/, Projects/) fail the strict
  // top-level test, so consent is still required — but the copy must not tell
  // the owner their own notes are "other files"
  await bootFirstRun(page);
  await page.getByLabel("Existing folder").fill("/home/me/Obsidian");
  await page.getByLabel("Existing folder").press("Enter");

  const cand = page.getByTestId("onboarding-candidate");
  await expect(cand.getByRole("button")).toHaveText("Open it anyway");
  const warning = cand.locator(".onboarding-warning");
  await expect(warning).toContainText("notes all live in subfolders");
  await expect(warning).not.toContainText("already holds other files");
  // and it still goes through the consent path
  await cand.getByRole("button").click();
  await expect(page.getByTestId("onboarding-done")).toContainText("/home/me/Obsidian");
});

test("the demo vault is a one-click way in", async ({ page }) => {
  await bootFirstRun(page);
  await page.getByRole("button", { name: "Try the demo vault" }).click();
  await expect(page.getByTestId("onboarding-done")).toContainText("Substrate Demo");
});

test("a build without the demo vault says so instead of opening nothing", async ({ page }) => {
  // Review #3: the missing-resource fallback used to create an empty
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
  await settingsTab(page, "vault");
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
