import { expect, test, type Page } from "@playwright/test";

// Custom dashboard kinds (SUB-960): a `dashboard:` value naming a bundle in
// the vault mounts that bundle's mount(el, ctx) module behind the standard
// head. Every state that can't run — review pending, api out of range, an
// invalid bundle, a module that throws — renders a card naming the kind and
// the file, and the head survives all of them. The one thing a named kind
// must NEVER do is fall through to charts-or-yield: that fallback belongs to
// notes naming no kind at all, and using it here would answer "show me
// gear-log" with a yield tracker (the SUB-993 regression, one layer down).
//
// The mock lane has no `substrate-kind:` scheme, so the pane imports the same
// source through a blob URL (gated on !isTauri; the shipped CSP allows the
// scheme and not blob:). Bundles are seeded with __mockWriteKind, which hashes
// through the real hashKindBundle — so a drifted hash here drifts for the same
// reason it would on disk.

const ENTRY = `
export default {
  mount(el, ctx) {
    const h = document.createElement("div");
    h.className = ctx.css["dash-hero"];
    h.textContent = "gear rack: " + ctx.note.title;
    el.appendChild(h);

    const api = document.createElement("div");
    api.className = "gear-api";
    api.textContent = "api " + ctx.api;
    el.appendChild(api);

    ctx.setState({ label: "3 racks" });
  },
};
`;

const THROWS = `
export default {
  mount() {
    throw new TypeError("rack.map is not a function");
  },
};
`;

/** Subscribes, records that it did, then throws — the mid-life failure whose
    teardown has to run even though the effect's deps never changed. */
const SUBSCRIBES_THEN_THROWS = `
export default {
  mount(el, ctx) {
    window.__gearTicks = 0;
    ctx.onChange(() => { window.__gearTicks++; });
    throw new TypeError("rack.map is not a function");
  },
};
`;

/** Counts its own cleanup calls, so a re-mount can prove the previous run was
    torn down rather than abandoned. */
