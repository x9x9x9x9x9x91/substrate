import { expect, test, type Page } from "./fixtures";

// the in-grid totals row, in-place summary editing, and the
// ephemeral selection readout. The mock's Fixed Costs sheet is the fixture:
// data columns month, rent_eur, studio_eur, tools_eur, paid; computed column
// monthly_eur; thirteen named summaries, most of them single-column.

async function openNote(page: Page, title: string) {
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.locator(".palette-input").fill(title);
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue(title);
}

async function openFixedCosts(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await openNote(page, "Fixed Costs");
  await expect(page.locator(".sheet-table")).toBeVisible();
}

const totalsCell = (page: Page, c: number) => page.locator(".sheet-totals td").nth(c);
const dataCell = (page: Page, r: number, c: number) =>
  page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);

test("single-column summaries render under their column; the rest stay in the footer", async ({
  page,
}) => {
  await openFixedCosts(page);

  // rent_eur is column 1 — both of its summaries stack in that totals cell
  await expect(totalsCell(page, 1)).toContainText("rent_total");
  await expect(totalsCell(page, 1)).toContainText("rent_avg");
  await expect(totalsCell(page, 3)).toContainText("tools_peak");
  // monthly_eur is the computed column, last before the spacer
  await expect(totalsCell(page, 5)).toContainText("monthly_total");
  // the value is real, not a placeholder: rent 1240×3 + 1290×3 (four-digit
  // integers stay ungrouped)
  await expect(totalsCell(page, 1)).toContainText("7590");

  // a filtered sum sits under the column it sums, next to the plain total of
  // that same column — `paid_eur = SUMIF(paid, "yes", monthly_eur)`
  await expect(totalsCell(page, 5)).toContainText("paid_eur");
  await expect(totalsCell(page, 4)).not.toContainText("paid_eur");

  // the footer keeps only what has no single column: a summary over summaries
  // and a constant
  const footer = page.locator(".sheet-sums");
  await expect(footer).toContainText("open_eur");
  await expect(footer).toContainText("annual_plan");
  await expect(footer).not.toContainText("rent_total");
  await expect(footer).not.toContainText("monthly_total");
  await expect(footer).not.toContainText("paid_eur");
  await expect(page.locator(".sheet-sums .sheet-sum")).toHaveCount(2);
});

test("an empty totals cell writes a new summary; quick-picks prefill the input", async ({
  page,
}) => {
  await openFixedCosts(page);
  const paid = totalsCell(page, 4); // no summary describes `paid` yet
  await expect(paid).not.toContainText("paid_count");

  await paid.locator(".sheet-total-add").click();
  await paid.locator(".sheet-fx-pick", { hasText: "Count" }).click();
  // `paid` holds yes/no, so Count prefills the wildcard COUNTIF:
  // plain COUNT counts numbers and could only ever read 0 here
  await expect(paid.locator(".sheet-fx-input")).toHaveValue('paid_count = COUNTIF(paid, "*")');
  await page.keyboard.press("Enter");

  await expect(totalsCell(page, 4)).toContainText("paid_count");
  await expect(totalsCell(page, 4)).toContainText("6"); // six non-blank cells
  // it landed in the note body, not just this render: let the debounced save
  // flush, leave the note, and come back to a fresh read (no page reload —
  // that would reset the mock backend and prove nothing)
  await page.waitForTimeout(1200);
  await page.locator(".side-item", { hasText: /^Notes/ }).first().click();
  await openNote(page, "Fixed Costs");
  await expect(page.locator(".sheet-table")).toBeVisible();
  await expect(totalsCell(page, 4)).toContainText("paid_count");
});

// A machine-written sheet — a budget loop rewriting a per-category block — is
// how one column collects far more summaries than a person would add by hand:
// the totals cell only offers its "+" while it is empty, so the UI alone never
// builds a stack this deep. Written through the source view, the way the file
// on disk arrives.
const CAPPED_BODY = [
  "Per-category budget.",
  "",
  "```csv",
  "category,spent_eur",
  "Rent,1290",
  "Food,511.4",
  "Studio,355",
  "Travel,262.8",
  "```",
  "",
  "```formulas",
  'spent_rent = SUMIF(category, "Rent", spent_eur)',
  'spent_food = SUMIF(category, "Food", spent_eur)',
  'spent_studio = SUMIF(category, "Studio", spent_eur)',
  'spent_travel = SUMIF(category, "Travel", spent_eur)',
  "spent_all = SUM(spent_eur)",
  "```",
  "",
].join("\n");

