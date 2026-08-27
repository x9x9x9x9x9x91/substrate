import { expect, test, type Page } from "./fixtures";

// Evidence run, not a gate:
//   SHOTS=1 SHOT_DIR=/tmp/shots VARIANT=after npx playwright test e2e/accentappwideshots.spec.ts
// Photographs every surface the tone dial now reaches, at two tones far apart
// on the wheel, so a reader can see one accent family app-wide instead of a
// tinted dashboard sitting next to indigo chrome: the cell cursor and the page
// hairline, a dashboard, the appearance chips, and
// the three filled controls whose ink sits ON an accent fill (sync save,
// calendar-feed primary, a checked search-panel box). VARIANT tags the files so
// the same run against the base commit can be laid beside this one.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/accent-appwide-shots";
const VARIANT = process.env.VARIANT || "current";
const TONES = ["sky", "violet"] as const;

/** Drive the real Settings dial, not the DOM attribute: the point of the shots
    is that the shipped control moves these surfaces. Sky is the default and
    writes no attribute, so it is reached by clicking its own chip. */
async function setTone(page: Page, tone: string) {
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  const chip = page
    .locator(".settings-row", { hasText: "Accent tone" })
    .locator(`.settings-chip[data-tone-swatch="${tone}"]`);
  await expect(chip, `no chip for tone ${tone}`).toBeVisible();
  await chip.click();
  await page.waitForTimeout(200);
}

/** A reload drops the tone back to the default in the mock backend, so every
    surface reached through a fresh load re-picks it before it is photographed —
    otherwise half the frames would quietly be sky whatever the file name says. */
async function boot(page: Page, tone: string) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await setTone(page, tone);
  await closeSettings(page);
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

/** A shot named after a surface that is not on screen is the one outcome an
    evidence run must not report as a pass. */
async function shoot(page: Page, tone: string, name: string, mustSee: string) {
  const target = page.locator(mustSee).first();
  await expect(target, `${name}: nothing matched ${mustSee} to photograph`).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/${VARIANT}-${tone}-${name}.png`, fullPage: false });
}

for (const tone of TONES) {
  test(`accent surfaces at tone ${tone}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".list-title")).toBeVisible();
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/${VARIANT}-${tone}-settings-appearance.png` });
    await closeSettings(page);

    // cell cursor + the strong page hairline, one frame (the selected sidebar
    // row is in shot too, and is meant to stay put: it wears the neutral wash)
    await page.locator(".side-item", { hasText: "All databases" }).click();
    const row = page.locator(".dbmgr-row", { hasText: "Release" });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator(".list-title")).toHaveText("Release");
    await page.locator(".db-cell").first().click();
    await shoot(page, tone, "db-cell-cursor", ".db-cell.focused");

    await page.locator(".side-item", { hasText: "Overview" }).click();
    await expect(page.locator(".dash-title")).toHaveText("Overview");
    await page.waitForTimeout(1200);
    await shoot(page, tone, "dashboard", ".dash-inner");

    // the three filled controls: ink on an accent fill
    await boot(page, tone);
    await page.getByRole("button", { name: "Vault sync" }).first().click();
    await page.locator(".vault-sync-form").first().waitFor();
    await shoot(page, tone, "sync-save", ".vault-sync-save");

    await boot(page, tone);
    await page.keyboard.press("Meta+4");
    await expect(page.locator(".cal-grid.month")).toBeVisible();
    await page.getByRole("button", { name: "Calendars", exact: true }).click();
    const feeds = page.getByRole("dialog", { name: "External calendars" });
    await feeds.getByRole("button", { name: "Add URL…" }).click();
    await shoot(page, tone, "cal-feed-primary", ".cal-feed-form-actions button.primary");

    await boot(page, tone);
    await page.locator(".side-item", { hasText: /^Scratch/ }).click();
    await expect(page.locator(".note-title")).toHaveValue("Welcome");
    await page.locator(".cm-content").click();
    // the editor's find binding is CodeMirror's Mod-f, which is ⌘ on macOS and
    // Ctrl everywhere else — an evidence run has to work on both hosts
    const box = page.locator(".cm-panel.cm-search input[type=checkbox]").first();
    await page.keyboard.press("ControlOrMeta+f");
    if ((await box.count()) === 0) await page.keyboard.press("Meta+f");
    await expect(box, "the editor's search panel never opened").toBeVisible();
    await box.check();
    await shoot(page, tone, "search-checkbox", ".cm-panel.cm-search input[type=checkbox]:checked");
  });
}
