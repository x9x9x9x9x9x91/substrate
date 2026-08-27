import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Table columns drag-reorder from the header LABEL, and the order
// persists on the database's ViewPref (views.json in the real engine,
// mockViews here) — the same channel as widths and wrap, so it
// survives navigating away and a layout switch. Runs against the
// deterministic mock backend (fresh page = fresh vault).

async function openRelease(page: Page) {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
}

// the data column labels in render order — Name leads (frozen, never dragged)
// and the trailing ＋ add-property cell is empty, so both drop out
async function colOrder(page: Page): Promise<string[]> {
  const texts = await page.locator(".db-table thead th").allTextContents();
  return texts.map((t) => t.trim().toLowerCase()).filter((t) => t !== "" && t !== "name");
}

// Chromium's synthetic-mouse drag never reaches the app's dragstart with a
// usable payload (see folderorder.spec.ts), so dispatch the events with a
// real DataTransfer — the app's own handlers still do all the work. No
// clientX on a dispatched event means x=0, i.e. the header's left half:
// the drop lands the dragged column BEFORE the target.
async function dragColBefore(page: Page, from: string, to: string) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(".db-table thead th", { hasText: from })
    .locator(".db-th-label")
    .dispatchEvent("dragstart", { dataTransfer });
  const target = page.locator(".db-table thead th", { hasText: to });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

test("drag a header to reorder; the order survives a page switch and a layout switch", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  const before = await colOrder(page);
  expect(before.length).toBeGreaterThan(2);
  // move the LAST data column to the front of the list — a move no default
  // ordering (COLUMN_ORDER then alphabet) would ever produce on its own
  const moved = before[before.length - 1];
  const head = before[0];
  const expected = [moved, ...before.filter((c) => c !== moved)];

  await dragColBefore(page, moved, head);
  expect(await colOrder(page)).toEqual(expected);

  // persists across a page switch (mock vault_views_set round-trip)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await openRelease(page);
  expect(await colOrder(page)).toEqual(expected);

  // …and across a layout switch out to List and back
  await page.locator("button[aria-label='List']").click();
  await expect(page.locator(".db-table")).toHaveCount(0);
  await page.locator("button[aria-label='Table']").click();
  await expect(page.locator(".db-table")).toBeVisible();
  expect(await colOrder(page)).toEqual(expected);
});

test("the Name column is frozen first: not a drag source, not a drop target", async ({ page }) => {
  await page.goto("/");
  await openRelease(page);

  const nameTh = page.locator(".db-table thead th").first();
  await expect(nameTh.locator(".db-th-title")).toHaveAttribute("aria-label", "Sort by Name");
  await expect(nameTh.locator("[draggable='true']")).toHaveCount(0);

  // dropping a data column onto Name changes nothing — no drop handler there
  const before = await colOrder(page);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(".db-table thead th", { hasText: before[1] })
    .locator(".db-th-label")
    .dispatchEvent("dragstart", { dataTransfer });
  await nameTh.dispatchEvent("dragover", { dataTransfer });
  await nameTh.dispatchEvent("drop", { dataTransfer });
  expect(await colOrder(page)).toEqual(before);
});

test("after a reorder the resize handle and the right-click checklist still work", async ({
  page,
}) => {
  await page.goto("/");
  await openRelease(page);

  const before = await colOrder(page);
  const moved = before[before.length - 1];
  await dragColBefore(page, moved, before[0]);
  expect((await colOrder(page))[0]).toBe(moved);

  // Resize: the moved column's 8px edge strip still drags it wider,
  // and the width persists — the two gestures share the header, never fight
  const th = page.locator(".db-table thead th", { hasText: moved });
  const start = (await th.boundingBox())!;
  const hb = (await th.locator(".db-th-resize").boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = (await th.boundingBox())!;
  expect(after.width).toBeGreaterThan(start.width + 40);

  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await openRelease(page);
  const back = (await page.locator(".db-table thead th", { hasText: moved }).boundingBox())!;
  expect(Math.abs(back.width - after.width)).toBeLessThan(3);
  expect((await colOrder(page))[0]).toBe(moved);

  // Regression: right-click the header row still opens the
  // property-visibility checklist
  await page.locator(".db-table thead").click({ button: "right" });
  await expect(page.locator(".propvis")).toBeVisible();
  await expect(page.locator(".propvis .propvis-item")).toHaveCount(before.length);
});
