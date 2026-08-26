import { expect, test, type Page } from "./fixtures";

// Throwaway evidence run (SHOTS=1): the column menu of a column that CANNOT
// carry a sub-item tree — a plain text column, and a relation aimed at another
// database — so the entry that used to be absent there can be looked at in
// both grounds. Delete this spec once the change it photographs has been read.
//
// "Both grounds" is both ACCENT TONES (appearance.ts): the app has no runtime
// light theme, as e2e/subitemsshots.spec.ts records at the same spot.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOTS_DIR || "/tmp/sub1402-shots";

test.use({ viewport: { width: 1400, height: 900 } });

async function setTone(page: Page, tone: "sky" | "violet") {
  await page.evaluate((t) => {
    document.documentElement.dataset.tone = t;
  }, tone);
  await page.waitForTimeout(150);
}

async function newDatabase(page: Page, name: string, prop: string) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").first().fill(name);
  await form.locator(".dbform-addprop").click();
  await form.locator(".dbform-proprow").last().locator(".dbform-input").fill(prop);
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText(name);
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

async function addRelationProp(page: Page, name: string, target: string) {
  await page.locator(".db-add-btn").click();
  const form = page.locator(".selmenu");
  await form.locator(".dbprop-name").fill(name);
  await form.locator(".selmenu-kind", { hasText: "Relation" }).click();
  await form
    .getByRole("listbox", { name: "Target databases" })
    .getByRole("option", { name: target, exact: true })
    .click();
  await form.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(form).toHaveCount(0);
}

async function openColMenu(page: Page, label: string) {
  await page
    .locator("th", { has: page.locator(".db-th-label", { hasText: label }) })
    .locator(".db-th-caret")
    .click();
  await expect(page.locator(".colmenu")).toHaveCount(1);
}

async function shoot(page: Page, name: string) {
  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/${name}-${tone}.png` });
  }
}

test("the column menu of an ineligible column, both grounds", async ({ page }) => {
  await page.goto("/");
  await newDatabase(page, "Subtree", "status");
  for (const t of ["Album master", "Stem bounce", "Reference pass"]) await newEntry(page, t);
  await addRelationProp(page, "parent task", "Subtree");

  // a plain text column — nothing about it can name a row's parent
  await openColMenu(page, "Status");
  await shoot(page, "text-column");
  await page.keyboard.press("Escape");

  // the relation that CAN carry the tree, for the contrast
  await openColMenu(page, "Parent task");
  await shoot(page, "self-relation");
  await page.keyboard.press("Escape");

  // a relation aimed at a different database
  await newDatabase(page, "Other", "note");
  await newEntry(page, "One");
  await addRelationProp(page, "linked", "Subtree");
  await openColMenu(page, "Linked");
  await shoot(page, "other-relation");
});

// Second evidence run: the two things the fix round changed on this row —
// what it looks like under the pointer, and what a long unbroken database
// name does to it. The "before" capture re-asserts the hover the shared row
// class used to win with, so the pair shows the same pixels the change
// removed rather than a description of them.
const OLD_HOVER = `.dots-item.colmenu-off:hover { background: var(--active); color: var(--text-1); }`;
const OLD_WRAP = `.colmenu-off-text { overflow-wrap: normal; }`;

async function withOldRule(page: Page, id: string, css: string, on: boolean) {
  await page.evaluate(
    ({ id: key, css: text, on: apply }) => {
      document.getElementById(key)?.remove();
      if (!apply) return;
      const el = document.createElement("style");
      el.id = key;
      el.textContent = text;
      document.head.append(el);
    },
    { id, css, on }
  );
  await page.waitForTimeout(80);
}

const withOldHover = (page: Page, on: boolean) => withOldRule(page, "old-hover", OLD_HOVER, on);
const withOldWrap = (page: Page, on: boolean) => withOldRule(page, "old-wrap", OLD_WRAP, on);

test("the off row under the pointer, and with a long name in it", async ({ page }) => {
  await page.goto("/");
  await newDatabase(page, "Project_deliverable_tracking_queue_2026_master_pipeline", "status");
  await newEntry(page, "Album master");
  await addRelationProp(page, "parent task", "Project_deliverable_tracking_queue_2026_master_pipeline");

  await openColMenu(page, "Status");
  const off = page.locator(".colmenu .colmenu-off");
  await expect(off).toHaveCount(1);

  // a long unbroken database name is the wrap case: the reason quotes it,
  // and without a break opportunity it used to paint past the popover
  await withOldWrap(page, true);
  await shoot(page, "long-name-before");
  await withOldWrap(page, false);
  await shoot(page, "long-name-after");

  await off.hover();
  await withOldHover(page, true);
  await shoot(page, "hover-before");
  await withOldHover(page, false);
  await shoot(page, "hover-after");
});
