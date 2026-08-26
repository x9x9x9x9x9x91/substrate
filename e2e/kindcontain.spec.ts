import { expect, test, type Page } from "./fixtures";

// Containment: the three ways a mounted kind used to reach past the element it
// was handed and take the pane with it. A mount that never settles left the
// pane blank forever with no card and no clue; a kind writing outside its `el`
// could empty the host and take the head with it; a `setInterval` armed at
// mount kept ticking long after its pane was gone, because only the ctx
// subscriptions were ever reclaimed. Each one is a card or a teardown now, and
// each is driven here through the real pane rather than the sandbox unit.
//
// Same seeding as the custom-kind spec: __mockWriteKind hashes through the
// real bundle hash, and the mock lane imports the module through a blob URL.

/** Returns a promise nothing ever resolves — the pane is left waiting. */
const NEVER_SETTLES = `
export default {
  mount() {
    return new Promise(() => {});
  },
};
`;

/** Draws where it was told, then appends to the body as well. */
const ESCAPES_TO_BODY = `
export default {
  mount(el) {
    const h = document.createElement("div");
    h.className = "gear-inside";
    h.textContent = "inside";
    el.appendChild(h);

    const stray = document.createElement("div");
    stray.className = "gear-stray";
    stray.textContent = "outside";
    document.body.appendChild(stray);
  },
};
`;

/** Empties the host it lives in — head, own element and all. */
const EMPTIES_THE_HOST = `
export default {
  mount(el) {
    el.parentElement.replaceChildren();
  },
};
`;

/** Rejects out of an async mount, having drawn nothing. */
const MOUNT_REJECTS = `
export default {
  async mount() {
    await Promise.resolve();
    throw new Error("gear index is empty");
  },
};
`;

/** Draws after an await and hands its cleanup back through the promise. */
const ASYNC_CLEANUP = `
export default {
  async mount(el) {
    await new Promise((r) => setTimeout(r, 30));
    window.__gearTicks = 0;
    const iv = setInterval(() => { window.__gearTicks++; }, 20);
    const h = document.createElement("div");
    h.className = "gear-inside";
    h.textContent = "ticking";
    el.appendChild(h);
    return () => {
      clearInterval(iv);
      window.__gearCleaned = (window.__gearCleaned || 0) + 1;
    };
  },
};
`;

/** Settles well inside the watchdog's wait, drawing only at the end. */
const SLOW_BUT_SETTLES = `
export default {
  async mount(el) {
    await new Promise((r) => setTimeout(r, 1200));
    const h = document.createElement("div");
    h.className = "gear-inside";
    h.textContent = "arrived";
    el.appendChild(h);
  },
};
`;

/** Paints first, then keeps loading forever — working, not stalled. */
const DRAWS_THEN_WAITS = `
export default {
  mount(el) {
    const h = document.createElement("div");
    h.className = "gear-inside";
    h.textContent = "loading gear";
    el.appendChild(h);
    return new Promise(() => {});
  },
};
`;

/** Arms an interval and never gives it back. */
const LEAKS_AN_INTERVAL = `
export default {
  mount(el) {
    window.__gearTicks = 0;
    setInterval(() => { window.__gearTicks++; }, 20);
    const h = document.createElement("div");
    h.className = "gear-inside";
    h.textContent = "ticking";
    el.appendChild(h);
  },
};
`;

function kindJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "gear-log",
    title: "Gear log",
    api: 1,
    entry: "index.js",
    description: "What is plugged into what.",
    ...over,
  });
}

