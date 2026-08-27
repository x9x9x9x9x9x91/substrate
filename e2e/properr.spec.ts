import { expect, test, type Page } from "./fixtures";

// Prop-write failures against the mock backend's failure hook
// (window.__mockFail, installed by src/lib/tauri.ts outside Tauri).
// A failed vault_set_prop used to vanish: the chip editor had already closed,
// the typed value was gone, the rejection unhandled. Now the failure lands on
// the same retry pill as body saves, holding the attempted write so
// the pill's click retries it — and the chip keeps showing the disk truth
// until a write actually lands.

// cold open lands on the Scratch list (Today is a destination) —
// first mock note selected and loaded (same shape as smoke.spec's boot)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("chip edit failure shows the retry pill, click retries and clears (SUB-240)", async ({
  page,
}) => {
  // an unhandled rejection would fire pageerror — the old bug's signature
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  // Welcome is a plain note — its `created` chip edits as plain text
  await page.locator(".chip", { hasText: "created" }).click();
  const input = page.locator(".chip-input");
  await expect(input).toBeVisible();
  await input.fill("2026-07-18");
  await input.press("Enter");

  // the write rejected: the pill surfaces with the engine error as its title,
  // and the chip keeps the disk-known value — nothing claims the write landed
  const pill = page.locator(".save-error");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("save failed");
  await expect(pill).toHaveAttribute("title", /mock failure: vault_set_prop/);
  await expect(page.locator(".chip", { hasText: "created" })).toContainText("Jul 17, 2026");
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const pillRect = await pill.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(pillRect.top).toBeGreaterThanOrEqual(0);
  expect(pillRect.bottom).toBeLessThanOrEqual(620);

  // hook cleared: the pill IS the retry — the held write lands, the pill
  // clears, the chip re-renders from the mock store
  await page.evaluate(() => window.__mockFail.clear());
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(page.locator(".chip", { hasText: "created" })).toContainText("Jul 18, 2026");

  expect(pageErrors).toEqual([]);
});
