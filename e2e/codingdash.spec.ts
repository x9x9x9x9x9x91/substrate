import { expect, test, type Page } from "@playwright/test";

// Coding dashboard: the `dashboard: coding` surface renders
// the mock coding_scan lane as two-line repo rows — dot | name + branch over
// the last commit subject | chips | commit age. Attention rows sort first
// (substrate: dirty + behind + a 9d-old unmerged lane, old-maxpatches: broken),
// quiet repos after. Fixture: Dashboards/Coding.md + mockCodingScan in
// src/lib/tauri.ts.

async function openCoding(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Coding$/ }).click();
  await expect(page.locator(".dash-title")).toHaveText("Coding");
}

test("renders two-line rows attention-sorted, quiet rows dim", async ({ page }) => {
  await openCoding(page);
  const rows = page.locator(".coding2-row");
  await expect(rows).toHaveCount(4);

  // attention first (broken + dirty), then quiet repos by last commit desc
  await expect(rows.nth(0)).toContainText("substrate");
  await expect(rows.nth(0)).not.toHaveClass(/quiet/);
  await expect(rows.nth(1)).toContainText("old-maxpatches");
  await expect(rows.nth(1)).not.toHaveClass(/quiet/);
  await expect(rows.nth(2)).toContainText("granulate-engine");
  await expect(rows.nth(2)).toHaveClass(/quiet/);
  await expect(rows.nth(3)).toContainText("m8-sketches");
  await expect(rows.nth(3)).toHaveClass(/quiet/);

  // line 1 = name + branch, line 2 = the commit subject
  await expect(rows.nth(0).locator(".coding2-branch")).toHaveText("sub/coding-dashboard");
  await expect(rows.nth(0).locator(".coding2-sub")).toHaveText("feat: coding dashboard scan");
  await expect(rows.nth(0).locator(".coding2-age")).toContainText("2h ago");
});

test("the attention dot is amber, the quiet dot is dim", async ({ page }) => {
  await openCoding(page);
  const dot = (n: number) =>
    page
      .locator(".coding2-row")
      .nth(n)
      .locator(".dash-dot")
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  // The amber is --warn. Read it off the page rather than re-typing
  // it here: a hand-copied hex in a test is the same defect the token fixed,
  // and it would fail the next time the amber legitimately moves.
  const warn = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  // #d9a02b — pinned once, on the token itself, so a stray edit still shows up
  expect(warn).toBe("rgb(217, 160, 43)");
  expect(await dot(0)).toBe(warn);
  // rgba(255,255,255,0.18)
  expect(await dot(2)).toBe("rgba(255, 255, 255, 0.18)");
});

test("chips render only for non-zero facts; a clean repo has none", async ({ page }) => {
  await openCoding(page);
  const rows = page.locator(".coding2-row");

  const substrate = rows.nth(0).locator(".coding2-chip");
  await expect(substrate).toHaveText(["3 dirty", "2 lanes · 9d", "2 wt", "↑4 ↓1"]);
  // stale lanes (>7d) and being behind are the two warn states
  await expect(rows.nth(0).locator(".coding2-chip.warn")).toHaveText(["2 lanes · 9d", "↑4 ↓1"]);

  // granulate-engine is clean and in sync: zero chips, not zero-valued chips
  await expect(rows.nth(2)).toContainText("granulate-engine");
  await expect(rows.nth(2).locator(".coding2-chip")).toHaveCount(0);
  await expect(rows.nth(2).locator(".coding2-chips")).toHaveCount(0);

  // m8-sketches has no origin at all — ↑↓ is unknown, so no chip either
  await expect(rows.nth(3).locator(".coding2-chip")).toHaveCount(0);
});

