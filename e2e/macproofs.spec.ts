import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

import { openDb } from "./nav";

// Mac screenshot proofs — the OTHER visual tier (docs/visual-tiers.md).
// visualbaselines.spec.ts answers "did this change?" against committed Linux
// PNGs and skips itself everywhere else. This file answers nothing by itself:
// it CAPTURES the same core surfaces on a macOS host and writes them to a
// directory a person can look at. No baselines, no comparisons — a capture
// that failed to render at all is the only red it can produce.
//
// It exists for the nightly full mac pass: headless Linux pixels are the
// wrong pixels for judging the shipped app, so the nightly runs this on the
// Mac gate host and files the PNGs with the run report. Opt-in by env so the
// ordinary e2e gate never pays for it or writes stray files:
//
//   MAC_PROOFS=1 [MAC_PROOFS_DIR=/some/dir] npx playwright test macproofs
//
// Captures land in MAC_PROOFS_DIR (default test-results/mac-proofs).
test.skip(!process.env.MAC_PROOFS, "mac proof captures are opt-in (MAC_PROOFS=1) — the e2e gate compares Linux baselines instead");
// And opt-in is not enough by itself: a MAC_PROOFS=1 run on a Linux host would
// file Linux pixels under a name that promises macOS rendering. Skip, not
// fail — unlike the macsmoke gate this tier certifies nothing, so a wrong-host
// run has nothing to lie about beyond its filename.
test.skip(process.platform !== "darwin", "mac proofs capture macOS rendering — this host is not a Mac");

const OUT = process.env.MAC_PROOFS_DIR ?? join("test-results", "mac-proofs");

// Same determinism pins as the baseline tier: fixed clock so the seeded
// fixtures are constant, UTC so the capture host's zone stays out of the
// pixels. Not for comparability run-to-run-diffing here — just so a proof
// set is reproducible when someone asks "was that real?".
const FIXED_TIME = new Date("2026-06-17T09:30:00Z");

test.use({ timezoneId: "UTC", locale: "en-US" });

async function boot(page: Page) {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
}

async function openDash(page: Page, name: string) {
  await boot(page);
  await page.locator(".side-item", { hasText: new RegExp(`^${name}$`) }).click();
  await expect(page.locator(".dash-title")).toHaveText(name);
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: join(OUT, `${name}.png`) });
}

test("proof: note list and editor", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await shot(page, "notes-editor");
});

test("proof: all notes list pane", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await shot(page, "all-notes");
});

test("proof: database manager", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-row").first()).toBeVisible();
  await shot(page, "db-manager");
});

test("proof: database table view", async ({ page }) => {
  await boot(page);
  await openDb(page, "Release");
  await shot(page, "db-table");
});

test("proof: dashboard overview", async ({ page }) => {
  await openDash(page, "Overview");
  await shot(page, "dash-overview");
});

test("proof: dashboard portfolio charts", async ({ page }) => {
  await openDash(page, "Portfolio");
  await shot(page, "dash-portfolio");
});


test("proof: calendar month grid", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
  await shot(page, "calendar-month");
});

test("proof: search results", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill("inbox");
  await expect(page.locator(".search-stats")).toBeVisible();
  await shot(page, "search-results");
});

test("proof: print surface (light ramp)", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await openDash(page, "Overview");
  await page
    .locator("#root .dash-actions")
    .getByRole("button", { name: "Print", exact: true })
    .click();
  await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  await shot(page, "print-light");
});
