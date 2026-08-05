import { expect, test } from "@playwright/test";

async function boot(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("a note seals whole-file, unlocks for a peek, and can return to Markdown", async ({
  page,
}) => {
  await boot(page);

  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Seal note…" }).click();

  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await expect(setup).toContainText("frontmatter and body are encrypted whole-file");
  await expect(setup).toContainText("old plaintext versions from local Git history");
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();

  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();
  await expect(page.locator(".note-title")).toHaveCount(0);
  await expect(page.locator(".row-sealed")).toHaveCount(1);

  await page.getByRole("button", { name: "Unlock to peek" }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock “Welcome”" });
  await expect(unlock).toContainText("local agents still receive no sealed content");
  await unlock.getByRole("button", { name: "Unlock with Touch ID / Face ID" }).click();

  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".cm-content")).toContainText("Everything here is a plain markdown file");

  // even UNLOCKED, no plaintext-emitting action reaches the menu — Remove
  // seal is the one deliberate lane back to plaintext (SUB-839 review)
  await page.getByRole("button", { name: "Note actions" }).click();
  for (const leaky of ["Duplicate", "Export Markdown…", "Export PDF…", "Send as link…"]) {
    await expect(page.locator(".dots-item", { hasText: leaky })).toHaveCount(0);
  }
  await expect(page.locator(".dots-item", { hasText: "Remove seal…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A path change is an authorization boundary (SUB-839): rename and move both
  // reopen locked at the destination, so no read can slip through under the
  // new path on the old authorization.
  await page.locator(".note-title").fill("Welcome Sealed");
  await page.locator(".note-title").press("Enter");
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Unlock to peek" }).click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome Sealed”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome Sealed");

  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Move to folder…" }).click();
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette-item", { hasText: "Inbox" }).first().click();
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Unlock to peek" }).click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome Sealed”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome Sealed");

  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Lock now" }).click();
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Unlock to peek" }).click();
  const fallback = page.getByRole("dialog", { name: "Unlock “Welcome Sealed”" });
  await fallback.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await fallback.getByRole("button", { name: "Use password" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome Sealed");

  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Remove seal…" }).click();
  const unseal = page.getByRole("dialog", { name: "Remove seal from “Welcome Sealed”" });
  await expect(unseal).toContainText("ordinary Markdown");
  await unseal.getByRole("button", { name: "Write plain Markdown" }).click();

  await expect(page.locator(".note-title")).toHaveValue("Welcome Sealed");
  await expect(page.locator(".row-sealed")).toHaveCount(0);
  await page.getByRole("button", { name: "Note actions" }).click();
  await expect(page.locator(".dots-item", { hasText: "Seal note…" })).toBeVisible();
});

/* SUB-889: the two states a happy-path seal never reaches — a machine with no
   device key (so Touch ID refuses and the vault password is the only way in),
   and a scope whose files encrypted but whose history cleanup did not, which
   leaves the marker pending. Both are staged before the module loads. */
test("without a device key the password carries the unlock, and a failed history purge leaves the seal pending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__mockNoDeviceUnlock = true;
    window.__mockSealPending = true;
  });
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Seal note…" }).click();
  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".toast")).toContainText("use the vault password to unlock");

  // the device lane is offered and refuses; the fallback field is what works
  await page.getByRole("button", { name: "Unlock to peek" }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock “Welcome”" });
  await unlock.getByRole("button", { name: "Unlock with Touch ID / Face ID" }).click();
  await expect(unlock.locator(".dbform-err")).toContainText("device unlock");
  await unlock.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await unlock.getByRole("button", { name: "Use password" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  // a scope seal whose history rewrite fails: encrypted, but still pending
  const folder = page.locator(".side-folder", { hasText: "Field notes" });
  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Seal folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Seal folder “Field notes”" });
  await dialog.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await dialog.getByRole("button", { name: "Use password" }).click();
  await expect(dialog.locator(".dbform-err")).toContainText("still pending");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await folder.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Seal conversion pending" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Stop seal inheritance" })).toHaveCount(0);
});

/* SUB-889: the attack the confirmation gate exists to stop. A marker that
   arrives by sync or an external write is inert on this device — it encrypts
   nothing, it hides nothing, and the user has to accept it in-app before it
   means anything. */
