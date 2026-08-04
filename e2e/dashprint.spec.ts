import { expect, test, type Page } from "@playwright/test";

// Dashboard print (SUB-676): the portable kinds — metrics, charts, hub —
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

// the hand-off fires after the surface's layout settle (~150ms) — poll for it
const expectPrinted = async (page: Page) => {
  await expect.poll(() => printCalls(page)).toBe(1);
};

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

  const token = (selector: string, name: string) =>
    page.locator(selector).first().evaluate((el, property) =>
      getComputedStyle(el).getPropertyValue(property).trim(), name
    );

  // Outside a dashboard, the app keeps its interactive indigo. The dashboard
  // inherits the chosen V1 sky without moving the app-wide root token.
  await expect.poll(() => token(".side-item", "--accent")).toBe("#5e6ad2");
  await expect.poll(() => token(".dash-inner", "--accent")).toBe("#6cc0ec");

  // State remains a separate semantic band. Dashboard scoping may replace
  // accent/series tokens, never the state or schema-option tokens.
  for (const [stateToken, value] of [
    ["--danger", "#eb5757"],
    ["--ok", "#4cb782"],
    ["--opt-orange", "#e8965a"],
    ["--opt-yellow", "#d9b850"],
  ] as const) {
    await expect.poll(() => token(".side-item", stateToken)).toBe(value);
    await expect.poll(() => token(".dash-inner", stateToken)).toBe(value);
  }
  await expect.poll(() => token(".dash-inner", "--series-5")).toBe("#c9b98f");
});

test("metrics: Print clones the live cards into #print-surface and hands off", async ({
  page,
}) => {
  await openDash(page, "Portfolio");
  // wait for real values — the clone must capture resolved cards, not "…"
  await expect(page.locator("#root .metrics-cards .dash-card-eur").first()).not.toHaveText("…");
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
});

test("charts: bars and the line chart clone with their geometry", async ({ page }) => {
  await openDash(page, "Overview");
  // all four fences resolved (3 bar + 1 line) before the clone
  await expect(page.locator("#root .dash-chart")).toHaveCount(3);
  await expect(page.locator("#root .chart-line")).toHaveCount(1);
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".dash-chart")).toHaveCount(3);
  await expect(surface.locator(".chart-line")).toHaveCount(1);
  await expectPrinted(page);

  await page.emulateMedia({ media: "print" });
  // real geometry on paper, not a re-render placeholder
  const bar = surface.locator(".dash-bar").first();
  expect((await bar.boundingBox())!.height).toBeGreaterThan(0);
  // the chart language draws in the accent family (SUB-932); on paper the
  // surface remaps --accent to its darker print weight, so the stroke prints
  // as deep sky-on-white rather than the dark ground's value
  await expect(surface.locator(".chart-line-path")).toHaveCSS("stroke", "rgb(22, 120, 171)");
  const printTokens = await surface.locator(".dash-inner").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      accent: style.getPropertyValue("--accent").trim(),
      accentText: style.getPropertyValue("--accent-text").trim(),
      series5: style.getPropertyValue("--series-5").trim(),
      danger: style.getPropertyValue("--danger").trim(),
      ok: style.getPropertyValue("--ok").trim(),
      orange: style.getPropertyValue("--opt-orange").trim(),
      yellow: style.getPropertyValue("--opt-yellow").trim(),
    };
  });
  expect(printTokens).toEqual({
    accent: "#1678ab",
    accentText: "#14597a",
    series5: "#8f7a3f",
    danger: "#eb5757",
    ok: "#4cb782",
    orange: "#e8965a",
    yellow: "#d9b850",
  });
});

test("hub: cards, table and link text clone — links stay on paper as content", async ({
  page,
}) => {
  await openDash(page, "Umbra Home");
  await expect(page.locator("#root .hub-cards .dash-card")).toHaveCount(3);
  await printButton(page).click();

  const surface = page.locator("#print-surface");
  await expect(surface.locator(".hub-cards .dash-card")).toHaveCount(3);
  await expect(surface.locator(".hub-body .dash-table")).toHaveCount(1);
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
