import { expect, test, type Page } from "./fixtures";

// Live ```view embeds on a hub. The same fence is editable in the editor
// (e2e/viewedit.spec.ts); on a dashboard it used to render flat grey text. Two claims here: a queried value wears the same pill as the
// identical value hand-typed into the markdown table above it (design
// principle 4), and a click commits through the app's own undoable write with
// the editor fence's failure surface. Fixture: Dashboards/Umbra Home.md —
// `## People` holds a typed `| person | role |` table and a `type: contact`
// fence over the four mock contacts, both carrying "mix engineer".

async function openHub(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");
}

/** a row of the live table, by its title cell */
function embedRow(page: Page, title: string) {
  return page.locator(".hub-view .embed-view-table tbody tr[data-path]", {
    has: page.locator(".embed-view-title", { hasText: title }),
  });
}

function cell(page: Page, title: string, column: string) {
  return embedRow(page, title).locator(`td[data-column="${column}"]`);
}

/** the tint a pill actually paints with — the custom property the option's
    colour resolves into, so two pills are compared by colour, not by markup */
const tint = (pill: ReturnType<Page["locator"]>) =>
  pill.evaluate((el) => getComputedStyle(el).getPropertyValue("--pill").trim());

test("a live cell wears the same pill as the same value typed by hand", async ({ page }) => {
  await openHub(page);

  const typed = page.locator(".hub-body .dash-table .opt-pill", { hasText: "mix engineer" });
  const live = page
    .locator('.hub-view .embed-view-table td[data-column="role"] .opt-pill', {
      hasText: "mix engineer",
    })
    .first();
  await expect(typed).toHaveCount(1);
  await expect(live).toBeVisible();

  const typedTint = await tint(typed);
  expect(typedTint).not.toBe("");
  expect(await tint(live)).toBe(typedTint);

  // every value the schema colours pills, not just the one in both tables
  await expect(
    page.locator('.hub-view .embed-view-table td[data-column="role"] .opt-pill', {
      hasText: "booking",
    })
  ).toHaveCount(1);
});

test("a cell on a hub commits through the same undoable write as the editor fence", async ({
  page,
}) => {
  await openHub(page);

  const target = cell(page, "Noa", "role");
  await expect(target).toHaveText("artwork");
  await target.click();

  // the same picker the database pane and the editor fence open, listing the
  // column's options — not a hub-only affordance
  const menu = page.locator(".selmenu");
  await expect(menu).toHaveCount(1);
  await menu.locator(".selmenu-item", { hasText: "booking" }).click();
  await expect(menu).toHaveCount(0);

  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Noa.md", "role")))
    .toBe("booking");
  await expect(cell(page, "Noa", "role")).toHaveText("booking");

  // it landed in the app's prop-undo stack — one ⌘Z reverts it whichever
  // surface the edit came from, with the database pane's own toast wording
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(cell(page, "Noa", "role")).toHaveText("artwork");
});

test("a refused write says so and leaves the cell as it was", async ({ page }) => {
  await openHub(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  await cell(page, "Noa", "role").click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();

  // the editor fence's failure surface, not a silent no-op
  await expect(page.locator(".toast")).toContainText("couldn’t save");
  await expect(cell(page, "Noa", "role")).toHaveText("artwork");
  await expect(page.evaluate(() => window.__mockPropOf!("Noa.md", "role"))).resolves.toBe(
    "artwork"
  );
});
