import { expect, test, type Page } from "@playwright/test";

// Sub-items: a relation prop pointing back at its own database can be
// MARKED as the parent link from that column's header menu, after which the
// table and board render ONE level of expandable tree rows with a done/total
// badge that climbs the chain. Nothing about the notes changes — the link is
// the plain relation value a hand-edited vault would carry, which is how this
// spec stages it. End-to-end through the UI against the mock backend.

/** sidebar ＋ → New database…, with one initial text property */
async function newDatabase(page: Page, name: string, prop: string) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill(name);
  await form.locator(".dbform-addprop").click();
  await form.locator(".dbform-proprow").last().locator(".dbform-input").fill(prop);
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText(name);
}

/** the ＋ add-property popover: a relation prop pointing at `target` */
async function addRelationProp(page: Page, name: string, target: string) {
  await page.locator(".db-add-btn").click();
  const form = page.locator(".selmenu");
  await form.locator(".dbprop-name").fill(name);
  await form.locator(".selmenu-kind", { hasText: "Relation" }).click();
  // the database can name ITSELF here — that self-link is what a sub-item
  // tree is made of
  await form
    .getByRole("listbox", { name: "Target databases" })
    .getByRole("option", { name: target, exact: true })
    .click();
  await form.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(form).toHaveCount(0);
}

/** stage frontmatter values the way a hand-edited vault would carry them */
async function stageProps(page: Page, edits: [path: string, key: string, value: unknown][]) {
  await page.evaluate((batch) => {
    for (const [path, key, value] of batch) window.__mockEditProp!(path, key, value);
    window.__mockEmit!("vault:changed");
  }, edits);
}

async function newEntry(page: Page, title: string) {
  if ((await page.locator(".db-draft-input").count()) === 0) {
    const empty = page.locator(".empty-action");
    if ((await empty.count()) > 0) await empty.click();
    else await page.locator(".db-new").click();
  }
  const draft = page.locator(".db-draft-input");
  await draft.fill(title);
  await draft.press("Enter");
  await expect(page.locator(".db-title-txt", { hasText: new RegExp(`^${title}$`) })).toHaveCount(1);
}

const row = (page: Page, title: string) =>
  page.locator("tr", { has: page.locator(".db-title-txt", { hasText: new RegExp(`^${title}$`) }) });

/** every rendered row title, top to bottom */
const titles = (page: Page) => page.locator("tbody .db-title-txt").allTextContents();

/** the column header menu of one property */
async function colMenu(page: Page, label: string) {
  await page
    .locator("th", { has: page.locator(".db-th-label", { hasText: label }) })
    .locator(".db-th-caret")
    .click();
  return page.locator(".colmenu");
}

/** mark (or unmark) the relation column as the parent link */
async function markParent(page: Page, label: string, item: string) {
  const menu = await colMenu(page, label);
  await menu.locator(".dots-item", { hasText: item }).click();
  await expect(menu).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await newDatabase(page, "Subtree", "status");
  // the ＋ add-property control rides the table header, so the rows come first
  for (const t of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) await newEntry(page, t);
  await addRelationProp(page, "parent task", "Subtree");
  // Bravo + Charlie hang off Alpha, Delta off Bravo (the grandchild), Echo
  // stands alone. Two of Alpha's three descendants read complete.
  await stageProps(page, [
    ["Subtree/Alpha.md", "status", "todo"],
    ["Subtree/Bravo.md", "status", "done"],
    ["Subtree/Charlie.md", "status", "todo"],
    ["Subtree/Delta.md", "status", "done"],
    ["Subtree/Echo.md", "status", "todo"],
    ["Subtree/Bravo.md", "parent task", "Alpha"],
    ["Subtree/Charlie.md", "parent task", "Alpha"],
    ["Subtree/Delta.md", "parent task", "Bravo"],
  ]);
});

