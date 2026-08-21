import { expect, test, type Page } from "@playwright/test";

// Dashboard print: the portable kinds — metrics, charts, hub —
// carry a Print action in DashHead's actions slot. It clones the live pane
// (a workbook's ACTIVE page) into the note path's #print-surface and hands
// off to the same print mechanism notes use; the @media print rules re-skin
// the clone light and drop the actions cluster. The webview print call
// itself can't be asserted in Playwright, so window.print is stubbed (the
// mock backend runs the dev-browser path) and the print-media pass is
// emulated — what's asserted is the surface population, the hand-off call,
// and the print-media restyle. Fixtures (src/lib/tauri.ts): Portfolio
// (metrics), Overview (charts), Umbra Home (hub), Label Books (metrics
// workbook), Jobs (machine kind), Yield APR (portable, out of scope).

async function openDash(page: Page, name: string) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: name }).click();
  await expect(page.locator(".dash-title")).toHaveText(name);
}

// the live app's print button — never the clone's (the clone carries its own
// dash-actions, hidden only under print media)
const printButton = (page: Page) =>
  page.locator("#root .dash-actions").getByRole("button", { name: "Print", exact: true });

const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls);

// Custom properties keep their authored token stream when read directly.
// The nudgable tones are hsl(calc(...)), so resolve them through a real
// color declaration before comparing the palette that actually paints.
const resolvedColor = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((host, name) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      host.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, property);

// the hand-off fires after the surface's layout settle (~150ms) — poll for it
const expectPrinted = async (page: Page) => {
  await expect.poll(() => printCalls(page)).toBe(1);
};

const enableFullGlow = (page: Page) =>
  page.locator("html").evaluate((root) => {
    root.dataset.glow = "on";
    root.dataset.glowBars = "on";
    root.style.setProperty("--glow", "1");
    root.style.setProperty("--glow-bars", "1");
  });

test.beforeEach(async ({ page }) => {
  // stub the hand-off: no dialog blocks, and afterprint never fires so the
  // surface stays populated for the assertions
  await page.addInitScript(() => {
    const w = window as unknown as { __printCalls: number };
    w.__printCalls = 0;
    window.print = () => {
      w.__printCalls += 1;
    };
  });
});

test("dashboard accent stays scoped and cannot replace reserved state tokens (SUB-932)", async ({
  page,
}) => {
  await openDash(page, "Overview");

  // Outside a dashboard, the app keeps its interactive indigo. The dashboard
  // inherits the chosen V1 sky without moving the app-wide root token.
  await expect
    .poll(() => resolvedColor(page, ".side-item", "--accent"))
    .toBe("rgb(94, 106, 210)");
  await expect
    .poll(() => resolvedColor(page, ".dash-inner", "--accent"))
    .toBe("rgb(108, 192, 236)");

  // State remains a separate semantic band. Dashboard scoping may replace
  // accent/series tokens, never the state or schema-option tokens.
  for (const [stateToken, value] of [
    ["--danger", "rgb(235, 87, 87)"],
    ["--ok", "rgb(76, 183, 130)"],
    ["--opt-orange", "rgb(232, 150, 90)"],
    ["--opt-yellow", "rgb(217, 184, 80)"],
  ] as const) {
    await expect
      .poll(() => resolvedColor(page, ".side-item", stateToken))
      .toBe(value);
    await expect
      .poll(() => resolvedColor(page, ".dash-inner", stateToken))
      .toBe(value);
  }
  await expect
    .poll(() => resolvedColor(page, ".dash-inner", "--series-5"))
    .toBe("rgb(201, 185, 143)");
});

test("metrics: Print clones the live cards into #print-surface and hands off", async ({
  page,
}) => {
  await openDash(page, "Portfolio");
  // wait for real values — the clone must capture resolved cards, not "…"
  await expect(page.locator("#root .metrics-cards .dash-card-eur").first()).not.toHaveText("…");
  await enableFullGlow(page);
  const liveSharp = page.locator("#root .metrics-cards .dash-card:not(.sunk) .dash-card-eur").first();
  await expect(liveSharp).toHaveCSS("text-shadow", /rgb/);
  await expect(printButton(page)).toBeVisible();
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-inner")).toHaveCount(1);
  await expect(surface.locator(".dash-title")).toHaveText("Portfolio");
  await expect(surface.locator(".metrics-cards .dash-card")).toHaveCount(7);
  await expect(surface.locator(".metrics-cards .dash-card-eur").first()).not.toHaveText("…");
  await expectPrinted(page);
  // the on-screen original is untouched — a clone, not a move
  await expect(page.locator("#root .metrics-cards")).toBeVisible();
  await expect(surface).toBeHidden();

  // the print-media pass: the surface replaces the app, the actions chrome
  // drops, and the dark ramp remaps to the light print palette
  await page.emulateMedia({ media: "print" });
  await expect(surface).toBeVisible();
  await expect(page.locator("#root")).toBeHidden();
  await expect(surface.locator(".dash-actions")).toBeHidden();
  await expect(surface.locator(".dash-label").first()).toHaveCSS("color", "rgb(113, 118, 126)");
  await expect(surface.locator(".dash-card:not(.sunk) .dash-card-eur").first()).toHaveCSS(
    "text-shadow",
    "none"
  );
});