test("one column takes three summaries; the overflow goes to the footer", async ({ page }) => {
  await openFixedCosts(page);
  await page.locator('.sheet-tool[title="View note source"]').click();
  await expect(page.locator(".sheet-src .cm-editor")).toBeVisible();
  await page.locator(".sheet-src .cm-content").click();
  // ControlOrMeta: CodeMirror's `Mod-` follows the browser's platform, not the app's
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(CAPPED_BODY);
  await page.locator('.sheet-tool[title="Back to grid"]').click();
  await expect(page.locator(".sheet-table")).toBeVisible();

  // spent_eur is column 1; five summaries describe it, three fit
  const stack = totalsCell(page, 1);
  await expect(stack.locator(".sheet-total-name")).toHaveCount(3);
  await expect(stack).toContainText("spent_rent");
  await expect(stack).toContainText("spent_studio");
  await expect(stack).not.toContainText("spent_travel");

  // the two it could not take are visible, not dropped
  const footer = page.locator(".sheet-summary");
  const more = footer.locator(".sheet-sum-more");
  if (await more.count()) await more.click();
  await expect(footer).toContainText("spent_travel");
  await expect(footer).toContainText("spent_all");
});

test("Enter on a totals add control opens its editor, not the last data cell", async ({ page }) => {
  await openFixedCosts(page);
  const lastDataFocus = dataCell(page, 0, 0);
  await lastDataFocus.click();
  await expect(lastDataFocus).toHaveClass(/focused/);

  const add = totalsCell(page, 4).locator(".sheet-total-add");
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(totalsCell(page, 4).locator(".sheet-fx-input")).toBeFocused();
  await expect(page.locator(".sheet-input")).toHaveCount(0);
});

test("the summary editor refuses a row-shaped computed-column formula", async ({ page }) => {
  await openFixedCosts(page);
  const paid = totalsCell(page, 4);
  await paid.locator(".sheet-total-add").click();
  const input = paid.locator(".sheet-fx-input");
  await input.fill("paid_double = paid * 2");
  await page.keyboard.press("Enter");

  await expect(input).toHaveValue("paid_double = paid * 2");
  await expect(paid.locator(".sheet-fx-err")).toContainText(
    "column formula, not a summary"
  );
  await expect(page.locator(".sheet-computed", { hasText: "paid_double" })).toHaveCount(0);
});