const COUNTS_CLEANUP = `
export default {
  mount(el, ctx) {
    window.__gearCleanups = window.__gearCleanups ?? 0;
    const h = document.createElement("div");
    h.className = ctx.css["dash-hero"];
    h.textContent = "rewritten: " + ctx.note.title;
    el.appendChild(h);
    return () => { window.__gearCleanups++; };
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

/** Seed a bundle, point Overview at it, open it. */
async function openKind(
  page: Page,
  bundle: {
    manifest?: string;
    entry?: string;
    enabled?: boolean;
    enabledHash?: string;
    files?: Record<string, string>;
  } = {},
) {
  await page.goto("/");
  await page.evaluate(
    async ([manifest, entry, enabled, enabledHash, extra]) => {
      await window.__mockWriteKind?.({
        id: "gear-log",
        manifest: manifest as string,
        files: { "index.js": entry as string, ...(extra as Record<string, string>) },
        enabled: enabled as boolean,
        enabledHash: (enabledHash as string) || undefined,
      });
      window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log");
    },
    [
      bundle.manifest ?? kindJson(),
      bundle.entry ?? ENTRY,
      bundle.enabled ?? true,
      bundle.enabledHash ?? "",
      bundle.files ?? {},
    ] as const,
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

/** Neither of the two fallbacks the pane must never reach. */
async function noFallback(page: Page) {
  // the yield tracker (its hero and its snapshot form)
  await expect(page.locator(".dash-apr")).toHaveCount(0);
  await expect(page.locator(".dash-form")).toHaveCount(0);
  // and the charts renderer, though Overview's body is full of chart fences
  await expect(page.locator(".dash-section-label")).toHaveCount(0);
}

test("an enabled bundle mounts and renders behind the standard head", async ({ page }) => {
  await openKind(page);

  // the kind's own output, inside the element the host handed it
  const body = page.locator(".kind-host .kind-body");
  await expect(body).toHaveCount(1);
  await expect(body.locator(".dash-hero")).toHaveText("gear rack: Overview");
  // ctx.api is the number the build speaks, not a string the kind guessed
  await expect(body.locator(".gear-api")).toHaveText("api 1");

  // the head is the app's, not the kind's: title, ctx.setState's dot, source
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".dash-state")).toHaveText("3 racks");
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await noFallback(page);

  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Overview");
});

test("a bundle that has not been enabled shows its card, not the fallback", async ({ page }) => {
  await openKind(page, { enabled: false });

  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("has not been enabled");
  await expect(err).toContainText("index.js");
  // the card says out loud that it is standing in for SUB-961's review flow
  await expect(err.locator(".dash-sub")).toContainText("Placeholder card");

  // head intact, and the kind's code never ran
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".dash-state")).toHaveText("review pending");
  await expect(page.locator(".kind-body")).toHaveCount(0);
  await noFallback(page);
});

test("a bundle whose bytes changed since it was enabled shows drift, not the fallback", async ({
  page,
}) => {
  await openKind(page, {
    enabled: true,
    enabledHash: "sha256:" + "f".repeat(64),
  });

  const err = page.locator(".chart-err");
  await expect(err).toContainText("changed since you enabled it");
  await expect(page.locator(".dash-state")).toHaveText("review pending");
  await expect(page.locator(".kind-body")).toHaveCount(0);
  await noFallback(page);
});

test("a bundle written for a newer api names both versions", async ({ page }) => {
  await openKind(page, { manifest: kindJson({ api: 9 }) });

  const err = page.locator(".chart-err");
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("api 9");
  await expect(err).toContainText("api 1");
  await expect(page.locator(".dash-state")).toHaveText("needs a newer Substrate");
  await expect(page.locator(".kind-body")).toHaveCount(0);
  await noFallback(page);
});

test("a bundle that throws at mount shows the runtime card with the head intact", async ({
  page,
}) => {
  await openKind(page, { entry: THROWS });

  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("index.js");
  await expect(err).toContainText("rack.map is not a function");
  // a runtime failure is not a review state — no stub note under it
  await expect(err.locator(".dash-sub")).toHaveCount(0);

  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".dash-state")).toHaveText("kind failed");
  // the pane never blanks: the head and the card are both there
  await expect(page.locator(".dash-head")).toHaveCount(1);
  await noFallback(page);

  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Overview");
});

/** Re-seed a bundle and let the app notice: the bundle list is cached per
    vault epoch, so a rewrite on disk only reaches the pane once something
    bumps the epoch — which is exactly what the watcher does in the app. */
async function rewriteKind(page: Page, entry: string, manifest = kindJson()) {
  await page.evaluate(
    async ([e, m]) => {
      await window.__mockWriteKind?.({
        id: "gear-log",
        manifest: m as string,
        files: { "index.js": e as string },
        enabled: true,
      });
      window.__mockEmit?.("vault:changed", [".vault/kinds/gear-log/index.js"]);
    },
    [entry, manifest] as const,
  );
}

test("a kind rewritten after it failed recovers in place, without a relaunch", async ({ page }) => {
  // The point of hashing the bundle into the module URL: an agent rewriting a
  // broken kind is a hot swap. That only works if the failed pane keeps a live
  // host to re-mount into — a failure that swaps the host out for the card
  // leaves every later run bailing on a null ref, and the stale error card
  // stays until the user navigates away and back.
  await openKind(page, { entry: THROWS });
  await expect(page.locator(".chart-err")).toContainText("rack.map is not a function");
  await expect(page.locator(".dash-state")).toHaveText("kind failed");

  await rewriteKind(page, COUNTS_CLEANUP);

  // same pane, never left: the rewritten code runs and the card is gone
  const body = page.locator(".kind-host .kind-body");
  await expect(body.locator(".dash-hero")).toHaveText("rewritten: Overview");
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await noFallback(page);
});

test("a working kind rewritten to a broken one shows a card that names it", async ({ page }) => {
  // The other ordering, and the one that used to render an empty card: React
  // reused one DOM node for the host and the card, and the pane's cleanup
  // called replaceChildren on it — wiping the children React owned. The card
  // must always carry its sentence.
  await openKind(page);
  await expect(page.locator(".kind-host .kind-body .dash-hero")).toHaveText("gear rack: Overview");

  await rewriteKind(page, THROWS);

  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("gear-log");
  await expect(err).toContainText("index.js");
  await expect(err).toContainText("rack.map is not a function");
  await expect(page.locator(".dash-state")).toHaveText("kind failed");
  // and the previous run's element went with it, rather than sitting under
  // the card as output from code that is no longer running
  await expect(page.locator(".kind-body")).toHaveCount(0);
  await noFallback(page);
});

test("a mid-life failure runs the kind's cleanup and drops its subscriptions", async ({ page }) => {
  // A failure after mount flips render but does NOT change the effect's deps,
  // so the effect cleanup will not run until the pane truly unmounts. Anything
  // the kind registered before it failed — timers, listeners, ctx.onChange —
  // would keep running behind the error card. Both halves asserted: the
  // previous run's cleanup ran, and its onChange no longer fires.
  await openKind(page, { entry: COUNTS_CLEANUP });
  await expect(page.locator(".kind-body .dash-hero")).toHaveText("rewritten: Overview");
  // the counter the kind sets up at mount, still at zero: nothing has torn down
  expect(
    await page.evaluate(() => (window as never as { __gearCleanups?: number }).__gearCleanups),
  ).toBe(0);

  await rewriteKind(page, SUBSCRIBES_THEN_THROWS);
  await expect(page.locator(".chart-err")).toContainText("rack.map is not a function");

  // the first kind's cleanup ran on the way out — exactly once
  expect(
    await page.evaluate(() => (window as never as { __gearCleanups?: number }).__gearCleanups),
  ).toBe(1);

  // and the failed kind's own onChange, subscribed before it threw, is gone:
  // a vault change fires no handler behind the error card
  await page.evaluate(() => window.__mockEmit?.("vault:changed", ["Dashboards/Overview.md"]));
  await expect(page.locator(".chart-err")).toContainText("rack.map is not a function");
  expect(await page.evaluate(() => (window as never as { __gearTicks?: number }).__gearTicks)).toBe(
    0,
  );
});

test("a stylesheet in the bundle is injected for the pane and taken out again", async ({
  page,
}) => {
  await openKind(page, {
    manifest: kindJson({ style: "kind.css" }),
    files: { "kind.css": ".gear-api { color: rgb(1, 2, 3); }" },
  });

  const api = page.locator(".kind-body .gear-api");
  await expect(api).toHaveCSS("color", "rgb(1, 2, 3)");

  // leaving the pane takes the <style> with it — a kind must not restyle the
  // next dashboard it happens to be followed by
  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Label Books");
  await expect(page.locator("style[data-kind='gear-log']")).toHaveCount(0);
});

test("a custom kind renders as a workbook page too", async ({ page }) => {
  // SUB-464 workbook pages route every dashboard page back through
  // DashboardBody, so the custom branch should be inherited — verified here
  // rather than assumed. Label Books' page list gains a page pointing at
  // Overview, which is the custom kind.
  await page.goto("/");
  await page.evaluate(async ([entry, manifest]) => {
    await window.__mockWriteKind?.({
      id: "gear-log",
      manifest: manifest as string,
      files: { "index.js": entry as string },
      enabled: true,
    });
    window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log");
    window.__mockEditProp?.("Dashboards/Label Books.md", "pages", [
      { label: "Gear", note: "Overview" },
    ]);
  }, [ENTRY, kindJson()] as const);

  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Label Books");

  await page.locator(".wb-tab", { hasText: "Gear" }).click();
  const body = page.locator(".kind-host .kind-body");
  await expect(body.locator(".dash-hero")).toHaveText("gear rack: Overview");
  // the tab strip is still the workbook's, and the page has its own head
  await expect(page.locator(".wb-tabs")).toHaveCount(1);
  await expect(page.locator(".chart-err")).toHaveCount(0);
});

test("a disabled kind on a workbook page shows its card, not the fallback", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async ([entry, manifest]) => {
    await window.__mockWriteKind?.({
      id: "gear-log",
      manifest: manifest as string,
      files: { "index.js": entry as string },
    });
    window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", "gear-log");
    window.__mockEditProp?.("Dashboards/Label Books.md", "pages", [
      { label: "Gear", note: "Overview" },
    ]);
  }, [ENTRY, kindJson()] as const);

  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await page.locator(".wb-tab", { hasText: "Gear" }).click();

  await expect(page.locator(".chart-err")).toContainText("has not been enabled");
  await expect(page.locator(".kind-body")).toHaveCount(0);
  await noFallback(page);
});
