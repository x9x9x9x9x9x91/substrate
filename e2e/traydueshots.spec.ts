import { expect, test } from "@playwright/test";

// Throwaway evidence run that photographs the tray popover with a completed
// task before and after the fix — not a gate.
//   SHOTS=1 npx playwright test e2e/traydueshots.spec.ts
// One pass, not a light/dark pair: styles.css carries no prefers-color-scheme
// block and the app has no theme switch, so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = "/tmp/sub1279-shots";
const TASK = "Tasks/Ship the patron download codes.md";

test("shot: the tray agenda with a completed task", async ({ page }) => {
  // the real popover window size (AGENDA_WIDTH 340)
  await page.setViewportSize({ width: 340, height: 480 });
  await page.goto("/agenda.html");
  await expect(page.locator(".palette")).toBeVisible();
  const row = page.locator(".agenda-list .agenda-row", {
    has: page.locator(".agenda-title", { hasText: "Ship the patron download codes" }),
  });
  await expect(row).toHaveCount(1);

  // before: the task is still open, so the yellow due dot is correct here
  await page.screenshot({ path: `${OUT}/tray-todo.png` });

  await page.evaluate((p) => {
    window.__mockEditProp?.(p, "status", "done");
    window.__mockEmit?.("vault:changed", [p]);
  }, TASK);
  await expect(row).toHaveClass(/done/);
  // let the 120ms colour fade settle before the shutter
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/tray-done.png` });

  // …and the same row while it IS the selection, to check the dim survives the
  // hover/selected wash rather than being repainted to the live tone
  for (let i = 0; i < 20 && !(await row.getAttribute("class"))?.includes("selected"); i++)
    await page.keyboard.press("ArrowDown");
  await expect(row).toHaveClass(/selected/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/tray-done-selected.png` });
});
