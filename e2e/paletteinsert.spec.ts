import { expect, test } from "@playwright/test";

// Content matches arrive on a debounce, after the synchronous note
// and command rows. Inserting that section pushes every row below it down —
// and a cursor resting where the user left it is suddenly over a different
// row. The browser fires mouseenter for the row that moved under the pointer,
// which is indistinguishable from a real hover unless you require motion.
//
// The bug this guards: selection silently jumped to whatever slid beneath the
// cursor, so a keyboard user who then pressed Enter opened a note they never
// pointed at, and a screen-reader user heard the active row change on its own.
test("an async result insert under a resting cursor does not steal selection", async ({ page }) => {
  await page.goto("/");
  // The Content batch is HELD, not raced. Its section is inserted ABOVE Search,
  // so a batch that lands between measuring the row and moving onto it shifts
  // that row down and the pointer arrives on a neighbour — the row under test
  // never selects, and the failure reads as the steal this test guards against.
  // Parking the search until the cursor is resting makes the order a fact.
  await page.evaluate(() => window.__mockHoldCommand!("vault_search"));
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.keyboard.press("Meta+k");

  const input = page.getByRole("combobox", { name: "Command palette" });
  const listbox = page.getByRole("listbox", { name: "Command palette results" });

  await input.fill("vessel");
  await expect(listbox.getByRole("group", { name: "Search" })).toBeVisible();

  // Park the pointer on a row while the Content batch is still in flight —
  // moving it after the insert would be a genuine hover and prove nothing.
  const searchAll = listbox
    .getByRole("group", { name: "Search" })
    .getByRole("option", { name: /See all results/ });
  await expect(listbox.getByRole("group", { name: "Content" })).toHaveCount(0);
  const box = (await searchAll.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(searchAll).toHaveAttribute("aria-selected", "true");

  // Release it: the rows now reflow beneath a stationary cursor.
  await page.evaluate(() => window.__mockReleaseCommand!("vault_search"));
  await expect(listbox.getByRole("group", { name: "Content" })).toBeVisible();
  await expect(listbox.getByRole("option", { selected: true })).toHaveCount(1);
  await expect(searchAll).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", await searchAll.getAttribute("id"));

  // Deliberate motion must still select — the fix narrows what counts as a
  // hover, it does not remove hover selection.
  const other = listbox.getByRole("group", { name: "Content" }).getByRole("option").first();
  await other.hover();
  await expect(other).toHaveAttribute("aria-selected", "true");
  await expect(searchAll).toHaveAttribute("aria-selected", "false");
});
