import { expect, test, type Locator, type Page } from "@playwright/test";

// Sync manager: the `dashboard: sync` surface as a control
// surface — direction-grouped leg rows off the mock sync state, per-leg Run
// now (running→ok on the mock tick), Run-all per direction, Pause/Resume
// per launchd job, and the quiet activity/error tails. Fixture:
// Dashboards/Sync.md + the sync lane in src/lib/tauri.ts.

async function openSync(page: Page) {
  await page.goto("/");
  // exact match — "Label sync call" (Calendar) would catch a bare hasText
  await page.locator(".side-item", { hasText: /^Sync$/ }).click();
  await expect(page.locator(".dash-title")).toHaveText("Sync");
}

function dir(page: Page, name: string) {
  return page.locator(".sync-dir", { hasText: name });
}

function legRow(scope: Locator, leg: string) {
  return scope.locator(".strip-row", { hasText: leg });
}

// A leg row is name · history track · right fact · hover Run. The
// track is always STRIP_CELLS wide, so cell classes — not counts — carry the
// state, and `strip-none` covers both "no run in this slot" and "this leg has
// no history at all". A problem leg's finding is one red sentence
// next to the name (.strip-story); the right fact keeps the last-ok
// counter-fact, and --hair-soft rules separate the rows.
const STRIP_CELLS = 40;

function cellKinds(row: Locator) {
  return row.locator(".strip-cell").evaluateAll((els) =>
    els.map((e) =>
      [...e.classList].find((c) => c.startsWith("strip-") && c !== "strip-cell")!.slice(6)
    )
  );
}

test("renders the header meta, direction sections, and all 13 legs", async ({ page }) => {
  await openSync(page);
  // overall state: the mock's failed Keys:cloud leg makes it an alert
  await expect(page.locator(".dash-state")).toContainText("alert");
  // the header speaks in sentences now (.sync-meta2), not a meta strip
  await expect(page.locator(".sync-meta2")).toContainText("A sweep is running now.");
  await expect(page.locator(".sync-meta2-alert")).toContainText("Weekly verify found mismatches");

  // cloud carries 7 legs (Samples is cloud-only), nas 6
  await expect(dir(page, "Cloud").locator(".strip-row")).toHaveCount(7);
  await expect(dir(page, "Nas").locator(".strip-row")).toHaveCount(6);

  // direction facts: schedule + quota + sweep age; cloud is mid-sweep
  await expect(dir(page, "Cloud").locator(".sync-dir-facts")).toContainText("running…");
  await expect(dir(page, "Cloud").locator(".sync-dir-facts")).toContainText("every 4h");
  await expect(dir(page, "Cloud").locator(".sync-dir-facts")).toContainText("GiB free");
  await expect(dir(page, "Nas").locator(".sync-dir-facts")).toContainText("sweep 1d 2h");
  await expect(dir(page, "Nas").locator(".sync-dir-facts")).toContainText("daily 10:00");
});

test("leg rows carry a fixed history track, findings, and the right fact", async ({ page }) => {
  await openSync(page);
  const cloud = dir(page, "Cloud");

  // every track is the same width regardless of how much history exists
  for (const row of await cloud.locator(".strip-row").all())
    await expect(row.locator(".strip-cell")).toHaveCount(STRIP_CELLS);

  // a healthy leg says nothing in words: the track is the whole statement
  // a healthy leg says nothing in words: old failures stay visible in the
  // track (that is the point of history), but the newest run is clean
  const fin = legRow(cloud, "Finance");
  await expect(fin.locator(".strip-age")).toContainText("ago");
  expect((await cellKinds(fin)).at(-1)).toBe("ok");

  // the failed leg: red cells at the newest end, and the whole story as one
  // red sentence next to the name — the right edge keeps the
  // counter-fact instead (when the leg last went well)
  const keys = legRow(cloud, "Keys");
  const keyKinds = await cellKinds(keys);
  expect(keyKinds.slice(-2)).toEqual(["fail", "fail"]);
  await expect(keys.locator(".strip-story")).toHaveText(/failed · 2 errors · tried 3\dm ago/);
  await expect(keys.locator(".strip-story")).toHaveCSS("color", "rgb(235, 87, 87)");
  await expect(keys.locator(".strip-age")).toContainText("ok 2d");
  await expect(keys.locator(".strip-cell.strip-fail").last()).toHaveAttribute(
    "title",
    /^failed · .+ · [1-9]\d* errors$/
  );

  // the running leg pulses in the newest slot and says so on the right
  const mp = legRow(cloud, "Music-Production");
  await expect(mp.locator(".strip-cell.strip-live")).toHaveCount(1);
  await expect(mp.locator(".strip-age")).toContainText("running");
  // its verify mismatch shows as the Δ chip plus exactly one amber cell
  await expect(mp.locator(".sync-vchip")).toHaveText("Δ246");
  await expect(mp.locator(".strip-cell.strip-warn")).toHaveCount(1);
  await expect(mp.locator(".strip-cell.strip-warn")).toHaveAttribute("title", /verify mismatch/);
  // a clean leg carries no chip and no amber — the hue means one thing here
  await expect(fin.locator(".sync-vchip")).toHaveCount(0);
  await expect(fin.locator(".strip-cell.strip-warn")).toHaveCount(0);

  // a leg whose state predates the runner's history field: same geometry, all
  // cells empty, and the track says why
  const samples = legRow(cloud, "Samples");
  expect(new Set(await cellKinds(samples))).toEqual(new Set(["none"]));
  await expect(samples.locator(".strip-track")).toHaveAttribute(
    "title",
    "history builds up as runs complete"
  );

  // dry-run leg: never completed, so the right fact names the mode, and the
  // dry runs read as empty slots rather than as findings
  const dryVault = legRow(dir(page, "Nas"), "Vault");
  await expect(dryVault.locator(".strip-age")).toContainText("dry-run");
  expect((await cellKinds(dryVault)).slice(-4)).toEqual(["none", "none", "none", "none"]);
});

