import { expect, test, type Page } from "@playwright/test";

// The €1 donation nag (SUB-419). It ships dormant — NAG_ENABLED is false — so
// the surface is driven here through the dev-only ?donatenag=1 seam, which is
// honoured outside Tauri only. Every other spec therefore sees no nag at all,
// which the last test asserts directly.

const KEY = "substrate.donationNag";
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Boot with the seam on and a pre-seeded nag state, so we control the clock
    without waiting a week. Seeding must happen before the app's first paint. */
async function boot(page: Page, seed: Record<string, unknown> | null) {
  await page.addInitScript(
    ([key, value]) => {
      // init scripts re-run on every navigation — seed the starting state
      // once and then let the app own the key, so a reload proves persistence
      // instead of silently restoring the seed
      if (window.localStorage.getItem(key as string) !== null) return;
      if (value !== null) window.localStorage.setItem(key as string, JSON.stringify(value));
    },
    [KEY, seed] as const
  );
  await page.goto("/?donatenag=1");
  await expect(page.locator(".list-title")).toHaveText("Notes");
}

const due = () => ({ firstSeenAt: Date.now() - WEEK * 4, lastNagAt: null, dismissedForever: false });

test("shows on boot once the grace week is past, over nothing in progress", async ({ page }) => {
  await boot(page, due());
  const nag = page.locator(".donate-nag");
  await expect(nag).toBeVisible();
  await expect(nag).toContainText("€1 makes this message go away forever");
  // a banner, not a modal: no overlay backdrop, and it never took focus
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(nag.locator(":focus")).toHaveCount(0);
});

test("its innards are the shared dialog grammar, not a bespoke shell (SUB-1168)", async ({
  page,
}) => {
  await boot(page, due());
  const nag = page.locator(".donate-nag");
  // the sentence and the action row are dbform primitives…
  await expect(nag.locator(".dbform-note")).toContainText(
    "€1 makes this message go away forever"
  );
  await expect(nag.locator(".dbform-foot")).toBeVisible();
  // …and dismiss is the shared XIcon button, not a hand-rolled glyph
  await expect(nag.locator(".dbform-x svg")).toBeVisible();
  // the classes it used to roll itself are gone from the document entirely
  for (const dead of [".donate-nag-body", ".donate-nag-close"]) {
    await expect(page.locator(dead)).toHaveCount(0);
  }
});

test("stays quiet inside the first week and inside the weekly interval", async ({ page }) => {
  await boot(page, { firstSeenAt: Date.now() - 1000, lastNagAt: null, dismissedForever: false });
  await expect(page.locator(".donate-nag")).toHaveCount(0);

  await boot(page, {
    firstSeenAt: Date.now() - WEEK * 4,
    lastNagAt: Date.now() - 1000,
    dismissedForever: false,
  });
  await expect(page.locator(".donate-nag")).toHaveCount(0);
});

test("Esc dismisses for the session; it comes back next boot", async ({ page }) => {
  await boot(page, due());
  await expect(page.locator(".donate-nag")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".donate-nag")).toHaveCount(0);
  // per-session only — the checkbox was untouched, so nothing is permanent
  const stored = await page.evaluate((k) => window.localStorage.getItem(k), KEY);
  expect(JSON.parse(stored ?? "{}").dismissedForever).toBe(false);
});

test("the close button dismisses for the session too", async ({ page }) => {
  await boot(page, due());
  await page.locator(".donate-nag .dbform-x").click();
  await expect(page.locator(".donate-nag")).toHaveCount(0);
});

test("the checkbox retires it forever — survives a reload", async ({ page }) => {
  await boot(page, due());
  // click, not check(): check() re-reads the box afterwards and the nag is
  // already gone by then — vanishing on tick is the whole point
  await page.locator(".donate-nag-forever input").click();
  await expect(page.locator(".donate-nag")).toHaveCount(0);

  // reload with the seam still on and the schedule long overdue: gone for good
  await page.goto("/?donatenag=1");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".donate-nag")).toHaveCount(0);
  const stored = await page.evaluate((k) => window.localStorage.getItem(k), KEY);
  expect(JSON.parse(stored ?? "{}").dismissedForever).toBe(true);
});

test("master switch off: no nag, and no state written at all", async ({ page }) => {
  await page.addInitScript((k) => window.localStorage.removeItem(k as string), KEY);
  await page.goto("/"); // no seam — the shipped default
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".donate-nag")).toHaveCount(0);
  const stored = await page.evaluate((k) => window.localStorage.getItem(k), KEY);
  expect(stored).toBeNull();
});
