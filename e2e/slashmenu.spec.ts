import { expect, test } from "@playwright/test";

// Slash menu: a line-initial `/` opens the insertion palette —
// /view, /date, /task, /asset — on CodeMirror's own autocompletion extension,
// the same one the [[ wikilink popup rides. The flagship is /view: the fence it
// inserts completes its `type:` from LIVE database names, so a hub page never
// needs exact recall of a db's spelling.

const menu = ".cm-tooltip-autocomplete";
/** the highlighted row — Enter only accepts once CodeMirror has selected one */
const selected = `${menu} li[aria-selected="true"]`;

/** Wait for `label` to be the selected option, then Enter to accept it.
    The wait past autocompletion's `interactionDelay` (75ms) is load-bearing,
    not a flake patch: CodeMirror deliberately ignores Enter for that window
    after the popup opens so an in-flight keystroke can't accept an option the
    user never saw. Pressing Enter inside it inserts a newline instead. */
async function accept(page: import("@playwright/test").Page, label: string) {
  await expect(page.locator(selected)).toContainText(label);
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  // wait for the BODY to land too — the title updates a beat before the editor
  // adopts the doc, and keystrokes aimed at the outgoing note are lost
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  // land on a fresh last line — the fixture body ends in prose. Every test
  // below types its `/` there, so pin that the new line actually arrived
  // (an Enter that races the doc adopt is silently lost).
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
});

test("/ at line start opens the menu with all four commands", async ({ page }) => {
  await page.keyboard.type("/");
  await expect(page.locator(menu)).toBeVisible();
  for (const label of ["/view", "/date", "/task", "/asset"]) {
    await expect(page.locator(`${menu} .cm-completionLabel`, { hasText: label })).toBeVisible();
  }
});

test("/ mid-line after text opens nothing", async ({ page }) => {
  await page.keyboard.type("see the notes /");
  await expect(page.locator(menu)).toHaveCount(0);
  // and typing on leaves the slash as plain text
  await page.keyboard.type("view");
  await expect(page.locator(menu)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("see the notes /view");
});

test("Escape dismisses the menu and leaves the slash alone", async ({ page }) => {
  await page.keyboard.type("/vi");
  await expect(page.locator(menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("/vi");
});

test("/view inserts the fence, whose type: completes from live db names", async ({ page }) => {
  await page.keyboard.type("/view");
  await accept(page, "/view");

  // the db picker is already open on the type: line — accepting /view opens it
  // rather than making you type a letter to summon it
  await expect(page.locator(".cm-content")).toContainText("type:");
  await expect(page.locator(menu)).toBeVisible();

  await page.keyboard.type("rel");
  await accept(page, "release");

  // picking a database settles the fence, so the cursor steps out past its
  // closing line and the table renders on the spot — no raw fence source left
  // on screen to escape by hand
  const embed = page.locator(".embed-view");
  await expect(embed).toBeVisible();
  await expect(embed.locator(".embed-view-name")).toHaveText("Release");
  await expect(page.locator(".cm-content")).not.toContainText("type: release");

  // and the document itself holds a well-formed fence — the cursor landed
  // outside it, so what gets typed next is body text, not fence source
  await page.keyboard.type("after");
  await expect(page.locator(".cm-line", { hasText: "after" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md")))
    .toContain("```view\ntype: release\n```\nafter");
});

test("/task inserts the vault's checkbox shape", async ({ page }) => {
  await page.keyboard.type("/task");
  await accept(page, "/task");
  // the cursor lands after the marker, ready for the task text. The raw `- [ ]`
  // stays visible while the cursor is on that line — live preview suppresses
  // the checkbox widget on the active line by design, so you can edit the
  // markup you're typing; it renders once the cursor leaves.
  await page.keyboard.type("ship the lane");
  await expect(page.locator(".cm-content")).toContainText("- [ ] ship the lane");
  await expect(page.locator(".cm-task-line")).toBeVisible();

  // move off the line — now it's a real checkbox, not literal text
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-content input[type=checkbox]").last()).toBeVisible();
});

test("a line-initial / inside a code fence stays literal", async ({ page }) => {
  // documenting a shell command: `/date` here is a path, not a palette command.
  // If the menu opened, the Enter meaning "newline" would accept it instead.
  await page.keyboard.type("```bash");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/date");
  await expect(page.locator(menu)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toContainText("/date");
});

test("/asset opens the wikilink picker without an extra keystroke", async ({ page }) => {
  await page.keyboard.type("/asset");
  await accept(page, "/asset");
  // the cursor lands between `![[` and `]]` and the note picker is already up
  await expect(page.locator(menu)).toBeVisible();
});

test("/date inserts today in ISO form", async ({ page }) => {
  await page.keyboard.type("/date");
  await accept(page, "/date");
  const today = new Date();
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  await expect(page.locator(".cm-content")).toContainText(iso);
});
