import { expect, test, type Page } from "./fixtures";
import { settingsTab } from "./settings";

// The two appearance dials in ⌘, — Glow (0-100) and Accent tone
// (four curated presets + a ±12° nudge). Runs against the mock backend, so
// this covers the whole path a user takes: the pane writes Settings.md, the
// watcher echo re-reads it, and App re-applies the result to <html>.

/** A colour token as the browser actually paints it inside a given scope.

    An unregistered custom property computes to its token stream, not to a
    colour — reading `--accent` directly would hand back the literal
    `hsl(calc(…))` text and assert nothing about what lands on screen. So this
    parks a throwaway span in the scope, points its `color` at the token and
    reads the resolved rgb back. */
function colorOn(page: Page, selector: string, prop: string) {
  return page.evaluate(
    ([sel, name]) => {
      const host = document.querySelector(sel);
      if (!host) return null;
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      probe.style.position = "absolute";
      host.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    },
    [selector, prop] as const
  );
}

/** a real (non-custom) computed style on the first element matching */
function styleOf(
  page: Page,
  selector: string,
  prop: "filter" | "textShadow" | "backgroundImage"
) {
  return page.evaluate(
    ([sel, name]) => {
      const el = document.querySelector(sel);
      if (!el) return `NO ELEMENT: ${sel}`;
      return getComputedStyle(el)[name];
    },
    [selector, prop] as const
  );
}

/** the scalars the dials write straight onto <html> as inline properties */
function scalar(page: Page, prop: string) {
  return page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    prop
  );
}

async function openDashboard(page: Page, name: string) {
  await page.locator(".side-item", { hasText: name }).click();
  await expect(page.locator(".dash-title")).toHaveText(name);
}

async function openSettings(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "appearance");
}

function row(page: Page, label: string) {
  return page.locator(".settings-row", { hasText: label });
}

test("the shipped default sets no appearance state at all", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");

  // no attribute means the bloom rules never match — the default is free
  await expect(page.locator("html")).not.toHaveAttribute("data-glow", /.*/);
  await expect(page.locator("html")).not.toHaveAttribute("data-glow-bars", /.*/);
  // and sky needs no attribute either: it is the stylesheet's own :root
  await expect(page.locator("html")).not.toHaveAttribute("data-tone", /.*/);

  await openDashboard(page, "Portfolio");
  // the sky accent, unchanged by the tone table's arithmetic
  await expect.poll(() => colorOn(page, ".dash-inner", "--accent")).toBe("rgb(108, 192, 236)");
});

test("the glow dial lights the line language, then the bars, and pays nothing at 0", async ({
  page,
}) => {
  await openSettings(page);

  const glow = row(page, "Glow").locator(".settings-range");
  await expect(glow).toHaveValue("0");
  await expect(row(page, "Glow").locator(".settings-slider-val")).toHaveText("off");

  // half way up the line stage: strokes bloom, bars stay flat. 35 of 70, so
  // the scalar is 0.5 — the dial's number is not the scalar, because the
  // line language reaches full weight where the bars start
  await glow.fill("35");
  await expect(page.locator("html")).toHaveAttribute("data-glow", "on");
  await expect(page.locator("html")).not.toHaveAttribute("data-glow-bars", /.*/);
  await expect.poll(() => scalar(page, "--glow")).toBe("0.5");

  // 70 is the V2 picture: line language at full weight, bars still dark
  await glow.fill("70");
  await expect(page.locator("html")).not.toHaveAttribute("data-glow-bars", /.*/);
  await expect.poll(() => scalar(page, "--glow")).toBe("1");

  // top of the dial: bars join (the V3 picture)
  await glow.fill("100");
  await expect(page.locator("html")).toHaveAttribute("data-glow-bars", "on");
  await expect.poll(() => scalar(page, "--glow")).toBe("1");
  await expect.poll(() => scalar(page, "--glow-bars")).toBe("1");
  await expect(row(page, "Glow").locator(".settings-slider-val")).toHaveText("100");

  // the value survives the round trip through Settings.md and the watcher,
  // and reaches the marks themselves — Overview is the pane with a line
  // chart and bars on it
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
  await openDashboard(page, "Overview");
  await expect(page.locator("html")).toHaveAttribute("data-glow", "on");
  await expect.poll(() => styleOf(page, ".chart-line-path", "filter")).toContain("drop-shadow");
  await expect.poll(() => styleOf(page, ".chart-dot", "filter")).toContain("drop-shadow");
  await expect.poll(() => styleOf(page, ".dash-bar", "filter")).toContain("drop-shadow");

  // back to 0: not a 0px shadow, no filter at all — the rules stop matching
  await page.keyboard.press("Meta+,");
  await settingsTab(page, "appearance");
  await row(page, "Glow").locator(".settings-range").fill("0");
  await expect(page.locator("html")).not.toHaveAttribute("data-glow", /.*/);
  await expect(page.locator("html")).not.toHaveAttribute("data-glow-bars", /.*/);
  await page.keyboard.press("Escape");
  await expect.poll(() => styleOf(page, ".chart-line-path", "filter")).toBe("none");
  await expect.poll(() => styleOf(page, ".chart-dot", "filter")).toBe("none");
  await expect.poll(() => styleOf(page, ".dash-bar", "filter")).toBe("none");
});

