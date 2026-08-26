import { expect, test, type Page } from "./fixtures";
import { todayBase } from "./clock";

// Food dashboard flows over the mock seed: Dashboards/Calories.md
// (band 1900–2300) + the Food Log sheet. Seeded today: Chicken bowl 650/45g +
// Gym −300 → net 350, under the floor. Day-relative seed rows keep these
// invariants on any date the suite runs.

async function openFood(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calories" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Calories");
}

test("food: hero, band verdict, metrics from the seeded log", async ({ page }) => {
  await openFood(page);
  // net 350 = 650 − 300; exercise subtracts, protein ignores negatives
  await expect(page.locator(".dash-apr")).toHaveText("350");
  await expect(page.locator(".dash-state")).toContainText("under floor");
  // under the floor the sub-line leads with distance to goal,
  // and the seeded Gym row surfaces as burned kcal
  await expect(page.locator(".dash-sub")).toContainText("1.550 kcal to goal · 1.950 to ceiling");
  await expect(page.locator(".dash-sub")).toContainText("300 burned");
  await expect(page.locator(".dash-sub")).toContainText("45 g protein");
  // band metric renders the props, day strip carries 14 columns
  await expect(page.locator(".dash-metric", { hasText: "band" })).toContainText("1.900–2.300");
  // week vs goal over the seeded window: 4 logged days, all rows
  // day-relative, Σnet − 4×1900 — the exact number is seed-derived, so just
  // assert the metric renders with its logged-days sub-line
  await expect(page.locator(".dash-metric", { hasText: "week vs goal" })).toContainText("4/7 logged");
  await expect(page.locator(".food-col")).toHaveCount(14);
  await expect(page.locator(".food-band")).toBeVisible();
});

test("food: weight overlay rides the strip, dots only on weigh-in days (SUB-707)", async ({
  page,
}) => {
  await openFood(page);
  // seeded Weight Log: three day-relative weigh-ins inside the 14-day window
  // (−9 / −5 / today), so three dots and one bridging line, not 14
  await expect(page.locator(".food-weight-line")).toHaveCount(1);
  await expect(page.locator(".food-weight-dot")).toHaveCount(3);
  // endpoints carry their number; today's weigh-in is also the focus day
  const vals = page.locator(".food-weight-val");
  await expect(vals.first()).toHaveText("78,4");
  await expect(vals.last()).toHaveText("77,4");
  // Today's dot lands in the kcal label's band (short 350 bar, the
  // 77,4 dot near the weight scale's padded floor) — the kg label must stack
  // ABOVE the kcal value with daylight between them, never print through it
  const barVal = page.locator(".food-col.today .dash-bar-val");
  await expect(barVal).toHaveText("350");
  const barBox = (await barVal.boundingBox())!;
  const kgBox = (await vals.last().boundingBox())!;
  expect(kgBox.y + kgBox.height).toBeLessThan(barBox.y);
  // stacked, and still centred on the same column
  const kgCx = kgBox.x + kgBox.width / 2;
  const barCx = barBox.x + barBox.width / 2;
  expect(Math.abs(kgCx - barCx)).toBeLessThan(2);
  // the non-colliding first endpoint is untouched: still riding its dot, 7px up
  const dotBox = (await page.locator(".food-weight-dot").first().boundingBox())!;
  const firstBox = (await vals.first().boundingBox())!;
  const dotCy = dotBox.y + dotBox.height / 2;
  expect(Math.abs(firstBox.y + firstBox.height - (dotCy - 7))).toBeLessThan(2);
  // the real numbers reach the footer, from the named log
  await expect(page.locator(".dash-foot")).toContainText("weight line 77,4–78,4 kg from Weight Log");
});

test("food: clicking a weight dot selects its day and keeps its hover title (SUB-730)", async ({
  page,
}) => {
  await openFood(page);
  // The first seeded weigh-in is nine days ago, at strip column 4. The dot
  // sits in an overlay above the columns, so it must forward the same day
  // selection while retaining the title that makes the exact weight legible.
  const dot = page.locator(".food-weight-dot").first();
  await expect(dot).toHaveAttribute("title", /78,4 kg$/);
  await dot.click();
  await expect(page.locator(".food-daynav-day")).toHaveText(labelFor(-9));
  await expect(page.locator(".food-col").nth(4)).toHaveClass(/focus/);
});

