import { expect, test, type Page } from "@playwright/test";

// What the engine's result cap does to a filtered query,
// and whether a quoted query can display what it found. Both run against the
// mock backend (src/lib/tauri.ts), which caps exactly like the engine.

/** Seed the cap-buster before the app mounts: 210 untyped notes matching in
    the TITLE (they win the ranking) and 12 `type: inventory` ones matching
    late in the BODY (they lose it). Any cap applied before the caller's
    `type:` filter therefore returns 200 notes of which none are inventory. */
async function seedCapFixture(page: Page) {
  await page.addInitScript(() => {
    const install = () => {
      const seed = (window as unknown as { __mockSeedMatching?: unknown })
        .__mockSeedMatching as
        | ((o: {
            folder: string;
            count: number;
            token: string;
            where: "title" | "body";
            noteType?: string;
          }) => void)
        | undefined;
      if (!seed) return false;
      seed({ folder: "Bulk", count: 210, token: "quillon", where: "title" });
      seed({
        folder: "Stock",
        count: 12,
        token: "quillon",
        where: "body",
        noteType: "inventory",
      });
      return true;
    };
    if (!install()) {
      // the mock installs its hooks at module scope — poll until it lands
      const t = setInterval(() => {
        if (install()) clearInterval(t);
      }, 5);
    }
  });
}

async function openSearch(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
}

test("a filtered query finds matches ranked past the engine's cap (SUB-566)", async ({ page }) => {
  await seedCapFixture(page);
  await openSearch(page);

  // sanity: unfiltered, the query really does overflow the 200-note page
  await page.locator(".search-input").fill("quillon");
  await expect(page.locator(".search-stats")).toContainText("of 222 results");

  // filtered: all 12 inventory notes rank below the 210 title matches, so a
  // cap applied before the filter leaves zero of them on the page
  await page.locator(".search-input").fill("type:inventory quillon");
  await expect(page.locator(".search-group")).toHaveCount(12);
  await expect(page.locator(".search-pane .empty")).toHaveCount(0);
});

test("the stats line owns up to a truncated page (SUB-566)", async ({ page }) => {
  await seedCapFixture(page);
  await openSearch(page);

  await page.locator(".search-input").fill("quillon");
  // never presents the page as the whole truth: 200 shown, 222 matched. The
  // engine's total counts mounted files too, and this vault has a mount, so
  // that number can only honestly be called "results" — while the page below
  // it, all notes, is still counted in notes.
  await expect(page.locator(".search-stats")).toHaveText("first 200 of 222 results");

  // a match set that fits reports matches, not a truncation
  await page.locator(".search-input").fill("lisbon");
  await expect(page.locator(".search-stats")).toHaveText("1 match in 1 note");
});

test("the palette finds filtered matches ranked past its cap (SUB-566)", async ({ page }) => {
  await seedCapFixture(page);
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();

  // the palette's cap is 30 — 210 title matches bury the inventory notes far
  // deeper here than in the pane
  await input.fill("type:inventory quillon");
  await expect(page.locator(".palette-item", { hasText: "Stock" }).first()).toBeVisible();
  await expect(page.locator(".palette-empty")).toHaveCount(0);
});

test("a quoted-only query displays its results (SUB-567)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();

  // the search fires on the quoted text, and the rows must actually render —
  // not fall back to the Recent list as if nothing had been typed
  await input.fill('"lisbon"');
  await expect(page.locator(".palette-section", { hasText: /Notes|Content/ }).first()).toBeVisible();
  await expect(page.locator(".palette-item", { hasText: "Gero" }).first()).toBeVisible();

  // and a quoted query nothing matches says so, instead of showing Recent
  await input.fill('"zzqxwv"');
  await expect(page.locator(".palette-empty")).toContainText("No results for “zzqxwv”");
});
