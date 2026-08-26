import { expect, test } from "./fixtures";

// Evidence run only, not a gate: the search pane answering with a picture, and
// the picture opened where it was found.
//   SHOTS=1 npx playwright test e2e/ocrshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/lane-reports/shots-1301";

test("shot: the hit list and the opened picture", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await page.locator(".search-input").fill("4711");
  const group = page.locator(".search-group", { hasText: "invoice-4711" });
  await expect(group).toHaveCount(1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/hitlist-dark.png`, fullPage: false });

  await group.locator(".search-note-row").click();
  await expect(page.locator(".search-image-text mark").first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/opened-dark.png`, fullPage: false });
  await page.locator(".search-image").screenshot({ path: `${dir}/opened-detail-dark.png` });
});

// The app ships one ground: the dark ramp in styles.css, with no
// prefers-color-scheme or theme attribute anywhere. The only light surface is
// the note→PDF pass, and it hides `#root` outright to put one note on paper —
// the search pane is not on it by design. So the panel's second look is not a
// second palette but a second shape: longer recognized text in a narrower
// window, where a fixed picture column and a wrapping text column would clip.
test("shot: a longer recognition in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await page.locator(".search-input").fill("mixdown");
  const group = page.locator(".search-group", { hasText: "studio-whiteboard" });
  await expect(group).toHaveCount(1);
  await group.locator(".search-note-row").click();
  await expect(page.locator(".search-image-text mark").first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/opened-narrow.png`, fullPage: false });
  await page.locator(".search-image").screenshot({ path: `${dir}/opened-detail-narrow.png` });
});
