import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

/* Every bulk database sweep takes a safety snapshot first, and the two ways
   that can come back short are different states.

   No restore point (history disabled, a foreign folder) is a known state: the
   sweep runs — history is worth reporting, never worth blocking on — and the
   warning is appended to the outcome, never replacing it.

   A snapshot that FAILED is history existing and the commit not landing. That
   stops the sweep, because a rewrite of every note carrying a property must
   not run believing it has a restore point it hasn't got. It used to be
   caught into the first case, which is how a data-lossy sweep proceeded on a
   parachute that was never packed. */

async function renamePropTo(page: Page, name: string) {
  await page.locator(".db-table th", { hasText: "status" }).locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Rename property…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").fill(name);
  await form.locator(".selmenu-btn-primary").click();
}

test("a vault with no history sweeps anyway, saying so", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockNoVaultHistory = true;
  });
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await renamePropTo(page, "state");

  // the warning ACCOMPANIES the outcome — the user still learns what the
  // sweep did, which is exactly when they most need to
  await expect(page.locator(".toast")).toContainText("Renamed in 5 notes");
  await expect(page.locator(".toast")).toContainText("no safety snapshot taken");
  // …and the sweep genuinely went through
  await expect(page.locator(".db-table th", { hasText: "state" })).toHaveCount(1);
  await expect(page.locator(".db-table th", { hasText: "status" })).toHaveCount(0);
  await expect(page.locator(".db-table")).toContainText("in review");
  // nothing to restore from, so nothing is offered
  await expect(page.locator(".toast button", { hasText: "Restore from snapshot" })).toHaveCount(0);
});

test("a failed snapshot stops the sweep and the dialog says nothing changed", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["history_snapshot"]);
  });
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await renamePropTo(page, "state");

  // the dialog stays open with its inline error — a 4s toast is not where a
  // refusal this consequential belongs
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await expect(form).toContainText("nothing was changed");
  // and the vault is exactly where it was
  await expect(page.locator(".db-table th", { hasText: "status" })).toHaveCount(1);
  await expect(page.locator(".db-table th", { hasText: "state" })).toHaveCount(0);
});

test("a snapshot that landed leaves the success toast, plus the way back", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await renamePropTo(page, "state");

  await expect(page.locator(".toast")).toContainText("Renamed in 5 notes");
  await expect(page.locator(".toast")).not.toContainText("no safety snapshot");

  // the sweep's own commit is the newest point in vault history, so the way
  // back out is the time travel list
  await page.locator(".toast button", { hasText: "Restore from snapshot" }).click();
  await expect(page.locator(".timebar")).toBeVisible();
});
