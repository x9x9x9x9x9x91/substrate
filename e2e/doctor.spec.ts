import { expect, test } from "./fixtures";

// The vault doctor is a read-only report. The palette opens it, the
// findings group by kind, note paths click through — and there is deliberately
// nothing in the pane that repairs anything.

test("palette opens the vault doctor report (SUB-432)", async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("vault doctor");
  await page.locator(".palette-item", { hasText: "Vault doctor" }).first().click();

  await expect(page.locator(".list-title")).toHaveText("Vault doctor");

  // the mock report seeds one finding per kind — each renders under its own
  // heading, with the severity dot and the detail line
  const groups = page.locator(".doctor-group");
  await expect(groups).toHaveCount(7);
  await expect(page.locator(".doctor-group-title").first()).toHaveText("Broken links");
  await expect(page.locator(".trash-row")).toHaveCount(7);
  await expect(page.locator(".doctor-dot.sev-error").first()).toBeVisible();

  // read-only: the footer says so and no row offers a repair
  await expect(page.locator(".doctor-foot")).toContainText("nothing here changes the vault");
  await expect(
    page.locator(".trash").getByRole("button", { name: /fix|repair/i })
  ).toHaveCount(0);

  // a note finding clicks through to the note itself
  await page.locator(".doctor-path", { hasText: "Slow Bloom EP.md" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
});
