import { expect, test, type Page } from "./fixtures";

// Evidence run, not a gate:
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test e2e/rewritepauseshots.spec.ts
//   SHOTS=1 SHOTS_BEFORE=1 SHOT_DIR=/tmp/shots-before npx playwright test …
// Shoots the sync pane in the states a purge or trim leaves on a hosted vault
// — on the device that ran it: the pause itself, the consent paragraph the
// first press opens, and the pane once the replacement has run; and on a
// second device that agreed to none of it: the pause a replaced store leaves,
// what adopting would spend, and the report that says the vault moved onto
// someone else's rewritten history. Scrolled to the top of the pane, so the state
// chip and the status line are in frame with the block they describe.
//
// The BEFORE pass reconstructs the pane as it read before this change rather
// than shooting the older build, which cannot reach the state at all: its mock
// backend had no way to stage a rewritten history, so there was nothing to
// photograph. The reconstruction is exactly the two things that changed on
// this surface — the recovery block is removed from the page, and the refusal
// carries the wording it had then, which named no way out.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/rewrite-pause-shots";
const before = !!process.env.SHOTS_BEFORE;

const OLD_PUSH_ERROR =
  "hosted sync push rejected: this vault's history was rewritten by a purge or trim, but the " +
  "remote still holds the old history; replace or re-initialize the hosted-sync vault before " +
  "pushing again";

// One ground, because the app has one: nothing in src/styles.css answers a
// theme attribute or the system's colour scheme, and the light surface is the
// print pass, which this pane has no path to. A second file per state would
// only be the dark one under another name.
async function shoot(page: Page, name: string) {
  // The pane scrolls inside its own container, and a press near its foot
  // leaves the status chip above the frame — the one thing every one of these
  // shots is supposed to show next to the block.
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((node) => {
      if (node instanceof HTMLElement && node.scrollTop > 0) node.scrollTop = 0;
    });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

async function openPaused(page: Page, opts: { adopting?: boolean; rewritten?: boolean } = {}) {
  // Tall enough that the status chip, the block, and its consent paragraph
  // share one frame; the default e2e viewport cannot hold all three.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/");
  await page.locator(".sidebar").getByRole("button", { name: "Vault sync", exact: true }).click();
  await expect(page.locator(".vault-sync .list-title")).toHaveText("Vault sync");

  await page.getByLabel("Remote URL").fill("blob+https://drop.example/blob");
  await page.getByLabel("Access token").fill("test-token-0123456789");
  await page.locator(".vault-sync-passphrase").fill("correct horse battery staple");
  await page.locator(".vault-sync-passphrase-again").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");

  if (opts.adopting) {
    await page.evaluate(() =>
      window.__mockSyncReplacedStore?.({ discarded_snapshots: 2, unsaved_edits: true }),
    );
  }
  if (opts.rewritten || !opts.adopting) {
    await page.evaluate(() => window.__mockSyncRewriteBlocked?.(true));
  }
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".vault-sync-error").first()).toBeVisible();
}

test("the pane in the state a rewrite leaves behind", async ({ page }) => {
  await openPaused(page);

  if (before) {
    // The pre-change pane: the refusal is the whole answer, in its own words.
    await page.evaluate((text) => {
      document
        .querySelectorAll(".vault-sync-privacy")
        .forEach((block) => {
          if (block.querySelector("h3")?.textContent?.includes("history was rewritten"))
            block.remove();
        });
      const error = document.querySelector(".vault-sync-error");
      if (error) error.textContent = text;
    }, OLD_PUSH_ERROR);
    await shoot(page, "paused");
    return;
  }

  const paused = page.getByRole("heading", { name: /history was rewritten/ });
  await expect(paused).toBeVisible();
  await shoot(page, "paused");

  await page.getByRole("button", { name: /^Replace the server/ }).click();
  await expect(page.getByRole("heading", { name: "This replaces what the server holds" })).toBeVisible();
  await shoot(page, "consent");

  await page.getByRole("button", { name: "Replace the server’s copy", exact: true }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
  await expect(paused).toHaveCount(0);
  await shoot(page, "recovered");
});

/** The device on the other end of that replacement, which ran no purge and is
    holding work the new history has no line to. Nothing to reconstruct for a
    BEFORE pass: the branch this ships on is where the state first exists at
    all — before it, this device reset itself onto the new history in silence. */
test("the pane on a device a replaced store paused", async ({ page }) => {
  test.skip(before, "the pre-change pane could not reach this state at all");
  await openPaused(page, { adopting: true });

  const paused = page.getByRole("heading", { name: /another device rewrote/ });
  await expect(paused).toBeVisible();
  await shoot(page, "adopt-paused");

  await page.getByRole("button", { name: /^Move onto the server/ }).click();
  await expect(page.getByRole("heading", { name: "This discards work on this device" })).toBeVisible();
  await shoot(page, "adopt-consent");

  await page
    .getByRole("button", { name: "Discard this device\u2019s work and sync", exact: true })
    .click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
  await expect(paused).toHaveCount(0);
  await expect(page.locator(".vault-sync-notice")).toBeVisible();
  await shoot(page, "adopt-recovered");
});

/** The one device that can hold both states at once: it purged here, and the
    store it is paused on was replaced by someone else. Two doors are described
    on this pane and only one of them is open, so the shot is about which one
    the page leads with — and about the line the consent paragraph owes a
    device that purged: adopting brings back what its own purge removed.

    The BEFORE pass is the same two things as they read before this change: the
    headline led with the rewrite while the block below it was the pause, and
    the consent said nothing about the purge. */
test("the pane on a device holding a purge and a replaced store", async ({ page }) => {
  await openPaused(page, { adopting: true, rewritten: true });

  if (before) {
    await page.evaluate(() => {
      const title = document.querySelector(".vault-sync-status-title");
      const line = title?.nextElementSibling;
      if (line)
        line.textContent =
          "This vault's history was rewritten here, so no push or pull runs until the " +
          "server's copy is replaced \u2014 below.";
    });
    await shoot(page, "both-paused");
    await page.getByRole("button", { name: /^Move onto the server/ }).click();
    await expect(
      page.getByRole("heading", { name: "This discards work on this device" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll(".vault-sync-privacy p"));
      paragraphs.find((node) => node.textContent?.includes("purge or trim ran here too"))?.remove();
    });
    await shoot(page, "both-consent");
    return;
  }

  await expect(page.getByRole("heading", { name: /another device rewrote/ })).toBeVisible();
  await shoot(page, "both-paused");

  await page.getByRole("button", { name: /^Move onto the server/ }).click();
  await expect(
    page.getByRole("heading", { name: "This discards work on this device" }),
  ).toBeVisible();
  await shoot(page, "both-consent");
});
