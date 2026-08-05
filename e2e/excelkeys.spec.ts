import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// SUB-947: the spreadsheet keyboard grammar for database tables. Before this,
// every commit closed the editor and stranded focus — filling a column meant
// re-pressing Enter on every single cell. Now Enter commits and carries the
// editor down, Tab carries it across (wrapping at the row ends), a printable
// key on a focused cell opens the editor already holding it, and F2 edits in
// place without replacing. Escape is untouched; checkbox and rollup cells have
// no text editor and the hop steps over the derived ones.

/** td index of a column, which is also its data-fc coordinate (td 0 = title) */
function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

/** move keyboard focus onto a cell without a mouse: the roving tab stop takes
    DOM focus on the title cell, arrows walk from there */
async function focusCell(page: Page, fc: number, fr: number) {
  await page.locator('.db-table [data-fc="0"][data-fr="0"]').focus();
  for (let r = 0; r < fr; r++) await page.keyboard.press("ArrowDown");
  for (let c = 0; c < fc; c++) await page.keyboard.press("ArrowRight");
  await expect(page.locator(`.db-table [data-fc="${fc}"][data-fr="${fr}"]`)).toBeFocused();
}

/** a small database carrying a rollup column, built the way rollup.spec does:
    a relation into the seeded Ledger, then a Sum rollup over its `gross` */
async function newRollupDatabase(page: Page) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill("Hoprol");
  await form.locator(".dbform-addprop").click();
  const prow = form.locator(".dbform-proprow").last();
  await prow.locator(".dbform-input").fill("entries");
  await prow.locator(".dbform-select").first().click();
  await page.getByRole("option", { name: "Relation", exact: true }).click();
  await prow.locator(".dbform-select").last().click();
  await page.getByRole("option", { name: "ledger", exact: true }).click();
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText("Hoprol");

  // one entry, so the table has a row to hop along
  const empty = page.locator(".empty-action");
  if ((await empty.count()) > 0) await empty.click();
  else await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  await draft.fill("HX1");
  await draft.press("Enter");
  await expect(page.locator(".db-title-txt", { hasText: /^HX1$/ })).toHaveCount(1);

  // the rollup prop through the ＋ add-property popover
  await page.locator(".db-add-btn").click();
  const pop = page.locator(".selmenu");
  await pop.locator(".dbprop-name").fill("earned");
  await pop.locator(".selmenu-kind", { hasText: "Rollup" }).click();
  await pop
    .getByRole("listbox", { name: "Property to roll up" })
    .getByRole("option", { name: "gross" })
    .click();
  await pop.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(pop).toHaveCount(0);
}

/** the one cell currently hosting an open editor */
const editing = (page: Page) => page.locator(".db-table td.db-cell.editing");

async function expectEditingAt(page: Page, fc: number, fr: number) {
  await expect(editing(page)).toHaveAttribute("data-fc", String(fc));
  await expect(editing(page)).toHaveAttribute("data-fr", String(fr));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Ledger");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(10);
});

test("a printable key opens the editor already holding it (SUB-947)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  await focusCell(page, notes, 0);
  // h/j/k/l are letters here, not vim nav — a data cell has to be typeable
  await page.keyboard.press("k");
  await expectEditingAt(page, notes, 0);
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue("k");
  // the rest of the word lands after it: type-to-replace, not type-then-lose
  await page.keyboard.type("ickoff");
  await expect(input).toHaveValue("kickoff");
});

test("Enter commits and carries the editor down the column (SUB-947)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  await focusCell(page, notes, 0);
  await page.keyboard.press("d");
  await page.keyboard.type("own-one");
  await page.keyboard.press("Enter");

  // the editor is now on the cell BELOW, same column, without a second press
  await expectEditingAt(page, notes, 1);
  await expect(page.locator(".db-table tbody tr").nth(0).locator("td").nth(notes)).toHaveText(
    "down-one"
  );
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "notes"), `${titles[0]}.md`)
  ).toBe("down-one");

  // Shift-Enter walks back up the column the way Shift-Tab walks left
  await page.keyboard.press("Shift+Enter");
  await expectEditingAt(page, notes, 0);
});

test("Enter on the last row commits, closes, and keeps focus (SUB-947)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  const last = titles.length - 1;
  await focusCell(page, notes, last);
  await page.keyboard.press("e");
  await page.keyboard.type("nd-of-column");
  await page.keyboard.press("Enter");

  // spreadsheet behaviour at the bottom: saved, editor gone, focus stays put
  await expect(editing(page)).toHaveCount(0);
  await expect(page.locator(`.db-table [data-fc="${notes}"][data-fr="${last}"]`)).toBeFocused();
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "notes"), `${titles[last]}.md`)
  ).toBe("end-of-column");
});

