import { expect, test } from "@playwright/test";

test("Search exposes one input-owned listbox and opens the active match", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Search/ }).click();

  const input = page.getByRole("combobox", { name: "Search everything" });
  await input.fill("lisbon");
  const listbox = page.getByRole("listbox", { name: "Search results" });
  const note = listbox.getByRole("option", { name: /Open Gero at first match/ });
  const match = listbox.getByRole("option", { name: /Open Gero at line 1:.*Lisbon/ });

  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));
  await expect(input).toHaveAttribute("aria-activedescendant", await note.getAttribute("id"));
  await expect(note).toHaveAttribute("aria-selected", "true");
  await expect(listbox.locator("[tabindex]")).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", await match.getAttribute("id"));
  await expect(match).toHaveAttribute("aria-selected", "true");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Gero");
});

test("command palette announces sections and tracks its active result across stages", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.keyboard.press("Meta+k");

  const input = page.getByRole("combobox", { name: "Command palette" });
  await input.fill("vessel");
  const listbox = page.getByRole("listbox", { name: "Command palette results" });
  const notes = listbox.getByRole("group", { name: "Notes" });
  const vessel = notes.getByRole("option", { name: "Vessel Songs, Release" });
  const master = notes.getByRole("option", { name: "Master Vessel Songs v3, Task" });

  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));
  await expect(input).toHaveAttribute("aria-activedescendant", await vessel.getAttribute("id"));
  await expect(listbox.getByRole("group", { name: "Search" })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Commands" })).toBeVisible();
  await expect(listbox.locator("[tabindex]")).toHaveCount(0);

  // Content matches arrive after the synchronous note and command rows. A
  // selected command must stay selected when that section is inserted ahead
  // of it rather than silently transferring to the same numeric row index.
  await input.fill("lisbon");
  const searchAll = listbox
    .getByRole("group", { name: "Search" })
    .getByRole("option", { name: /See all results for “lisbon”/ });
  await searchAll.hover();
  await expect(searchAll).toHaveAttribute("aria-selected", "true");
  await expect(listbox.getByRole("group", { name: "Content" })).toBeVisible();
  await expect(searchAll).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", await searchAll.getAttribute("id"));

  await input.hover();
  await input.fill("vessel");
  await expect(vessel).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      input.evaluate((el) => {
        const id = el.getAttribute("aria-activedescendant");
        return id ? document.getElementById(id)?.getAttribute("aria-label") : null;
      })
    )
    .toContain("Vessel Songs");

  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", await master.getAttribute("id"));
  await expect(master).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Master Vessel Songs v3");

  // Capture is an ordinary textbox with no result popup, not a false empty
  // combobox announced to assistive technology.
  await page.keyboard.press("Meta+n");
  const capture = page.getByRole("textbox", { name: "Capture note title" });
  await expect(capture).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Command palette results" })).toHaveCount(0);
});

test("phone Search and palette composites stay within their established geometry", async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".side-item", { hasText: /^Search/ }).click();
  const search = page.getByRole("combobox", { name: "Search everything" });
  await search.fill("lisbon");
  const searchBox = page.getByRole("listbox", { name: "Search results" });
  const searchGeometry = await searchBox.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, overflow: el.scrollWidth - el.clientWidth };
  });
  expect(searchGeometry.left).toBeGreaterThanOrEqual(0);
  expect(searchGeometry.right).toBeLessThanOrEqual(390);
  expect(searchGeometry.overflow).toBeLessThanOrEqual(0);

  await page.keyboard.press("Meta+k");
  const paletteInput = page.getByRole("combobox", { name: "Command palette" });
  await paletteInput.fill("vessel");
  const palette = page.locator(".palette");
  const paletteGeometry = await palette.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, overflow: el.scrollWidth - el.clientWidth };
  });
  expect(paletteGeometry.left).toBeGreaterThanOrEqual(8);
  expect(paletteGeometry.right).toBeLessThanOrEqual(382);
  expect(paletteGeometry.width).toBeGreaterThanOrEqual(360);
  expect(paletteGeometry.overflow).toBeLessThanOrEqual(0);
  await expect(paletteInput).toBeFocused();
  await page.close();
});
