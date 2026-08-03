import { expect, test } from "@playwright/test";

test("external ICS subscriptions render read-only and toggle per feed (SUB-821)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  await page.getByRole("button", { name: "Calendars", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "External calendars" });
  await expect(dialog.getByText("No external calendars yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Add URL…" }).click();
  await dialog.getByLabel("Name").fill("Team");
  await dialog.getByLabel("URL or local .ics path").fill("https://example.test/team.ics");
  await dialog.getByRole("button", { name: "Add calendar" }).click();

  const subscription = dialog.locator(".cal-feed-row", { hasText: "Team" });
  await expect(subscription).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  const event = page
    .locator(".cal-grid.month")
    .locator('[aria-label="Team appointment, external calendar Team"]');
  await expect(event).toBeVisible();
  await expect(event).toHaveClass(/external/);
  await expect(event).not.toHaveAttribute("draggable", "true");
  await expect(event.locator("button, input, [role=button]")).toHaveCount(0);
  await page.getByRole("button", { name: "Calendars", exact: true }).click();
  await dialog.getByRole("switch", { name: "Hide Team" }).click();
  await expect(dialog.getByRole("switch", { name: "Show Team" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(event).toHaveCount(0);
});
