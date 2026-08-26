import { expect, test, type Page } from "./fixtures";

// Both shortcut hint surfaces render from held state rather than from a
// key event, so they used to normalize `typing` away and advertise the
// surface-scoped chords — Move note to Trash ⌘⌫, Back ⌘[, Previous / next
// journal day ⌘⇧←/→ — while the caret sat in a text edit and those chords
// provably do not fire (shortcuts.spec.ts:58 asserts ⌘⇧→ mid-edit keeps the
// day). Each test here asserts both halves: absent while typing, present when
// focus is outside a text edit, so neither can pass on an empty panel.

/** Open a journal note and put the caret in its body. ⌘D gives a `daily`
    context, which is what arms the journal-step row in the first place.

    ⌘D autofocuses the editor asynchronously, so wait for `cm-focused` BEFORE
    typing — keystrokes sent into the gap land on the body and leave focus
    outside any text edit, which is the opposite of what these tests set up. */
async function typeInJournal(page: Page) {
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".note-title-daily")).toBeVisible();
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
  await page.keyboard.type("hint context ");
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
}

/** Cold open, optionally with the click panel already unfolded.

    The panel remembers being open across launches (localStorage),
    which is also the only way to have it up while the caret is in a text edit:
    clicking the chip focuses the chip, and from there the surface chords really
    do fire, so that reading would be honest either way. An open panel hides the
    hold HUD (they never share the screen), so the HUD tests boot without it. */
async function boot(page: Page, opts: { panelOpen?: boolean } = {}) {
  if (opts.panelOpen) {
    await page.addInitScript(() => localStorage.setItem("substrate.keyHints", "1"));
  }
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Notes — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // both surfaces listen from effects, which flush after the commit that
  // painted the list — a key sent on that paint can land before anything is
  // listening (modkeyhud.spec.ts pays the same toll)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

test("the click panel drops the surface rows while the caret is in the editor (SUB-498)", async ({
  page,
}) => {
  await boot(page, { panelOpen: true });
  await typeInJournal(page);
  const panel = page.locator(".keyhints-panel");
  await expect(panel).toBeVisible();

  // Of the surface rows, the journal step is the one that fits the panel's
  // 12-row cap in this context — ⌘⌫ and ⌘[ fall off the tail either way, so
  // asserting their absence here would pass on the cap, not on the gate.
  const journal = panel.locator(".shortcut-row-label", { hasText: "Previous / next journal day" });
  await expect(journal).toHaveCount(0);
  // not an empty panel: the globals and the editor surface holding the caret
  // stay, because those really do fire mid-edit
  await expect(panel.locator(".shortcut-row-label", { hasText: "Bold" })).toBeVisible();
  await expect(panel.locator(".shortcut-row-label", { hasText: "Search notes" })).toBeVisible();

  // the discriminating half — Tab leaves the editor for its toolbar without
  // closing the panel, and the row comes back to the very same panel
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(0);
  await expect(journal).toBeVisible();
});

test("the click panel re-answers when focus enters the editor under it (SUB-498)", async ({
  page,
}) => {
  // The panel outlives the focus it opened against: it is restored open at
  // launch against a body-focused app, and ⌘D then moves focus into the journal
  // editor with no click, so nothing folds the panel away. A value read once at
  // open would keep advertising ⌘⇧←/→ into a live text edit.
  await boot(page, { panelOpen: true });
  const panel = page.locator(".keyhints-panel");
  const journal = panel.locator(".shortcut-row-label", { hasText: "Previous / next journal day" });
  await expect(panel).toBeVisible();

  await page.keyboard.press("Meta+d");
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
  await page.keyboard.type("under the panel ");
  await expect(panel).toBeVisible();
  await expect(journal).toHaveCount(0);

  // and back out, twice over, so this cannot pass on a one-shot flip
  await page.keyboard.press("Tab");
  await expect(journal).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
  await expect(journal).toHaveCount(0);
});

test("the hold-⌘ HUD drops the surface rows while typing (SUB-498)", async ({ page }) => {
  await boot(page);
  await typeInJournal(page);

  // hold ⌘ from inside the editor: the HUD arms on a 250ms dwell and samples
  // focus at that moment
  await page.keyboard.down("Meta");
  const hud = page.locator(".modkey-hud");
  await expect(hud).toBeVisible();
  const rows = page.locator(".modkey-hud-row");
  await expect(rows.filter({ hasText: "Move note to Trash" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Back" })).toHaveCount(0);
  // ⌘K / ⌘N fire from anywhere, so the HUD is narrowed, not emptied
  await expect(rows.filter({ hasText: "Command palette" })).toBeVisible();
  await page.keyboard.up("Meta");

  // ⌘⇧ from inside the editor: the journal step is the chord the editor itself
  // claims for selection extension
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await expect(hud).toBeVisible();
  await expect(rows.filter({ hasText: "Previous / next journal day" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Search notes" })).toBeVisible();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");

  // the discriminating half — focus out of the editor and every row is back
  await page.locator(".sidebar-title").click();
  await page.keyboard.down("Meta");
  await expect(hud).toBeVisible();
  await expect(rows.filter({ hasText: "Move note to Trash" })).toBeVisible();
  await expect(rows.filter({ hasText: "Back" })).toBeVisible();
  await page.keyboard.up("Meta");

  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await expect(rows.filter({ hasText: "Previous / next journal day" })).toBeVisible();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
});

test("the HUD re-samples focus on every hold, not once per mount (SUB-498)", async ({ page }) => {
  // typing → out → typing without a reload: a value read once at mount (or
  // memoized on App's render state) would be stale on the second and third leg
  await boot(page);
  await typeInJournal(page);
  const rows = page.locator(".modkey-hud-row");
  const trash = rows.filter({ hasText: "Move note to Trash" });

  await page.keyboard.down("Meta");
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(trash).toHaveCount(0);
  await page.keyboard.up("Meta");

  await page.locator(".sidebar-title").click();
  await page.keyboard.down("Meta");
  await expect(trash).toBeVisible();
  await page.keyboard.up("Meta");

  await page.locator(".cm-content").click();
  await page.keyboard.type("again");
  await page.keyboard.down("Meta");
  await expect(page.locator(".modkey-hud")).toBeVisible();
  await expect(trash).toHaveCount(0);
  await page.keyboard.up("Meta");
});