test("food: goal-met sub-line once past the floor (SUB-374)", async ({ page }) => {
  await openFood(page);
  await page.locator(".dash-form input[type=text]").fill("Big bowl");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("1700");
  await page.locator(".dash-add").click();
  // net 2050: inside the band → goal met, headroom to ceiling remains
  await expect(page.locator(".dash-apr")).toHaveText("2.050");
  await expect(page.locator(".dash-state")).toContainText("in the band");
  await expect(page.locator(".dash-sub")).toContainText("goal met · 250 kcal headroom");
});

test("food: a minus-typed kcal logs an exercise row, protein dropped (SUB-702)", async ({ page }) => {
  await openFood(page);
  // no mode switch anymore — one form, the minus is the exercise marker
  await expect(page.locator(".food-mode")).toHaveCount(0);
  await page.locator(".dash-form input[type=text]").fill("Run");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("-150");
  // a stray protein entry must not survive onto an exercise row
  await page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input").fill("5");
  await page.locator(".dash-add").click();
  // 350 − 150: the burn subtracts and the row renders as exercise
  await expect(page.locator(".dash-apr")).toHaveText("200");
  const run = page.locator(".food-row", { hasText: "Run" });
  await expect(run.locator(".food-row-kcal")).toContainText("−150");
  await expect(run.locator(".food-row-protein")).toHaveCount(0);
  await expect(page.locator(".dash-sub")).toContainText("450 burned");
});

test("food: an activity name logs negative even without a minus (SUB-702)", async ({ page }) => {
  await openFood(page);
  await page.locator(".dash-form input[type=text]").fill("Walking");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("200");
  await page.locator(".dash-add").click();
  // the vocabulary flips the sign: 350 − 200
  await expect(page.locator(".dash-apr")).toHaveText("150");
  await expect(
    page.locator(".food-row", { hasText: "Walking" }).locator(".food-row-kcal")
  ).toContainText("−200");
  await expect(page.locator(".dash-sub")).toContainText("500 burned");
});

