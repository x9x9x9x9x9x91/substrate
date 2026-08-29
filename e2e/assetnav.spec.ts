import { expect, test, type Page } from "./fixtures";

// An asset save is an IPC round trip. Switching notes while one is in
// flight destroys the editor view the embed was going to be dispatched into,
// and CodeMirror swallows a dispatch on a destroyed view — so the file landed
// in the vault, nothing referenced it, and nothing said so. The write must
// never be silent: the toast names what the vault kept.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

// cold open lands on Today — one sidebar click to Scratch selects the first note
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* Paste stays fully in-page (Playwright-level paste is flaky) and the save
   command is held open, so the switch below is guaranteed to happen while the
   IPC is pending — the random async-dispatch window is too narrow to race. */
async function pasteHeld(page: Page, name: string) {
  // The cursor goes on the FIRST CHARACTER of the note's first line: an
  // element click lands on the element's centre, and the centre of a wrapped
  // line maps to whatever character the current type scale puts there — at
  // one size that is mid-word (the pasted embed gets its own line, caret
  // moves past it, the chip renders), at another it is the end of the line
  // (no trailing newline, the caret stays on the embed's line, and the
  // editor correctly keeps the source revealed). Pinning the click to the
  // line's first character is size-independent.
  await page.locator(".cm-line").first().click({ position: { x: 1, y: 4 } });
  await page.evaluate(() => window.__mockHoldCommand?.("vault_save_asset"));
  await page.evaluate((n) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["e2e document"], n, { type: "application/msword" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  }, name);
}

test("a paste that lands after a note switch is reported, not silently orphaned (SUB-550)", async ({
  page,
}) => {
  await boot(page);
  await pasteHeld(page, "e2e-orphan.docx");

  // leave before the save resolves — this destroys the editor view the embed
  // was headed for
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");

  // let the save land into the world it left behind
  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));

  await expect(page.locator(".toast")).toContainText("e2e-orphan.docx");
  await expect(page.locator(".toast")).toContainText("before it could be linked");
  // and it did not leak into the note the user switched TO
  await expect(page.locator(".cm-filechip")).toHaveCount(0);
});

test("a paste that resolves while the note is still open embeds normally (SUB-550)", async ({
  page,
}) => {
  await boot(page);
  await pasteHeld(page, "e2e-stays.docx");
  await page.evaluate(() => window.__mockReleaseCommand?.("vault_save_asset"));

  const chip = page.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("e2e-stays.docx");
  await expect(page.locator(".toast")).toHaveCount(0);
});
