import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";
import { applyFakeToday } from "./clock";

function propertyRow(page: Page, key: string) {
  return page.locator(".prop-row.chip").filter({
    has: page.locator(".chip-key", { hasText: key }),
  });
}

async function openRelease(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
}

test("property controls expose native actions and an announced relation picker", async ({ page }) => {
  await openRelease(page);

  const status = page.getByRole("button", { name: "Edit status: in review" });
  const removeStatus = page.getByRole("button", { name: "Remove status property" });
  const relation = page.getByRole("button", { name: "Edit contact relations: Gero" });

  await expect(page.getByRole("button", { name: "Change database from release" })).toBeVisible();
  await expect(page.locator(".prop-rows").getByRole("button", { name: "Add property" })).toBeVisible();
  await expect(page.locator(".prop-rows :is(button, a) :is(button, a)")).toHaveCount(0);

  // Every row's primary action and separate remove action are genuine tab
  // stops. The visually quiet remove control reveals itself when reached.
  await status.focus();
  await page.keyboard.press("Tab");
  await expect(removeStatus).toBeFocused();
  await expect(removeStatus).toHaveCSS("opacity", "1");

  await relation.focus();
  await page.keyboard.press("Enter");
  const combo = page.getByRole("combobox", { name: "Pick a contact" });
  const listbox = page.getByRole("listbox", { name: "contact relations" });
  await expect(combo).toBeFocused();
  await expect(combo).toHaveAttribute("aria-controls", await listbox.getAttribute("id"));

  const firstActive = await combo.getAttribute("aria-activedescendant");
  expect(firstActive).toBeTruthy();
  await page.keyboard.press("ArrowDown");
  const secondActive = await combo.getAttribute("aria-activedescendant");
  expect(secondActive).not.toBe(firstActive);
  await expect(page.locator(`[id="${secondActive}"]`)).toContainText("Gero");
  await expect(page.getByRole("option", { name: /Gero/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  // Toggling the sole value removes the property, so its owning row and menu
  // close together after the successful keyboard commit.
  await expect(propertyRow(page, "contact")).toHaveCount(0);
  await expect(listbox).toHaveCount(0);

  // A missing local file opens its editor rather than the OS, so its name
  // must describe that action once the existence probe resolves.
  await page
    .locator(".db-table tbody tr", { hasText: "Vessel Songs" })
    .locator(".db-title")
    .dblclick();
  await expect(page.getByRole("button", { name: "Edit contract: missing contract.pdf" })).toBeVisible();
});

test("the remove control deletes the property on pointer click (SUB-399)", async ({ page }) => {
  await openRelease(page);

  // The × only accepts pointer events once the row is hovered; the click must
  // land on the remove button, not fall through to the row's edit overlay.
  const row = propertyRow(page, "status");
  await row.hover();
  await page.getByRole("button", { name: "Remove status property" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(page.locator(".chip-input")).toHaveCount(0);
});

test("relation values open the exact note from the keyboard", async ({ page }) => {
  await openRelease(page);
  const gero = page.getByRole("button", { name: "Open related note Gero" });
  await gero.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Gero");
});

test("checkbox and URL properties retain their distinct keyboard semantics", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  await page
    .locator(".db-table tbody tr", { hasText: "Aeon Driftbox" })
    .locator(".db-title")
    .dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Aeon Driftbox");

  const toggle = page.getByRole("button", { name: "in use: checked. Toggle" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(propertyRow(page, "in use")).toHaveCount(0);

  const link = page.getByRole("link", { name: /Open link: aeon\.audio\/driftbox/ });
  await expect(link).toHaveAttribute("href", "https://www.aeon.audio/driftbox");
  await expect(page.getByRole("button", { name: "Remove link property" })).toBeAttached();
  await link.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".selmenu")).toContainText("https://www.aeon.audio/driftbox");
});

test("phone property actions keep the established full-width row geometry", async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await applyFakeToday(page);
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .dblclick();

  const row = propertyRow(page, "contact");
  const primary = page.getByRole("button", { name: "Edit contact relations: Gero" });
  const geometry = await row.evaluate((el) => {
    const action = el.querySelector(".chip-primary");
    if (!(action instanceof HTMLElement)) throw new Error("missing primary action");
    const r = el.getBoundingClientRect();
    const a = action.getBoundingClientRect();
    return {
      row: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      action: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
      overflow: el.scrollWidth - el.clientWidth,
    };
  });
  expect(geometry.action).toEqual(geometry.row);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  await expect(primary).toBeVisible();
  await page.close();
});
