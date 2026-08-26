import { expect, test, type Page } from "./fixtures";

// Narrowing a search used to land the selection on the LAST surviving
// row instead of the top hit, so Enter opened a note the user never picked.
//
// The cause is two effects firing in one commit: `query` changing resets the
// selection to 0, while the row-count clamp captured the pre-reset selection
// and pinned it to `rows.length - 1`. The clamp ran second and won. Any way of
// getting the selection above 0 arms it — arrow keys or hover alike — so the
// keyboard case below is the real guard and the pointer case is the same bug
// reached through the mouse.

async function openSearch(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
}

test("narrowing a search after arrowing down selects the top result", async ({ page }) => {
  await openSearch(page);
  const input = page.locator(".search-input");
  const list = page.locator(".search-results");

  // pointer parked far from the list — this case is keyboard-only
  await page.mouse.move(5, 5);

  await input.fill("the");
  await expect(list.locator('[role="option"]').first()).toBeVisible();
  await expect(list.locator(".search-group")).not.toHaveCount(0);

  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("data-idx", "10");

  // narrowing drops groups; selection belongs at the top hit, not the last row
  await input.fill("the type:contact");
  await expect(list.locator(".search-group")).not.toHaveCount(0);
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("data-idx", "0");
});

test("narrowing a search under a resting cursor selects the top result", async ({ page }) => {
  await openSearch(page);
  const input = page.locator(".search-input");
  const list = page.locator(".search-results");

  await input.fill("the");
  await expect(list.locator('[role="option"]').first()).toBeVisible();
  await expect(list.locator(".search-group")).not.toHaveCount(0);

  // park the pointer deep in the list, on a row the filter is about to drop
  const parked = list.locator('[role="option"]').nth(10);
  const box = (await parked.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(parked).toHaveAttribute("aria-selected", "true");

  await input.fill("the type:contact");
  await expect(list.locator(".search-group")).not.toHaveCount(0);
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("data-idx", "0");

  // hover selection still works — the fix is in the clamp, not in hover
  const other = list.locator('[role="option"]').nth(1);
  await other.hover();
  await expect(other).toHaveAttribute("aria-selected", "true");
  await expect(list.locator('[data-idx="0"]')).toHaveAttribute("aria-selected", "false");
});