test("Tab carries the editor across, wrapping at the row ends (SUB-947)", async ({ page }) => {
  const period = await colIndex(page, "period");
  await focusCell(page, period, 0);
  await page.keyboard.press("q");
  await page.keyboard.type("2 sideways");
  await page.keyboard.press("Tab");
  // one cell to the right, still editing
  await expectEditingAt(page, period + 1, 0);
  await expect(page.locator(".db-table tbody tr").nth(0).locator("td").nth(period)).toHaveText(
    "q2 sideways"
  );
  // and back again
  await page.keyboard.press("Shift+Tab");
  await expectEditingAt(page, period, 0);
  await page.keyboard.press("Escape");

  // the right end of a row wraps to the first data cell of the next one
  const lastCol =
    (await page.locator(".db-table tbody tr").first().locator("td[data-fc]").count()) - 1;
  await focusCell(page, lastCol, 0);
  await page.keyboard.press("F2");
  await expectEditingAt(page, lastCol, 0);
  await page.keyboard.press("Tab");
  await expectEditingAt(page, 1, 1);
  await page.keyboard.press("Escape");

  // …and the left end wraps back up
  await focusCell(page, 1, 1);
  await page.keyboard.press("F2");
  await page.keyboard.press("Shift+Tab");
  await expectEditingAt(page, lastCol, 0);
});

test("a keystroke on a select cell filters its picker (SUB-947)", async ({ page }) => {
  const platform = await colIndex(page, "platform");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  await focusCell(page, platform, 0);
  // the keystroke is the picker's filter query, not a raw value
  await page.keyboard.press("b");
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue("b");
  await page.keyboard.type("eat");
  // one option survives the filter, and it is the highlighted row
  await expect(page.locator(".selmenu-list .selmenu-val")).toHaveCount(1);
  await expect(page.locator(".selmenu-list .selmenu-item.selected")).toHaveText(/Beatport/);
  // Enter picks it AND carries on down, like any other commit
  await page.keyboard.press("Enter");
  await expectEditingAt(page, platform, 1);
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "platform"), `${titles[0]}.md`)
  ).toBe("Beatport");
});

test("F2 edits in place instead of replacing (SUB-947)", async ({ page }) => {
  const period = await colIndex(page, "period");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  const before = await page.locator(".db-table tbody tr").nth(0).locator("td").nth(period).innerText();
  expect(before).not.toBe("");

  await focusCell(page, period, 0);
  await page.keyboard.press("F2");
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue(before);
  // the caret parks after the text, so typing appends rather than wipes
  await page.keyboard.type(" rev");
  await expect(input).toHaveValue(`${before} rev`);
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "period"), `${titles[0]}.md`)
  ).toBe(`${before} rev`);
});

test("Escape still abandons the edit and keeps focus (SUB-947)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  const before = await page.evaluate((p) => window.__mockPropOf!(p, "notes"), `${titles[0]}.md`);

  await focusCell(page, notes, 0);
  await page.keyboard.press("z");
  await page.keyboard.type("apped");
  await page.keyboard.press("Escape");

  await expect(editing(page)).toHaveCount(0);
  await expect(page.locator(`.db-table [data-fc="${notes}"][data-fr="0"]`)).toBeFocused();
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "notes"), `${titles[0]}.md`)).toBe(
    before
  );
});

test("a checkbox cell toggles and never opens a text editor (SUB-947)", async ({ page }) => {
  const paid = await colIndex(page, "paid");
  await focusCell(page, paid, 0);
  const cell = page.locator(`.db-table [data-fc="${paid}"][data-fr="0"]`);
  const on = await cell.locator(".prop-check.on").count();
  // a printable key is not a value here — the cell has no editor behind it
  await page.keyboard.press("x");
  await expect(editing(page)).toHaveCount(0);
  // …and Enter keeps toggling in place, as before
  await page.keyboard.press("Enter");
  await expect(cell.locator(".prop-check.on")).toHaveCount(on ? 0 : 1);
  await expect(editing(page)).toHaveCount(0);
});

