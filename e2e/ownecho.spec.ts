import { expect, test, type Page } from "@playwright/test";

// SUB-296: with the mock's opt-in own-write echo on, a completed save echoes
// vault:changed exactly like the engine's watcher — and the open editor must
// NOT adopt its own echo (SUB-116 invariant): the save round-trip leaves the
// buffer untouched (no adopt flash, no remount) and the text lands on disk.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

// cold open lands on the Notes scratch list (Today is hidden, SUB-299)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

const echoCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __echoCount?: number }).__echoCount ?? 0);

const domTag = (page: Page) =>
  page
    .locator(".cm-content")
    .evaluate((el) => (el as unknown as { __tag?: number }).__tag ?? 0);

test("a save echoes once and the open editor never adopts its own echo (SUB-296)", async ({
  page,
}) => {
  await boot(page);
  const ed = page.locator(".cm-content");
  await page.evaluate(() => {
    window.__mockSetEchoOnWrites?.(true);
    // count watcher echoes as they fire — the flag's proof of life
    (window as unknown as { __echoCount: number }).__echoCount = 0;
    const orig = window.__mockEmit!;
    window.__mockEmit = (event: string, payload?: unknown) => {
      if (event === "vault:changed") {
        (window as unknown as { __echoCount: number }).__echoCount++;
      }
      orig(event, payload);
    };
  });
  // tag the editor's DOM node — a remount (the adopt flash) replaces it
  await ed.evaluate((el) => ((el as unknown as { __tag: number }).__tag = 42));

  const marker = `E2E-ECHO ${Date.now()}`;
  await ed.click();
  await page.keyboard.insertText(marker);

  // one completed save → exactly one watcher echo (engine cadence: the 500ms
  // debounced save, then the watcher's 300ms quiet window)
  await expect.poll(() => echoCount(page)).toBe(1);
  // settle past the app's 1s own-echo window (SUB-116) so the trailing
  // refresh and the open-note re-read have fully run
  await page.waitForTimeout(1600);

  // the invariant: buffer untouched, same DOM node — no remount flash
  await expect(ed).toContainText(marker);
  await expect.poll(() => domTag(page)).toBe(42);

  // a second save round-trip echoes exactly once more, still no adopt
  const more = `E2E-ECHO-MORE ${Date.now()}`;
  await ed.click();
  await page.keyboard.insertText(more);
  await expect.poll(() => echoCount(page)).toBe(2);
  await expect(ed).toContainText(marker);
  await expect(ed).toContainText(more);

  // disk truth: leave (unmount flushes anything pending) and come back — the
  // body is re-read from the mock store with both saves intact
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(ed).toContainText(marker);
  await expect(ed).toContainText(more);
});

/* SUB-660: the four database/property bulk sweeps rewrite ordinary notes, so
   with the echo flag on the watcher reports them exactly like any other write.
   Before the fix the app recorded no own-write for them, and ~300ms later its
   own echo came back classified as somebody ELSE's edit — which marks every
   undo entry touching a swept note stale (or, past RESCAN_THRESHOLD, flattens
   the whole stack). Here: a property edit on a Contact note, then a rename of
   that very database, and ⌘Z must still run the edit. */
test("a database rename does not stale the undo entries on its notes (SUB-660)", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Contact" }).click();
  await expect(page.locator(".list-title")).toHaveText("Contact");

  // an undoable property edit — this is the entry the sweep must not stale
  const roleCol = await page
    .locator(".db-table thead th")
    .evaluateAll((ths) =>
      ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith("role"))
    );
  const cell = () =>
    page.locator(".db-table tbody tr", { hasText: "Gero" }).locator("td").nth(roleCol);
  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell()).toHaveText("booking");

  // the sweep: rename the database the edited note belongs to
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const contactRow = page.locator(".dbmgr-row", { hasText: "Contact" });
  await contactRow.locator(".dbmgr-menu").click();
  await page.locator(".ctx-item", { hasText: "Rename database…" }).click();
  const rename = page.locator(".dbform");
  await rename.locator(".dbform-input").fill("person660");
  await rename.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".dbmgr-row", { hasText: "person660" })).toBeVisible();

  // let the sweep's own echo land (watcher debounce 300ms) and the app's
  // 1s own-write window close, so a mis-classification has fully played out
  await page.waitForTimeout(1600);

  // the invariant: the edit is still invertible, not refused as changed-on-disk
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(page.locator(".toast")).not.toContainText("changed on disk");

  // and it landed: the value is back on the note, under the renamed database
  await page.locator(".dbmgr-row", { hasText: "person660" }).click();
  // (the pane title-cases the type for display — DatabasePane.tsx:1314)
  await expect(page.locator(".list-title")).toHaveText("Person660");
  await expect(cell()).toHaveText("mix engineer");
});
