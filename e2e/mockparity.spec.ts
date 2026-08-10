import { expect, test, type Page } from "@playwright/test";

// The mock backend must recompute a note's excerpt on
// vault_write_body like the real engine (write_body → reindex_one →
// make_excerpt). Before the fix, lists kept showing the pre-edit excerpt
// after a save — e2e went green on behavior the real app doesn't have.
// The (c) case-insensitive rename collision has no UI error surface (inline
// rename rejections are swallowed), so it's covered at IPC level in
// src/lib/tauri.test.ts instead.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

test("list row excerpt follows the edited body (SUB-290)", async ({ page }) => {
  // This timed out at 20s under full-suite load while the excerpt
  // logic was provably correct. The budget, not the app, was the failure:
  // in every captured failure `page.goto("/")` alone consumed 20.8–25.5s of
  // the 20s test budget (cold Vite transform of the app's module graph while
  // sibling workers compete for CPU), so the final assertion started after
  // the test clock had already expired and got 0.16–0.66s of its 5s window
  // instead of the full one. The excerpt itself was never slow: it lands
  // ~550ms after the keystroke on an idle machine (500ms debounce + one round
  // trip) and still ~1.5–2s under 45× CPU throttling. Reproduced 80/160 at 64
  // workers; 0/7 full-suite runs at the normal 4. So declare the boot cost
  // rather than weaken the assertion — the toHaveText below keeps its own 5s
  // budget, which is the actual coverage.
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  // replace the whole body so the first line is fully controlled, then let
  // the debounced save land and the list refetch
  const marker = `Mockparity excerpt ${Date.now()}`;
  await page.locator(".cm-content").click();
  // ControlOrMeta, not Meta: CodeMirror owns this one, and its `Mod-` binds to
  // Ctrl off macOS — the app's own shortcuts take either modifier, so only
  // editor-owned keystrokes need the platform spelling.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(`${marker}\nsecond line stays out of the excerpt`);

  // the row subtitle shows the engine-computed excerpt of the NEW body
  await expect(row(page, "Welcome").locator(".row-sub")).toHaveText(marker);
});

// The engine's fts_match_expr quotes each query token as a prefix phrase, so
// unicode61 finds hyphenated identifiers (statement numbers, cat#s) as
// consecutive word runs. The mock kept the token whole against word-split hay
// and could never match one — the palette said "no results" for identifiers
// the real app finds, and every walk judging retrieval through the mock
// inherited that blind spot.
test("palette finds a hyphenated statement number like the engine (SUB-1221)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  // the Ledger's seeded Bandcamp 2025 Q4 row carries stmt BC-2025Q4-00352 in
  // its "statement no" prop — exactly the copied-from-an-email shape
  await page.locator(".palette-input").fill("BC-2025Q4-00352");
  await expect(
    page.locator(".palette-item", { hasText: "Bandcamp 2025 Q4" })
  ).toBeVisible();
  // a cat# from the releases fixture goes through the same tokenizer
  await page.locator(".palette-input").fill("SMP-030");
  await expect(
    page.locator(".palette-item", { hasText: "Slow Bloom" })
  ).toBeVisible();
});
