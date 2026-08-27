import { expect, test } from "./fixtures";

// ⌘K ranking against the mock backend: the vault has a "release"
// database plus notes whose bodies mention "release". Before the fix the
// palette showed only Content snippets — the destination never surfaced.

test("query 'release' surfaces Go to Release without scrolling (SUB-171)", async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Scratch — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Scratch");
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
  await expect(page.locator(".list-title")).toHaveText("Scratch");
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
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("create a note");

  // the query-echo fallback keeps the typed title; the article-dropping
  // rewrite only affects ranking, never what gets created
  await expect(
    page.locator(".palette-item-label", { hasText: "New note “create a note”" })
  ).toBeVisible();
});

// A dashboard note that already surfaced as a Scratch row must not list again
// as its "Dashboard: X" command — both rows open the same rendered surface,
// so the pair reads as a duplicate.



// MacOS autocorrect draws a candidate bubble under the input and
// captures ↑↓ while visible — query inputs must opt out entirely

test("palette and search inputs disable autocorrect (SUB-397)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
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
  await expect(page.locator(".list-title")).toHaveText("Scratch");
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

// The palette answers "why did this row match?" the same way full
// search does: matched substrings wear <mark>. Title rows mark the
// query's thread through the label; Content rows mark the engine's word-prefix
// hits in the snippet. Fallback rows echo the query, so they never mark.

test("palette rows mark the matched substring like the search pane (SUB-1205)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("vessel");

  // title row: the substring run is marked, casing preserved
  const noteRow = page.locator(".palette-item", {
    has: page.locator(".palette-item-label", { hasText: "Vessel Songs" }),
  }).first();
  await expect(noteRow.locator(".palette-item-label mark")).toHaveText("Vessel");

  // content row: a body-matched hit marks the whole engine token in its
  // snippet ("masters" for the query "master"), never the title
  await page.locator(".palette-input").fill("masters");
  const contentRow = page.locator(".palette-item", {
    has: page.locator(".palette-item-snippet"),
  }).first();
  await expect(contentRow.locator(".palette-item-snippet mark").first()).toHaveText(/^masters/i);

  // fallback rows echo the query rather than match it — no marks
  await page.locator(".palette-input").fill("zzzqqqxyz");
  const fallbackRow = page.locator(".palette-item", {
    has: page.locator(".palette-item-label", { hasText: "New note “zzzqqqxyz”" }),
  });
  await expect(fallbackRow).toBeVisible();
  await expect(fallbackRow.locator("mark")).toHaveCount(0);
});

// The palette closes the instant a property applies, so a rejected
// write used to vanish into console.error — the value never landed and nothing
// on screen said so. The failure must reach the app toast, like every sibling
// surface reports its own write failures.

test("a rejected palette property write reports on the toast (SUB-1149)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Slow Bloom");
  const firstLabel = page.locator(".palette-results .palette-item .palette-item-label").first();
  await expect(firstLabel).toHaveText("Slow Bloom EP");
  await page.keyboard.press("Tab"); // → the note's actions stage
  // filter to the row and take it with Enter — the stage lists every note verb
  // now, so a click on a row that far down races its own scroll
  await page.locator(".palette-input").fill("Set property");
  await expect(page.locator(".palette-item.selected")).toContainText("Set property…");
  await page.keyboard.press("Enter");

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

// The palette's structural actions close the overlay before their promise
// settles, so an engine refusal (rename collision, duplicate folder) has
// nowhere to land but the app toast — before the fix it went to
// console.error and the note silently kept its old name.

test("a refused palette rename reports on the toast (SUB-1214)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Vessel Songs");
  const firstLabel = page.locator(".palette-results .palette-item .palette-item-label").first();
  await expect(firstLabel).toHaveText("Vessel Songs");
  await page.keyboard.press("Tab"); // → the note's actions stage
  await page.locator(".palette-item", { hasText: "Rename…" }).click();

  // collide with an existing root note — the engine refuses this rename
  await page.locator(".palette-input").fill("Slow Bloom EP");
  await page.locator(".palette-item", { hasText: "Rename to" }).click();

  // the palette is gone, so the toast is the only place the refusal can land
  await expect(page.locator(".palette-input")).toHaveCount(0);
  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("already exists");

  // and the rename really did not land
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Vessel Songs");
  await expect(
    page.locator(".palette-results .palette-item .palette-item-label").first()
  ).toHaveText("Vessel Songs");
});

// A fact that lives only in frontmatter answers plain-text search. The
// people-walk that surfaced this typed a contact's ROLE into ⌘K and got an
// artist whose body prose restates the phrase — while the contact whose
// `role:` prop says it never appeared: the index held title + body only.

test("a prop-only fact surfaces its note in the palette", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  // Annelies Verbeek carries role: radio plugger in props alone — her body
  // says "Plugs the roster's singles", never the phrase itself
  await page.locator(".palette-input").fill("radio plugger");
  await expect(
    page.locator(".palette-item", { hasText: "Annelies Verbeek" })
  ).toBeVisible();
});

