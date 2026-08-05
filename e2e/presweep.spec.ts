import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

/* Every bulk database sweep takes a safety snapshot first. When the
   vault has no restore point (history disabled), the sweep must still run —
   history is worth reporting, never worth blocking on — but it must not pass
   in silence, and the warning is appended to the outcome, never replacing it.
   The failure is forced through the mock backend's __mockFail hook, the same
   way the other error-surface specs do it. */

test("a failed pre-sweep snapshot warns and the property rename still runs", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["history_snapshot"]);
  });
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  await page.locator(".db-table th", { hasText: "status" }).locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Rename property…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").fill("state");
  await form.locator(".selmenu-btn-primary").click();

  // the warning ACCOMPANIES the outcome — the user still learns what the
  // sweep did, which is exactly when they most need to
  await expect(page.locator(".toast")).toContainText("Renamed in 5 notes");
  await expect(page.locator(".toast")).toContainText("no safety snapshot taken");
  // …and the sweep genuinely went through
  await expect(page.locator(".db-table th", { hasText: "state" })).toHaveCount(1);
  await expect(page.locator(".db-table th", { hasText: "status" })).toHaveCount(0);
  await expect(page.locator(".db-table")).toContainText("in review");
});

test("a working snapshot leaves the ordinary success toast alone", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  await page.locator(".db-table th", { hasText: "status" }).locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Rename property…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").fill("state");
  await form.locator(".selmenu-btn-primary").click();

  await expect(page.locator(".toast")).toContainText("Renamed in 5 notes");
  await expect(page.locator(".toast")).not.toContainText("no safety snapshot");
});
