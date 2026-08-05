import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator('.list .row[data-path="Welcome.md"]').click();
});

test("vault time travel swaps the whole read projection and returns to live state", async ({
  page,
}) => {
  const liveBody = await page.evaluate(() => window.__mockBodyOf!("Welcome.md"));
  await page.getByRole("button", { name: "Browse the vault's past" }).click();
  const bar = page.getByRole("region", { name: "Vault time travel" });
  await expect(bar).toBeVisible();

  // The handle opens on the NEWEST snapshot, not the oldest — the
  // bar mounts before the snapshot list resolves, and it used to stay at 0.
  const slider = bar.getByRole("slider", { name: "Vault snapshot" });
  await expect(slider).toHaveAttribute("max", "2");
  await expect(slider).toHaveValue("2");

  await slider.fill("0");
  await bar.getByRole("button", { name: "View" }).click();
  await expect(page.locator(".app")).toHaveClass(/viewing-past/);
  await expect(bar).toContainText("Viewing the vault as of");
  await expect(bar.getByRole("button", { name: "Restore this note" })).toBeVisible();

  const oldRendered = await page.locator(".cm-content").innerText();
  expect(oldRendered.trim().length).toBeGreaterThan(0);
  expect(oldRendered, "the historical editor is not today's body").not.toContain(liveBody.trim());

  // Typing must not even reach the buffer — the app-root input guard
  // missed CodeMirror's own keymap commands, and the mutated past body then
  // rode orphanedEdits onto the live file.
  await page.locator(".cm-content").click();
  await page.keyboard.type("MUST-NOT-LAND");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  expect(await page.locator(".cm-content").innerText()).toBe(oldRendered);
  expect(await page.evaluate(() => window.__mockBodyOf!("Welcome.md"))).toBe(liveBody);

  await bar.getByRole("button", { name: "Return to present" }).click();
  await expect(page.locator(".app")).not.toHaveClass(/viewing-past/);
  await expect.poll(() => page.evaluate(() => window.__mockBodyOf!("Welcome.md"))).toBe(liveBody);
  await expect(page.locator(".cm-content")).toContainText(
    "Everything here is a plain markdown file on disk"
  );
});

test("restore this note writes the selected historical blob on top", async ({ page }) => {
  const liveBody = await page.evaluate(() => window.__mockBodyOf!("Welcome.md"));
  await page.getByRole("button", { name: "Browse the vault's past" }).click();
  const bar = page.getByRole("region", { name: "Vault time travel" });
  await expect(bar.getByRole("slider", { name: "Vault snapshot" })).toHaveValue("2");
  await bar.getByRole("slider", { name: "Vault snapshot" }).fill("0");
  await bar.getByRole("button", { name: "View" }).click();
  const historicalBody = await page.locator(".cm-content").innerText();

  await bar.getByRole("button", { name: "Restore this note" }).click();

  await expect(page.locator(".app")).not.toHaveClass(/viewing-past/);
  await expect(page.getByText("Restored Welcome", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__mockBodyOf!("Welcome.md"))).not.toBe(liveBody);
  await expect.poll(() => page.locator(".cm-content").innerText()).toBe(historicalBody);
});
