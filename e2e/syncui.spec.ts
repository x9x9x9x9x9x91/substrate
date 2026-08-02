import { expect, test, type Page } from "@playwright/test";

async function openVaultSync(page: Page, phone = false) {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  if (phone) await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();
  await expect(page.locator(".vault-sync .list-title")).toHaveText("Vault sync");
}

async function configure(page: Page) {
  await page.getByLabel("Remote URL").fill("https://sync.example.com/ada/vault.git");
  await page.getByLabel("Access token").fill("vault-token-371");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
}

test("phone setup saves the remote, flips status, and clears the write-only token", async ({
  page,
}) => {
  await openVaultSync(page, true);

  await expect(page.locator(".vault-sync-state")).toContainText("Setup needed");
  await expect(page.getByText("No remote configured", { exact: true })).toBeVisible();

  await configure(page);
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveValue("");
  await expect(page.getByRole("status")).toHaveText("Remote saved");
});

test("push updates the last outcome summary", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);

  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 2 · Pulled 0");
  await expect(page.locator(".vault-sync-head")).toContainText("5dc371a8");
});

test("pull renders every conflicted path and opens the resolution surface", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);

  await page.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Needs attention");
  await expect(page.getByRole("heading", { name: "Conflicts — resolve below" })).toBeVisible();
  const conflicts = page.locator(".vault-sync-conflicts li");
  await expect(conflicts).toHaveCount(2);
  await expect(conflicts.nth(0)).toHaveText("Journal/2026-07-22.md");
  await expect(conflicts.nth(1)).toHaveText("Projects/Release plan.md");

  // Each conflicted file gets its own three-way panel: the frontmatter rows
  // the two sides disagree on, plus History's diff presentation.
  const files = page.locator(".sync-conflict-file");
  await expect(files).toHaveCount(2);
  await expect(page.locator(".sync-conflict-progress")).toHaveText("0 of 2 resolved");
  const journal = files.filter({ has: page.locator('code:text-is("Journal/2026-07-22.md")') });
  await expect(journal.locator(".sync-conflict-props tbody tr")).toHaveCount(1);
  await expect(journal.locator(".sync-conflict-props tbody tr th")).toHaveText("mood");
  await expect(journal.locator(".hist-line-del").first()).toHaveText("mood: focused");
  await expect(journal.locator(".hist-line-add").first()).toHaveText("mood: tired");
});

test("resolving by side and by keeping both finishes the merge", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);
  await page.getByRole("button", { name: "Pull", exact: true }).click();

  const files = page.locator(".sync-conflict-file");
  const journal = files.filter({ has: page.locator('code:text-is("Journal/2026-07-22.md")') });
  const plan = files.filter({ has: page.locator('code:text-is("Projects/Release plan.md")') });
  const finish = page.getByRole("button", { name: "Finish merge" });
  await expect(finish).toBeDisabled();

  // Choose a side on the first file…
  await journal.getByRole("button", { name: "Take theirs" }).click();
  await expect(journal.getByRole("button", { name: "Take theirs" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(journal.locator(".sync-conflict-badge")).toContainText("version history");
  await expect(page.locator(".sync-conflict-progress")).toHaveText("1 of 2 resolved");
  await expect(finish).toBeDisabled();

  // …and keep both on the second, which names the copy the remote lands in.
  await plan.getByRole("button", { name: "Keep both" }).click();
  await expect(plan.locator(".sync-conflict-badge")).toContainText(
    "Projects/Release plan (conflict 2026-07-22).md",
  );
  await expect(page.locator(".sync-conflict-progress")).toHaveText("2 of 2 resolved");

  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.locator(".sync-conflict")).toHaveCount(0);
  await expect(page.locator(".vault-sync-conflicts")).toHaveCount(0);
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 0 · Pulled 3");
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
});

test("a choice can be taken back before the merge is finished", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);
  await page.getByRole("button", { name: "Pull", exact: true }).click();

  const journal = page
    .locator(".sync-conflict-file")
    .filter({ has: page.locator('code:text-is("Journal/2026-07-22.md")') });
  await journal.getByRole("button", { name: "Keep mine" }).click();
  await expect(page.locator(".sync-conflict-progress")).toHaveText("1 of 2 resolved");

  await journal.getByRole("button", { name: "Keep mine" }).click();
  await expect(page.locator(".sync-conflict-progress")).toHaveText("0 of 2 resolved");
  await expect(journal.locator(".sync-conflict-badge")).toHaveCount(0);
});

test("a refused choice keeps the backend's message on screen", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);
  await page.getByRole("button", { name: "Pull", exact: true }).click();

  const journal = page
    .locator(".sync-conflict-file")
    .filter({ has: page.locator('code:text-is("Journal/2026-07-22.md")') });

  // The re-read that follows a failed action succeeds — the reason the action
  // was refused must survive it rather than being wiped before it is painted.
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_sync_resolve_set"]);
  });
  await journal.getByRole("button", { name: "Keep mine" }).click();
  const alert = page.locator(".sync-conflict .vault-sync-error");
  await expect(alert).toContainText("mock failure: vault_sync_resolve_set");
  await expect(page.locator(".sync-conflict-progress")).toHaveText("0 of 2 resolved");

  // Same for the finish button's refusal.
  await page.evaluate(() => window.__mockFail.clear());
  await journal.getByRole("button", { name: "Keep mine" }).click();
  await expect(alert).toHaveCount(0);
  await page
    .locator(".sync-conflict-file")
    .filter({ has: page.locator('code:text-is("Projects/Release plan.md")') })
    .getByRole("button", { name: "Take theirs" })
    .click();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_sync_resolve_finish"]);
  });
  await page.getByRole("button", { name: "Finish merge" }).click();
  await expect(alert).toContainText("mock failure: vault_sync_resolve_finish");
  await expect(page.locator(".sync-conflict-file")).toHaveCount(2);
});

test("a failed conflict read reports itself instead of rendering nothing", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_sync_conflicts"]);
  });
  await page.getByRole("button", { name: "Pull", exact: true }).click();

  await expect(page.locator(".sync-conflict .vault-sync-error")).toContainText(
    "mock failure: vault_sync_conflicts",
  );
});

test("a merge parked before a restart still reads as needing attention", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);

  // The state a restart leaves: the merge is still parked in git, but nothing
  // has pushed or pulled in this session, so there is no last result to read.
  // Status has to come from the repository or the chip lies (SUB-572).
  await page.evaluate(() => window.__mockParkConflicts?.());
  // leaving and returning remounts the pane — a fresh status read with no
  // last result, the same thing a relaunch produces
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();

  await expect(page.locator(".vault-sync-state")).toContainText("Needs attention");
  // and there is no last-result summary backing it up — the chip is reading
  // the repository, not this session's memory
  await expect(page.locator(".vault-sync-summary")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Conflicts — resolve below" })).toHaveCount(0);
  await expect(page.locator(".sync-conflict-file")).toHaveCount(2);
});

test("remote command errors stay inline and preserve the token draft", async ({ page }) => {
  await openVaultSync(page);
  await page.getByLabel("Remote URL").fill("ftp://sync.example.com/vault.git");
  await page.getByLabel("Access token").fill("retry-this-token");
  await page.getByRole("button", { name: "Save remote" }).click();

  await expect(page.locator(".vault-sync-form-error")).toHaveText(
    "vault sync remote must use https:// (file:// is allowed for tests)",
  );
  await expect(page.locator(".vault-sync-state")).toContainText("Setup needed");
  await expect(page.getByLabel("Access token")).toHaveValue("retry-this-token");
});