test("a direction mid-sweep disables its Run buttons", async ({ page }) => {
  await openSync(page);
  const cloud = dir(page, "Cloud");
  // Music-Production:cloud is running in the mock state and cloud's remote
  // flag is up — every cloud Run and the Run-all stay off
  await expect(cloud.locator(".sync-run")).toHaveCount(7);
  for (const btn of await cloud.locator(".sync-run").all()) await expect(btn).toBeDisabled();
  await expect(cloud.locator(".sync-run-all")).toBeDisabled();
  // nas is idle — its controls are live
  const syn = dir(page, "Nas");
  await expect(syn.locator(".sync-run").first()).toBeEnabled();
  await expect(syn.locator(".sync-run-all")).toBeEnabled();
});

// The public claim (docs/differentiators.md): "a missing runner disables the
// buttons with the reason instead of offering a verb that could only fail."
// The pane reads the sync system either way — it just can't start a sweep.
test("an estate with no runner disables every Run and says why", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockSyncNoRunner = true;
  });
  await openSync(page);
  // the read-only surface is intact: the legs still render
  await expect(dir(page, "Cloud").locator(".strip-row")).toHaveCount(7);
  await expect(dir(page, "Nas").locator(".strip-row")).toHaveCount(6);
  const reason = /No sync runner on this machine/;
  // nas is idle, so nothing but can_run:false can be disabling these
  const syn = dir(page, "Nas");
  for (const btn of await syn.locator(".sync-run").all()) {
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("title", reason);
  }
  await expect(syn.locator(".sync-run-all")).toBeDisabled();
  await expect(syn.locator(".sync-run-all")).toHaveAttribute("title", reason);
  // and the Pause/Resume side is untouched — it doesn't need a runner
  await expect(page.locator(".sync-job-row", { hasText: "verify" }).locator(".sync-pause")).toBeEnabled();
});

test("Run now flips the leg running → ok, grows its track, and logs it", async ({ page }) => {
  await openSync(page);
  const keys = legRow(dir(page, "Nas"), "Keys");
  const before = (await cellKinds(keys)).filter((k) => k !== "none").length;
  // Run reveals on hover; the button holds its cell either way
  await keys.hover();
  await expect(keys.locator(".sync-run")).toHaveCSS("opacity", "1");
  await keys.locator(".sync-run").click();

  // the mock marks the leg running right away: newest slot pulses, no 41st cell
  await expect(keys.locator(".strip-cell.strip-live")).toHaveCount(1);
  await expect(keys.locator(".strip-cell")).toHaveCount(STRIP_CELLS);
  await expect(keys.locator(".sync-run")).toBeDisabled();
  await expect(page.locator(".sync-activity summary")).toContainText("Activity (1)");

  // the mock run completes ~1.2s in; the 2s in-flight poll lands it
  await expect(keys.locator(".strip-cell.strip-live")).toHaveCount(0, { timeout: 12_000 });
  await expect(keys.locator(".strip-age")).toContainText("0m ago", { timeout: 12_000 });
  // the completed run appended one outcome to the track
  expect((await cellKinds(keys)).filter((k) => k !== "none").length).toBe(before + 1);
  await expect(page.locator(".sync-activity-row").first()).toContainText("nas · Keys");
  await expect(page.locator(".sync-activity-row").first()).toContainText("run ok");
});

test("Run all sweeps the direction's legs and re-stamps the sweep", async ({ page }) => {
  await openSync(page);
  const syn = dir(page, "Nas");
  await syn.locator(".sync-run-all").click();

  // every leg goes running, the head says so, controls lock
  await expect(syn.locator(".sync-dir-facts")).toContainText("running…");
  await expect(syn.locator(".sync-run-all")).toBeDisabled();
  await expect(syn.locator(".sync-run").first()).toBeDisabled();

  // the sweep completes: fresh stamp on the head, legs back to ok
  await expect(syn.locator(".sync-dir-facts")).toContainText("sweep 0m ago", {
    timeout: 12_000,
  });
  // back to healthy = back to silent: no leg says a word
  await expect(syn.locator(".strip-row .strip-cell.strip-live")).toHaveCount(0, {
    timeout: 12_000,
  });
  await expect(page.locator(".sync-activity-row").first()).toContainText("nas · all legs");
});

