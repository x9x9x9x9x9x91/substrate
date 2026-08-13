import { expect, test, type Page } from "@playwright/test";

/* The auto-sync lane: push debounced off edits settling, pull on
   app open / focus / interval, parked conflicts pause everything, and a
   clean pull rewrites an open note the same way a button pull does. All of
   it runs against the mock backend with shortened timers via the
   `__mockAutoSync` seam — the real debounce is two minutes. */

const FAST = {
  pushDebounceMs: 300,
  pullIntervalMs: 400,
  focusGapMs: 60_000,
};

async function bootSyncingApp(
  page: Page,
  pull: { conflicted: boolean; changed?: string[] },
  timings: typeof FAST = FAST
) {
  await page.addInitScript(
    ({ timings, plan }) => {
      window.__mockSyncConfigured = true;
      window.__mockAutoSync = timings;
      window.__mockBootPull = plan;
    },
    { timings, plan: pull }
  );
  await page.goto("/");
}

async function syncCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__mockSyncCalls?.() ?? []);
}

async function openWelcome(page: Page) {
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("a configured app pulls on open and then on the interval", async ({ page }) => {
  await bootSyncingApp(page, { conflicted: false, changed: [] });

  // Growth, never an exact snapshot: the interval keeps firing while the
  // poll reads, so an exactly-equal list can fall permanently behind the
  // timer on a loaded machine. What matters is that pulls happen unasked
  // and nothing else rides along.
  // the boot pull fires as soon as the lane sees the configured remote
  await expect.poll(async () => (await syncCalls(page)).length).toBeGreaterThanOrEqual(1);
  // …and the background interval keeps it fresh without anyone asking
  await expect.poll(async () => (await syncCalls(page)).length).toBeGreaterThanOrEqual(2);
  expect((await syncCalls(page)).every((c) => c === "vault_sync_pull")).toBe(true);
});

test("edits settle into one debounced push", async ({ page }) => {
  // interval parked far away so the only pull this spec sees is the open one
  await bootSyncingApp(
    page,
    { conflicted: false, changed: [] },
    { ...FAST, pullIntervalMs: 600_000 }
  );
  await expect.poll(() => syncCalls(page)).toEqual(["vault_sync_pull"]);

  await openWelcome(page);
  await page.locator(".cm-content").click();
  await page.keyboard.type("a thought worth keeping");

  // nothing has pushed yet — the vault is still being typed in
  expect(await syncCalls(page)).toEqual(["vault_sync_pull"]);
  await expect
    .poll(() => syncCalls(page), { timeout: 5_000 })
    .toEqual(["vault_sync_pull", "vault_sync_push"]);
});

test("a conflicted auto-pull parks the merge and pauses the lane", async ({ page }) => {
  await bootSyncingApp(page, { conflicted: true });

  // the first pull conflicts and parks; every later tick must stand down
  await expect.poll(() => syncCalls(page)).toEqual(["vault_sync_pull"]);
  await page.waitForTimeout(1_200); // three more intervals
  expect(await syncCalls(page)).toEqual(["vault_sync_pull"]);

  // and the parked merge surfaces exactly where the manual flow does
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();
  await expect(page.locator(".vault-sync-state")).toContainText("Needs attention");
});

test("an auto-pull rewrites an open note like a button pull does", async ({ page }) => {
  await bootSyncingApp(page, { conflicted: false, changed: [] });
  await expect.poll(() => syncCalls(page)).toEqual(["vault_sync_pull"]);

  await openWelcome(page);
  await expect(page.locator(".cm-content")).toContainText("plain markdown file on disk");

  // another device landed a rewrite of the open note; the next interval pull
  // checks it out and announces the paths (the same vault:pulled a button
  // pull emits — undo invalidation rides it, docs/undo.md §3.5)
  await page.evaluate(() => {
    window.__mockEditNote("Welcome.md", "# Welcome\n\nrewritten on another device\n");
    window.__mockSetPull({ conflicted: false, changed: ["Welcome.md"] });
  });

  await expect(page.locator(".cm-content")).toContainText("rewritten on another device", {
    timeout: 5_000,
  });
  // Nothing pushes after the checkout — but that is this backend's shape, not
  // the engine's: the mock has no filesystem watcher, so the files a pull
  // rewrites raise no change event and nothing arms the push debounce. The
  // real watcher does report those paths, and the push it arms finds the
  // checkout already committed and sends nothing new.
  await page.waitForTimeout(600);
  expect((await syncCalls(page)).filter((c) => c === "vault_sync_push")).toEqual([]);
});

test("the sync pane toggle switches the lane off and back on", async ({ page }) => {
  await page.addInitScript((timings) => {
    window.__mockAutoSync = timings;
  }, FAST);
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();

  // not configured yet: the switch card only shows once a remote exists
  await expect(page.getByRole("switch", { name: "Auto-sync" })).toHaveCount(0);
  await page.getByLabel("Remote URL").fill("https://sync.example.com/ada/vault.git");
  await page.getByLabel("Access token").fill("vault-token-371");
  await page.getByRole("button", { name: "Save remote" }).click();

  const toggle = page.getByRole("switch", { name: "Auto-sync" });
  await expect(toggle).toBeVisible();
  // default ON — the note never mentions the key
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // off persists through Settings.md and App's settings re-read flips the prop
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

/* The switch is only worth its pixel if the lane obeys it, which the card's
   own state cannot show. This boots an already-configured vault — a remote
   saved mid-session arms the lane only after a reload — and reads the mock's
   command log across the flip. */
test("the toggle stops the lane firing, and back on resumes it", async ({ page }) => {
  await bootSyncingApp(page, { conflicted: false, changed: [] });
  await expect.poll(() => syncCalls(page)).toEqual(["vault_sync_pull"]);

  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: "Auto-sync" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const parked = (await syncCalls(page)).length;
  await page.waitForTimeout(1_200); // three interval ticks and a push debounce
  expect((await syncCalls(page)).length).toBe(parked);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await syncCalls(page)).length).toBeGreaterThan(parked);
});
