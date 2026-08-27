import { expect, test, type Page } from "./fixtures";

// the segmented `.db-switch` idiom is a set of buttons that only
// mean anything together, and it carried no group role or name on any of its
// seven instances. SwitchGroup now owns the container. The unit guard
// (src/components/SwitchGroup.test.ts) proves no raw markup is left; this
// walks the real surfaces and proves the semantics survive rendering — a
// group role with a non-empty accessible name, on every switch each pane
// actually paints.

async function everySwitchIsANamedGroup(page: Page, atLeast: number) {
  const groups = page.locator(".db-switch");
  const n = await groups.count();
  expect(n, "expected switches on this surface").toBeGreaterThanOrEqual(atLeast);
  for (let i = 0; i < n; i++) {
    const g = groups.nth(i);
    await expect(g).toHaveAttribute("role", "group");
    // a name, and one that says what the group chooses rather than repeating
    // a button label
    const label = await g.getAttribute("aria-label");
    expect(label?.trim()).toBeTruthy();
  }
}

test("switch groups: the tasks dashboard names its sort and layout switches", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await expect(page.locator(".dash-title")).toHaveText("Tasks");
  await everySwitchIsANamedGroup(page, 2);
  await expect(page.locator(".tasks-sort")).toHaveAttribute("aria-label", "Order rows by");
  await expect(page.locator(".tasks-view")).toHaveAttribute("aria-label", "Layout");
  // the buttons keep the pressed state they always had — the group names the
  // question, the buttons still answer it
  await expect(page.locator(".tasks-view button", { hasText: /^List$/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("switch groups: the music work switcher is a named group", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Music Work" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Music Work");
  await everySwitchIsANamedGroup(page, 1);
  await expect(page.locator(".mw-views")).toHaveAttribute("aria-label", "View");
});

test("switch groups: the search sort switch is a named group", async ({ page }) => {
  await page.goto("/");
  // the shortcut listener attaches on mount — key too early and it's lost
  await expect(page.locator(".side-item", { hasText: /^Scratch/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  // the sort switch only renders once results exist
  await page.locator(".search-input").fill("lisbon");
  const sort = page.locator(".search-sort");
  await expect(sort).toBeVisible();
  await expect(sort).toHaveAttribute("role", "group");
  await expect(sort).toHaveAttribute("aria-label", "Sort results by");
});