test("Pause/Resume marks the launchd job and logs the activity", async ({ page }) => {
  await openSync(page);
  await expect(page.locator(".dash-section-label", { hasText: "Automation" })).toBeVisible();
  const verify = page.locator(".sync-job-row", { hasText: "verify" });
  await expect(verify.locator(".sync-status")).toContainText("Sun 11:00");
  await expect(verify).toContainText("exit 1");

  await verify.locator(".sync-pause").click();
  await expect(verify.locator(".sync-status")).toContainText("paused");
  await expect(verify.locator(".sync-resume")).toBeVisible();
  await expect(page.locator(".sync-activity-row").first()).toContainText("com.example.sync.verify");
  await expect(page.locator(".sync-activity-row").first()).toContainText("pause ok");

  await verify.locator(".sync-resume").click();
  await expect(verify.locator(".sync-status")).toContainText("Sun 11:00");
  await expect(verify.locator(".sync-pause")).toBeVisible();
  await expect(page.locator(".sync-activity-row").first()).toContainText("resume ok");
});

test("keep-awake capsule reflects and flips the machine flag (SUB-424)", async ({ page }) => {
  await openSync(page);
  // the mock machine starts pinned awake, like the real one
  const chip = page.locator(".sync-awake");
  await expect(chip).toHaveText("keep awake on");
  await expect(chip).toHaveClass(/on/);

  await chip.click();
  await expect(chip).toHaveText("keep awake off");
  await expect(chip).not.toHaveClass(/on/);

  await chip.click();
  await expect(chip).toHaveText("keep awake on");
});

test("the error tail expands as a quiet collapsible list", async ({ page }) => {
  await openSync(page);
  const errors = page.locator(".sync-errors", { hasText: "Recent errors" });
  await expect(errors.locator("summary")).toContainText("Recent errors (3)");
  await expect(errors.locator(".sync-errlog")).toBeHidden();
  await errors.locator("summary").click();
  await expect(errors.locator(".sync-errlog")).toBeVisible();
  await expect(errors.locator(".sync-errlog")).toContainText("Keys/id-backup-2026-07.pcv");
});

// The direction head borrows the rows' --sync-grid so its facts and its
// action buttons land on column boundaries the rows already own. Both
// clusters are wider than the tracks they claim, though, so both overflow
// their cell leftward and the track boundary alone does not separate them —
// they overlapped by 1.4px until .sync-dir-facts took an explicit right
// margin. Geometry, not text: only a measurement catches it.
test("the head's facts clear its buttons, and its right edge holds the rows'", async ({
  page,
}) => {
  await openSync(page);
  for (const name of ["Cloud", "Nas"]) {
    const head = dir(page, name).locator(".sync-dir-head");
    const facts = await head.locator(".sync-dir-facts").boundingBox();
    const actions = await head.locator(".sync-dir-actions").boundingBox();
    const gap = actions!.x - (facts!.x + facts!.width);
    expect(gap, `${name}: facts run into the head's buttons`).toBeGreaterThan(6);
  }
  // the head's trailing edge is the rows' Run column, to the pixel
  const actions = await dir(page, "Cloud").locator(".sync-dir-actions").boundingBox();
  const run = await dir(page, "Cloud").locator(".strip-row .sync-run").first().boundingBox();
  expect(Math.abs(actions!.x + actions!.width - (run!.x + run!.width))).toBeLessThan(1);
});

// A ~760px pane is the narrow end of the desktop window. The strip claims the
// grid's flexible column, so the failure mode is silent: cells overflow the
// track (or the row overflows the pane) rather than shrinking. Only a
// measurement catches it — the ticks are 1px-floored, so they can always fit.
test("the strip shrinks instead of overflowing in a narrow pane", async ({ page }) => {
  await openSync(page);
  // 760px exercises the ≤900px template, 1000px the ≤1100px mid-range one,
  // and 1060px the band the review caught overflowing under the old 1040px
  // breakpoint — the name column is wide enough for the finding story, and
  // every band must keep the 40 ticks inside their track
  for (const width of [760, 1000, 1060]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = dir(page, "Cloud").locator(".strip-row");
    for (const row of await rows.all()) {
      const track = (await row.locator(".strip-track").boundingBox())!;
      const cells = await row.locator(".strip-cell").evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect())
      );
      expect(cells).toHaveLength(STRIP_CELLS);
      // every tick is inside its track, and still has width to read as a tick
      for (const c of cells) {
        expect(c.width).toBeGreaterThan(0.5);
        expect(c.left).toBeGreaterThanOrEqual(track.x - 0.5);
        expect(c.right).toBeLessThanOrEqual(track.x + track.width + 0.5);
      }
      // and the row itself never pushes past the pane
      const rb = (await row.boundingBox())!;
      expect(rb.x + rb.width).toBeLessThanOrEqual(width + 0.5);
    }
    // the right fact still fits on one line rather than wrapping the row taller
    const heights = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  }
});
