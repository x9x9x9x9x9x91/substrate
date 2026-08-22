import { expect, test } from "@playwright/test";

// Evidence run only — the visual self-check for the frontmatter affordances
// (the chip's key suggestions, the workbook strip's add-page field). Not a gate.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = "/tmp/sub1256";

test("shot: the + property chip's key suggestions", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
  await page.locator(".chip-add").click();
  await expect(page.locator(".chip-suggest-row").first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/chip-suggest-open.png` });

  await page.locator(".chip-input").fill("re");
  await page.locator(".chip-input").press("ArrowDown");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/chip-suggest-typed.png` });
});

test("shot: the workbook tab strip's add control", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".wb-tabs")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/wb-strip-plus.png` });

  await page.locator(".wb-tab-add").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/wb-strip-typing.png` });

  await page.locator(".wb-tabs .inline-edit").fill("Nothing By That Name");
  await page.locator(".wb-tabs .inline-edit").press("Enter");
  await expect(page.locator(".inline-edit-error")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/wb-strip-error.png` });

  // the other half of the refusal set: a name that resolves, to something a
  // page can't render
  await page.locator(".wb-tabs .inline-edit").fill("Slow Bloom EP");
  await page.locator(".wb-tabs .inline-edit").press("Enter");
  await expect(page.locator(".inline-edit-error")).toContainText("not a sheet or dashboard");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/wb-strip-error-type.png` });

  await page.locator(".wb-tabs .inline-edit").fill("release");
  await page.locator(".wb-tabs .inline-edit").press("Enter");
  await expect(page.locator(".wb-tab")).toHaveCount(5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/wb-strip-added.png` });
});
