import { expect, test, type Page } from "./fixtures";

const SHOT_DIR = process.env.SHOT_DIR || "/tmp/sync-busy-shots";

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

test("a blob+ URL asks for the vault passphrase instead of a certificate", async ({ page }) => {
  await openVaultSync(page);

  await page.getByLabel("Remote URL").fill("blob+https://drop.example/blob");
  await expect(page.locator(".vault-sync-passphrase")).toBeVisible();
  await expect(page.locator(".vault-sync-passphrase-again")).toBeVisible();
  await expect(page.getByText("Losing the passphrase loses")).toBeVisible();
  await expect(page.getByLabel("Server certificate (optional)")).toHaveCount(0);

  // Saving without the passphrase is refused with the backend's words…
  await page.getByLabel("Access token").fill("test-token-0123456789");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.getByRole("alert")).toContainText("needs the vault passphrase");

  // …a phrase typed differently twice is refused before anything is sent…
  await page.locator(".vault-sync-passphrase").fill("correct horse battery staple");
  await page.locator(".vault-sync-passphrase-again").fill("correct horse battery stapel");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.getByRole("alert")).toContainText("do not match");

  // …a short one on its length…
  await page.locator(".vault-sync-passphrase").fill("short pass");
  await page.locator(".vault-sync-passphrase-again").fill("short pass");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.getByRole("alert")).toContainText("at least 12 characters");

  // …and the reveal toggle shows what was typed, so a repeat can be checked.
  await page.getByRole("button", { name: "Show the vault passphrase" }).click();
  await expect(page.locator(".vault-sync-passphrase")).toHaveAttribute("type", "text");
  await expect(page.locator(".vault-sync-passphrase-again")).toHaveAttribute("type", "text");

  // With both entries matching, the remote lands and every secret clears
  // write-only — the reveal goes back to masked with them.
  await page.locator(".vault-sync-passphrase").fill("correct horse battery staple");
  await page.locator(".vault-sync-passphrase-again").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
  await expect(page.locator(".vault-sync-passphrase")).toHaveValue("");
  await expect(page.locator(".vault-sync-passphrase-again")).toHaveValue("");
  await expect(page.locator(".vault-sync-passphrase")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Access token")).toHaveValue("");
});

async function configureHosted(page: Page) {
  await page.getByLabel("Remote URL").fill("blob+https://drop.example/blob");
  await page.getByLabel("Access token").fill("test-token-0123456789");
  await page.locator(".vault-sync-passphrase").fill("correct horse battery staple");
  await page.locator(".vault-sync-passphrase-again").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
}

/** The state a purge or trim leaves on an encrypted vault: every leg refuses,
    and the only way out is publishing this device's history over the server's.
    The pane has to name that state, say what the way out costs before it runs,
    and go quiet once sync works again. */
test("a vault paused by a rewrite is walked back to syncing", async ({ page }) => {
  await openVaultSync(page);
  await configureHosted(page);
  await page.evaluate(() => window.__mockSyncRewriteBlocked?.(true));

  // Ordinary sync is refused while it stands, in the words the backend uses —
  // and the pane says what the state is, not only that the last leg failed.
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-error").first()).toContainText("hosted sync is paused");
  await expect(page.locator(".vault-sync-state")).toContainText("Needs attention");
  const paused = page.getByRole("heading", { name: /history was rewritten/ });
  await expect(paused).toBeVisible();

  // The first press says what the second one does; it does not run anything.
  const replace = page.getByRole("button", { name: /^Replace the server/ });
  await replace.click();
  await expect(page.getByRole("heading", { name: "This replaces what the server holds" })).toBeVisible();
  await expect(paused).toBeVisible();
  // Arming clears the last leg's error, so the status has to carry the state
  // by itself rather than falling back to the line that says sync is fine.
  await expect(page.locator(".vault-sync-status")).toContainText("Sync is paused");
  await expect(page.locator(".vault-sync-status")).not.toContainText("Ready to sync");

  // Taking it back leaves the vault exactly as paused as it was.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This replaces what the server holds" })).toHaveCount(0);
  await expect(paused).toBeVisible();

  await replace.click();
  await page.getByRole("button", { name: "Replace the server’s copy", exact: true }).click();

  // Sync is ordinary from here: the pause is gone, the way out with it, and
  // an ordinary push goes through.
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
  await expect(paused).toHaveCount(0);
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 4 · Pulled 0");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 2 · Pulled 0");
});

/** The other side of that replacement, on a device that agreed to nothing: it
    holds a snapshot and an unsaved edit the new history has no line to, so it
    is paused rather than reset behind the user's back. The pane has to name
    the pause, price it in the work it would spend, and only then offer the
    way through. */
