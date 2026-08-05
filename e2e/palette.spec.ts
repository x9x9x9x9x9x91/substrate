import { expect, test } from "@playwright/test";

// ⌘K ranking against the mock backend: the vault has a "release"
// database plus notes whose bodies mention "release". Before the fix the
// palette showed only Content snippets — the destination never surfaced.

test("query 'release' surfaces Go to Release without scrolling (SUB-171)", async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Notes — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("release");

  const item = page.locator(".palette-item", { hasText: "Go to Release" });
  await expect(item).toBeVisible();

  // hoisted above the Content section: no snippet row renders above it
  const rows = page.locator(".palette-results .palette-item");
  const count = await rows.count();
  let goIdx = -1;
  let firstSnippet = -1;
  for (let i = 0; i < count; i++) {
    const r = rows.nth(i);
    if ((await r.locator(".palette-item-label").innerText()) === "Go to Release") goIdx = i;
    if (firstSnippet === -1 && (await r.locator(".palette-item-snippet").count()) > 0)
      firstSnippet = i;
  }
  expect(goIdx).toBeGreaterThanOrEqual(0);
  expect(firstSnippet === -1 || goIdx < firstSnippet).toBe(true);

  // fully inside the results scrollport — visible without scrolling
  const itemBox = await item.boundingBox();
  const resultsBox = await page.locator(".palette-results").boundingBox();
  expect(itemBox).not.toBeNull();
  expect(resultsBox).not.toBeNull();
  expect(itemBox!.y).toBeGreaterThanOrEqual(resultsBox!.y);
  expect(itemBox!.y + itemBox!.height).toBeLessThanOrEqual(
    resultsBox!.y + resultsBox!.height + 1,
  );
});

// Command labels say "New" but people type "create"/"make"/"add" —
// the synonym rewrite must surface the real command as the top selectable
// row, not leave the query stranded on the New-note fallback.

test("query 'create database' surfaces New database… (SUB-805)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("create database");

  // parity with typing "new database": the command ranks top of Commands
  await expect(
    page.locator(".palette-item-label", { hasText: "New database…" })
  ).toBeVisible();
  const labels = page.locator(
    ".palette-results [aria-labelledby*='Commands'] .palette-item-label"
  );
  await expect(labels.first()).toHaveText("New database…");
});

test("query 'create a note' still offers New note (SUB-805)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("create a note");

  // the query-echo fallback keeps the typed title; the article-dropping
  // rewrite only affects ranking, never what gets created
  await expect(
    page.locator(".palette-item-label", { hasText: "New note “create a note”" })
  ).toBeVisible();
});


// MacOS autocorrect draws a candidate bubble under the input and
// captures ↑↓ while visible — query inputs must opt out entirely

test("palette and search inputs disable autocorrect (SUB-397)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  const palette = page.locator(".palette-input");
  await expect(palette).toHaveAttribute("spellcheck", "false");
  await expect(palette).toHaveAttribute("autocorrect", "off");
  await expect(palette).toHaveAttribute("autocapitalize", "off");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+Shift+f");
  const search = page.locator(".search-input");
  await expect(search).toHaveAttribute("spellcheck", "false");
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
});

// Regression guard. The "No results" banner keyed off an id
// whitelist of fallback rows; "New sheet “x”" landed later, echoes
// the query in its label so it always survives ranking, and its absence from
// the whitelist killed the banner for every plain-text no-match query.

test("a garbage plain-text query still shows the No results banner (SUB-673)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("zzzqqqxyz");

  // the fallback rows are exactly what makes zero hits look like a result set
  await expect(page.locator(".palette-item-label", { hasText: "New sheet “zzzqqqxyz”" })).toBeVisible();
  await expect(page.locator(".palette-item-label", { hasText: "New note “zzzqqqxyz”" })).toBeVisible();

  const banner = page.locator(".palette-empty[role=status]");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText("No results for “zzzqqqxyz”");

  // and a query with real hits must not show it
  await page.locator(".palette-input").fill("release");
  await expect(page.locator(".palette-item-label", { hasText: "Go to Release" })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

// The palette closes the instant a property applies, so a rejected
// write used to vanish into console.error — the value never landed and nothing
// on screen said so. The failure must reach the app toast, like every sibling
// surface reports its own write failures.

test("a rejected palette property write reports on the toast (SUB-1149)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Slow Bloom");
  const firstLabel = page.locator(".palette-results .palette-item .palette-item-label").first();
  await expect(firstLabel).toHaveText("Slow Bloom EP");
  await page.keyboard.press("Tab"); // → the note's actions stage
  await page.locator(".palette-item", { hasText: "Set property…" }).click();

  await page.locator(".palette-input").fill("status: shipped");
  await page.locator(".palette-item", { hasText: "Set status: shipped" }).click();

  // the palette is gone, so the toast is the only place the failure can land
  await expect(page.locator(".palette-input")).toHaveCount(0);
  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn't set status");
  await expect(toast).toContainText("vault_set_prop");

  // and the write really did not land — the note keeps the value it had
  await page.evaluate(() => window.__mockFail?.clear());
  expect(await page.evaluate(() => window.__mockPropOf?.("Slow Bloom EP.md", "status"))).toBe(
    "in review"
  );
});
