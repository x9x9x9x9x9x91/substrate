import { expect, test, type Page } from "@playwright/test";

// Jobs dashboard: the `dashboard: jobs` surface renders the mock
// launchd roster (jobs_read) as one row per agent — dot | short name + prefix
// over schedule/pid | chips | actions. Control buttons are gated twice: the
// label must be listed in the note's `control:` prop AND the machine must
// have a plist for it. Fixture: Dashboards/Jobs.md props + mockJobs /
// mockJobStamps in src/lib/tauri.ts. The exit-history ring:
// mockJobs carry `exit_ring` run outcomes, surfaced as a "N of last M runs
// failed" chip folded into the row's dot/tint.

const row = (page: Page, label: string) => page.locator(`.jobs-row[data-label="${label}"]`);

async function openJobs(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Jobs$/ }).click();
  await expect(page.locator(".dash-title")).toHaveText("Jobs");
}

test("renders one row per allowed job, label-sorted, healthy rows dim", async ({ page }) => {
  await openJobs(page);
  const rows = page.locator(".jobs-row");
  await expect(rows).toHaveCount(5);

  await expect(rows.nth(0)).toHaveAttribute("data-label", "com.example.backup");
  await expect(rows.nth(1)).toHaveAttribute("data-label", "com.example.digest");
  await expect(rows.nth(2)).toHaveAttribute("data-label", "com.example.index");
  await expect(rows.nth(3)).toHaveAttribute("data-label", "com.example.verify");
  await expect(rows.nth(4)).toHaveAttribute("data-label", "com.substrate.vault-sync");

  // short name + prefix on line 1, schedule (and pid when live) on line 2
  await expect(rows.nth(0).locator(".jobs-name")).toHaveText("backup");
  await expect(rows.nth(0).locator(".jobs-prefix")).toHaveText("com.example");
  await expect(rows.nth(0).locator(".jobs-sub")).toContainText("every 4h");
  await expect(rows.nth(0).locator(".jobs-sub")).toContainText("pid 37031");
  await expect(rows.nth(0)).toHaveClass(/quiet/);

  // a paused job says so and keeps the normal foreground
  await expect(rows.nth(2).locator(".jobs-sub")).toHaveText("paused");
  await expect(rows.nth(2)).not.toHaveClass(/quiet/);
});

test("a nonzero last exit gets an alert chip and a red dot", async ({ page }) => {
  await openJobs(page);
  const verify = row(page, "com.example.verify");
  await expect(verify.locator(".jobs-chip.alert", { hasText: "exit 1" })).toHaveCount(1);
  // #EB5757
  expect(
    await verify.locator(".dash-dot").evaluate((el) => getComputedStyle(el).backgroundColor)
  ).toBe("rgb(235, 87, 87)");
  await expect(page.locator(".dash-state")).toContainText("1 failing");
});

test("exit history: repeated failures surface as a chip and an unhealthy row", async ({
  page,
}) => {
  await openJobs(page);
  // verify: 4 of the last 5 runs failed — one lucky success must not
  // repaint the row green; the chip sits next to the last-exit chip
  const verify = row(page, "com.example.verify");
  const chip = verify.locator(".jobs-chip.alert", { hasText: "4 of last 5 runs failed" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", /polls are not runs/);
  // digest: 1 of the last 3 — the amber warn idiom, not red
  const digest = row(page, "com.example.digest");
  await expect(digest.locator(".jobs-chip.warn", { hasText: "1 of last 3 runs failed" })).toBeVisible();
  // a clean history renders no ring chip at all
  await expect(row(page, "com.example.backup").locator(".jobs-chip", { hasText: "runs failed" })).toHaveCount(0);
});

test("a stale freshness probe warns on the row", async ({ page }) => {
  await openJobs(page);
  // the mock News curated stamp is 4d old against the note's 26h max-age
  const digest = row(page, "com.example.digest");
  const chip = digest.locator(".jobs-chip.warn", { hasText: "curated is" });
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("old");
});

test("freshness failure warns configured rows, keeps the roster, and recovers", async ({
  page,
}) => {
  await openJobs(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["jobs_freshness"]);
  });

  // A successful control action kicks both reads immediately. The roster
  // refresh still succeeds; only its separate freshness evidence is unknown.
  await row(page, "com.example.verify").locator(".sync-run").click();
  const error = page.locator(".dash-alert", { hasText: "freshness unreadable" });
  await expect(error).toContainText("mock failure: jobs_freshness");
  await expect(page.locator(".jobs-row")).toHaveCount(5);
  const digest = row(page, "com.example.digest");
  await expect(digest).not.toHaveClass(/quiet/);
  await expect(digest.locator(".jobs-chip.warn", { hasText: "freshness unknown" })).toHaveText(
    "freshness unknown"
  );
  expect(
    await digest.locator(".dash-dot").evaluate((el) => getComputedStyle(el).backgroundColor)
  ).toBe("rgb(217, 160, 43)");

  await page.evaluate(() => window.__mockFail.clear());
  await row(page, "com.example.verify").locator(".sync-run").click();
  await expect(error).toHaveCount(0);
  await expect(digest.locator(".jobs-chip.warn", { hasText: "curated is" })).toContainText(
    "curated is"
  );
});

