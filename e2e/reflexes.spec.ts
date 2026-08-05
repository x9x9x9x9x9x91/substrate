import { expect, test, type Page } from "@playwright/test";

// SUB-826: the Reflexes settings section — the one thing about this feature a
// user actually operates. Rules are authored in `.vault/reflexes.json` and the
// pane never writes one, so what is worth pinning here is the consent walk:
// a vault with no rules file says nothing at all, a rules file that ARRIVES on
// this device (synced vault, restored backup) shows up PAUSED behind one
// switch, and only after that switch is thrown does the same control become an
// ordinary pause. Whether rules FIRE is the Rust suite's question — the mock
// lane has no watcher.

async function openSettings(page: Page) {
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

const enableSwitch = (page: Page) => page.getByTestId("reflexes-enable");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("no rules file: the section is not there at all", async ({ page }) => {
  await openSettings(page);
  // not "an empty Reflexes heading" — a feature nobody has asked for is
  // absent, not present-and-blank
  await expect(enableSwitch(page)).toHaveCount(0);
  await expect(page.locator(".settings-sheet .palette-section", { hasText: "Reflexes" })).toHaveCount(
    0
  );
});

test("an arriving rules file is paused behind one switch, which then pauses", async ({ page }) => {
  await page.evaluate(() => window.__mockStageReflexesFile?.());
  await openSettings(page);

  // first sight of a rules file: the section appears, the rules are listed so
  // the decision is informed, and the switch is OFF — nothing has run
  await expect(page.locator(".settings-sheet .palette-section", { hasText: "Reflexes" })).toBeVisible();
  const sw = enableSwitch(page);
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("reflex-state-file-drafts")).toHaveText("not fired yet");
  // and the copy asks rather than reports, since this is the arming decision
  await expect(page.locator(".settings-sheet")).toContainText("Enable reflexes");
  // no way to un-decide something never decided
  await expect(page.getByTestId("reflexes-forget")).toHaveCount(0);

  // one click arms the vault on this device
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".settings-sheet")).toContainText("Run this vault's rules");
  await expect(page.getByTestId("reflexes-forget")).toBeVisible();

  // thereafter the SAME control is an ordinary pause — it does not re-ask the
  // consent question, and it does not forget the decision
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("reflexes-forget")).toBeVisible();
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");

  // the decision outlives the sheet: it is device state, not component state
  await closeSettings(page);
  await openSettings(page);
  await expect(enableSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("reflexes-forget")).toBeVisible();
});

test("the file's own paused flag is a different switch, and disables this one", async ({ page }) => {
  await page.evaluate(() => window.__mockStageReflexesFile?.({ filePaused: true }));
  await openSettings(page);

  // before consent the file's flag changes nothing: the arming question is
  // still the one being asked, and it is still answerable
  const sw = enableSwitch(page);
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toBeEnabled();
  await sw.click();

  // armed, but the file says paused — the switch reads off and goes dead,
  // because the pane must not offer a toggle the file would immediately win
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toBeDisabled();
  await expect(page.locator(".settings-sheet")).toContainText("paused by the file");
  // the decision itself is still the user's to take back
  await expect(page.getByTestId("reflexes-forget")).toBeEnabled();
});

test("forget puts the vault back to the first-run question", async ({ page }) => {
  await page.evaluate(() => window.__mockStageReflexesFile?.());
  await openSettings(page);
  await enableSwitch(page).click();
  await expect(enableSwitch(page)).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("reflexes-forget").click();

  // back to `offer`: rules still listed, nothing running, switch asking again
  await expect(enableSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".settings-sheet")).toContainText("Enable reflexes");
  await expect(page.getByTestId("reflex-state-file-drafts")).toBeVisible();
  await expect(page.getByTestId("reflexes-forget")).toHaveCount(0);
});
