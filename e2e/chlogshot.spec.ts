import { test } from "./fixtures";

// Visual evidence for the changelog pass — not a gate.
//   SHOTS=1 npx playwright test e2e/chlogshot.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

test("what's-new pane", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.goto("/");
  await page.getByRole("button", { name: "What's new" }).click();
  await page.locator(".chlog-release").first().waitFor();
  await page.screenshot({ path: "/tmp/chlog-shots/changelog-wide.png" });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({ path: "/tmp/chlog-shots/changelog-narrow.png" });
});
