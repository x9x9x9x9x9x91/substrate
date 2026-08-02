import { expect, test } from "@playwright/test";

// Rendered markdown tables honor inline marks in cells (SUB-201): the Welcome
// seed's table carries a wikilink and a **bold** status cell — the block
// widget must render both, not show literal asterisks.

test("rendered table cells: bold renders, wikilink still follows (SUB-201)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();

  // the **live** cell renders as a real <strong>, no asterisks anywhere
  await expect(table.locator("td strong", { hasText: "live" })).toHaveCount(1);
  await expect(table).not.toContainText("**");

  // wikilink cells keep their follow behavior alongside the new marks
  await table.locator(".cm-wikilink", { hasText: "Static Bouquet" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Static Bouquet");
});