test("the marked relation nests one level and rolls up the whole branch (SUB-1300)", async ({
  page,
}) => {
  // before the mark it is an ordinary relation column: no chevrons anywhere
  await expect(page.locator(".db-tree-chevron")).toHaveCount(0);
  await markParent(page, "Parent task", "Nest sub-items under this");

  // the mark rides the SCHEMA, not the notes — nothing new landed on disk
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "parent"), "Subtree/Bravo.md")).toBe(
    undefined
  );
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "parent task"), "Subtree/Bravo.md")
  ).toBe("Alpha");

  // Alpha carries the chevron and both its children follow it immediately
  await expect(row(page, "Alpha").locator(".db-tree-chevron")).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  const order = await titles(page);
  const at = order.indexOf("Alpha");
  expect(order.slice(at + 1, at + 3).sort()).toEqual(["Bravo", "Charlie"]);
  await expect(row(page, "Bravo").locator(".db-tree-cell.is-child")).toHaveCount(1);
  await expect(row(page, "Charlie").locator(".db-tree-cell.is-child")).toHaveCount(1);

  // ONE level: the grandchild does NOT indent under its indented parent. It
  // stands flat, as a top-level row of its own, carrying no chevron — and
  // its already-indented parent Bravo carries none either, only its badge:
  // in this section nothing hangs off an indented row
  await expect(row(page, "Delta").locator(".db-tree-cell.is-child")).toHaveCount(0);
  await expect(row(page, "Delta").locator(".db-tree-chevron")).toHaveCount(0);
  await expect(row(page, "Bravo").locator(".db-tree-chevron")).toHaveCount(0);
  expect(order.indexOf("Delta")).toBeGreaterThan(at + 2);

  // the rollup climbs: Alpha reports its whole branch (Bravo, Charlie, Delta,
  // two of them complete), Bravo the one row under it, Echo has none
  await expect(row(page, "Alpha").locator(".db-sub-badge")).toHaveText("2/3");
  await expect(row(page, "Bravo").locator(".db-sub-badge")).toHaveText("1/1");
  await expect(row(page, "Echo").locator(".db-sub-badge")).toHaveCount(0);
  await expect(row(page, "Echo").locator(".db-tree-chevron")).toHaveCount(0);

  // a staged completion re-derives on read, like any other computed column
  await stageProps(page, [["Subtree/Charlie.md", "status", "done"]]);
  await expect(row(page, "Alpha").locator(".db-sub-badge")).toHaveText("3/3");

  // and the mark comes back off from the same menu
  await markParent(page, "Parent task", "Stop nesting sub-items");
  await expect(page.locator(".db-tree-chevron")).toHaveCount(0);
  await expect(page.locator(".db-sub-badge")).toHaveCount(0);
});

test("collapsing removes the children from the rows keyboard nav walks (SUB-1300)", async ({
  page,
}) => {
  await markParent(page, "Parent task", "Nest sub-items under this");
  const full = await titles(page);
  expect(full).toHaveLength(5);

  await row(page, "Alpha").locator(".db-tree-chevron").click();
  await expect(row(page, "Alpha").locator(".db-tree-chevron")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  // the children are GONE from the row list, not hidden in it — that is what
  // keeps nav, lazy paint and the counts honest
  const folded = await titles(page);
  expect(folded).toEqual(full.filter((t) => t !== "Bravo" && t !== "Charlie"));
  // the badge still reports the whole branch: the rollup counts the database,
  // not what happens to be painted
  await expect(row(page, "Alpha").locator(".db-sub-badge")).toHaveText("2/3");

  // keyboard nav walks the VISIBLE rows: from Alpha's status cell, one
  // ArrowDown lands on the row that now follows it, never on a folded child
  const alphaRow = folded.indexOf("Alpha");
  await page.locator(`td[data-fc="1"][data-fr="${alphaRow}"]`).focus();
  await page.keyboard.press("ArrowDown");
  const focused = page.locator("td.db-cell.focused");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute("data-fr", String(alphaRow + 1));
  expect(
    await focused.evaluate((el) => el.closest("tr")?.querySelector(".db-title-txt")?.textContent)
  ).toBe(folded[alphaRow + 1]);

  // expanding puts them back, in the same place
  await row(page, "Alpha").locator(".db-tree-chevron").click();
  expect(await titles(page)).toEqual(full);
});

test("a fold never shrinks the CSV export or the footer tally (SUB-1300)", async ({
  page,
}) => {
  await markParent(page, "Parent task", "Nest sub-items under this");
  // collect what the dev-browser export path hands to the blob it downloads
  await page.evaluate(() => {
    const orig = URL.createObjectURL.bind(URL);
    (window as unknown as { __exported: Blob[] }).__exported = [];
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob) (window as unknown as { __exported: Blob[] }).__exported.push(obj);
      return orig(obj as Blob);
    };
  });
  const exportCsv = async () => {
    await page.locator("button[aria-label='View actions']").click();
    await page.locator(".dots-item", { hasText: "Export CSV…" }).click();
    return page.evaluate(async () => {
      const all = (window as unknown as { __exported: Blob[] }).__exported;
      return all.length ? await all[all.length - 1].text() : "";
    });
  };

  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  const whole = await exportCsv();
  for (const t of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) expect(whole).toContain(t);

  // fold Alpha: two rows leave the table…
  await row(page, "Alpha").locator(".db-tree-chevron").click();
  await expect(row(page, "Bravo")).toHaveCount(0);
  // …and neither the tally nor the file notices. Collapsing is a view state
  // like grouping: it must not quietly change an artifact.
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  expect(await exportCsv()).toBe(whole);
});