test("food: autocomplete suggests from the log, Enter accepts and prefills (SUB-375)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("Ram");
  // seeded Ramen (yesterday, 700 kcal) surfaces with its last portion
  const item = page.locator(".food-suggest-item", { hasText: "Ramen" });
  await expect(item).toBeVisible();
  await expect(item.locator(".food-suggest-detail")).toContainText("700 kcal");
  await food.press("Enter");
  await expect(food).toHaveValue("Ramen");
  await expect(page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input")).toHaveValue("700");
  await expect(page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input")).toHaveValue("40");
  // menu closed; the follow-up Enter submits the prefilled row
  await expect(page.locator(".food-suggest")).toHaveCount(0);
  await food.press("Enter");
  await expect(page.locator(".dash-apr")).toHaveText("1.050");
});

test("food: → accepts with a typed quantity and scales the fill (SUB-375)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  // seeded "Chicken bowl 650" — typing a 2x quantity first scales the accept
  await food.pressSequentially("2x Chick");
  const item = page.locator(".food-suggest-item", { hasText: "Chicken bowl" });
  await expect(item).toBeVisible();
  // the row advertises the scaled fill, not the last portion
  await expect(item.locator(".food-suggest-detail")).toContainText("2× · 1.300 kcal");
  await food.press("ArrowRight");
  await expect(food).toHaveValue("Chicken bowl 2x");
  await expect(page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input")).toHaveValue("1300");
});

test("food: known food submits with kcal left empty, placeholder previews (SUB-375)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("Flat white");
  await food.press("Escape"); // free-typed exact name, no accept needed
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await expect(kcal).toHaveAttribute("placeholder", "90");
  await page.locator(".dash-add").click();
  await expect(page.locator(".food-row", { hasText: "Flat white" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("440");
});

test("food: exercise memories suggest alongside food, filling negative (SUB-702)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("Gy");
  // Gym (seeded −300) suggests from the one pool, advertising the minus
  const item = page.locator(".food-suggest-item", { hasText: "Gym" });
  await expect(item).toBeVisible();
  await expect(item.locator(".food-suggest-detail")).toContainText("−300 kcal");
  await food.press("Enter");
  // the accept fills the kcal field negative — submitting logs exercise
  await expect(page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input")).toHaveValue("-300");
  await food.press("Enter");
  await expect(page.locator(".dash-apr")).toHaveText("50"); // 350 − 300
  await expect(page.locator(".dash-sub")).toContainText("600 burned");
});

test("food: quick add appends a row and moves the hero", async ({ page }) => {
  await openFood(page);
  await page.locator(".dash-form input[type=text]").fill("Späti sandwich");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("400");
  await page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input").fill("15");
  await page.locator(".dash-add").click();
  await expect(page.locator(".dash-apr")).toHaveText("750");
  await expect(page.locator(".dash-sub")).toContainText("60 g protein");
  const row = page.locator(".food-row", { hasText: "Späti sandwich" });
  await expect(row).toBeVisible();
  // the write landed in the log sheet, not the dashboard note
  await page.getByRole("button", { name: "Open log note" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Food Log");
  await expect(page.locator(".sheet-table")).toContainText("Späti sandwich");
});

test("food: ⌘Z undoes a quick add, ⌘⇧Z brings the row back", async ({ page }) => {
  await openFood(page);
  await page.locator(".dash-form input[type=text]").fill("Pretzel");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("300");
  await page.locator(".dash-add").click();
  const row = page.locator(".food-row", { hasText: "Pretzel" });
  await expect(row).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("650");

  await page.keyboard.press("Meta+z");
  await expect(row).toHaveCount(0);
  await expect(page.locator(".dash-apr")).toHaveText("350");

  await page.keyboard.press("Meta+Shift+z");
  await expect(row).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("650");
});

test("food: ⌘Z restores a deleted row", async ({ page }) => {
  await openFood(page);
  const gym = page.locator(".food-row", { hasText: "Gym" });
  await gym.hover();
  await gym.locator(".food-del").click();
  await expect(gym).toHaveCount(0);
  await expect(page.locator(".dash-apr")).toHaveText("650");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".food-row", { hasText: "Gym" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("350");
});

test("food: delete removes only its row", async ({ page }) => {
  await openFood(page);
  // Ramen logged via autocomplete (yesterday's row remembers it)
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("Ramen");
  await food.press("Enter"); // accept suggestion
  await food.press("Enter"); // submit prefilled row
  await expect(page.locator(".dash-apr")).toHaveText("1.050");
  const doener = page.locator(".food-row", { hasText: "Ramen" });
  await expect(doener).toHaveCount(1);
  // exercise row renders negative in the today list; deleting the Ramen row
  // restores the seeded net and leaves the others alone
  await expect(page.locator(".food-row", { hasText: "Gym" }).locator(".food-row-kcal")).toContainText("−300");
  await doener.hover();
  await doener.locator(".food-del").click();
  await expect(page.locator(".dash-apr")).toHaveText("350");
  await expect(page.locator(".food-row")).toHaveCount(2);
});

// ---- day navigation + food database ----

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** the pane's dayLabel for a day offset from the run date */
function labelFor(offset: number): string {
  const t = todayBase();
  t.setDate(t.getDate() + offset);
  return `${WD[t.getDay()]} ${t.getDate()}`;
}

test("food: day arrows navigate hero + rows, quick-add backdates (SUB-408)", async ({ page }) => {
  await openFood(page);
  const y = labelFor(-1);
  await expect(page.getByRole("button", { name: "Next day" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous day" }).click();
  // hero + rows describe yesterday (700 Ramen + 90 Flat white + 780 Tortellini + 320 Porridge)
  await expect(page.locator(".dash-apr")).toHaveText("1.890");
  await expect(page.locator(".dash-label", { hasText: "net kcal" })).toHaveText(`net kcal · ${y}`);
  await expect(page.locator(".food-daynav-day")).toHaveText(y);
  await expect(page.locator(".food-row")).toHaveCount(4);
  // the quick-add lands on the focused day, not today
  await page.locator(".dash-form input[type=text]").fill("Late snack");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("200");
  await page.locator(".dash-add").click();
  await expect(page.locator(".dash-apr")).toHaveText("2.090");
  // back to today: its net and rows are untouched
  await page.locator(".food-daynav-day").click();
  await expect(page.locator(".dash-apr")).toHaveText("350");
  await expect(page.locator(".food-row")).toHaveCount(2);
});

test("food: clicking a strip bar selects its day (SUB-408)", async ({ page }) => {
  await openFood(page);
  await page.locator(".food-col").nth(12).click(); // yesterday in the 14-day strip
  await expect(page.locator(".dash-apr")).toHaveText("1.890");
  await expect(page.locator(".food-daynav-day")).toHaveText(labelFor(-1));
  // the focus ring + persistent value moved to the clicked day; today keeps its marker
  await expect(page.locator(".food-col").nth(12)).toHaveClass(/focus/);
  await expect(page.locator(".food-col").nth(12).locator(".dash-bar-val")).toHaveText("1.890");
  await expect(page.locator(".food-col").nth(13)).toHaveClass(/today/);
});

test("food: autocomplete prices DB foods at their basis (SUB-408)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("150g Che");
  const item = page.locator(".food-suggest-item", { hasText: "Chevroux" });
  await expect(item).toBeVisible();
  // the detail prices the TYPED 150g, not the 100g basis portion
  await expect(item.locator(".food-suggest-detail")).toContainText("150g · 398 kcal");
  await food.press("ArrowRight");
  await expect(food).toHaveValue("Chevroux 150g");
  await expect(page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input")).toHaveValue("398");
  await expect(page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input")).toHaveValue("27");
  await food.press("Enter");
  await expect(page.locator(".food-row", { hasText: "Chevroux 150g" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("748"); // 350 + 265×1.5
});

test("food: unit-basis DB food scales by count (SUB-408)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.pressSequentially("Egg");
  const item = page.locator(".food-suggest-item", { hasText: "Eggs" });
  await expect(item.locator(".food-suggest-detail")).toContainText("80 kcal");
  await food.press("Enter"); // accept
  await expect(food).toHaveValue("Eggs");
  await expect(page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input")).toHaveValue("80");
});

// ---- kcal expressions in the food field ----

test("food: per-hundred expression prices the typed weight (SUB-629)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.pressSequentially("Eintopf 200g 100ph"); // 100 kcal/100g × 200g
  await expect(kcal).toHaveAttribute("placeholder", "200");
  await page.locator(".dash-add").click();
  // the name keeps the weight — the memory learns the per-gram basis
  await expect(page.locator(".food-row", { hasText: "Eintopf 200g" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("550"); // 350 + 200
});

test("food: trailing math in the food field fills kcal (SUB-629)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.pressSequentially("23+23");
  await expect(kcal).toHaveAttribute("placeholder", "46");
  await page.locator(".dash-add").click();
  // a nameless expression keeps the full text as the row's name
  await expect(page.locator(".food-row", { hasText: "23+23" })).toBeVisible();
  await food.pressSequentially("Pizza 2*180");
  await expect(kcal).toHaveAttribute("placeholder", "360");
  await page.locator(".dash-add").click();
  await expect(page.locator(".food-row", { hasText: "Pizza" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("756"); // 350 + 46 + 360
});

test("food: an expression's resolved name carries its protein (SUB-634)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  const protein = page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input");
  // Chevroux is a DB base: 265 kcal / 18 g protein per 100 g. The expression
  // states the kcal, the basis states the protein — 200 g → 36 g
  await food.pressSequentially("Chevroux 200g 250ph");
  await food.press("Escape"); // close the suggestion menu
  await expect(kcal).toHaveAttribute("placeholder", "500");
  await expect(protein).toHaveAttribute("placeholder", "36");
  await page.locator(".dash-add").click();
  const row = page.locator(".food-row", { hasText: "Chevroux 200g" });
  await expect(row.locator(".food-row-protein")).toHaveText("36 g");
  await expect(page.locator(".dash-apr")).toHaveText("850"); // 350 + 500
  await expect(page.locator(".dash-sub")).toContainText("81 g protein"); // 45 + 36
});

test("food: hand-typed protein beats the expression's basis (SUB-634)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const protein = page.locator(".dash-form-row label", { hasText: "Protein" }).locator("input");
  await food.pressSequentially("Chevroux 200g 250ph");
  await food.press("Escape");
  await protein.fill("12"); // the user owns the number they typed
  await page.locator(".dash-add").click();
  const row = page.locator(".food-row", { hasText: "Chevroux 200g" });
  await expect(row.locator(".food-row-protein")).toHaveText("12 g");
  await expect(page.locator(".dash-sub")).toContainText("57 g protein"); // 45 + 12
});

test("food: editing the food text after an accept reprices the fill (SUB-629)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.pressSequentially("Ramen");
  await food.press("Enter"); // accept → Ramen, 700 kcal
  await expect(kcal).toHaveValue("700");
  // the "6x" → "2x" fix: editing the quantity rescales the accepted fill
  // instead of logging the stale number against the new name
  await food.fill("Ramen 2x");
  await food.press("Escape"); // close the menu so Enter submits, not accepts
  await expect(kcal).toHaveValue("1400");
  await food.press("Enter");
  await expect(page.locator(".food-row", { hasText: "Ramen 2x" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("1.750"); // 350 + 1400
});

test("food: hand-typed kcal is never repriced by food edits (SUB-629)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.pressSequentially("Ramen");
  await food.press("Enter"); // accept → 700
  await kcal.fill("500"); // user overrides — ownership passes to them
  await food.fill("Ramen 2x");
  await food.press("Escape"); // close the suggestion menu for the locator
  await expect(kcal).toHaveValue("500"); // untouched
});

test("food: an accept-then-expression edit logs the canonical name (SUB-629 review)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.pressSequentially("Ramen");
  await food.press("Enter"); // accept → filledRef set
  await food.fill("Ramen 2*180"); // repriced through the expression…
  await food.press("Escape");
  await expect(kcal).toHaveValue("360");
  await food.press("Enter");
  // …but the row gets the expression's canonical name, not the verbatim text —
  // otherwise the memory learns a food literally named "Ramen 2*180"
  await expect(page.locator(".food-row-name", { hasText: "Ramen" })).toHaveText("Ramen");
  await expect(page.locator(".dash-apr")).toHaveText("710"); // 350 + 360
});

test("food: database section adds, applies, removes, ⌘Z restores (SUB-408)", async ({ page }) => {
  await openFood(page);
  await page.locator(".food-db-toggle").click();
  // seeded bases render with their per-basis numbers
  await expect(page.locator(".food-db-rows .food-row")).toHaveCount(3);
  const chevroux = page.locator(".food-db-rows .food-row", { hasText: "Chevroux" });
  await expect(chevroux).toContainText("265 kcal/100g");
  await expect(chevroux).toContainText("18 g/100g");
  // add a new base (per 100g is the default toggle)
  const dbForm = page.locator(".food-db-form");
  await dbForm.locator("input[type=text]").fill("Skyr");
  await dbForm.locator("label", { hasText: "kcal" }).locator("input").fill("60");
  await dbForm.locator("label", { hasText: "Protein" }).locator("input").fill("11");
  await dbForm.locator(".dash-add").click();
  await expect(page.locator(".food-db-toggle")).toContainText("Database · 4");
  await expect(page.locator(".food-db-rows .food-row", { hasText: "Skyr" })).toContainText("60 kcal/100g");
  // the log form prices it straight from the DB
  const logForm = page.locator(".dash-form:not(.food-db-form)");
  await logForm.locator("input[type=text]").pressSequentially("150g Sky");
  await logForm.locator("input[type=text]").press("ArrowRight");
  await expect(logForm.locator("label", { hasText: "kcal" }).locator("input")).toHaveValue("90");
  // remove it; ⌘Z brings the DB entry back
  const skyr = page.locator(".food-db-rows .food-row", { hasText: "Skyr" });
  await skyr.hover();
  await skyr.locator(".food-del").click();
  await expect(page.locator(".food-db-rows .food-row")).toHaveCount(3);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".food-db-rows .food-row", { hasText: "Skyr" })).toBeVisible();
});

test("food: grams-per-unit DB entry prices gram quantities (SUB-687)", async ({ page }) => {
  await openFood(page);
  await page.locator(".food-db-toggle").click();
  const dbForm = page.locator(".food-db-form");
  await dbForm.locator("input[type=text]").fill("Babybell");
  await dbForm.locator("label", { hasText: "kcal" }).locator("input").fill("55");
  await dbForm.locator(".food-db-per button", { hasText: "unit" }).click();
  // the g/unit input only exists for unit-based entries
  await dbForm.locator("label", { hasText: "g/unit" }).locator("input").fill("20");
  await dbForm.locator(".dash-add").click();
  await expect(page.locator(".food-db-rows .food-row", { hasText: "Babybell" })).toContainText(
    "55 kcal/unit · 20 g"
  );
  // the log form now prices grams against the piece basis — before the
  // bridge this accept left kcal blank
  const logForm = page.locator(".dash-form:not(.food-db-form)");
  const food = logForm.locator("input[type=text]");
  await food.pressSequentially("40g Baby");
  const item = page.locator(".food-suggest-item", { hasText: "Babybell" });
  await expect(item.locator(".food-suggest-detail")).toContainText("40g · 110 kcal");
  await food.press("ArrowRight");
  await expect(food).toHaveValue("Babybell 40g");
  await expect(logForm.locator("label", { hasText: "kcal" }).locator("input")).toHaveValue("110");
  await food.press("Enter");
  await expect(page.locator(".food-row", { hasText: "Babybell 40g" })).toBeVisible();
  await expect(page.locator(".dash-apr")).toHaveText("460"); // 350 + 110
});

// ---- basis-drift tripwire ----

test("food: a contradicting row trips the drift line; pin writes the DB (SUB-688)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  // seeded "Chicken bowl 650" (650/piece) — a 2000-kcal 2x row implies 1000/piece
  await food.fill("Chicken bowl 2x");
  await food.press("Escape"); // close the suggestion menu for the kcal locator
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("2000");
  await page.locator(".dash-add").click();
  const drift = page.locator(".food-drift");
  await expect(drift).toContainText("Chicken bowl at 1.000 kcal/piece — remembered 650");
  await drift.locator("button", { hasText: "Pin to DB" }).click();
  // the pin upserts the DB with the row's basis and the line clears
  await expect(drift).toHaveCount(0);
  await page.locator(".food-db-toggle").click();
  await expect(page.locator(".food-db-rows .food-row", { hasText: "Chicken bowl" })).toContainText(
    "1.000 kcal/unit"
  );
});

test("food: drift against a DB-backed food offers Update DB, preserves protein (SUB-688)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  // seeded DB Eggs 80/x/7 — a 400-kcal 2x row implies 200/piece
  await food.fill("Eggs 2x");
  await food.press("Escape");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("400");
  await page.locator(".dash-add").click();
  const drift = page.locator(".food-drift");
  await expect(drift).toContainText("Eggs at 200 kcal/piece — remembered 80");
  await drift.locator("button", { hasText: "Update DB" }).click();
  await expect(drift).toHaveCount(0);
  await page.locator(".food-db-toggle").click();
  const eggs = page.locator(".food-db-rows .food-row", { hasText: "Eggs" });
  await expect(eggs).toContainText("200 kcal/unit");
  await expect(eggs).toContainText("7 g/unit"); // protein is a fact of its own
});

test("food: dismiss hides the line; ordinary adds never trip it (SUB-688)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  // a new food + a memory-priced accept — neither may trip the wire
  await food.fill("Big bowl");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("1200");
  await page.locator(".dash-add").click();
  await expect(page.locator(".food-drift")).toHaveCount(0);
  await food.pressSequentially("Ramen");
  await food.press("Enter"); // accept
  await food.press("Enter"); // submit
  await expect(page.locator(".food-drift")).toHaveCount(0);
  // the babybell case: same food, implausible kcal — fires; dismiss clears
  await food.fill("Ramen 2x");
  await food.press("Escape");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("100");
  await page.locator(".dash-add").click();
  const drift = page.locator(".food-drift");
  await expect(drift).toContainText("Ramen at 50 kcal/piece — remembered 700");
  await drift.locator(".food-drift-x").click();
  await expect(page.locator(".food-drift")).toHaveCount(0);
});

test("food: undoing the drifted row self-clears the line (SUB-688)", async ({ page }) => {
  await openFood(page);
  const food = page.locator(".dash-form input[type=text]");
  await food.fill("Chicken bowl 2x");
  await food.press("Escape");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("2000");
  await page.locator(".dash-add").click();
  await expect(page.locator(".food-drift")).toContainText("Chicken bowl");
  // ⌘Z removes the row, the memory re-derives the old basis, the line has
  // nothing left to accuse
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".food-drift")).toHaveCount(0);
});

// Inside a dashboard the segmented switch wears the underline-dash
// voice instead of a filled pill — the active state has to survive that, and
// so does the keyboard focus ring. Probed on the DB's per-basis switch (the
// log form's Food|Exercise switch was retired once a minus-kcal entry became
// the way to log exercise).
test("food: the per switch reads active by underline, and keeps a focus ring", async ({ page }) => {
  await openFood(page);
  await page.locator(".food-db-toggle").click();
  const g100 = page.locator(".food-db-per button", { hasText: "100 g" });
  const ml100 = page.locator(".food-db-per button", { hasText: "100 ml" });

  // no pill fill anywhere in the dashboard switch — the active mark is the bar
  const fill = (l: typeof g100) =>
    l.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await fill(g100)).toBe("rgba(0, 0, 0, 0)");
  const bar = (l: typeof g100) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return { content: s.content, height: s.height, bg: s.backgroundColor };
    });
  const activeBar = await bar(g100);
  expect(activeBar.content).not.toBe("none");
  expect(activeBar.height).toBe("2px");
  expect((await bar(ml100)).content).toBe("none");

  // active also still carries the sharper text color than its inactive twin
  const ink = (l: typeof g100) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await ink(g100)).not.toBe(await ink(ml100));

  // and keyboard focus still paints the ring (outline, not the removed border).
  // :focus-visible only arms on keyboard motion, so Tab into it rather than
  // calling focus() — a programmatic focus renders no ring in Chromium.
  await g100.focus();
  await page.keyboard.press("Tab");
  await expect(ml100).toBeFocused();
  const outline = await ml100.evaluate((el) => {
    const s = getComputedStyle(el);
    return { w: s.outlineWidth, style: s.outlineStyle };
  });
  expect(outline.style).not.toBe("none");
  expect(parseFloat(outline.w)).toBeGreaterThan(0);
});

// An implausible kcal — a pasted extra digit, or a runaway
// expression — used to log fine, and one such row pins the strip's scale so
// every other day collapses to the 3% floor while avg7 / week-vs-goal stay
// poisoned for two weeks. Rejected at entry in both input paths now.
test("food: a 9-digit kcal can't be added, and the strip is unaffected (SUB-691)", async ({
  page,
}) => {
  await openFood(page);
  const bar = page.locator(".food-col.today .food-bar");
  const heightBefore = await bar.evaluate((el) => el.getBoundingClientRect().height);

  const food = page.locator(".dash-form input[type=text]");
  const kcal = page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input");
  await food.fill("Späti sandwich");
  await kcal.fill("650000000");
  await expect(page.locator(".dash-add")).toBeDisabled();

  // the same number as a typed expression is no answer either — the field
  // stays empty of a resolved preview and Add stays disabled
  await kcal.fill("");
  await food.fill("Späti sandwich 999999999*999999999");
  await expect(page.locator(".dash-add")).toBeDisabled();

  // one digit fewer than the bound is an ordinary (if large) meal
  await food.fill("Späti sandwich");
  await kcal.fill("19999");
  await expect(page.locator(".dash-add")).toBeEnabled();

  // nothing was logged by the rejected attempts: hero and strip stand where
  // the seed left them
  await kcal.fill("");
  await food.fill("");
  await expect(page.locator(".dash-apr")).toHaveText("350");
  await expect(bar).toHaveJSProperty("clientHeight", Math.round(heightBefore));
  await expect(page.locator(".food-row", { hasText: "Späti" })).toHaveCount(0);
});

// ---- zero-line split for net-negative days ----

test("food: a net-negative day hangs below the zero line at true scale (SUB-684)", async ({
  page,
}) => {
  await openFood(page);
  // seed a −900 day inside the window: focus the unlogged day four back
  // (strip index 9 of [today−13 … today]) and log an exercise row there
  await page.locator(".food-col").nth(9).click();
  await page.locator(".dash-form input[type=text]").fill("Run");
  await page.locator(".dash-form-row label", { hasText: "kcal" }).locator("input").fill("-900");
  await page.locator(".dash-add").click();
  await expect(page.locator(".dash-apr")).toHaveText("-900"); // focus-day hero, signed
  // defocus back to today so the strip geometry carries no focus ring
  await page.locator(".food-daynav-day").click();

  // the split: maxScale 2300 (the ceiling), minTotal −900 → span 3200, the
  // bottom 12% reserved for tip labels → zero at 12 + 900/3200×88 ≈ 36.75%
  // from the bottom, the −900 bar 900/3200×88 ≈ 24.75% tall, tip at 12%
  const plot = page.locator(".food-plot");
  await expect(plot).toHaveClass(/split/);
  const zero = page.locator(".food-zero");
  await expect(zero).toHaveCount(1);

  const col = page.locator(".food-col").nth(9);
  const bar = col.locator(".food-bar");
  // a net-negative day is under the floor: it keeps the yellow fill
  await expect(bar).toHaveClass(/food-under/);
  await expect(col.locator(".dash-bar-val")).toHaveText("−900");

  const colBox = (await col.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  const zeroBox = (await zero.boundingBox())!;
  const colH = colBox.height;
  const bottomY = colBox.y + colH;
  // the hairline sits at its proportional share of the plot
  expect(Math.abs(zeroBox.y + zeroBox.height - (bottomY - 0.3675 * colH))).toBeLessThan(2);
  // the bar hangs FROM the line (its top edge is the line), never above it
  expect(Math.abs(barBox.y - (zeroBox.y + zeroBox.height))).toBeLessThan(2);
  // true scale and the tip on the 12% reserve
  expect(Math.abs(barBox.height - 0.2475 * colH)).toBeLessThan(2);
  expect(Math.abs(barBox.y + barBox.height - (bottomY - 0.12 * colH))).toBeLessThan(2);

  // the signed label rides below the tip and stays on-canvas
  const valBox = (await col.locator(".dash-bar-val").boundingBox())!;
  expect(Math.abs(valBox.y - (barBox.y + barBox.height + 3))).toBeLessThan(2);
  expect(valBox.y + valBox.height).toBeLessThanOrEqual(bottomY + 1);

  // an empty day keeps its 3px grey stub ABOVE the line — distinct from a
  // downward negative bar
  const stub = page.locator(".food-col").nth(8).locator(".food-bar");
  await expect(stub).toHaveClass(/food-empty/);
  const stubBox = (await stub.boundingBox())!;
  expect(Math.abs(stubBox.height - 3)).toBeLessThan(1.5);
  expect(Math.abs(stubBox.y + stubBox.height - (zeroBox.y + zeroBox.height))).toBeLessThan(2);

  // a positive day draws upward from the line at the same scale
  const todayBar = page.locator(".food-col.today .food-bar");
  const todayBox = (await todayBar.boundingBox())!;
  expect(Math.abs(todayBox.y + todayBox.height - (zeroBox.y + zeroBox.height))).toBeLessThan(2);
  expect(Math.abs(todayBox.height - (350 / 3200) * 0.88 * colH)).toBeLessThan(2);

  // tooltip + click-to-pick-day work for the negative day like any other
  await expect(col).toHaveAttribute("title", /-900 kcal · 1 rows/);
  await col.click();
  await expect(page.locator(".food-daynav-day")).toHaveText(labelFor(-4));
  await expect(page.locator(".dash-apr")).toHaveText("-900");
});

test("food: no negative day → no zero line, strip geometry untouched (SUB-684)", async ({
  page,
}) => {
  await openFood(page);
  // the seed's window is all non-negative: no baseline, no split layout
  await expect(page.locator(".food-zero")).toHaveCount(0);
  await expect(page.locator(".food-plot")).not.toHaveClass(/split/);

  const col = page.locator(".food-col.today");
  const bar = col.locator(".food-bar");
  // bars stay in flow — no absolute-positioning inline styles leaked in
  expect(await bar.evaluate((el) => el.style.bottom)).toBe("");
  expect(await col.locator(".dash-bar-val").evaluate((el) => el.style.bottom)).toBe("");

  // today's 350 of maxScale 2300 (the ceiling pins the top — no day
  // overshoots it) → 15.22% of the column, bottom-anchored
  const colBox = (await col.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(Math.abs(barBox.height - (350 / 2300) * colBox.height)).toBeLessThan(2);
  expect(Math.abs(barBox.y + barBox.height - (colBox.y + colBox.height))).toBeLessThan(2);

  // the band stands where it always did: floor 1900 → 82.61% up, 400 tall
  const bandBox = (await page.locator(".food-band").boundingBox())!;
  const plotBottom = colBox.y + colBox.height;
  expect(Math.abs(bandBox.y + bandBox.height - (plotBottom - (1900 / 2300) * colBox.height))).toBeLessThan(2);
  expect(Math.abs(bandBox.height - (400 / 2300) * colBox.height)).toBeLessThan(2);
});
