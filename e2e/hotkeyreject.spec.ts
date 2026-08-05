import { expect, test } from "@playwright/test";

// A changed `capture-hotkey` the backend refuses (won't parse, or
// the OS says another app owns it) used to be silent outside the log file —
// the settings form showed the new chord while the OLD one stayed registered.
// `apply_settings` now emits `capture:hotkey-rejected` from both arms; the
// shell toasts which chord actually still fires. The real emit needs a live
// OS shortcut registry, so the spec drives the same event through the mock.

test("a hotkey the parser rejects surfaces on the toast (SUB-651)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();

  await page.evaluate(() =>
    window.__mockEmit("capture:hotkey-rejected", {
      kind: "invalid",
      typed: "opt+space",
      active: "alt+space",
    })
  );

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Hotkey “opt+space” isn’t valid");
  await expect(toast).toContainText("still using “⌥Space”");
});

test("a hotkey the OS refuses surfaces on the toast (SUB-651)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();

  await page.evaluate(() =>
    window.__mockEmit("capture:hotkey-rejected", {
      kind: "unavailable",
      typed: "cmd+j",
      active: "alt+shift+space",
    })
  );

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Hotkey “⌘J” is taken by another app");
  await expect(toast).toContainText("still using “⌥⇧Space”");
});

test("a refused hotkey with nothing registered says so (SUB-651)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();

  await page.evaluate(() =>
    window.__mockEmit("capture:hotkey-rejected", {
      kind: "invalid",
      typed: "ctl+j",
      active: "",
    })
  );

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("quick capture has no working hotkey");
});