// The bottom edge fade tells you more rows exist — but scrollIntoView's
// default aligns a keyboard-selected row flush with the scrollport bottom, so
// the walk's landing row sat half-dissolved in the mask band. scroll-padding on
// .edge-fade-y makes keyboard walks land clear of both bands, and the gate no
// longer counts the scroller's trailing padding as something left to reach —
// at the last row there is nothing more below, so the fade is off entirely.

test("arrow-walking to the last row lands it clear of the bottom fade (SUB-1218)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("release");
  // wait past the debounced Content batch — counting before it arrives
  // walks a shorter list and never reaches the true last row
  await expect(page.locator(".palette-item-snippet").first()).toBeVisible();

  const rows = page.locator(".palette-results .palette-item");
  // The Content batch lands over several paints, so no count taken up front is
  // safe: read it a moment too early and the walk is sized to a list that then
  // outgrew it, stopping short with real rows still below. Counting is the
  // wrong instrument — step until the row that is currently last is the
  // selected one, re-reading the list on every step, so a batch that arrives
  // mid-walk costs a few more presses instead of a wrong landing. The
  // assertions below are about the END of the list; they only mean anything
  // once the walk has provably reached it.
  await expect
    .poll(
      async () => {
        await page.keyboard.press("ArrowDown");
        return rows.last().evaluate((el) => el.classList.contains("selected"));
      },
      { timeout: 20000 }
    )
    .toBe(true);

  const selected = page.locator(".palette-item.selected");
  await expect(selected).toHaveCount(1);
  const geom = await page.evaluate(() => {
    const r = document.querySelector(".palette-results")!;
    const sel = document.querySelector(".palette-item.selected")!;
    const rb = r.getBoundingClientRect();
    const sb = sel.getBoundingClientRect();
    return {
      fadeOpen: r.className.includes("edge-more-y"),
      rowBottom: sb.bottom,
      fadeBandTop: rb.bottom - 20,
    };
  });
  // nothing is left below but the scroller's own clearance padding, and
  // padding is not content — the gate closes rather than promising a row
  // that isn't there
  expect(geom.fadeOpen).toBe(false);
  // and the selected row sits fully above the 20px band it used to dissolve in
  expect(geom.rowBottom).toBeLessThanOrEqual(geom.fadeBandTop + 0.5);
});

// Cold ⌘K with a note open painted "Commands" twice: the Pick row was
// appended after the Folders spread, and sections group by contiguity — one
// header per run, which is the intended shape (a header labels the rows under
// it, not every row of that kind anywhere in the list). So this is a claim
// about the cold-open ORDER, not about grouping in general: cold ⌘K must emit
// each section as a single run, hence each name once. A query whose ranking
// genuinely interleaves two sections would repaint both names, correctly.

test("cold-open palette sections are unique (SUB-1218)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  // open a note so the Pick/Actions command rows exist
  await page.locator(".list .row", { has: page.getByText("Welcome", { exact: true }) }).click();
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-item").first()).toBeVisible();

  const sections = await page.locator(".palette-section").allInnerTexts();
  expect(sections.length).toBeGreaterThan(0);
  expect(new Set(sections).size).toBe(sections.length);
});

test("a property-only hit says it matched in properties (SUB-1222)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");
  // "1k petals" is the artist prop on Vessel Songs — its body never says it
  await page.locator(".palette-input").fill("petals");
  const row = page.locator(".palette-item", { hasText: "Vessel Songs" });
  await expect(row).toBeVisible();
  await expect(row.locator(".palette-hint")).toHaveText("in properties");
  // the snippet is the value that matched, marked — not unrelated body prose
  await expect(row.locator(".palette-item-snippet mark").first()).toHaveText(/petals/i);
});

// One search row at a time. The palette carries two: a plain destination row
// on the empty palette, and "See all results…" once there is a query to carry
// across. Both print the same chord, so showing both at once would be one
// keycap over two rows that do different things with what was typed.

test("the browse palette offers Search, and a query hands it to See all results", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+k");

  // browse mode: the destination row is the only route to the search pane
  await expect(page.locator(".palette-item-label", { hasText: /^Search notes$/ })).toHaveCount(1);
  await expect(
    page.locator(".palette-item-label", { hasText: /^See all results/ })
  ).toHaveCount(0);

  await page.locator(".palette-input").fill("petals");

  // and with a query it stands down for the row that carries the query
  await expect(page.locator(".palette-item-label", { hasText: /^Search notes$/ })).toHaveCount(0);
  await expect(
    page.locator(".palette-item-label", { hasText: "See all results for “petals”…" })
  ).toHaveCount(1);
});

// The row prints ⌘⇧F, so it must behave like ⌘⇧F: open the pane and leave the
// last search standing. Seeding it with an empty string would clear it.

test("the Search row opens the pane without clearing the last search", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");

  // leave a real search behind first
  await page.keyboard.press("Meta+Shift+f");
  await page.locator(".search-input").fill("petals");
  await expect(page.locator(".search-input")).toHaveValue("petals");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+k");
  // the label, not the row: a row's text carries its keycap too
  await page.locator(".palette-item-label", { hasText: /^Search notes$/ }).click();

  await expect(page.locator(".search-input")).toHaveValue("petals");
});
