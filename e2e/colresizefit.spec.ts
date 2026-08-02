import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// SUB-613: column resize must track the pointer in BOTH directions in BOTH
// fit modes. The original SUB-404 rule pinned only the cell text block —
// a floor: with the 100%-width table FITTING its pane (wide window, small
// database — the everyday state), the layout redistributed the pane surplus
// straight back and a shrink drag visibly did nothing. The colresize.spec.ts
// fixture happens to overflow at 1280px, so the gate only ever saw the
// working mode. This matrix pins grow AND shrink at an overflowing (1280)
// and a fitting (2400) viewport.

async function dragCol(page: Page, col: string, dx: number) {
  const th = page.locator(".db-table thead th", { hasText: col });
  const before = (await th.boundingBox())!.width;
  const hb = (await th.locator(".db-th-resize").boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = (await th.boundingBox())!.width;
  if (dx > 0) expect(after, `${col} grow by ${dx}`).toBeGreaterThan(before + dx - 15);
  // shrink may floor early (MIN_COL_W / the nowrap header label) — require
  // real movement, not the exact delta
  else expect(after, `${col} shrink by ${dx}`).toBeLessThan(before - 25);
  // reset so the next drag starts from auto
  await th.locator(".db-th-resize").dblclick();
}

for (const width of [1280, 2400]) {
  test(`grow and shrink track the pointer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await openDb(page, "Release");
    await expect(page.locator(".db-table")).toBeVisible();
    await dragCol(page, "artist", 80);
    await dragCol(page, "artist", -60);
    await dragCol(page, "Name", 80);
    await dragCol(page, "Name", -60);
  });
}
