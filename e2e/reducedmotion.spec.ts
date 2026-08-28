import { expect, test } from "./fixtures";

// The reduced-motion promise, pinned as a property rather than as a list.
//
// The block this replaces named eighteen selectors and set `transition: none`
// on them. It could not stop an animation — it never mentioned the property —
// and it reached nothing outside those eighteen, so every rule written after
// it was uncovered by default. A test that checked "the sidebar row does not
// transition" would have passed against that block the whole time it was
// broken. So the assertions below deliberately do not name an app selector:
// they ask whether an ARBITRARY element, including one this suite invents on
// the spot, is still.

/** Turn the preference on, then boot.
 *
 *  The preference is set per page rather than through `test.use({ reducedMotion:
 *  "reduce" })`, which is the spelling you would reach for first and does NOT
 *  work here: measured on the runner, a spec declaring it that way still reads
 *  the app's full 120ms transitions, so the option is not reaching the context
 *  this suite's fixtures hand out. `emulateMedia` is unambiguous about which
 *  page it applies to and needs no theory about fixture composition. */
async function boot(
  page: import("@playwright/test").Page,
  preference: "reduce" | "no-preference" = "reduce",
) {
  await page.emulateMedia({ reducedMotion: preference });
  await page.goto("/");
  await expect(
    page.locator(".side-item", { hasText: /^Scratch/ }),
  ).toBeVisible();
}

/** A duration the blanket has flattened. It is near-zero rather than zero on
    purpose (see base.css), so read it as a bound, not an equality. */
const STILL_MS = 1;

async function motionOf(
  page: import("@playwright/test").Page,
  selector: string,
) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      transition: s.transitionDuration,
      animation: s.animationDuration,
      iterations: s.animationIterationCount,
    };
  }, selector);
}

const ms = (css: string | undefined) =>
  Math.max(
    ...(css || "0s")
      .split(",")
      .map((p) => parseFloat(p) * (p.includes("ms") ? 1 : 1000)),
  );

test("an element the old list never named is still", async ({ page }) => {
  await boot(page);
  // .side-item WAS in the eighteen; .list-title never was, and neither is
  // anything added to the app tomorrow.
  for (const sel of [".side-item", ".list-title", ".sidebar", "body"]) {
    const m = await motionOf(page, sel);
    expect(m, `${sel} should be in the DOM`).not.toBeNull();
    expect(ms(m!.transition), `${sel} transition-duration`).toBeLessThanOrEqual(
      STILL_MS,
    );
    expect(ms(m!.animation), `${sel} animation-duration`).toBeLessThanOrEqual(
      STILL_MS,
    );
  }
});

test("an infinite animation invented after the rule was written is still", async ({
  page,
}) => {
  await boot(page);
  // Exactly the shape the two sync-dashboard animations have, and exactly the
  // shape the old block was structurally unable to reach.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent =
      "@keyframes e2e-spin { to { transform: rotate(360deg) } }" +
      ".e2e-future-motion { position: fixed; top: 0; left: 0; width: 24px;" +
      " height: 24px; background: linear-gradient(#fff 50%, #000 50%);" +
      " animation: e2e-spin 800ms linear infinite }";
    document.head.append(style);
    const el = document.createElement("div");
    el.className = "e2e-future-motion";
    document.body.append(el);
  });

  const m = await motionOf(page, ".e2e-future-motion");
  expect(ms(m!.animation), "animation-duration").toBeLessThanOrEqual(STILL_MS);
  expect(m!.iterations, "animation-iteration-count").toBe("1");

  // And the frames agree: two captures a rotation period apart are identical.
  const el = page.locator(".e2e-future-motion");
  const a = await el.screenshot();
  await page.waitForTimeout(400);
  expect(Buffer.compare(a, await el.screenshot())).toBe(0);
});

test("without the preference, motion is left alone", async ({ page }) => {
  await boot(page, "no-preference");
  // The guard against a blanket that forgot its media query: the app's own
  // hover transitions still carry a real duration when nobody asked for less.
  const m = await motionOf(page, ".side-item");
  expect(ms(m!.transition)).toBeGreaterThan(STILL_MS);
});
