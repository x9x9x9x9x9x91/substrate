import { expect, test, type Page } from "@playwright/test";

const namedButton = (page: Page, name: string) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true });

test("sidebar destinations and section toggles are native keyboard controls (SUB-357)", async ({
  page,
}) => {
  await page.goto("/");

  const today = namedButton(page, "Today");
  expect(
    await today.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });
  await today.focus();
  await today.press("Enter");
  await expect(page.locator(".today-pane")).toBeVisible();
  await expect(today).toHaveAttribute("aria-current", "page");

  const hub = namedButton(page, "Umbra Home");
  await hub.focus();
  await hub.press("Space");
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  // Expandable rows expose two sibling controls: disclosure and destination.
  const projects = page.locator(".side-folder", {
    has: page.getByRole("button", { name: "Projects", exact: true }),
  });
  await expect(projects.getByRole("button", { name: "Collapse Projects" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(projects.getByRole("button", { name: "Projects", exact: true })).toHaveCount(1);
  await expect(projects.locator("button button")).toHaveCount(0);

  const calendarFolder = page
    .locator(".side-folder")
    .getByRole("button", { name: "Calendar", exact: true });
  await calendarFolder.focus();
  await calendarFolder.press("Space");
  await expect(page.locator(".list-title")).toHaveText("Calendar");

  const dashboards = namedButton(page, "Dashboards");
  await expect(dashboards).toHaveAttribute("aria-expanded", "true");
  await dashboards.focus();
  await dashboards.press("Space");
  await expect(dashboards).toHaveAttribute("aria-expanded", "false");
  await expect(namedButton(page, "Umbra Home")).toHaveCount(0);
  await dashboards.press("Enter");
  await expect(dashboards).toHaveAttribute("aria-expanded", "true");

  // Pointer-only affordances and fixed shortcuts remain intact.
  await namedButton(page, "Umbra Home").click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Rename…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
});

test.describe("phone sidebar controls", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("keyboard activation navigates and closes the drawer (SUB-357)", async ({ page }) => {
    await page.goto("/");
    await page.locator(".mobile-menu").click();

    const today = namedButton(page, "Today");
    await today.focus();
    await today.press("Enter");
    await expect(page.locator(".today-pane")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();

    await page.locator(".mobile-menu").click();
    const calendarFolder = page
      .locator(".side-folder")
      .getByRole("button", { name: "Calendar", exact: true });
    await calendarFolder.focus();
    await calendarFolder.press("Space");
    await expect(page.locator(".list-title")).toHaveText("Calendar");
    await expect(page.locator(".sidebar")).toBeHidden();
  });
});
