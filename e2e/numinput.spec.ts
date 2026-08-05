import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// German-typed numbers (SUB-636): the app RENDERS de-DE ("1.234,56 €") but
// stored values and every parser are canonical dot-decimal. Typing back what
// the app shows used to fail silently in two directions — "1.234" read as
// 1.234 (a 1000× corruption that still looked like money) and "1.234,56"
// matched no parser at all (no € suffix, skipped by Sum while count counted
// the row). commitCell now normalizes number-KIND text at the boundary, so
// the value round-trips through the app's own display.

async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

test("number cell: German-typed value round-trips through the app's own display", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Inventory");

  const price = await colIndex(page, "price");
  const row = () =>
    page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  const cell = () => row().locator("td").nth(price);

  // full de-DE shape: dot grouping + comma decimal
  await cell().click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("1.234,56");
  await input.press("Enter");
  // Enter now carries the editor to the row below (SUB-947); Escape leaves it
  await page.keyboard.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  // stored canonical → rendered back in the dialect it was typed in
  await expect(cell()).toHaveText("1.234,56 €");
  // …and the raw stored value the editor prefills is dot-decimal
  await cell().click();
  await expect(page.locator(".selmenu .selmenu-input")).toHaveValue("1234.56");
  await page.locator(".selmenu .selmenu-input").press("Escape");

  // grouping alone resolves de: "1.234" means one thousand two hundred
  // thirty-four, not 1,23 €
  await cell().click();
  await page.locator(".selmenu .selmenu-input").fill("1.234");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await page.keyboard.press("Escape");
  await expect(cell()).toHaveText("1.234 €");

  // comma decimal alone
  await cell().click();
  await page.locator(".selmenu .selmenu-input").fill("12,5");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await page.keyboard.press("Escape");
  await expect(cell()).toHaveText("12,5 €");

  // en-style input still works untouched
  await cell().click();
  await page.locator(".selmenu .selmenu-input").fill("1234.56");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await page.keyboard.press("Escape");
  await expect(cell()).toHaveText("1.234,56 €");
});

test("a German-typed price lands in the footer Sum, not beside it", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");

  // Sum over price: 11 numeric fixture rows (one junk "ask", three empty)
  await page.locator(".db-table th", { hasText: "price" }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Calculate…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: /^Sum$/ }).click();
  const sum = page.locator('.db-agg-cell[data-col="price"] .db-agg-value');
  await expect(sum).toHaveText("13.424,5 €");

  // retype Nordvik One (336) in the app's own dialect. Pre-fix this dropped
  // out of the sum entirely — 1.234,56 matched no parser, so the footer read
  // 13.088,50 € while the row still counted.
  const price = await colIndex(page, "price");
  const cell = page
    .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) })
    .locator("td")
    .nth(price);
  await cell.click();
  await page.locator(".selmenu .selmenu-input").fill("1.234,56");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await expect(cell).toHaveText("1.234,56 €");
  // 13424.5 - 336 + 1234.56
  await expect(sum).toHaveText("14.323,06 €");
});

test("an en-US locale reaches table cells, totals, board cards and gallery cards", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radiogroup", { name: "Number format" })
    .getByRole("radio", { name: /en-US/ })
    .click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Make a default card-subtitle property numeric so the same value is
  // observable in every database layout without changing production seeds.
  await page.evaluate(() => {
    window.__mockEditSchema?.("inventory", {
      status: { options: [] },
      category: { options: [], kind: "number", format: "euro" },
      price: { options: [], kind: "number", format: "euro" },
    });
    window.__mockEditProp?.("Nordvik One.md", "category", "1234.56");
    window.__mockEmit?.("vault:config-changed");
    window.__mockEmit?.("vault:changed", ["Nordvik One.md"]);
  });
  await openDb(page, "Inventory");

  const category = await colIndex(page, "category");
  const nordvik = () =>
    page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  await expect(nordvik().locator("td").nth(category)).toHaveText("1,234.56 €");

  // …and the reader follows the dial too, not just the renderer: under en-US
  // the comma groups and the dot decides the decimal, the exact mirror of the
  // German case above. Without this the dial would be half a seam — the app
  // would print 1,234.56 and then read the same text back as 1.23456.
  const price = await colIndex(page, "price");
  const priceCell = () => nordvik().locator("td").nth(price);
  await priceCell().click();
  const enInput = page.locator(".selmenu .selmenu-input");
  await enInput.fill("1,234.56");
  await enInput.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(priceCell()).toHaveText("1,234.56 €");
  // the stored value stayed canonical dot-decimal — the editor prefills it raw
  await priceCell().click();
  await expect(page.locator(".selmenu .selmenu-input")).toHaveValue("1234.56");
  await page.locator(".selmenu .selmenu-input").press("Escape");
  // grouping alone under en-US means one thousand, not 1.234
  await priceCell().click();
  await page.locator(".selmenu .selmenu-input").fill("1,234");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await page.keyboard.press("Escape");
  await expect(priceCell()).toHaveText("1,234 €");

  await page.locator(".db-table th", { hasText: "category" }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Calculate…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: /^Sum$/ }).click();
  await expect(page.locator('.db-agg-cell[data-col="category"] .db-agg-value')).toHaveText(
    "1,234.56 €"
  );

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator('.db-card[aria-label="Nordvik One"] .row-sub')).toContainText(
    "1,234.56 €"
  );
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.locator('.db-gcard[aria-label="Nordvik One"] .row-sub')).toContainText(
    "1,234.56 €"
  );
});

test("note property chips normalize German-typed numbers too", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  await page.locator(".db-title-txt", { hasText: "Falke F-3" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Falke F-3");

  const chip = page.locator(".chip", { hasText: "price" });
  await expect(chip.locator(".chip-val")).toHaveText("1.295 €");

  // the chip's overlay button is the affordance; .chip-val is aria-hidden
  await chip.locator(".chip-primary").click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("2.499,90");
  await input.press("Enter");
  // stored canonical → the chip re-renders through formatNumber (which drops
  // the trailing zero, like every other euro cell)
  await expect(chip.locator(".chip-val")).toHaveText("2.499,9 €");
});

test("non-number cells keep dotted/comma text verbatim", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");

  const acquired = await colIndex(page, "acquired");
  const cell = () =>
    page
      .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Monocord 64" }) })
      .locator("td")
      .nth(acquired);

  await cell().click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("1.234,56");
  await input.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("1.234,56");
});
