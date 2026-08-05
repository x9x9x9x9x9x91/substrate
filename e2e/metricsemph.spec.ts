import { expect, test, type Page } from "@playwright/test";

// Contrast discipline on metrics cards (design principle 11): at most
// two cards keep the sharp voice, chosen by `emph: true` in the note's
// frontmatter — never by position. Fixture: Dashboards/Portfolio.md
// (src/lib/tauri.ts) flags Total value + Grand total out of seven cards.

async function openPortfolio(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");
}

const cardByLabel = (page: Page, label: string) =>
  page.locator(".metrics-cards .dash-card", {
    has: page.locator(".dash-label", { hasText: new RegExp(`^${label}$`) }),
  });

const valueColor = (page: Page, label: string) =>
  cardByLabel(page, label)
    .locator(".dash-card-eur")
    .evaluate((el) => getComputedStyle(el).color);

const labelColor = (page: Page, label: string) =>
  cardByLabel(page, label)
    .locator(".dash-label")
    .evaluate((el) => getComputedStyle(el).color);

test("the two flagged cards stay sharp, the rest sink (SUB-578)", async ({ page }) => {
  await openPortfolio(page);
  await expect(page.locator(".metrics-cards .dash-card")).toHaveCount(7);

  // the seed flags exactly two: they carry no .sunk, everything else does
  await expect(cardByLabel(page, "Total value")).not.toHaveClass(/sunk/);
  await expect(cardByLabel(page, "Grand total")).not.toHaveClass(/sunk/);
  await expect(page.locator(".metrics-cards .dash-card.sunk")).toHaveCount(5);

  // and the class actually changes what the eye sees — value and label both
  const sharpVal = await valueColor(page, "Total value");
  const sunkVal = await valueColor(page, "Crypto");
  expect(sharpVal).not.toBe(sunkVal);
  const sharpLabel = await labelColor(page, "Total value");
  const sunkLabel = await labelColor(page, "Crypto");
  expect(sharpLabel).not.toBe(sunkLabel);

  // both flagged cards read identically — emphasis is a voice, not a rank
  expect(await valueColor(page, "Grand total")).toBe(sharpVal);
});

test("more than two flags cap at the first two in card order (SUB-578)", async ({ page }) => {
  // flag four cards before the pane opens; card order is frontmatter order,
  // so Total value and Crypto win and the later two sink despite the flag
  await page.goto("/");
  await page.evaluate(() => {
    const cards = (
      window.__mockPropOf!("Dashboards/Portfolio.md", "cards") as Record<string, unknown>[]
    ).map((c) =>
      ["Total value", "Crypto", "ETF", "Grand total"].includes(c.label as string)
        ? { ...c, emph: true }
        : c
    );
    window.__mockEditProp!("Dashboards/Portfolio.md", "cards", cards);
  });
  // no second goto — a reload rebuilds the mock store and drops the staging
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Portfolio");

  await expect(page.locator(".metrics-cards .dash-card.sunk")).toHaveCount(5);
  await expect(cardByLabel(page, "Total value")).not.toHaveClass(/sunk/);
  await expect(cardByLabel(page, "Crypto")).not.toHaveClass(/sunk/);
  await expect(cardByLabel(page, "ETF")).toHaveClass(/sunk/);
  await expect(cardByLabel(page, "Grand total")).toHaveClass(/sunk/);
});

test("a board that flags nothing still anchors on its first card (SUB-578)", async ({ page }) => {
  // Label Books' single card carries no flag — the default keeps it sharp
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();
  const card = page.locator(".metrics-cards .dash-card");
  await expect(card).toHaveCount(1);
  await expect(card).not.toHaveClass(/sunk/);
});