test("⌘P lands on a Print row where the surface prints, and nowhere else", async ({ page }) => {
  // ⌘P is the palette's own chord app-wide and stays that way — the webview
  // never sees it. On a printable surface the palette answers with the row
  // the muscle memory was reaching for.
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+p");
  await expect(page.locator(".palette-input")).toBeVisible();
  await expect(page.locator(".palette-item", { hasText: "Print…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openDash(page, "Portfolio");
  await expect(page.locator("#root .metrics-cards .dash-card-eur").first()).not.toHaveText("…");
  await page.keyboard.press("Meta+p");
  const row = page.locator(".palette-item", { hasText: "Print…" });
  await expect(row).toBeVisible();
  await row.click();

  // same door as the button: the live pane, cloned into the print surface
  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-title")).toHaveText("Portfolio");
  await expectPrinted(page);

  // and the row leaves with the surface that offered it
  await page.locator(".side-item", { hasText: /^Notes/ }).first().click();
  await page.keyboard.press("Meta+p");
  await expect(page.locator(".palette-input")).toBeVisible();
  await expect(page.locator(".palette-item", { hasText: "Print…" })).toHaveCount(0);
});

test("charts: bars and the line chart clone with their geometry", async ({ page }) => {
  await openDash(page, "Overview");
  // all four fences resolved (3 bar + 1 line) before the clone
  await expect(page.locator("#root .dash-chart")).toHaveCount(3);
  await expect(page.locator("#root .chart-line")).toHaveCount(1);
  await enableFullGlow(page);
  await expect(page.locator("#root .chart-line-path").first()).toHaveCSS("filter", /drop-shadow/);
  await expect(page.locator("#root .dash-bar").first()).toHaveCSS("filter", /drop-shadow/);
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-chart")).toHaveCount(3);
  await expect(surface.locator(".chart-line")).toHaveCount(1);
  await expectPrinted(page);

  await page.emulateMedia({ media: "print" });
  // real geometry on paper, not a re-render placeholder
  const bar = surface.locator(".dash-bar").first();
  expect((await bar.boundingBox())!.height).toBeGreaterThan(0);
  // the chart language draws in the accent family; on paper the
  // surface remaps --accent to its darker print weight, so the stroke prints
  // as deep sky-on-white rather than the dark ground's value
  await expect(surface.locator(".chart-line-path")).toHaveCSS("stroke", "rgb(22, 120, 171)");
  const printTokens = Object.fromEntries(
    await Promise.all(
      [
        ["accent", "--accent"],
        ["accentText", "--accent-text"],
        ["series5", "--series-5"],
        ["danger", "--danger"],
        ["ok", "--ok"],
        ["okSoft", "--ok-soft"],
        ["track", "--track"],
        ["orange", "--opt-orange"],
        ["yellow", "--opt-yellow"],
      ].map(
        async ([key, property]) =>
          [
            key,
            await resolvedColor(page, "#print-surface .dash-inner", property),
          ] as const,
      ),
    ),
  );
  expect(printTokens).toEqual({
    accent: "rgb(22, 120, 171)",
    accentText: "rgb(20, 89, 122)",
    series5: "rgb(143, 122, 63)",
    // the state family carries its own paper weights: the screen values are
    // tuned against the near-black ground and land under 4.5:1 as text on the
    // print panel, so the sheet re-slots them the way it re-slots accent
    danger: "rgb(163, 54, 54)",
    ok: "rgb(47, 116, 82)",
    // --ok-soft is substituted at :root, so re-slotting --ok alone would leave
    // the "progressing" sibling at its screen weight; --track is what gives a
    // goal bar its unfilled half, which on paper was white on white
    okSoft: "rgb(61, 153, 108)",
    track: "rgb(230, 232, 235)",
    orange: "rgb(232, 150, 90)",
    yellow: "rgb(217, 184, 80)",
  });
  await expect(surface.locator(".chart-line-path").first()).toHaveCSS("filter", "none");
  await expect(surface.locator(".chart-dot").first()).toHaveCSS("filter", "none");
  await expect(surface.locator(".dash-bar").first()).toHaveCSS("filter", "none");
  // A value written on its bar is knocked out of the fill in the surface's own
  // colour. On paper the surface is white and the fill is a pale wash, so the
  // dark ground's knockout would print white-on-white: the print sheet remaps
  // it to ink. Geometry that only ever ran on screen is geometry nobody has
  // checked (review).
  const inset = surface.locator(".dash-bar-val.is-inset");
  expect(await inset.count()).toBeGreaterThan(0);
  await expect(inset.first()).toHaveCSS("color", "rgb(27, 30, 34)");
});

test("hub: cards, table and link text clone — links stay on paper as content", async ({
  page,
}) => {
  await openDash(page, "Umbra Home");
  await expect(page.locator("#root .hub-cards .dash-card")).toHaveCount(3);
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".hub-cards .dash-card")).toHaveCount(3);
  await expect(surface.locator(".hub-body .dash-table")).toHaveCount(2);
  // a card wikilink is a <button> on screen but content on paper — it clones
  // as text and stays visible under print media (the surface itself is
  // display:none on screen, so presence first, visibility after emulation)
  await expect(surface.locator(".dash-link", { hasText: "Slow Bloom EP" }).first()).toHaveCount(1);
  await expectPrinted(page);

  await page.emulateMedia({ media: "print" });
  const link = surface.locator(".dash-link", { hasText: "Slow Bloom EP" }).first();
  await expect(link).toBeVisible();
  // links wear the note print path's blue — one concept, one treatment
  await expect(link).toHaveCSS("color", "rgb(61, 75, 181)");
  await expect(surface.locator(".dash-actions")).toBeHidden();
});

test("tax: the readiness board clones — cards, category table and checklist", async ({
  page,
}) => {
  await openDash(page, "Tax Readiness");
  // the pane resolves both sheets before the clone: real card values, not "—"
  await expect(page.locator("#root .metrics-cards .dash-card")).toHaveCount(9);
  await expect(page.locator("#root .dash-card-miss")).toHaveCount(0);
  await expect(page.locator("#root .tax-row")).toHaveCount(5);
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-inner")).toHaveCount(1);
  await expect(surface.locator(".dash-title")).toHaveText("Tax Readiness");
  await expect(surface.locator(".metrics-cards .dash-card")).toHaveCount(9);
  await expect(surface.locator(".tax-table tbody tr")).toHaveCount(6);
  await expect(surface.locator(".tax-row")).toHaveCount(5);
  await expectPrinted(page);
  await expect(page.locator("#root .tax-strip")).toBeVisible();

  await page.emulateMedia({ media: "print" });
  await expect(surface).toBeVisible();
  await expect(surface.locator(".dash-actions")).toBeHidden();
});

test("workbook: the ACTIVE page prints — sheet/view pages offer no action, tabs never print", async ({
  page,
}) => {
  await openDash(page, "Label Books");
  // page 0 is the workbook's own metrics kind — it prints
  await expect(page.locator("#root .dash-card .dash-label", { hasText: "Cash total" })).toBeVisible();
  await expect(page.locator("#root .metrics-cards .dash-card-eur").first()).not.toHaveText("…");
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-card .dash-label", { hasText: "Cash total" })).toHaveCount(1);
  // the tab strip is workbook chrome, not page content — it never clones
  await expect(surface.locator(".wb-tabs")).toHaveCount(0);
  await expectPrinted(page);

  // the view page's DashHead keeps only its own action — print is scoped to
  // the three portable kinds
  await page.locator(".wb-tab", { hasText: "Releases" }).click();
  await expect(page.locator(".wb-view-table")).toBeVisible();
  await expect(printButton(page)).toHaveCount(0);
  // the sheet page has no DashHead at all
  await page.locator(".wb-tab", { hasText: "Cash" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await expect(printButton(page)).toHaveCount(0);
});

test("machine kinds and out-of-scope kinds show no print action", async ({ page }) => {
  await openDash(page, "Jobs");
  await expect(printButton(page)).toHaveCount(0);

  await openDash(page, "Yield APR");
  await expect(printButton(page)).toHaveCount(0);
});
