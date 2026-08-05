import { expect, test, type Page } from "@playwright/test";

// Error surfaces and external-change lanes against the
// mock backend's e2e hooks (window.__mock*, installed by src/lib/tauri.ts
// outside Tauri). Each test gets a fresh page, so the per-page mock store and
// hook state never leak between flows.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

// cold open lands on the Notes scratch list (Today is a destination) —
// first mock note selected and loaded (same shape as smoke.spec's boot)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo: no immediate refetch, only a trailing one at window expiry
   (App.tsx) — wait the window out before emitting so the lane under
   test runs immediately */
async function emitChanged(page: Page) {
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

test("boot failure shows the boot-error bar, recovery clears it (SUB-156)", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["vault_list"]);
  });
  await page.goto("/");
  const bar = page.locator(".boot-error");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("mock failure: vault_list");

  await page.evaluate(() => window.__mockFail.clear());
  await emitChanged(page);
  await expect(bar).toHaveCount(0);
  // the vault reads again — the notes view lists and opens the first note
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(row(page, "Welcome")).toBeVisible();
});

test("save failure shows the retry pill, click retries and clears (SUB-156)", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_write_body"]);
  });
  await page.locator(".cm-content").focus();
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.keyboard.type("E2E-SAVE-FAIL");
  // autosave debounce is 500ms (NotePane onBodyChange) — the write then rejects
  const pill = page.locator(".save-error");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("save failed");
  const pillRect = await pill.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(pillRect.top).toBeGreaterThanOrEqual(0);
  expect(pillRect.bottom).toBeLessThanOrEqual(620);

  await page.evaluate(() => window.__mockFail.clear());
  await pill.click();
  await expect(pill).toHaveCount(0);
  // the retried write really landed: leave (flushes nothing — pending is
  // clear) and come back to the body re-read from the mock store
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText("E2E-SAVE-FAIL");
});

test("a save that fails on a note you already left is toasted, and Reopen has the text (SUB-549)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_write_body"]);
  });
  await page.locator(".cm-content").focus();
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.keyboard.type("E2E-ORPHAN-549");
  // leave inside the 500ms autosave debounce: the switch effect flushes, the
  // write rejects, and by then the pane is on the other note — no pill, no
  // banner, and the single pending slot now belongs to the note on screen
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Welcome");
  await expect(toast).toContainText("your text is held");

  // typing here used to destroy the held text — it overwrote the same slot
  await page.locator(".cm-content").focus();
  await page.keyboard.type("E2E-OTHER-549");

  await toast.locator("button", { hasText: "Reopen" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  // the held text is back in the editor, armed under the retry pill
  await expect(page.locator(".cm-content")).toContainText("E2E-ORPHAN-549");
  const pill = page.locator(".save-error");
  await expect(pill).toBeVisible();

  // and it really is a live buffer: with the failure cleared, the retry lands
  await page.evaluate(() => window.__mockFail.clear());
  await pill.click();
  await expect(pill).toHaveCount(0);
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText("E2E-ORPHAN-549");
});

test("a ghost day whose create fails while you're away is toasted, and Reopen has the text (SUB-558)", async ({
  page,
}) => {
  // ISO of today - 1, local, like dates.todayIso / the journal's day-step
  const p2 = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  // yesterday opens as a ghost: dated surface, no file until typed
  await page.keyboard.press("Meta+d");
  await page.locator(".daily-nav[title='Yesterday (⌘⇧←)']").click();
  const rows = page.locator(".list .row");
  await expect(rows).toHaveCount(1);

  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });
  await page.locator(".cm-content").focus();
  await page.keyboard.type("E2E-GHOST-558");
  // leave inside the 500ms autosave debounce: the switch effect flushes, the
  // create rejects, and by then the pane is on today — the ghost's text used
  // to go back into `pending`, a slot that now belongs to the note on screen
  await rows.first().click();
  const humanToday = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  await expect(page.locator(".note-title-daily")).toHaveText(humanToday);
  await expect(rows).toHaveCount(1); // the failed create made no file

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(yesterday);
  await expect(toast).toContainText("your text is held");

  // typing here used to destroy the held text — it overwrote the same slot
  await page.locator(".cm-content").focus();
  await page.keyboard.type("E2E-TODAY-558");

  await toast.locator("button", { hasText: "Reopen" }).click();
  // the day re-opens as a ghost (it still has no file) with its text back,
  // armed under the retry pill
  await expect(page.locator(".cm-content")).toContainText("E2E-GHOST-558");
  const pill = page.locator(".save-error");
  await expect(pill).toBeVisible();

  // and it really is a live buffer: with the failure cleared, the retry
  // creates the day for real and its row joins the journal list
  await page.evaluate(() => window.__mockFail.clear());
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-path", `Journal/${yesterday}.md`);
  await expect(page.locator(".cm-content")).toContainText("E2E-GHOST-558");
});

