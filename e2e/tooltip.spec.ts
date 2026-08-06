import { expect, test } from "@playwright/test";

// The in-app tooltip: hover copy that used to arrive a second later
// in OS chrome now appears in the app's own bubble, at the app's own timing,
// positioned inside the window. The migrated controls keep the accessible
// names their `title` used to give them. Runs against the same deterministic
// mock backend as smoke.spec.ts.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the list's first paint doubles as the "app is live" barrier
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("hovering a control opens the app's own bubble, not the OS one (SUB-1161)", async ({
  page,
}) => {
  const tip = page.locator(".tooltip");
  await expect(tip).toHaveCount(0);

  await page.locator(".sidebar-capture").hover();
  // a dwell, but the app's own (350ms) — nothing at 150ms, there by 700
  await page.waitForTimeout(150);
  await expect(tip).toHaveCount(0);
  await expect(tip).toHaveText("New note (⌘N)", { timeout: 700 });

  // and it goes away when the pointer does
  await page.locator(".list-title").hover();
  await expect(tip).toHaveCount(0);
});

test("the bubble stays inside the window at the bottom edge (SUB-1161)", async ({ page }) => {
  const gear = page.locator(".side-tool-btn[aria-label='Settings']");
  await gear.hover();
  const tip = page.locator(".tooltip");
  await expect(tip).toHaveText("Settings (⌘,)", { timeout: 700 });

  const box = (await tip.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);

  // the footer has no room below it, so the bubble sits above its trigger
  const trigger = (await gear.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(trigger.y);
});

test("with a folder queued the bubble clears the mini-player strip (SUB-1161)", async ({ page }) => {
  // the bubble sits at z 115, deliberately BELOW the mini-player's 150 — so a
  // footer tooltip placed into the strip isn't merely ugly, it is invisible.
  // Queue a folder the way folderplaylist.spec.ts does, then hover the footer.
  await page
    .locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Projects$/ }) })
    .locator(".side-destination")
    .click();
  await expect(page.locator(".list-title")).toHaveText("Projects");
  const rough = "01 umbra rough.wav";
  await page
    .locator(".row-file", { hasText: rough })
    .getByRole("button", { name: `Play ${rough}` })
    .click();
  const player = page.locator(".miniplayer");
  await expect(player).toBeVisible();

  const gear = page.locator(".side-tool-btn[aria-label='Settings']");
  await gear.hover();
  const tip = page.locator(".tooltip");
  await expect(tip).toHaveText("Settings (⌘,)", { timeout: 700 });

  const box = (await tip.boundingBox())!;
  const strip = (await player.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(strip.y);
});

test("migrated controls kept their accessible names (SUB-1161)", async ({ page }) => {
  // `title` WAS the name of this icon-only button — the primitive puts it back
  await expect(page.getByRole("button", { name: "New note (⌘N)" })).toBeVisible();
  // and where an aria-label already named the control, that name is untouched
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Journal", exact: true })).toBeVisible();

  // the bubble itself is aria-hidden: its words are already in the name above,
  // and announcing them twice is worse than not at all
  await page.locator(".sidebar-capture").hover();
  await expect(page.locator(".tooltip")).toHaveAttribute("aria-hidden", "true", { timeout: 700 });
});
