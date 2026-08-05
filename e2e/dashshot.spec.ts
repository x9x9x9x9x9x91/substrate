import { test } from "@playwright/test";

// Throwaway visual check for the dashboard folders — not a gate.
//   SHOTS=1 npx playwright test e2e/dashshot.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

test("sidebar dashboard groups", async ({ page }) => {
  await page.goto("/");
  const side = page.locator(".sidebar");
  await side.screenshot({ path: "/tmp/dash-shots/group-open.png" });
  await page.locator(".side-folder", { hasText: "Releases" }).locator(".side-chevron").click();
  await side.screenshot({ path: "/tmp/dash-shots/group-closed.png" });
  await page.locator(".side-folder", { hasText: "Releases" }).locator(".side-chevron").click();

  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.getByRole("button", { name: "Overview", exact: true }).dispatchEvent("dragstart", { dataTransfer: dt });
  const group = page.locator(".side-folder", { hasText: "Releases" });
  await group.dispatchEvent("dragover", { dataTransfer: dt });
  await side.screenshot({ path: "/tmp/dash-shots/drop-hover.png" });
  await group.dispatchEvent("drop", { dataTransfer: dt });
  await side.screenshot({ path: "/tmp/dash-shots/after-move.png" });

  await page.getByRole("button", { name: "Label Health", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to folder…" }).click();
  await page.screenshot({ path: "/tmp/dash-shots/move-picker.png" });
});
