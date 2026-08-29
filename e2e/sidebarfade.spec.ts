import { expect, test } from "./fixtures";

// The sidebar's folder tree hard-clipped its last visible row against
// the fixed bottom zone (Vault sync/Trash) when it overflowed. The scroller
// carries the app's shared gated edge-fade idiom (useEdgeFade):
// .edge-more-y paints a bottom mask only while it can still scroll down, so at
// the stop the last row renders crisp and a tree that fits never fades.
// Runs against the deterministic mock backend (fresh page = fresh vault).

const overflows = (sw: { scrollHeight: number; clientHeight: number }) =>
  sw.scrollHeight > sw.clientHeight;

// Every section the seeded vault can collapse. A section left expanded here is
// a section still holding the rail open, which is what these two tests measure
// against — so a new one has to be named, not left to chance.
const collapsible = [
  "Dashboards",
  "Folders",
  "Pinned",
  "Drives",
];

test("overflowing tree: fade while more is below, gone at the bottom stop", async ({ page }) => {
  // a short viewport guarantees the fixture's tree outgrows the scroller
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto("/");
  const scroll = page.locator(".sidebar-scroll");
  await expect(scroll).toBeVisible();

  // the fixture must actually overflow, or this test proves nothing
  const dims = await scroll.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(overflows(dims)).toBe(true);

  // at scroll 0 there is more below → the mask paints
  await expect(scroll).toHaveClass(/edge-more-y/);
  const maskAt0 = await scroll.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAt0).not.toBe("none");

  // at scroll 0 nothing is clipped above → no top fade
  await expect(scroll).not.toHaveClass(/edge-scrolled-y/);

  // mid-scroll both ends are clipped → both fades
  await scroll.evaluate((el) => {
    el.scrollTop = 40;
  });
  await expect(scroll).toHaveClass(/edge-more-y/);
  await expect(scroll).toHaveClass(/edge-scrolled-y/);

  // bottom stop: the last row renders crisp — fade gone
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(scroll).not.toHaveClass(/edge-more-y/);
  // the top fade legitimately stays (we are scrolled off the top stop), but
  // the mask must no longer end transparent — that is the clipped-row cue
  const maskAtEnd = await scroll.evaluate((el) => getComputedStyle(el).maskImage);
  expect(maskAtEnd.trimEnd().endsWith("14px)")).toBe(true);
});

test("tree that fits its pane never fades (SUB-627)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/");
  const scroll = page.locator(".sidebar-scroll");
  await expect(scroll).toBeVisible();

  // collapse the expandable sections so the tree is comfortably short
  for (const label of collapsible) {
    const toggle = page.locator(".side-section-toggle", { hasText: label });
    if (await toggle.count()) await toggle.first().click();
  }

  await expect
    .poll(async () =>
      scroll.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
    )
    .toBe(true);
  await expect(scroll).not.toHaveClass(/edge-more-y/);
  const mask = await scroll.evaluate((el) => getComputedStyle(el).maskImage);
  expect(mask).toBe("none");
});

test("collapsing a folder re-checks scrollability without a scroll event (SUB-627)", async ({
  page,
}) => {
  // 600, not 500: the rail carries one permanent section header per section
  // the seeded vault has, and collapsed-but-present headers are floor height —
  // so this number grows by a header every time the vault grows a section.
  // The viewport only has to leave the collapsed rail room to fit — the tree
  // still overflows it wide open (1357px of content), which is the premise.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  const scroll = page.locator(".sidebar-scroll");
  await expect(scroll).toHaveClass(/edge-more-y/);

  // shrinking the content is a geometry change that fires no scroll event —
  // the ResizeObserver is what keeps the gate honest
  for (const label of collapsible) {
    const toggle = page.locator(".side-section-toggle", { hasText: label });
    if (await toggle.count()) await toggle.first().click();
  }
  await expect
    .poll(async () =>
      scroll.evaluate((el) => ({
        fits: el.scrollHeight <= el.clientHeight + 1,
        gated: el.classList.contains("edge-more-y"),
      }))
    )
    .toEqual({ fits: true, gated: false });
});
