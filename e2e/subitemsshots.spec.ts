import { expect, test, type Page } from "./fixtures";

// Evidence run only (SHOTS=1): the sub-item tree on both grounds — table
// expanded and collapsed, and the board — so the chevron, the indent and the
// done/total badge can be LOOKED at, not just asserted. Same fixture as
// subitems.spec.ts.
//
// "Both grounds" here means both ACCENT TONES (appearance.ts): the app has no
// runtime light theme — styles.css carries no [data-theme] rule at all, and
// its only light surface is the print pass (see accentshots.spec.ts), which
// replaces the app rather than restyling a database pane.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOTS_DIR || "/tmp/sub1300-shots";

test.use({ viewport: { width: 1400, height: 900 } });

async function setTone(page: Page, tone: "sky" | "violet") {
  await page.evaluate((t) => {
    document.documentElement.dataset.tone = t;
  }, tone);
  await page.waitForTimeout(150);
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

test("sub-item tree, table and board, both grounds", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").first().fill("Subtree");
  await form.locator(".dbform-addprop").click();
  await form.locator(".dbform-proprow").last().locator(".dbform-input").fill("status");
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText("Subtree");

  for (const t of ["Album master", "Stem bounce", "Reference pass", "Loudness check", "Artwork"])
    await newEntry(page, t);

  const add = page.locator(".selmenu");
  await page.locator(".db-add-btn").click();
  await add.locator(".dbprop-name").fill("parent task");
  await add.locator(".selmenu-kind", { hasText: "Relation" }).click();
  await add
    .getByRole("listbox", { name: "Target databases" })
    .getByRole("option", { name: "Subtree", exact: true })
    .click();
  await add.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(add).toHaveCount(0);

  await page.evaluate(() => {
    const set = window.__mockEditProp!;
    set("Subtree/Album master.md", "status", "todo");
    set("Subtree/Stem bounce.md", "status", "done");
    set("Subtree/Reference pass.md", "status", "todo");
    set("Subtree/Loudness check.md", "status", "done");
    set("Subtree/Artwork.md", "status", "todo");
    set("Subtree/Stem bounce.md", "parent task", "Album master");
    set("Subtree/Reference pass.md", "parent task", "Album master");
    set("Subtree/Loudness check.md", "parent task", "Stem bounce");
    window.__mockEmit!("vault:changed");
  });

  await page
    .locator("th", { has: page.locator(".db-th-label", { hasText: "Parent task" }) })
    .locator(".db-th-caret")
    .click();
  await page.locator(".colmenu .dots-item", { hasText: "Nest sub-items under this" }).click();
  const parent = page.locator("tr", {
    has: page.locator(".db-title-txt", { hasText: /^Album master$/ }),
  });
  await expect(parent.locator(".db-sub-badge")).toHaveText("2/3");

  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/table-expanded-${tone}.png` });
  }
  await parent.locator(".db-tree-chevron").click();
  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/table-collapsed-${tone}.png` });
  }
  await parent.locator(".db-tree-chevron").click();

  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();
  // two nests here: "Reference pass" under its parent in the todo column and
  // "Loudness check" under its own parent in the done column
  await expect(page.locator(".db-card.db-card-child")).toHaveCount(2);
  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/board-expanded-${tone}.png` });
  }
  await page.locator(".db-card .db-tree-chevron").first().click();
  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/board-collapsed-${tone}.png` });
  }
});