test("glow blooms the emphasised card values, and only the emphasised ones", async ({ page }) => {
  await openSettings(page);
  await row(page, "Glow").locator(".settings-range").fill("100");
  await page.keyboard.press("Escape");

  // Portfolio is the metrics-card pane
  await openDashboard(page, "Portfolio");
  const sharp = ".metrics-cards .dash-card:not(.sunk) .dash-card-eur";
  await expect.poll(() => styleOf(page, sharp, "textShadow")).toContain("rgb");
  // a sunk card is mid-importance and must stay flat — emphasis is scarce
  await expect
    .poll(() => styleOf(page, ".metrics-cards .dash-card.sunk .dash-card-eur", "textShadow"))
    .toBe("none");

  await page.keyboard.press("Meta+,");
  await settingsTab(page, "appearance");
  await row(page, "Glow").locator(".settings-range").fill("0");
  await page.keyboard.press("Escape");
  await expect.poll(() => styleOf(page, sharp, "textShadow")).toBe("none");
});

test("a tone chip repaints the whole accent family, on screen and for paper", async ({ page }) => {
  await openSettings(page);

  const chips = row(page, "Accent tone").locator(".settings-chip");
  await expect(chips).toHaveCount(4);
  // sky is the live one before anything is touched
  await expect(chips.filter({ hasText: "Sky" })).toHaveAttribute("aria-checked", "true");

  await chips.filter({ hasText: "Violet" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-tone", "violet");
  await page.keyboard.press("Escape");

  await openDashboard(page, "Portfolio");
  // the whole family moved together — mark weight, text weight and the ramp
  await expect.poll(() => colorOn(page, ".dash-inner", "--accent")).toBe("rgb(201, 162, 230)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--accent-text")).toBe("rgb(217, 198, 241)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--series-2")).toBe("rgb(184, 99, 167)");
  // series-5 is the ramp's warm neutral counterweight and does NOT rotate
  await expect.poll(() => colorOn(page, ".dash-inner", "--series-5")).toBe("rgb(201, 185, 143)");
  // The page rule is part of this family too, not literal sky chrome
  await expect.poll(() => styleOf(page, ".dash-head", "backgroundImage")).toContain(
    "rgb(201, 162, 230)"
  );

  // state colours are not part of the family and never move with it
  await expect.poll(() => colorOn(page, ".dash-inner", "--danger")).toBe("rgb(235, 87, 87)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--ok")).toBe("rgb(76, 183, 130)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--opt-orange")).toBe("rgb(232, 150, 90)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--opt-yellow")).toBe("rgb(217, 184, 80)");
});

test("the fine-tune slider nudges the chosen tone and clears itself at 0", async ({ page }) => {
  await openSettings(page);

  const nudge = row(page, "Tone fine-tune").locator(".settings-range");
  await expect(nudge).toHaveValue("0");
  await expect(row(page, "Tone fine-tune").locator(".settings-slider-val")).toHaveText("0°");

  await nudge.fill("-9");
  await expect.poll(() => scalar(page, "--tone-nudge")).toBe("-9");
  await expect(row(page, "Tone fine-tune").locator(".settings-slider-val")).toHaveText("-9°");
  await page.keyboard.press("Escape");

  await openDashboard(page, "Portfolio");
  // sky rotated 9° toward cyan — still the sky family, visibly nudged
  await expect.poll(() => colorOn(page, ".dash-inner", "--accent")).toBe("rgb(108, 211, 236)");
  // the warm fifth slot and the semantic state tokens never follow the nudge
  await expect.poll(() => colorOn(page, ".dash-inner", "--series-5")).toBe("rgb(201, 185, 143)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--danger")).toBe("rgb(235, 87, 87)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--ok")).toBe("rgb(76, 183, 130)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--opt-orange")).toBe("rgb(232, 150, 90)");
  await expect.poll(() => colorOn(page, ".dash-inner", "--opt-yellow")).toBe("rgb(217, 184, 80)");
  await expect.poll(() => styleOf(page, ".dash-head", "backgroundImage")).toContain(
    "rgb(108, 211, 236)"
  );

  await page.keyboard.press("Meta+,");
  await settingsTab(page, "appearance");
  await row(page, "Tone fine-tune").locator(".settings-range").fill("0");
  await expect.poll(() => scalar(page, "--tone-nudge")).toBe("0");
});

test("a failed appearance write rolls its optimistic preview back", async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  const glow = row(page, "Glow").locator(".settings-range");
  await glow.fill("70");
  await expect(page.locator("html")).toHaveAttribute("data-glow", "on");
  await glow.blur();
  await expect(page.locator(".toast")).toContainText("couldn't save glow");
  await expect(glow).toHaveValue("0");
  await expect(page.locator("html")).not.toHaveAttribute("data-glow", /.*/);
  await expect.poll(() => scalar(page, "--glow")).toBe("");

  await row(page, "Accent tone").locator(".settings-chip", { hasText: "Violet" }).click();
  await expect(page.locator(".toast")).toContainText("couldn't save accent-tone");
  await expect(page.locator("html")).not.toHaveAttribute("data-tone", /.*/);
  await expect(
    row(page, "Accent tone").locator(".settings-chip", { hasText: "Sky" })
  ).toHaveAttribute("aria-checked", "true");
});
