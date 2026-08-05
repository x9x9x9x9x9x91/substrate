import { expect, test, type Page } from "@playwright/test";

// The select and file pickers are input-owned composites — one
// combobox tab stop, options referenced via aria-activedescendant, no
// focusable rows inside the popup. Same contract RelationMenu established.

async function openRelease(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
}

test("select picker exposes an input-owned listbox and keyboard commit works", async ({ page }) => {
  await openRelease(page);

  await page.getByRole("button", { name: "Edit status: in review" }).click();
  const combo = page.getByRole("combobox", { name: "Pick status" });
  const listbox = page.getByRole("listbox", { name: "Pick status options" });
  await expect(combo).toBeFocused();
  await expect(combo).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));
  await expect(listbox.locator("[tabindex]")).toHaveCount(0);

  // opens highlighting the current value, exposed through the active option
  const current = listbox.getByRole("option", { name: /in review/ });
  await expect(combo).toHaveAttribute("aria-activedescendant", await current.getAttribute("id"));
  await expect(current).toHaveAttribute("aria-selected", "true");

  // arrows move the active option without moving DOM focus
  await page.keyboard.press("ArrowDown");
  const next = await combo.getAttribute("aria-activedescendant");
  expect(next).not.toBe(await current.getAttribute("id"));
  await expect(combo).toBeFocused();

  // Enter commits the active option (mastering follows in review)
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Edit status: mastering" })).toBeVisible();
});

test("multi-select keeps the listbox multiselectable and toggles stay open", async ({ page }) => {
  await openRelease(page);

  await page.getByRole("button", { name: "Edit format: Vinyl" }).click();
  const combo = page.getByRole("combobox", { name: "Pick format" });
  const listbox = page.getByRole("listbox", { name: "Pick format options" });
  await expect(listbox).toHaveAttribute("aria-multiselectable", "true");
  await expect(listbox.getByRole("option", { name: /Vinyl/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(listbox.getByRole("option", { name: /Digital/ })).toHaveAttribute(
    "aria-selected",
    "false"
  );

  // toggling membership keeps the menu open and flips aria-selected live
  const digital = listbox.getByRole("option", { name: /Digital/ });
  await digital.hover();
  await expect(combo).toHaveAttribute("aria-activedescendant", await digital.getAttribute("id"));
  await page.keyboard.press("Enter");
  await expect(listbox.getByRole("option", { name: /Digital/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Edit format: Vinyl, Digital/ })).toBeVisible();
});

test("file menu is a named composite whose actions ride the input", async ({ page }) => {
  await openRelease(page);

  // an empty file prop opens the menu rather than the OS
  await page
    .locator(".db-table tbody tr", { hasText: "Vessel Songs" })
    .locator(".db-title")
    .click();
  await page.getByRole("button", { name: "Edit contract: missing contract.pdf" }).click();

  const combo = page.getByRole("combobox", { name: "File path" });
  const listbox = page.getByRole("listbox", { name: "File actions" });
  await expect(combo).toBeFocused();
  await expect(combo).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));
  await expect(listbox.locator("[tabindex]")).toHaveCount(0);

  const choose = listbox.getByRole("option", { name: "Choose file…" });
  await expect(combo).toHaveAttribute(
    "aria-activedescendant",
    await listbox.getByRole("option").first().getAttribute("id")
  );
  await choose.hover();
  await expect(combo).toHaveAttribute("aria-activedescendant", await choose.getAttribute("id"));

  // Enter on the active action runs it — the mock dialog returns a real path
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /Edit contract: Mastering notes\.pdf|Open contract: Mastering notes\.pdf/ })
  ).toBeVisible();

  // typing a path still beats the action rows on Enter
  await page.getByRole("button", { name: /contract: Mastering notes\.pdf/ }).click({ button: "right" });
  const combo2 = page.getByRole("combobox", { name: "File path" });
  await combo2.fill("~/Music/masters/static-bouquet.wav");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /contract: static-bouquet\.wav/ })
  ).toBeVisible();
});

test("schema-edit relation target rows are an input-owned listbox", async ({ page }) => {
  await openRelease(page);

  await page.getByRole("button", { name: "Edit contact relations: Gero" }).click();
  // relation picker → Property type… opens the schema editor
  await page.getByRole("option", { name: "Property type…" }).click();
  await page.getByRole("button", { name: "Relation" }).click();

  const combo = page.getByRole("combobox", { name: "Target database" });
  const listbox = page.getByRole("listbox", { name: "Target databases" });
  await expect(combo).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));
  await expect(listbox.locator("[tabindex]")).toHaveCount(0);

  // the current target (contact) opens as the active option
  const contact = listbox.getByRole("option", { name: "contact" });
  await expect(combo).toHaveAttribute("aria-activedescendant", await contact.getAttribute("id"));
  await expect(contact).toHaveAttribute("aria-selected", "true");

  // arrows walk the rows; Enter adopts the active row into the input
  await combo.click();
  await page.keyboard.press("ArrowDown");
  const nextId = await combo.getAttribute("aria-activedescendant");
  expect(nextId).not.toBe(await contact.getAttribute("id"));
  await page.keyboard.press("Enter");
  const adopted = await page.locator(`[id="${nextId}"] .selmenu-val`).textContent();
  await expect(combo).toHaveValue(adopted ?? "");
  await page.keyboard.press("Escape");
});

test("phone select picker keeps its geometry inside the viewport", async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .click();
  await page.getByRole("button", { name: "Edit status: in review" }).click();
  const listbox = page.getByRole("listbox", { name: "Pick status options" });
  const geometry = await listbox.evaluate((el) => {
    const menu = el.closest(".selmenu");
    if (!(menu instanceof HTMLElement)) throw new Error("selmenu missing");
    const r = menu.getBoundingClientRect();
    return { left: r.left, right: r.right, overflow: el.scrollWidth - el.clientWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  await page.close();
});
