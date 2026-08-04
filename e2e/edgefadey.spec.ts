import { expect, test, type Page } from "@playwright/test";

// The shared vertical edge fade (SUB-1001). One gate — useEdgeFade() plus
// .edge-fade-y in styles.css — now serves the settings sheet, the calendar's
// Upcoming rail, the charts dashboard and the database manager, replacing what
// would otherwise have been four bespoke fades. Same contract as the table edges (SUB-195) and the
// sidebar tree (SUB-627): .edge-more-y paints only while the scroller can move
// down, .edge-scrolled-y only while it is off the top stop, so the row at a
// stop always renders crisp and a surface that fits fades neither end.
// Runs against the deterministic mock backend (fresh page = fresh vault).

/** Scroll to the very bottom and let the onScroll gate settle. */
async function toBottom(page: Page, sel: string) {
  await page.locator(sel).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(sel)).toHaveClass(/edge-scrolled-y/);
}

test("settings sheet: fades down, never at the bottom stop", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  const body = page.locator(".shortcut-sheet-body");
  await expect(body).toBeVisible();

  // the sheet must actually overflow at this viewport, or this proves nothing
  const dims = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  // top: more below, nothing clipped above
  await expect(body).toHaveClass(/edge-more-y/);
  await expect(body).not.toHaveClass(/edge-scrolled-y/);

  // bottom stop: the last row ("Show app files") renders crisp — this is the
  // SUB-1001 defect itself, where the fade used to be unconditional
  await toBottom(page, ".shortcut-sheet-body");
  await expect(body).not.toHaveClass(/edge-more-y/);
  const maskAtBottom = await body.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAtBottom).toBe("linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)");

  // and the last row is inside the scroller's box, not clipped by it
  const clear = await body.evaluate((el) => {
    const last = el.lastElementChild;
    if (!last) return null;
    return last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  });
  expect(clear).not.toBeNull();
  expect(clear!).toBeLessThanOrEqual(1);
});

test("calendar Upcoming rail: fade gated on the rail's own overflow", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calendar" }).first().click();
  const rail = page.locator(".cal-agenda-body");
  await expect(rail).toBeVisible();

  const dims = await rail.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  await expect(rail).toHaveClass(/edge-more-y/);
  expect(await rail.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");

  await toBottom(page, ".cal-agenda-body");
  await expect(rail).not.toHaveClass(/edge-more-y/);
});

test("charts dashboard: bottom fade while charts continue past the pane", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item")
    .filter({ has: page.getByText("Overview", { exact: true }) })
    .first()
    .click();
  const note = page.locator(".note.edge-fade-y");
  await expect(note).toBeVisible();

  const dims = await note.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);

  await expect(note).toHaveClass(/edge-more-y/);
  await toBottom(page, ".note.edge-fade-y");
  await expect(note).not.toHaveClass(/edge-more-y/);
});

test("database manager: fades only at the heights where the list overflows", async ({ page }) => {
  // the list fits a 900px window and overflows a 600px one, so the same surface
  // proves both halves of the gate
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const body = page.locator(".dbmgr-body");
  await expect(body).toBeVisible();

  const dims = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh).toBeGreaterThan(dims.ch);
  await expect(body).toHaveClass(/edge-more-y/);

  // scrolled: a top fade marks the rows above, and the bottom one is gone
  await toBottom(page, ".dbmgr-body");
  await expect(body).not.toHaveClass(/edge-more-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 14px)",
  );

  // tall enough to fit: no fade at either end
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(body).not.toHaveClass(/edge-more-y/);
  await expect(body).not.toHaveClass(/edge-scrolled-y/);
  expect(await body.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});
