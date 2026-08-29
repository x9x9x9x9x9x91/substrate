import { test, expect } from "./fixtures";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/boot-shots npx playwright test e2e/bootframeshots.spec.ts
// The first frame, in the two waits it exists for, and the app that replaces
// it. The pair is the only way to judge the thing the frame is FOR: its
// sidebar column and pane inset are copies of the real ones, so the shots have
// to be laid side by side to see whether anything moves when content lands.
// Dark only — the app has no runtime light theme, and this is chrome, not a
// pane worth a print pass.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/boot-frame-shots";

test.use({ viewport: { width: 1400, height: 900 } });

test("the frame while boot status is in flight, and the app it hands over to", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__mockBootDelay = 2500;
  });
  await page.goto("/");
  await expect(page.getByTestId("boot-skeleton")).toBeVisible();
  await page.screenshot({ path: `${DIR}/boot-frame-status-wait.png` });

  await expect(page.locator(".side-item").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/boot-frame-handover.png` });
});

test("the frame while the vault index is still building", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockBootScanMs = 2500;
  });
  await page.goto("/");
  await expect(page.getByTestId("boot-skeleton")).toBeVisible();
  await page.screenshot({ path: `${DIR}/boot-frame-indexing.png` });
});
