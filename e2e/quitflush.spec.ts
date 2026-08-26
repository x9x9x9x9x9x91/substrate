import { expect, test, type Page } from "./fixtures";

// The pane's 500ms save debounce is a loss window against anything
// that ends the session without unmounting the pane. On macOS ⌘Q reaches
// neither CloseRequested nor ExitRequested — it lands straight in
// RunEvent::Exit, which is synchronous and cannot await a webview round trip,
// so the buffer has to already be on its way out by the time Rust hears about
// the quit. AppKit deactivates the webview before terminating, so the fix
// rides the page-lifecycle signals: losing focus, being hidden, being torn
// down. Each spec asserts against the mock store directly (__mockBodyOf) —
// switching notes would unmount the pane and flush on the way out, which
// passes with or without the fix — and inside a window SHORTER than the
// 500ms debounce, so an unfixed build has provably not written yet.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

const bodyOf = (page: Page, path: string) =>
  page.evaluate((p) => window.__mockBodyOf!(p), path);

/** The whole proof lives in this budget: comfortably longer than the flush's
    own microtask round trip, comfortably shorter than the 500ms debounce that
    would otherwise land the same text a moment later. */
const BEFORE_DEBOUNCE = { timeout: 300, intervals: [10, 20, 30, 40, 50, 50, 50] };

test.beforeEach(async ({ page }) => {
  await boot(page);
  // land on a note whose body is short enough to assert on cheaply
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
});

const PATH = "Inbox/Capture anything.md";

test("the webview being hidden flushes the pending save (SUB-551)", async ({ page }) => {
  const marker = `E2E-QUIT-HIDE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  // still inside the 500ms debounce: nothing has reached the store yet
  expect(await bodyOf(page, PATH)).not.toContain(marker);

  // what the OS does on its way to terminating the app
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => bodyOf(page, PATH), BEFORE_DEBOUNCE).toContain(marker);
});

test("the window losing focus flushes the pending save (SUB-551)", async ({ page }) => {
  const marker = `E2E-QUIT-BLUR ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  expect(await bodyOf(page, PATH)).not.toContain(marker);

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  await expect.poll(() => bodyOf(page, PATH), BEFORE_DEBOUNCE).toContain(marker);
});

test("the page being torn down flushes the pending save (SUB-551)", async ({ page }) => {
  const marker = `E2E-QUIT-PAGEHIDE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  expect(await bodyOf(page, PATH)).not.toContain(marker);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

  await expect.poll(() => bodyOf(page, PATH), BEFORE_DEBOUNCE).toContain(marker);
});
