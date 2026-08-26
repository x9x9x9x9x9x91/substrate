import { expect, test } from "./fixtures";

// Schema edits on a MOUNTED database go through the mount pane's own
// DatabasePane wiring, not the db-view's — a separate lambda in App.tsx that
// once dropped the trailing rollup wiring (8 declared params forwarding 9
// arguments, the arity shifts cancelling for every middle argument, which is
// why plain kinds never showed it). These specs pin the full add-property
// round-trip on the seeded finance-doc mount: the relation control arm, then
// the rollup that follows it.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "finance-doc" }).first().click();
  await expect(page.locator(".db-table")).toBeVisible();
});

test("a rollup lands on a mounted database — wiring survives the mount pane", async ({
  page,
}) => {
  // the relation the rollup will follow
  await page.locator(".db-add-btn").click();
  const relForm = page.locator(".selmenu");
  await relForm.locator(".dbprop-name").fill("linked note");
  await relForm.locator(".selmenu-kind", { hasText: /^Relation$/ }).click();
  await relForm
    .getByRole("listbox", { name: "Target databases" })
    .getByRole("option")
    .first()
    .click();
  await relForm.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(relForm).toHaveCount(0);
  await expect(
    page.locator(".db-table th", { hasText: /linked note/i })
  ).toBeVisible();

  // the rollup following it — before the fix this closed silently and no
  // column ever appeared (the wiring fell off the 8-param lambda)
  await page.locator(".db-add-btn").click();
  const rollForm = page.locator(".selmenu");
  await rollForm.locator(".dbprop-name").fill("rolled");
  await rollForm.locator(".selmenu-kind", { hasText: /^Rollup$/ }).click();
  await expect(
    rollForm.getByRole("combobox", { name: "Relation to follow" })
  ).toHaveValue("linked note");
  await rollForm
    .getByRole("listbox", { name: "Property to roll up" })
    .getByRole("option")
    .first()
    .click();
  await rollForm.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(rollForm).toHaveCount(0);
  await expect(page.locator(".db-table th", { hasText: /rolled/i })).toBeVisible();
});

test("a refused schema save surfaces as a toast, never silence", async ({ page }) => {
  // a property named after a mount binding is the engine's own refusal
  // (check_binding_prop) — the mock mirrors it. The editor closes on save, so
  // the toast is the only surface the refusal has left.
  await page.locator(".db-add-btn").click();
  const form = page.locator(".selmenu");
  await form.locator(".dbprop-name").fill("mount");
  await form.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(page.locator(".toast")).toContainText("set by the mount");
  // …and nothing landed: no new column
  await expect(page.locator(".db-table th", { hasText: /^mount$/i })).toHaveCount(0);
});