test("capture failure keeps the text and shows the error, retry files it (SUB-156)", async ({
  page,
}) => {
  // Match the real non-resizable capture window. The phone palette media
  // rule also applies at 620px, and used to cap the palette at 56px so this
  // error existed in the DOM but was clipped below its overflow boundary.
  await page.setViewportSize({ width: 620, height: 88 });
  await page.addInitScript(() => {
    window.__mockFail = new Set(["vault_create"]);
  });
  await page.goto("/capture.html");
  const input = page.locator(".palette-input");
  await input.fill("capture-retry-me");
  await input.press("Enter");
  const err = page.locator(".capture-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("mock failure: vault_create");
  const errorRect = await err.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(errorRect.top).toBeGreaterThanOrEqual(0);
  expect(errorRect.bottom).toBeLessThanOrEqual(88);
  // the text survived the failure — ready to retry or copy out
  await expect(input).toHaveValue("capture-retry-me");

  await page.evaluate(() => window.__mockFail.clear());
  await input.press("Enter");
  await expect(err).toHaveCount(0);
  // only the success path clears the input
  await expect(input).toHaveValue("");
});

test("external edit to a clean note swaps the editor body, no banner (SUB-158)", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "DISK-SWAP-158 external body\n"));
  await emitChanged(page);
  await expect(page.locator(".cm-content")).toContainText("DISK-SWAP-158 external body");
  // a clean buffer adopts silently — the conflict banner stays away
  await expect(page.locator(".note-banner")).toHaveCount(0);
});

test("external edit inside the echo window surfaces late, not never (SUB-239)", async ({
  page,
}) => {
  await boot(page);
  // no 1100ms wait this time: the event lands inside the boot refresh's echo
  // window, where the echo window used to drop it — the edit only surfaced on the
  // next watcher event. A trailing refresh at window expiry picks it up.
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "ECHO-239 late external body\n"));
  await page.evaluate(() => window.__mockEmit("vault:changed"));
  await expect(page.locator(".cm-content")).toContainText("ECHO-239 late external body");
});

test("external edit under a dirty buffer raises the conflict banner; Reload takes disk (SUB-158)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  // disk diverges from the editor's disk-known body before the user types —
  // no vault:changed here, the autosave flush is what discovers it
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "DISK-WINS-158\n"));
  await page.locator(".cm-content").focus();
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.keyboard.type("TYPED-158");
  // the flush carries the stale expected-body → the mock's conflict guard
  // (tauri.ts mirror) rejects → banner with the two choices
  const banner = page.locator(".note-banner");
  await expect(banner).toBeVisible();
  await expect(banner.locator("button", { hasText: "Reload" })).toBeVisible();
  await expect(banner.locator("button", { hasText: "Overwrite" })).toBeVisible();
  const bannerRect = await banner.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(bannerRect.top).toBeGreaterThanOrEqual(0);
  expect(bannerRect.bottom).toBeLessThanOrEqual(620);

  await banner.locator("button", { hasText: "Reload" }).click();
  await expect(page.locator(".cm-content")).toContainText("DISK-WINS-158");
  await expect(page.locator(".cm-content")).not.toContainText("TYPED-158");
  await expect(banner).toHaveCount(0);
});

test("Reload on a note that vanished mid-conflict says so instead of doing nothing (SUB-506)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 620 });
  await boot(page);
  // same conflict setup as above: disk diverges, then the user types
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "DISK-506\n"));
  await page.locator(".cm-content").focus();
  await page.keyboard.type("TYPED-506");
  const banner = page.locator(".note-banner");
  await expect(banner).toBeVisible();

  // ...and while the banner waits for a choice, the file goes away entirely
  await page.evaluate(() => window.__mockDeleteNote!("Welcome.md"));
  await banner.locator("button", { hasText: "Reload" }).click();

  // the reload read rejects — the pane has to say the file is gone. Before
  // The rejection was swallowed by an isGoneErr guard that the backend
  // never satisfies, leaving the stale buffer on screen looking live.
  await expect(page.locator(".note-banner", { hasText: "file is gone" })).toBeVisible();
  // the typed text stays reachable — this is the fileGone banner, not the
  // full-pane empty state that would wipe it
  await expect(page.locator(".cm-content")).toContainText("TYPED-506");
});

test("asset re-bounce rebinds the audio player under a new cache key (SUB-158)", async ({
  page,
}) => {
  await boot(page);
  // seed an audio embed via an external edit, pulled in by the watcher lane
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "audio embed\n\n![[test.wav]]\n"));
  await emitChanged(page);
  await expect(page.locator(".cm-audio")).toBeVisible();
  await expect(page.locator(".cm-audio-name")).toHaveText("test.wav");

  // peaks decode once the embed scrolls into view; the localStorage
  // entry keys by the asset's cacheKey path:size:mtime (assets.ts) —
  // the rebind reuses the widget DOM in place, so this cache artifact is the
  // observable proof that the re-stat → new cacheKey → rebind chain ran
  const peaksKey = (mtime: number) => `substrate:peaks:v1:mock://test.wav:16:${mtime}`;
  await page.waitForFunction((k) => localStorage.getItem(k) !== null, peaksKey(1));

  // a re-bounce: same name, new mtime → new cacheKey → refreshAudioPlayers
  // rebinds and recomputes peaks under the new key
  await page.evaluate(() => window.__mockTouchAsset("test.wav"));
  await emitChanged(page);
  await page.waitForFunction((k) => localStorage.getItem(k) !== null, peaksKey(2));
  // rebound, not evicted: the player is still there, not the missing state
  await expect(page.locator(".cm-audio")).toBeVisible();
  await expect(page.locator(".cm-audio-missing")).toHaveCount(0);
});
