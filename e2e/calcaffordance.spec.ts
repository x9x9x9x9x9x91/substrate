import { expect, test, type Page } from "@playwright/test";

import { docEnd, docStart } from "./keys";

// The entry points for the two computing syntaxes (vault-format §5.9/§5.10).
// Both are bare punctuation — `= 12 + 3` on a line, `` `= Sheet.summary` `` in a
// sentence — so before /calc and /live they were reachable only by having read
// the docs. These specs drive the palette and the name popup through the real
// editor: the command inserts, the popup lists what the vault actually has, and
// the accepted name resolves to a value.

const menu = ".cm-tooltip-autocomplete";
const selected = `${menu} li[aria-selected="true"]`;

/** Wait for `label` to be the selected option, then Enter. The wait past
    autocompletion's 75ms interactionDelay is load-bearing — inside it Enter
    inserts a newline instead of accepting (see slashmenu.spec.ts). */
async function accept(page: Page, label: string) {
  await expect(page.locator(selected)).toContainText(label);
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
}

/** Notes → Welcome, then a fresh last line to type on. */
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".cm-content").click();
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press(docEnd);
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
}

test("/calc opens a line that computes, and the answer lands beside it", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("/calc");
  // the palette advertises the grammar the line accepts — the reason the
  // command exists is that nothing else does
  await expect(page.locator(`${menu} .cm-completionDetail`).first()).toContainText("12 + 3");
  await accept(page, "/calc");

  // cursor sits after `= `, so the expression is simply typed on
  await page.keyboard.type("20kg in lb");
  // the answer renders beside the line rather than into the file
  await expect(page.locator(".cm-calc-result")).toBeVisible();
  await expect(page.locator(".cm-calc-result")).toContainText("lb");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Welcome.md")))
    .toContain("= 20kg in lb");
});

test("/live opens the span and the popup lists the vault's sheets", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("/live");
  await accept(page, "/live");

  // the cursor lands inside the span, and the sheet list is already up — no
  // extra keystroke to summon it, the way /view opens its db picker
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(`${menu} .cm-completionLabel`, { hasText: "Cash" })).toBeVisible();
  // only sheets — an ordinary note is not something `= …` can read
  await expect(page.locator(`${menu} .cm-completionLabel`, { hasText: /^Welcome$/ })).toHaveCount(0);
});

test("picking a sheet opens its members, and the accepted name computes", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("`= Ca");
  await expect(page.locator(menu)).toBeVisible();
  await accept(page, "Cash");

  // picking a sheet is half an answer: the dot is appended and the member
  // popup opens on the spot
  await expect(page.locator(".cm-content")).toContainText("Cash.");
  await expect(page.locator(menu)).toBeVisible();
  await accept(page, "cash_total");

  // close the span and move off the line so it renders — the name that was
  // completed is a name that resolves
  await page.keyboard.type("`");
  await page.keyboard.press(docStart);
  const chip = page.locator(".cm-live-value").last();
  await expect(chip).toBeVisible();
  // the value appears where it was typed: the sheet set follows the BUFFER
  // (NotePane samples it 400ms after the keystrokes stop), so a name completed
  // just now does not sit as a dim dash until the note is reopened
  await expect(chip).toHaveText("18.000");
  await expect(chip).not.toHaveClass(/cm-live-error/);
});

test("no name popup where a live value cannot be", async ({ page }) => {
  await boot(page);
  // inside a fence the span is code being shown, not a value being computed
  await page.keyboard.type("```bash");
  await page.keyboard.press("Enter");
  await page.keyboard.type("`= Ca");
  await expect(page.locator(menu)).toHaveCount(0);
});

/* The completion source used to read a fixed 250-char window back from the
   cursor, which a LONG SPAN outruns: `` `= 1 + 1 + … + Ca `` stops offering
   names once its opening backtick falls outside, and at exactly the window
   edge the escape hatch's first backtick falls outside instead — so the popup
   opens inside prose that was only showing the syntax. The source reads the
   cursor's line now (a span cannot cross a newline), so neither edge exists.
   The lengths below are picked against that old window on purpose. */
test("a long span still completes, and the escape hatch still stays silent", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("`= ");
  await page.keyboard.insertText("1 + ".repeat(80)); // span opener 320+ chars back
  await page.keyboard.type("Ca");
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(`${menu} .cm-completionLabel`, { hasText: "Cash" })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  // ``= … is prose ABOUT the syntax. 249 chars of span content puts the second
  // backtick exactly at the old window's first character, where the guard that
  // reads the character before it saw nothing at all.
  await page.keyboard.type("``= ");
  await page.keyboard.insertText("1 + ".repeat(61) + " ");
  await page.keyboard.type("Ca");
  await expect(page.locator(menu)).toHaveCount(0);
});