test("tree rows survive lazy paint (SUB-1300)", async ({ page }) => {
  // past WIN_MIN (60) rows the table paints only the viewport ± overscan
  await page.evaluate(() => {
    for (let i = 0; i < 70; i++)
      window.__mockCloneNote!("Subtree/Echo.md", `Subtree/Zed ${String(i).padStart(2, "0")}.md`);
    window.__mockEmit!("vault:changed");
  });
  await expect(page.locator("tbody .db-title-txt")).not.toHaveCount(5);
  await markParent(page, "Parent task", "Nest sub-items under this");

  // windowing is on — spacer rows stand in for what is not painted
  await expect(page.locator("tr.db-win-spacer")).not.toHaveCount(0);
  const painted = await page.locator("tbody .db-title-txt").count();
  expect(painted).toBeLessThan(75);

  // and the tree still reads correctly inside the painted slice
  await expect(row(page, "Alpha").locator(".db-sub-badge")).toHaveText("2/3");
  await expect(row(page, "Bravo").locator(".db-tree-cell.is-child")).toHaveCount(1);

  // folding removes rows from the windowed geometry, not just from view
  await row(page, "Alpha").locator(".db-tree-chevron").click();
  await expect(row(page, "Bravo")).toHaveCount(0);
  await expect(page.locator("tr.db-win-spacer")).not.toHaveCount(0);
});

test("the board nests cards inside their own column (SUB-1300)", async ({ page }) => {
  await markParent(page, "Parent task", "Nest sub-items under this");
  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();

  // the board groups by status: Alpha and Charlie share "todo", so Charlie
  // nests there; Bravo is "done" — a different column — so it stands alone
  const card = (title: string) =>
    page.locator(".db-card", { has: page.locator(".db-card-title", { hasText: new RegExp(`^${title}$`) }) });
  const todo = page.locator(".db-col", { has: page.locator(".db-card-title", { hasText: "Alpha" }) });
  await expect(todo.locator(".db-card", { hasText: "Alpha" }).locator(".db-tree-chevron")).toHaveCount(1);
  await expect(todo.locator(".db-card.db-card-child")).toHaveCount(1);
  await expect(todo.locator(".db-card.db-card-child .db-card-title")).toHaveText("Charlie");
  // a card whose parent sits in another column keeps its own place
  await expect(card("Bravo").locator(".db-card-child")).toHaveCount(0);

  // the badge climbs on the board too
  await expect(
    todo.locator(".db-card", { hasText: "Alpha" }).locator(".db-sub-badge").first()
  ).toHaveText("2/3");

  // and folding takes the child card out of its column
  await todo.locator(".db-card", { hasText: "Alpha" }).locator(".db-tree-chevron").click();
  await expect(todo.locator(".db-card.db-card-child")).toHaveCount(0);
});