test("a broken repo shows its error in danger ink, carries it in the tooltip, no chips", async ({
  page,
}) => {
  await openCoding(page);
  const row = page.locator(".coding2-row").filter({ hasText: "old-maxpatches" });

  const err = row.locator(".coding2-sub");
  await expect(err).toContainText("fatal: not a git repository");
  await expect(err).toHaveClass(/coding-err/);
  expect(await err.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(235, 87, 87)");

  // the name tooltip carries the error too, so a truncated line stays readable
  await expect(row.locator(".coding2-name")).toHaveAttribute(
    "title",
    /fatal: not a git repository/,
  );
  await expect(row.locator(".coding2-chip")).toHaveCount(0);
});

test("renders the non-git others list and the cache-age footer", async ({ page }) => {
  await openCoding(page);
  await expect(page.locator(".coding-others")).toContainText("not git repos:");
  await expect(page.locator(".coding-others")).toContainText("assets-scratch");
  await expect(page.locator(".coding-others")).toContainText("5d ago");
  await expect(page.locator(".dash-foot")).toContainText("scanned 12m ago");
  await expect(page.locator(".dash-foot")).toContainText("~/Coding");
});

// The scan root is the note's own `root:` prop — the hardcoded home folder is
// only its default. The prop has to reach the backend call, not just the prose:
// the mock lane echoes the root it was handed back as `dir`, so the footer
// naming a different folder is proof the note's value travelled.
test("the note's root prop is the folder scanned, not the default", async ({ page }) => {
  await openCoding(page);
  await expect(page.locator(".dash-foot")).toContainText("~/Coding");

  await page.evaluate(() => {
    const w = window as unknown as {
      __mockEditProp: (p: string, k: string, v: unknown) => void;
      __mockEmit: (e: string) => void;
    };
    w.__mockEditProp("Dashboards/Coding.md", "root", "~/src");
    w.__mockEmit("vault:changed");
  });

  await expect(page.locator(".dash-foot")).toContainText("~/src");
  await expect(page.locator(".coding2-row")).toHaveCount(4);
});

test("refresh button forces a rescan", async ({ page }) => {
  await openCoding(page);
  await page.locator(".coding-refresh").click();
  // the mock fixture is static — the table stays, the scan re-renders
  await expect(page.locator(".coding2-row")).toHaveCount(4);
  await expect(page.locator(".coding2-row").first()).toContainText("substrate");
});

// The row's squeeze point is the pane, not the window: at a 760px viewport the
// sidebar leaves ~545px for the rows, so the narrow form has to fire there too.
// A viewport-only breakpoint starved the repo name to one letter at 760.
test("a narrow pane keeps the repo name whole even at a desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await openCoding(page);
  const row = page.locator(".coding2-row").first();
  const geometry = await row.evaluate((el) => {
    const box = (s: string) => (el.querySelector(s) as HTMLElement).getBoundingClientRect();
    return { name: box(".coding2-name"), chips: box(".coding2-chips"), main: box(".coding2-main") };
  });
  // the full name renders, not an ellipsised stub, and chips are on line 3
  expect(geometry.name.width).toBeGreaterThan(60);
  expect(geometry.chips.top).toBeGreaterThan(geometry.main.top);
});

test("phone rows keep repo identity and wrap the chips below it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: /^Coding$/ }).click();

  const row = page.locator(".coding2-row").first();
  await expect(row).toContainText("substrate");
  await expect(row).toContainText("sub/coding-dashboard");
  await expect(row).toContainText("feat: coding dashboard scan");

  const geometry = await row.evaluate((el) => {
    const box = (selector: string) => {
      const node = el.querySelector(selector);
      if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
      return node.getBoundingClientRect();
    };
    return {
      overflow: el.scrollWidth - el.clientWidth,
      name: box(".coding2-name"),
      chips: box(".coding2-chips"),
      age: box(".coding2-age"),
      main: box(".coding2-main"),
    };
  });

  expect(geometry.overflow).toBeLessThanOrEqual(0);
  // the repo name never collapses to nothing (the minmax floor)
  expect(geometry.name.width).toBeGreaterThan(40);
  // chips drop to their own line, under the name block, not beside it
  expect(geometry.chips.top).toBeGreaterThan(geometry.main.top);
  expect(geometry.chips.left).toBeLessThan(geometry.age.left);
  // the age keeps the top-right corner
  expect(geometry.age.top).toBeLessThan(geometry.chips.top);
});
