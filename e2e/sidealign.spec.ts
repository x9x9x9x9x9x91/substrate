import { expect, test, type Page } from "@playwright/test";

// SUB-618: one vertical icon column down the whole rail. Every navigable row in
// the scroll area — the fixed top zone, flat dashboards, grouped-dashboard
// headers, All databases, pins, folder tree — carries the chevron gutter, so a
// row without a twisty still lands its mark in the shared column. Indent is
// purely tree depth: one 14px step per level.

/** Each sidebar row's leading mark x, by label. Chevrons are excluded — the
    mark is the icon after the gutter, whether it's an svg or an emoji span. */
async function marks(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".sidebar-scroll .side-item")].map((el) => {
      const mark = [...el.querySelectorAll("svg, .type-icon-emoji")].find(
        (n) => !n.closest(".side-chevron")
      );
      return {
        label: (el.textContent || "").trim().slice(0, 24),
        x: mark ? mark.getBoundingClientRect().x : -1,
        depth: Math.round((parseFloat(getComputedStyle(el).paddingLeft) - 8) / 14),
      };
    })
  );
}

test("every sidebar row shares one icon column per depth", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Umbra Home", exact: true })).toBeVisible();

  const rows = await marks(page);
  // the seeded vault exercises every builder: fixed rows, flat dashboards, a
  // dashboard group + its nested row, All databases, folders, nested folders
  expect(rows.length).toBeGreaterThan(20);
  expect(rows.some((r) => r.depth === 1)).toBe(true);

  // no row is missing its mark, and rows at one depth share one column
  const byDepth = new Map<number, number[]>();
  for (const r of rows) {
    expect(r.x, `no mark on "${r.label}"`).toBeGreaterThan(0);
    byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r.x]);
  }
  for (const [depth, xs] of byDepth) {
    const spread = Math.max(...xs) - Math.min(...xs);
    const off = rows.filter((r) => r.depth === depth && r.x !== xs[0]).map((r) => r.label);
    expect(spread, `depth ${depth} icon column split: ${off.join(", ")}`).toBeLessThanOrEqual(0.5);
  }

  // …and each depth indents exactly one 14px step from the one above
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i++) {
    const step = byDepth.get(depths[i])![0] - byDepth.get(depths[i - 1])![0];
    expect(step).toBeCloseTo(14 * (depths[i] - depths[i - 1]), 1);
  }
});

test("a pinned note joins the same column", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Umbra Home", exact: true })).toBeVisible();

  // pin a ROOT note so the flat Pinned section renders (a folder note's pin
  // nests in the tree instead — SUB-585)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  const note = page.locator('.row[data-path="Welcome.md"]');
  await expect(note).toBeVisible();
  await note.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  await expect(page.locator(".side-label-row", { hasText: "Pinned" })).toBeVisible();

  const rows = await marks(page);
  const pin = rows.find((r) => r.label.startsWith("Welcome"));
  const today = rows.find((r) => r.label.startsWith("Today"));
  expect(pin, "pinned row not found").toBeTruthy();
  expect(pin!.x).toBeCloseTo(today!.x, 1);
});
