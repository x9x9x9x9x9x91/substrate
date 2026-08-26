import { expect, test } from "./fixtures";
import { openSettingsByKey } from "./settings";

// The window-opacity dial rides an AppKit material only the macOS
// desktop build has. Everywhere else — this Chromium run against the mock
// backend included — the setting is inert: ⌘, hides the row and the window
// ground keeps the solid `var(--bg)` it always had. That absence is the
// contract worth pinning: no e2e may come to depend on a material the browser
// cannot provide, and a regression that leaked the translucent path into the
// plain webview would show up here as a visible slider.

test("the opacity dial is absent outside the macOS desktop build, and the ground stays solid", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await openSettingsByKey(page, "appearance");

  // the dial's own tab, and a neighbouring row on it proves that tab rendered
  // its fields at all — so the assertion below is "hidden", not "nothing
  // painted yet"
  await expect(page.locator(".settings-row", { hasText: "Glow" })).toBeVisible();
  await expect(page.locator(".settings-row", { hasText: "Window opacity" })).toHaveCount(0);
  // The appearance dials ride the same slider chrome, so "no opacity
  // dial" is an assertion about WHICH sliders the sheet has, not that it has
  // none: a leaked window-opacity row would show up here as a third one, even
  // if it somehow rendered without its label.
  const sliderRows = page.locator(".settings-row:has(.settings-slider)");
  await expect(sliderRows).toHaveCount(2); // Glow and Tone fine-tune
  await expect(sliderRows.filter({ hasText: "opacity" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // the translucent path is class-gated on <html>: no class, no alpha anywhere
  await expect(page.locator("html.vibrancy")).toHaveCount(0);
  const opaque = await page.evaluate(() => {
    // rgb(...) — an rgba() with alpha < 1 would mean the ground went
    // see-through. Both layers: the canvas paint from index.html and body's
    // own ground, since either one going translucent shows the desktop.
    const solid = (el: Element) => {
      const bg = getComputedStyle(el).backgroundColor;
      return !bg.includes("rgba") || bg.trim().endsWith(", 1)");
    };
    return solid(document.documentElement) && solid(document.body);
  });
  expect(opaque).toBe(true);
});

// The rule the macOS build actually rides can still be checked HERE, without a
// material: forcing the class on proves the alpha math and the layering that
// makes it visible — the canvas ground clearing, body and .main taking the
// dial, and every surface above them staying opaque. Only AppKit's blur is
// unreachable in Chromium, and that is the one thing this doesn't claim.
test("forced on, the class opens the ground to the desktop and leaves panels opaque", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  /* Two serializations to read, because color-mix() does not collapse to
     rgba(): a mixed value computes to `color(srgb r g b / a)` while the plain
     tokens stay `rgb(...)`/`rgba(...)`. Alpha is the part after the slash, or
     the fourth comma-separated component, or 1 when neither is present. */
  const alpha = (bg: string) => {
    const m = bg.match(/^(?:rgba?|color)\((.+)\)$/);
    if (!m) return null;
    const slash = m[1].split("/");
    if (slash.length > 1) return parseFloat(slash[1].trim());
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return parts.length > 3 ? parts[3] : 1;
  };

  const solidBefore = await page.evaluate(
    () => getComputedStyle(document.querySelector(".main")!).backgroundColor
  );
  expect(alpha(solidBefore)).toBe(1);

  const at = async (pct: number) =>
    await page.evaluate((p) => {
      const root = document.documentElement;
      root.classList.add("vibrancy");
      root.style.setProperty("--window-opacity", `${p}%`);
      const bg = (sel: string) =>
        getComputedStyle(document.querySelector(sel)!).backgroundColor;
      return {
        html: getComputedStyle(root).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        main: bg(".main"),
        list: bg(".list"),
      };
    }, pct);

  // at the 80 floor the ground is 80% solid; .main stacks over it, so the
  // writing surface stays the more solid of the two by construction
  const floor = await at(80);
  expect(alpha(floor.html)).toBe(0); // canvas cleared, or nothing shows through
  expect(alpha(floor.body)).toBeCloseTo(0.8, 2);
  expect(alpha(floor.main)).toBeCloseTo(0.8, 2);

  // …and the dial moves it: 90 is strictly more solid than the floor
  const nominal = await at(90);
  expect(alpha(nominal.body)).toBeCloseTo(0.9, 2);
  expect(alpha(nominal.body)!).toBeGreaterThan(alpha(floor.body)!);

  // the sidebar paints no ground of its own by design, so it shows body's —
  // that is where most of the effect lands, and it is why the note column had
  // to be the more solid of the two above
  expect(alpha(nominal.list)).toBe(0);

  // the hierarchy survives where it matters: an elevated surface keeps its
  // solid token, so the ⌘, sheet reads as floating ABOVE the translucent
  // ground rather than dissolving into the wallpaper with it
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  const sheet = await page.evaluate(
    () => getComputedStyle(document.querySelector(".settings-sheet")!).backgroundColor
  );
  expect(alpha(sheet)).toBe(1);
  await page.keyboard.press("Escape");

  // and removing the class restores the pre-feature rendering exactly
  const restored = await page.evaluate(() => {
    const root = document.documentElement;
    root.classList.remove("vibrancy");
    root.style.removeProperty("--window-opacity");
    return {
      body: getComputedStyle(document.body).backgroundColor,
      main: getComputedStyle(document.querySelector(".main")!).backgroundColor,
    };
  });
  expect(alpha(restored.body)).toBe(1);
  expect(restored.main).toBe(solidBefore);
});