test("initial launchd read failure shows an honest empty error state", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["jobs_read"]);
  });
  await openJobs(page);

  await expect(page.locator(".dash-alert")).toContainText("launchd unreadable");
  await expect(page.locator(".dash-alert")).toContainText("mock failure: jobs_read");
  await expect(page.locator(".jobs-row")).toHaveCount(0);
});

test("transient launchd read failure keeps the last-good roster and recovers", async ({ page }) => {
  await openJobs(page);
  const digest = row(page, "com.example.digest");
  await page.evaluate(() => {
    window.__mockFail = new Set(["jobs_read"]);
  });

  // The control succeeds in the backend, then its immediate roster reload
  // fails. The last-good row remains usable instead of becoming an empty pane.
  await digest.locator(".sync-pause").click();
  const error = page.locator(".dash-alert", { hasText: "launchd refresh failed" });
  await expect(error).toContainText("mock failure: jobs_read");
  await expect(page.locator(".jobs-row")).toHaveCount(5);
  await expect(digest.locator(".sync-pause")).toBeVisible();

  // The old button can kick a successful retry without waiting for POLL_MS.
  await page.evaluate(() => window.__mockFail.clear());
  await digest.locator(".sync-pause").click();
  await expect(error).toHaveCount(0);
  await expect(digest.locator(".jobs-sub")).toHaveText("paused");
  await expect(digest.locator(".sync-resume")).toBeVisible();
});

test("control is gated: opted-in rows get buttons, everything else is read-only", async ({
  page,
}) => {
  await openJobs(page);

  // in `control:` and has a plist → both verbs
  await expect(row(page, "com.example.digest").locator(".sync-btn")).toHaveCount(2);
  await expect(row(page, "com.example.verify").locator(".sync-btn")).toHaveCount(2);

  // not listed in `control:` → read-only even though the plist exists
  const backup = row(page, "com.example.backup");
  await expect(backup.locator(".sync-btn")).toHaveCount(0);
  await expect(backup.locator(".jobs-readonly")).toBeVisible();

  // listed by launchctl but no plist on this machine → no buttons,
  // and the row says why rather than offering a verb that would fail
  const vaultSync = row(page, "com.substrate.vault-sync");
  await expect(vaultSync.locator(".sync-btn")).toHaveCount(0);
  await expect(vaultSync.locator(".jobs-sub")).toContainText("not registered here");
});

test("pause flips the row to paused, resume flips it back", async ({ page }) => {
  await openJobs(page);
  const digest = row(page, "com.example.digest");

  await expect(digest.locator(".sync-pause")).toHaveText("Pause");
  await digest.locator(".sync-pause").click();
  await expect(digest.locator(".jobs-sub")).toHaveText("paused");
  await expect(digest.locator(".sync-resume")).toHaveText("Resume");
  // kickstart needs a loaded service, so a paused row never offers Run
  await expect(digest.locator(".sync-run")).toHaveCount(0);

  await digest.locator(".sync-resume").click();
  await expect(digest.locator(".jobs-sub")).toContainText("every 30m");
  await expect(digest.locator(".sync-pause")).toHaveText("Pause");
});

test("run now spins and leaves the job live with a pid", async ({ page }) => {
  await openJobs(page);
  const verify = row(page, "com.example.verify");
  await verify.locator(".sync-run").click();
  await expect(verify.locator(".jobs-sub")).toContainText("pid");
  // the kickstart cleared the stale exit status — but the failure HISTORY
  // stays: not erasing it on one lucky run is the ring's whole point
  await expect(verify.locator(".jobs-chip.alert", { hasText: "exit" })).toHaveCount(0);
  await expect(
    verify.locator(".jobs-chip.alert", { hasText: "4 of last 5 runs failed" })
  ).toHaveCount(1);
});

// The pane ships to machines that have no launchd at all. It says
// so once, in the header and in place of the roster, rather than offering
// control verbs whose only possible outcome is an error.
test("a machine with no launchd says so instead of showing a roster", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockJobsNoLaunchd = true;
  });
  await openJobs(page);
  await expect(page.locator(".dash-empty")).toContainText("This machine has no launchd");
  await expect(page.locator(".jobs-row")).toHaveCount(0);
  await expect(page.locator(".sync-btn")).toHaveCount(0);
  await expect(page.locator(".dash-inner")).toContainText("no scheduler here");
});

// A probe that FAILS is not a probe that answered no. The pane used to treat
// the two the same, so one dropped bridge call pinned it to the permanent
// no-scheduler line with no poll left running to take it back. An unknown
// answer reads the roster instead and lets that call speak for itself.
test("a failed availability probe still reads the roster", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["jobs_available"]);
  });
  await openJobs(page);

  await expect(page.locator(".jobs-row")).toHaveCount(5);
  await expect(page.locator(".dash-inner")).not.toContainText("This machine has no launchd");
  await expect(page.locator(".dash-inner")).not.toContainText("no scheduler here");
});
