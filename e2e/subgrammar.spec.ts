import { expect, test, type Page } from "@playwright/test";

// A wikilink has three parts and an embed has two, but only the first ever
// completed — past a `#` or a `|` you were typing from memory, and callout
// accents were memory-only end to end. Now each slot offers what it accepts:
// the target note's own headings past `#`, the labels the link implies past
// `|`, the documented display modifiers past an embed's `|`, and the three
// kinds plus the ten roster hues inside `> [!`.

const menu = ".cm-tooltip-autocomplete";
const options = `${menu} li`;
const selected = `${menu} li[aria-selected="true"]`;

/** Wait for `label` to be the selected option, then Enter to accept it. Same
    75ms interactionDelay dance as e2e/slashmenu.spec.ts. */
async function accept(page: Page, label: string) {
  await expect(page.locator(selected)).toContainText(label);
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
}

/** Open the Inbox note and land the cursor on a fresh last line. */
async function openScratchNote(page: Page) {
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("`[[Welcome#` offers Welcome's own headings, in document order", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("See [[Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#");
  await expect(page.locator(menu)).toBeVisible();
  // the target note's outline, not this note's and not an alphabet — "The
  // basics" sits above "Checklists and tables" in Welcome, and would sort
  // below it in any alphabet
  await expect(page.locator(options).first()).toContainText("The basics");
  await expect(page.locator(options).filter({ hasText: "Checklists and tables" })).toHaveCount(1);
  // headings say how deep they sit
  await expect(page.locator(options).first()).toContainText("h2");

  await page.keyboard.type("Check");
  await accept(page, "Checklists and tables");
  await expect(page.locator(".cm-content")).toContainText("[[Welcome#Checklists and tables]]");
});

test("an accepted anchor is one the link actually lands on", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("See [[Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#The b");
  await accept(page, "The basics");
  await page.keyboard.press("Escape");
  await page.keyboard.type("\n\nnext line");
  await page
    .locator(".cm-wikilink", { hasText: "Welcome#The basics" })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".cm-flash-line")).toContainText("The basics");
});

test("an empty target reads this note's own headings", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("## Loose ends\n\nback to [[");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#Loose");
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(options).filter({ hasText: "Loose ends" })).toHaveCount(1);
});

test("`[[#` lists headings only — the vault's tags stay out of the slot", async ({ page }) => {
  // the mock boots with no tagged notes, so the collision this pins is
  // invisible without seeding one: `#` inside `[[` passes the tag boundary
  // rule (the char before it is `[`), and CodeMirror merges every source
  // answering at the same range
  await page.evaluate(() => {
    window.__mockEditProp!("Static Bouquet.md", "tags", ["demo"]);
  });
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));

  await openScratchNote(page);
  await page.keyboard.type("## Loose ends\n\nback to [[");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#");
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(options).filter({ hasText: "Loose ends" })).toHaveCount(1);
  await expect(page.locator(options).filter({ hasText: "demo" })).toHaveCount(0);

  // and the guard is exactly that slot — in prose the tag popup still fires
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await page.keyboard.type("\ntagged #de");
  await expect(page.locator(options).filter({ hasText: "demo" })).toHaveCount(1);
});

test("past the pipe a link offers the labels it already implies", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("See [[Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.type("#The b");
  await accept(page, "The basics");
  // an accepted anchor closes the link, so the alias slot is two keys back
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("|");
  await expect(page.locator(menu)).toBeVisible();
  // the target, the anchor, and the two joined — an alias is prose, so these
  // are starting points rather than a roster
  await expect(page.locator(options).filter({ hasText: /^Welcome$/ })).toHaveCount(1);
  await expect(page.locator(options).filter({ hasText: /^The basics$/ })).toHaveCount(1);
  await accept(page, "Welcome");
  await expect(page.locator(".cm-content")).toContainText("[[Welcome#The basics|Welcome]]");
});

test("an embed spends its pipe on a display modifier, not an alias", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("![[Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.type("|");
  await expect(page.locator(menu)).toBeVisible();
  // the documented sizes, and the float hints marked as the no-ops they are
  await expect(page.locator(options).filter({ hasText: "300x200" })).toHaveCount(1);
  await expect(page.locator(options).filter({ hasText: "not honoured" })).toHaveCount(2);
  await page.keyboard.type("300x");
  await accept(page, "300x200");
  await expect(page.locator(".cm-content")).toContainText("![[Welcome|300x200]]");
});

test("`> [!` completes the kind, and the kind's pipe completes the accent", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("> [!");
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(options)).toHaveCount(3);
  await page.keyboard.type("wa");
  await accept(page, "warn");
  await expect(page.locator(".cm-content")).toContainText("> [!warn]");

  // the accent is one keystroke away rather than written for you: back over
  // the closed header and say `|`
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("|");
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(options)).toHaveCount(10);
  await page.keyboard.type("teal");
  await accept(page, "teal");
  await expect(page.locator(".cm-content")).toContainText("> [!warn|teal]");
});

test("none of it fires inside code", async ({ page }) => {
  await openScratchNote(page);
  await page.keyboard.type("```\n[[Welcome#");
  await expect(page.locator(menu)).toHaveCount(0);
  await page.keyboard.type("\n> [!");
  await expect(page.locator(menu)).toHaveCount(0);
});
