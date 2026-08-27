import { expect, test } from "./fixtures";

// Enter on a bare key in the + property input is a commit gesture mid-format,
// not a cancel: the draft used to be discarded silently — the one lane where
// the user is still learning the `key: value` shape ate their typing. Now the
// draft morphs to `key: ` and stays open so the value types in place.
// Escape and blur keep their cancel semantics.

async function openNote(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
}

test("bare key + Enter morphs to `key: ` and commits with the value (SUB-1213)", async ({
  page,
}) => {
  await openNote(page);

  await page.locator(".chip-add").click();
  const input = page.locator(".chip-input");
  await input.fill("est_price");
  await input.press("Enter");

  // still open, morphed — not discarded
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("est_price: ");

  await input.pressSequentially("~€500");
  await input.press("Enter");
  await expect(page.locator(".chip-input")).toHaveCount(0);
  const chip = page.locator(".chip", { hasText: "est_price" });
  await expect(chip).toContainText("~€500");

  // the `key:` (trailing colon, empty value) variant morphs the same way
  await page.locator(".chip-add").click();
  await input.fill("condition:");
  await input.press("Enter");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("condition: ");

  // a draft that opens with a colon is a mistyped key, not a key named ":".
  // It used to fold the whole draft into the key and re-append ": " on every
  // Enter (":foo" → ":foo: " → ":foo:: "), so the draft never reached a
  // committable shape.
  await input.fill(":foo");
  await input.press("Enter");
  await expect(input).toHaveValue("foo: ");
  await input.press("Enter");
  await expect(input).toHaveValue("foo: ");

  // Escape still cancels the whole draft
  await input.press("Escape");
  await expect(page.locator(".chip-input")).toHaveCount(0);
  await expect(page.locator(".chip", { hasText: "condition" })).toHaveCount(0);

  // blur still cancels a bare key (only Enter morphs)
  await page.locator(".chip-add").click();
  await input.fill("loose_end");
  await page.locator(".note-title").click();
  await expect(page.locator(".chip-input")).toHaveCount(0);
  await expect(page.locator(".chip", { hasText: "loose_end" })).toHaveCount(0);
});