test("a seal marker planted from outside this device seals nothing until it is confirmed", async ({
  page,
}) => {
  await page.goto("/");
  const folder = page.locator(".side-folder", { hasText: "Field notes" });
  await folder.click();
  await page.evaluate(() => window.__mockPlantSealScope?.("Field notes"));

  // nothing under the scope became sealed, and the affordance to seal it
  // properly is still there — an unconfirmed marker must not lock the user out
  await expect(page.locator('.row[data-path^="Field notes/"] .row-sealed')).toHaveCount(0);
  await folder.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Stop seal inheritance" })).toHaveCount(0);
  await expect(page.locator(".ctx-item", { hasText: "Confirm seal…" })).toBeVisible();

  // rejecting it leaves the vault exactly as it was
  await page.locator(".ctx-item", { hasText: "Reject seal" }).click();
  await expect(page.locator(".toast")).toContainText("nothing was encrypted or purged");
  await expect(page.locator('.row[data-path^="Field notes/"] .row-sealed')).toHaveCount(0);

  // give the vault a key of its own, the ordinary way
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.getByRole("button", { name: "Note actions" }).click();
  await page.locator(".dots-item", { hasText: "Seal note…" }).click();
  const setup = page.getByRole("dialog", { name: /^Seal “/ });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();

  // confirming is what actually seals — the gate is a gate, not a refusal
  await page.evaluate(() => window.__mockPlantSealScope?.("Field notes"));
  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Confirm seal…" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm seal on folder “Field notes”" });
  await expect(dialog).toContainText("arrived from outside this device");
  await dialog.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await dialog.getByRole("button", { name: "Use password" }).click();
  await folder.click();
  await expect(page.locator('.row[data-path^="Field notes/"] .row-sealed').first()).toBeVisible();
});

/* SUB-889: the denial-of-service half of the same attack. A marker planted
   *inside* a folder this device really did seal must still be rejectable —
   otherwise one planted file wedges the subtree, and the only way out is
   removing the outer seal the user wanted. The engine skips both removal
   guards for an unconfirmed marker precisely so this stays reachable. */
test("a marker planted inside an already sealed folder can still be rejected", async ({ page }) => {
  await page.goto("/");
  const parent = page.locator(".side-folder", { hasText: "Projects" }).first();
  await parent.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Seal folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Seal folder “Projects”" });
  await dialog.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await dialog.getByLabel("Repeat vault password").fill("correct horse");
  await dialog.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".toast")).toContainText("Folder sealed");

  // now the planted marker, one level down inside the confirmed seal
  await page.evaluate(() => window.__mockPlantSealScope?.("Projects/Active"));
  const nested = page.locator(".side-folder", { hasText: "Active" }).first();
  await nested.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Confirm seal…" })).toBeVisible();

  await page.locator(".ctx-item", { hasText: "Reject seal" }).click();
  await expect(page.locator(".toast")).toContainText("nothing was encrypted or purged");

  // the planted marker is gone and the user's own seal is untouched
  await nested.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Confirm seal…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await parent.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Stop seal inheritance" })).toBeVisible();
});

test("a folder seal converts existing notes and new notes inherit until inheritance stops", async ({
  page,
}) => {
  await page.goto("/");
  const folder = page.locator(".side-folder", { hasText: "Field notes" });
  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Seal folder…" }).click();

  const dialog = page.getByRole("dialog", { name: "Seal folder “Field notes”" });
  await expect(dialog).toContainText("New, moved, restored, synced, and externally written notes");
  await expect(dialog).toContainText("resumes before the next snapshot");
  await dialog.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await dialog.getByLabel("Repeat vault password").fill("correct horse");
  await dialog.getByRole("button", { name: "Set password & seal" }).click();

  await expect(page.locator(".toast")).toContainText("Folder sealed");
  await folder.click();
  await expect(page.locator('.row[data-path^="Field notes/"] .row-sealed').first()).toBeVisible();

  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New note" }).click();
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();

  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Stop seal inheritance" }).click();
  await expect(page.locator(".toast")).toContainText("existing encrypted notes stay sealed");

  await folder.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New note" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled 2");
});
