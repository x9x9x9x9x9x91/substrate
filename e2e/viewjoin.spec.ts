import { expect, test, type Page } from "@playwright/test";

// View-fence joins (SUB-829): a dotted `relation.prop` column in a ```view
// fence shows a stored property of the row the relation names. That value
// belongs to ANOTHER note, so the cell is read-only on every surface — the
// paint, the editor-opening click, and the checkbox toggle, which writes on
// mousedown without ever opening a picker and so isn't covered by the
// editor-opening guard.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

function embedRow(page: Page, title: string) {
  return page.locator(".embed-view-table tbody tr[data-path]", {
    has: page.locator(".embed-view-title", { hasText: title }),
  });
}

function cell(page: Page, title: string, column: string) {
  return embedRow(page, title).locator(`td[data-column="${column}"]`);
}

/** Give `contact` a checkbox prop and point the hub's fence at it through the
    release db's existing `contact` relation, so one joined column is
    checkbox-KINDED on its target — the case a kind-only guard lets through.
    Both edits land before the note is opened, so the editor loads the fence
    from the vault rather than having it swapped under an open buffer. */
async function openJoinedFence(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.__mockEditSchema!("contact", {
      email: { options: [], kind: "email" },
      phone: { options: [], kind: "phone" },
      settled: { options: [], kind: "checkbox" },
    });
    window.__mockEditProp!("Gero.md", "settled", true);
    window.__mockEditNote!(
      "Projects/Umbra.md",
      "Label hub.\n\n```view\ntype: release\ncolumns: status, contact.email, contact.settled\nview: table\n```\n"
    );
    window.__mockEmit!("vault:config-changed");
  });

  await page.locator(".side-folder", { hasText: "Projects" }).click();
  await row(page, "Umbra").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
  await expect(page.locator(".embed-view-table")).toBeVisible();
}

test("a dotted column shows the linked note's stored value", async ({ page }) => {
  await openJoinedFence(page);
  // Slow Bloom EP's `contact` names Gero
  await expect(cell(page, "Slow Bloom EP", "contact.email")).toHaveText("gero@umbra.example");
  // Static Bouquet holds two contacts — both values, comma-joined, no extra row
  const two = cell(page, "Static Bouquet", "contact.email");
  await expect(two).toContainText("gero@umbra.example");
  await expect(two).toContainText("noa@umbra.example");
  await expect(embedRow(page, "Static Bouquet")).toHaveCount(1);
});

test("a joined cell opens no editor when clicked", async ({ page }) => {
  await openJoinedFence(page);
  await cell(page, "Slow Bloom EP", "contact.email").click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  // and the note the value actually lives on is untouched
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Gero.md", "email")))
    .toBe("gero@umbra.example");
});

test("a joined checkbox cell writes nothing on mousedown (SUB-829)", async ({ page }) => {
  await openJoinedFence(page);
  const target = cell(page, "Slow Bloom EP", "contact.settled");
  // the lookup renders the target's stored value as text — never as this
  // row's live checkbox affordance, because it isn't this row's prop
  await expect(target.locator(".prop-check")).toHaveCount(0);

  await target.click();
  await expect(page.locator(".selmenu")).toHaveCount(0);

  // neither note moved: not the base row (whose prop this never was) …
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Slow Bloom EP.md", "contact.settled")))
    .toBe(undefined);
  // … nor the linked one the value belongs to
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Gero.md", "settled")))
    .toBe(true);
});

test("a stored cell in the same table still edits — the guard is scoped to joins", async ({
  page,
}) => {
  await openJoinedFence(page);
  await cell(page, "Slow Bloom EP", "status").click();
  await expect(page.locator(".selmenu")).toHaveCount(1);
});