test("Count follows the column: COUNT over numbers, wildcard COUNTIF over text", async ({
  page,
}) => {
  // Holdings: asset(0) bucket(1) units(2) price_usd(3) | value_usd(4) value_eur(5).
  // bucket holds etf/crypto, price_usd holds numbers; neither has a summary yet.
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await openNote(page, "Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();

  const price = totalsCell(page, 3);
  await price.locator(".sheet-total-add").click();
  await price.locator(".sheet-fx-pick", { hasText: "Count" }).click();
  await expect(price.locator(".sheet-fx-input")).toHaveValue("price_usd_count = COUNT(price_usd)");
  await page.keyboard.press("Escape");

  const bucket = totalsCell(page, 1);
  await bucket.locator(".sheet-total-add").click();
  await bucket.locator(".sheet-fx-pick", { hasText: "Count" }).click();
  await expect(bucket.locator(".sheet-fx-input")).toHaveValue(
    'bucket_count = COUNTIF(bucket, "*")'
  );
  // the other picks are untouched — Sum still prefills SUM
  await bucket.locator(".sheet-fx-pick", { hasText: "Sum" }).click();
  await expect(bucket.locator(".sheet-fx-input")).toHaveValue("bucket_sum = SUM(bucket)");

  await bucket.locator(".sheet-fx-pick", { hasText: "Count" }).click();
  await page.keyboard.press("Enter");
  await expect(totalsCell(page, 1)).toContainText("bucket_count");
  await expect(totalsCell(page, 1)).toContainText("4"); // four non-blank cells
});

test("the input takes the whole formula language, not just the quick-picks", async ({ page }) => {
  await openFixedCosts(page);
  const paid = totalsCell(page, 4);
  await paid.locator(".sheet-total-add").click();
  await paid.locator(".sheet-fx-input").fill('unpaid = COUNTIF(paid, "no")');
  await page.keyboard.press("Enter");
  await expect(totalsCell(page, 4)).toContainText("unpaid");
  await expect(totalsCell(page, 4)).toContainText("2");
});

test("a filled totals cell edits in place; a bad line keeps the editor open", async ({ page }) => {
  await openFixedCosts(page);
  await totalsCell(page, 3).locator(".sheet-total", { hasText: "tools_low" }).click();
  const input = totalsCell(page, 3).locator(".sheet-fx-input");
  await expect(input).toHaveValue("tools_low = MIN(tools_eur)");

  // a name that already exists is refused, and the draft survives
  await input.fill("rent_total = MIN(tools_eur)");
  await page.keyboard.press("Enter");
  await expect(totalsCell(page, 3).locator(".sheet-fx-err")).toContainText("already exists");

  await input.fill("tools_floor = MIN(tools_eur)");
  await page.keyboard.press("Enter");
  await expect(totalsCell(page, 3)).toContainText("tools_floor");
  await expect(totalsCell(page, 3)).not.toContainText("tools_low");
});

test("right-click deletes a summary from the totals row and from the footer", async ({ page }) => {
  await openFixedCosts(page);
  await totalsCell(page, 1).locator(".sheet-total", { hasText: "rent_avg" }).click({
    button: "right",
  });
  await page.locator(".ctx-item", { hasText: "Delete summary" }).click();
  await expect(totalsCell(page, 1)).not.toContainText("rent_avg");
  await expect(totalsCell(page, 1)).toContainText("rent_total");

  await page.locator(".sheet-sum", { hasText: "annual_plan" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete summary" }).click();
  await expect(page.locator(".sheet-sums")).not.toContainText("annual_plan");
});

test("the footer's + summary appends a line to the fence", async ({ page }) => {
  await openFixedCosts(page);
  await page.locator(".sheet-sum-add").click();
  await page.locator(".sheet-sums .sheet-fx-input").fill("spread = tools_peak - tools_low");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-sums")).toContainText("spread");
  await expect(page.locator(".sheet-sums")).toContainText("87");
});

test("a range selection reports sum, avg and count without touching the file", async ({ page }) => {
  await openFixedCosts(page);
  await expect(page.locator(".sheet-selstat")).toHaveCount(0);

  await dataCell(page, 0, 1).click();
  await dataCell(page, 2, 1).click({ modifiers: ["Shift"] });
  const stat = page.locator(".sheet-selstat");
  await expect(stat).toContainText("Sum");
  await expect(stat).toContainText("3720"); // 1240 × 3
  await expect(stat).toContainText("Count");
  await expect(stat).toContainText("3");
  // the row/FX meta keeps its place on the right
  await expect(page.locator(".sheet-meta")).toContainText("6 rows");

  // a plain click collapses the selection again
  await dataCell(page, 0, 1).click();
  await expect(page.locator(".sheet-selstat")).toHaveCount(0);
});

test("shift+arrow extends the selection; a text range reports count only", async ({ page }) => {
  await openFixedCosts(page);
  await dataCell(page, 0, 0).click(); // month column — text cells
  await page.keyboard.press("Shift+ArrowDown");
  const stat = page.locator(".sheet-selstat");
  await expect(stat).toContainText("Count");
  await expect(stat).not.toContainText("Sum");
  await expect(stat).toContainText("2");

  await page.keyboard.press("Escape");
  await expect(page.locator(".sheet-selstat")).toHaveCount(0);
});

test("the column names stay legible where a short pane makes the totals row meet them", async ({
  page,
}) => {
  // a pane short enough that the last rows, the totals row and the column
  // names all want the same band — the case the overprint was reported from
  await page.setViewportSize({ width: 1100, height: 420 });
  await openFixedCosts(page);
  await page.locator(".sheet-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(120);

  // a totals row tall enough to reach the column names has always outgrown a
  // third of the scrollport, so the band this test stages is a LOOSE row —
  // the pinned row and the header are geometrically unable to meet while
  // that cap is live. A loose row can end up under the header by painting
  // order alone, so the hit-test can stay green with the header's own layer
  // reverted; the layer order is asserted directly instead, which is the
  // thing this fix changes and the thing a regression would take back.
  await expect(page.locator(".sheet-totals")).toHaveClass(/sheet-totals-loose/);

  const verdict = await page.evaluate(() => {
    const head = document.querySelector(".sheet-table th") as HTMLElement | null;
    const cell = document.querySelector(".sheet-totals td:nth-child(2)") as HTMLElement | null;
    if (!head || !cell) return "missing";
    const headZ = Number.parseInt(getComputedStyle(head).zIndex, 10);
    if (!Number.isFinite(headZ)) return "header-unlayered";
    // the layer the header must beat is the PINNED rule's — a loose cell
    // computes `auto` and loses to any positive header layer regardless, so
    // the row's class is lifted for one read to measure the pinned rule
    const row = cell.closest("tr") as HTMLElement;
    row.classList.remove("sheet-totals-loose");
    const pinnedZ = Number.parseInt(getComputedStyle(cell).zIndex, 10);
    row.classList.add("sheet-totals-loose");
    if (Number.isFinite(pinnedZ) && headZ <= pinnedZ) return "header-under-totals";
    const h = head.getBoundingClientRect();
    const t = cell.getBoundingClientRect();
    const from = Math.max(h.top, t.top);
    const to = Math.min(h.bottom, t.bottom);
    // the hit-test is only worth anything if the two really do meet here
    if (to - from < 4) return "no-overlap";
    const hit = document.elementFromPoint(h.left + h.width / 2, (from + to) / 2);
    return hit?.closest("thead") ? "header" : "totals";
  });

  expect(verdict).toBe("header");
});
