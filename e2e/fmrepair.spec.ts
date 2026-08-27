import { expect, test } from "./fixtures";

// A malformed frontmatter block is invisible to read() (stripped)
// while every prop edit refuses on it — the repair surface makes
// the block visible and fixable in-app. Seeded mock note:
// Repair/Broken frontmatter.md (duplicate `status` key, src/lib/tauri.ts).

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
});

test("broken frontmatter: banner → repair dialog → clean save unblocks prop edits", async ({
  page,
}) => {
  await page.locator(".side-folder", { hasText: "Repair" }).click();
  await page.locator(".list .row", { hasText: "Broken frontmatter" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Broken frontmatter");

  const banner = page.locator(".fm-banner");
  await expect(banner).toContainText("Frontmatter can’t be parsed");
  await banner.locator("button", { hasText: "Repair…" }).click();

  const dialog = page.locator(".dbform");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".dbform-title")).toHaveText("Repair frontmatter");
  await expect(dialog.locator(".dbform-note")).toHaveText("duplicate top-level keys");
  const raw = dialog.locator(".fm-raw");
  await expect(raw).toHaveValue("status: draft\nstatus: review\ncreated: 2026-07-17\n");

  // a still-broken save bounces back with its diagnosis — dialog stays open
  await raw.fill("status: draft\nstatus: review\n");
  await dialog.locator("button", { hasText: "Save" }).click();
  await expect(dialog.locator(".dbform-err")).toHaveText("duplicate top-level keys");
  await expect(dialog).toBeVisible();

  // fixing the duplicate key lands: dialog closes, banner clears
  await raw.fill("status: review\ncreated: 2026-07-17\n");
  await dialog.locator("button", { hasText: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".prop-row", { hasText: "status" })).toContainText("review");

  // and the refusal is gone — a property edit succeeds
  await page.locator('button[aria-label="Add property"]').click();
  const chip = page.locator(".chip-input");
  await chip.fill("mood: repaired");
  await chip.press("Enter");
  await expect(page.locator(".prop-row", { hasText: "mood" })).toContainText("repaired");
  await expect(page.locator(".save-error")).toHaveCount(0);
});

// An opening `---` that never closes reads as "no frontmatter" —
// the whole file is body text. Prop edits still refuse (writing one would
// serialize a fresh block on top and demote every property to text), so the
// banner has to say why, and it points at the editor rather than offering a
// repair dialog: there is no block for the dialog to edit.
test("unterminated frontmatter: banner names the fix, no repair dialog", async ({ page }) => {
  await page.locator(".side-folder", { hasText: "Repair" }).click();
  await page.locator(".list .row", { hasText: "Unterminated frontmatter" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Unterminated frontmatter");

  const banner = page.locator(".fm-banner");
  await expect(banner).toContainText("Frontmatter is never closed");
  await expect(banner.locator("button")).toHaveCount(0);

  // and the refusal is real: a prop edit fails instead of silently eating
  // the properties that are sitting in the body
  await page.locator('button[aria-label="Add property"]').click();
  const chip = page.locator(".chip-input");
  await chip.fill("mood: hopeful");
  await chip.press("Enter");
  // the button's label is the generic retry affordance; the engine's refusal
  // rides its title, same as every other save failure
  await expect(page.locator(".save-error")).toHaveAttribute("title", /never closed/);
});

test("healthy notes carry no banner", async ({ page }) => {
  await page.locator(".list .row", { hasText: "Welcome" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".fm-banner")).toHaveCount(0);
});