test("a device holding its own work is asked before a replaced store takes it", async ({ page }) => {
  await openVaultSync(page);
  await configureHosted(page);
  await page.evaluate(() =>
    window.__mockSyncReplacedStore?.({ discarded_snapshots: 2, unsaved_edits: true }),
  );

  // Both legs refuse — including Push, which must not send the user to Pull.
  await page.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.locator(".vault-sync-error").first()).toContainText("hosted sync is paused");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-error").first()).toContainText(
    "another device rewrote this vault",
  );
  await expect(page.locator(".vault-sync-state")).toContainText("Needs attention");

  // The block names the state and what walking through it would spend.
  const paused = page.getByRole("heading", { name: /another device rewrote/ });
  await expect(paused).toBeVisible();
  await expect(page.locator(".vault-sync-privacy")).toContainText(
    "2 snapshots taken here, and edits no snapshot holds yet",
  );

  // The first press says what the second one does; it runs nothing, and the
  // status carries the state once the last leg's error is cleared.
  const adopt = page.getByRole("button", { name: /^Move onto the server/ });
  await adopt.click();
  await expect(
    page.getByRole("heading", { name: "This discards work on this device" }),
  ).toBeVisible();
  await expect(paused).toBeVisible();
  await expect(page.locator(".vault-sync-status")).toContainText("Sync is paused");
  await expect(page.locator(".vault-sync-status")).not.toContainText("Ready to sync");

  // Taking it back leaves the device exactly as paused as it was.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "This discards work on this device" }),
  ).toHaveCount(0);
  await expect(paused).toBeVisible();

  // Consenting adopts — and the report says the device moved onto a rewritten
  // history rather than reading as an ordinary pull of six notes.
  await adopt.click();
  await page
    .getByRole("button", { name: "Discard this device\u2019s work and sync", exact: true })
    .click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
  await expect(paused).toHaveCount(0);
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 0 · Pulled 6");
  await expect(page.locator(".vault-sync-notice")).toContainText(
    "moved onto a history another device rewrote",
  );
  await expect(page.locator(".vault-sync-notice")).toContainText("2 snapshots taken here");

  // Sync is ordinary from here.
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 2 · Pulled 0");
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
  const alert = page.locator(".sync-conflict .dash-alert");
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

  await expect(page.locator(".sync-conflict .dash-alert")).toContainText(
    "mock failure: vault_sync_conflicts",
  );
});

test("a merge parked before a restart still reads as needing attention", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);

  // The state a restart leaves: the merge is still parked in git, but nothing
  // has pushed or pulled in this session, so there is no last result to read.
  // Status has to come from the repository or the chip lies.
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
    "vault sync remote must use https:// or blob+https:// (file:// is allowed for tests)",
  );
  await expect(page.locator(".vault-sync-state")).toContainText("Setup needed");
  await expect(page.getByLabel("Access token")).toHaveValue("retry-this-token");
});

/** A retry after a failed push has to say it is running. The failure is
    recorded and outlives the attempt — that is the point of the slot — but the
    chip kept reading "Error" with the previous message for the whole of the
    next push, so a leg that ran for minutes was invisible and pressing Push
    again looked like it had done nothing.

    Shots for the change ride this test: SHOTS=1 SHOT_DIR=… npx playwright
    test e2e/syncui.spec.ts -g "retry". */
test("a retry after a failed push reads as pushing, not as the old error", async ({ page }) => {
  await openVaultSync(page);
  await configure(page);

  // The failure the user is retrying from.
  await page.evaluate(() => window.__mockFailOnce?.("vault_sync_push"));
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Error");
  await expect(page.locator(".dash-alert")).toContainText("mock failure: vault_sync_push");

  // The retry, parked mid-flight — the state the pane could not describe.
  await page.evaluate(() => window.__mockHoldCommand?.("vault_sync_push"));
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const chip = page.locator(".vault-sync-state");
  await expect(chip).toContainText("Pushing");
  await expect(chip).not.toContainText("Error");
  await expect(chip).not.toHaveClass(/danger/);
  if (process.env.SHOTS)
    await page.screenshot({ path: `${SHOT_DIR}/pushing-in-flight.png`, fullPage: true });

  // And when it lands, the old error is gone with it.
  await page.evaluate(() => window.__mockReleaseCommand?.("vault_sync_push"));
  await expect(chip).toContainText("Ready");
  await expect(page.locator(".vault-sync-summary")).toHaveText("Pushed 2 · Pulled 0");
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  if (process.env.SHOTS)
    await page.screenshot({ path: `${SHOT_DIR}/after-success.png`, fullPage: true });
});