async function openKind(page: Page, entry: string) {
  await page.goto("/");
  await page.evaluate(
    async ([e, m]) => {
      await window.__mockWriteKind?.({
        id: "gear-log",
        manifest: m as string,
        files: { "index.js": e as string },
        enabled: true,
      });
      window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log");
    },
    [entry, kindJson()] as const,
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("a mount that never finishes becomes a card instead of a pane that stays blank", async ({
  page,
}) => {
  await openKind(page, NEVER_SETTLES);

  // the watchdog's own wait is seconds long, so this assertion outlives the
  // default expect timeout on purpose
  // the runtime card is being renamed `.chart-err` -> `.dash-alert` alongside
  // this work, so the locator accepts either until that lands
  const err = page.locator(".chart-err, .dash-alert");
  await expect(err).toHaveCount(1, { timeout: 15000 });
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("index.js");
  await expect(err).toContainText("has not finished");

  // the head is still the app's, and neither fallback was reached
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".dash-state")).toHaveText("kind failed");
  await expect(page.locator(".dash-apr")).toHaveCount(0);
  await expect(page.locator(".dash-section-label")).toHaveCount(0);
});

test("a kind writing outside its element has it taken away and is named", async ({ page }) => {
  await openKind(page, ESCAPES_TO_BODY);

  // the runtime card is being renamed `.chart-err` -> `.dash-alert` alongside
  // this work, so the locator accepts either until that lands
  const err = page.locator(".chart-err, .dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("outside the element it was given");
  await expect(err).toContainText("<body>");

  // the stray node is gone and the kind's own output went with the refusal
  await expect(page.locator(".gear-stray")).toHaveCount(0);
  await expect(page.locator(".gear-inside")).toHaveCount(0);
  await expect(page.locator(".dash-title")).toHaveText("Overview");
});

test("a kind that empties the host gets the head put back, not a blank pane", async ({ page }) => {
  await openKind(page, EMPTIES_THE_HOST);

  // the head the kind tore out is back where it was, above the card
  await expect(page.locator(".dash-head")).toHaveCount(1);
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  // the runtime card is being renamed `.chart-err` -> `.dash-alert` alongside
  // this work, so the locator accepts either until that lands
  const err = page.locator(".chart-err, .dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("outside the element it was given");
});

test("timers a kind armed stop when its pane goes", async ({ page }) => {
  await openKind(page, LEAKS_AN_INTERVAL);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("ticking");

  // it is running while the pane is up
  await expect
    .poll(async () => page.evaluate(() => window.__gearTicks as number))
    .toBeGreaterThan(0);

  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Label Books");

  // and stopped the moment the pane left: two readings a beat apart agree
  const after = await page.evaluate(() => window.__gearTicks as number);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__gearTicks as number)).toBe(after);
});

test("a mount that rejects becomes a card, not a blank pane", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openKind(page, MOUNT_REJECTS);

  const err = page.locator(".chart-err, .dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("index.js");
  await expect(err).toContainText("gear index is empty");
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  // the author's own report is still on the console, card or no card
  expect(errors.join("\n")).toContain("gear index is empty");
});

test("the cleanup an async mount resolves still runs when the pane goes", async ({ page }) => {
  await openKind(page, ASYNC_CLEANUP);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("ticking");
  await expect
    .poll(async () => page.evaluate(() => window.__gearTicks as number))
    .toBeGreaterThan(0);

  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Label Books");

  expect(await page.evaluate(() => window.__gearCleaned as number)).toBe(1);
  const after = await page.evaluate(() => window.__gearTicks as number);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__gearTicks as number)).toBe(after);
});

/* The two guards that keep the stall watchdog off a kind that is merely
   slow. Both outlive the watchdog's own wait on purpose — a regression here
   is a card appearing, so the test has to sit past the moment it would. */

test("a slow mount that settles is left alone", async ({ page }) => {
  await openKind(page, SLOW_BUT_SETTLES);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("arrived", { timeout: 5000 });
  await page.waitForTimeout(6000);
  await expect(page.locator(".chart-err, .dash-alert")).toHaveCount(0);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("arrived");
});

test("a kind that drew and kept loading is not called stalled", async ({ page }) => {
  await openKind(page, DRAWS_THEN_WAITS);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("loading gear");
  await page.waitForTimeout(6500);
  await expect(page.locator(".chart-err, .dash-alert")).toHaveCount(0);
  await expect(page.locator(".kind-body .gear-inside")).toHaveText("loading gear");
});