test("filling ten cells down a column takes only the keyboard (SUB-947)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  const titles = await page.locator(".db-table tbody .db-title-txt").allTextContents();
  expect(titles).toHaveLength(10);

  // the acceptance run: focus once, then type-value-Enter ten times over. No
  // mouse, and no re-pressing Enter to re-open the editor between rows.
  await focusCell(page, notes, 0);
  await page.keyboard.press("r");
  for (let i = 0; i < 10; i++) {
    if (i > 0) await page.keyboard.type("r");
    await page.keyboard.type(`ow-${i}`);
    await page.keyboard.press("Enter");
  }

  await expect(editing(page)).toHaveCount(0);
  for (let i = 0; i < 10; i++) {
    expect(
      await page.evaluate((p) => window.__mockPropOf!(p, "notes"), `${titles[i]}.md`)
    ).toBe(`row-${i}`);
  }
});

test("the hop steps over a derived rollup column (SUB-947)", async ({ page }) => {
  // a rollup (SUB-678) is computed on read with no editor behind it: Tab must
  // not park the editor on one, it has to keep going to the next real cell
  await page.goto("/");
  await newRollupDatabase(page);
  const created = await colIndex(page, "created");
  const earned = await colIndex(page, "earned");
  const entries = await colIndex(page, "entries");
  expect(created).toBeGreaterThan(0);
  expect(earned).toBeGreaterThan(created);
  expect(entries).toBeGreaterThan(earned);

  await focusCell(page, created, 0);
  await page.keyboard.press("F2");
  await expectEditingAt(page, created, 0);
  await page.keyboard.press("Tab");
  await expectEditingAt(page, entries, 0);
  // and back the other way, skipping it again
  await page.keyboard.press("Shift+Tab");
  await expectEditingAt(page, created, 0);
});

test("the hop keeps its target row painted in a windowed table (SUB-947)", async ({ page }) => {
  test.setTimeout(300_000);
  // SUB-310: above 60 rows the tbody paints only the viewport ± overscan, so
  // the row the editor is hopping to may not be in the DOM at all yet
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);

  const version = await colIndex(page, "version");
  await focusCell(page, version, 0);
  await page.keyboard.press("v");
  await expectEditingAt(page, version, 0);
  // walk far enough down that the window has to repaint several times over
  for (let r = 1; r <= 40; r++) {
    await page.keyboard.press("Enter");
    await expectEditingAt(page, version, r);
  }
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
});

test("an Option chord that produces a character types it (SUB-1120)", async ({ page }) => {
  // On a German Mac layout Option is how you type ordinary characters — `@` is
  // ⌥L, `[` is ⌥5, `~` is ⌥N — but the handler used to drop every altKey chord
  // on the floor, so those keys were dead on a focused cell.
  const notes = await colIndex(page, "notes");
  await focusCell(page, notes, 0);
  await page.keyboard.press("Alt+l");
  await expectEditingAt(page, notes, 0);
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue("l");
});

test("an Option chord over a named key still navigates (SUB-1120)", async ({ page }) => {
  // the gate is narrow: only openers ride an Option chord through. ⌥↓ carries
  // no character and must not open an editor.
  const notes = await colIndex(page, "notes");
  await focusCell(page, notes, 0);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(editing(page)).toHaveCount(0);
});

/** what a real international layout puts on the wire, which Playwright cannot
    synthesize from a key descriptor: the chord reports the PRODUCED character,
    and a dead key reports "Dead" with no character at all */
async function layoutKey(page: Page, init: Record<string, unknown>) {
  await page.evaluate((i) => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })
    );
  }, init);
}

test("the character an Option chord produces is what seeds the editor (SUB-1120)", async ({
  page,
}) => {
  const notes = await colIndex(page, "notes");
  await focusCell(page, notes, 0);
  // ⌥L on a German layout: key is "@", not "l"
  await layoutKey(page, { key: "@", altKey: true });
  await expectEditingAt(page, notes, 0);
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue("@");
  // and the rest of the address lands after it, as with any other character
  await page.keyboard.type("home");
  await expect(input).toHaveValue("@home");
});

test("a dead key opens the editor so its accent can compose (SUB-1120)", async ({ page }) => {
  const notes = await colIndex(page, "notes");
  await focusCell(page, notes, 0);
  // ´ then e → é. The dead key itself carries no character, so the editor
  // opens EMPTY and the composition finishes inside the input — where the
  // browser can actually complete it. (The composition itself needs a real OS
  // layout; what is asserted here is that the keystroke is no longer swallowed
  // and the following characters land in the cell.)
  await layoutKey(page, { key: "Dead" });
  await expectEditingAt(page, notes, 0);
  const input = page.locator(".selmenu-input");
  await expect(input).toHaveValue("");
  await page.keyboard.type("é");
  await expect(input).toHaveValue("é");
});
