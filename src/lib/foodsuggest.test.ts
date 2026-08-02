import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoFill,
  buildFoodMemory,
  detectDrift,
  fillFor,
  foodName,
  isExerciseName,
  parseFoodInput,
  parseKcalExpr,
  suggestFoods,
} from "./foodsuggest.ts";
import { KCAL_MAX, parseFoodRows } from "./food.ts";

function rowsOf(lines: string[]) {
  return parseFoodRows(
    ["Log.", "", "```csv", "date,food,kcal,protein_g", ...lines, "```", ""].join("\n")
  );
}

test("parseFoodInput: trailing and leading quantity forms", () => {
  assert.deepEqual(parseFoodInput("Eggs 2x"), { base: "Eggs", qty: 2, unit: "x" });
  assert.deepEqual(parseFoodInput("Eggs x2"), { base: "Eggs", qty: 2, unit: "x" });
  assert.deepEqual(parseFoodInput("2x Eggs"), { base: "Eggs", qty: 2, unit: "x" });
  assert.deepEqual(parseFoodInput("x2 Eggs"), { base: "Eggs", qty: 2, unit: "x" });
  assert.deepEqual(parseFoodInput("3 Eggs"), { base: "Eggs", qty: 3, unit: "x" });
  assert.deepEqual(parseFoodInput("Magerspeck 30g"), { base: "Magerspeck", qty: 30, unit: "g" });
  assert.deepEqual(parseFoodInput("100ml Milch"), { base: "Milch", qty: 100, unit: "ml" });
  assert.deepEqual(parseFoodInput("Milch 100 ml"), { base: "Milch", qty: 100, unit: "ml" });
  assert.deepEqual(parseFoodInput("1,5x Toast"), { base: "Toast", qty: 1.5, unit: "x" });
});

test("parseFoodInput: no quantity, bare trailing number stays a name", () => {
  assert.deepEqual(parseFoodInput("Chicken bowl"), { base: "Chicken bowl", qty: null, unit: null });
  assert.deepEqual(parseFoodInput("Area 51"), { base: "Area 51", qty: null, unit: null });
  // trailing token wins over leading
  assert.deepEqual(parseFoodInput("2 Eggs 100g"), { base: "2 Eggs", qty: 100, unit: "g" });
});

test("foodName: canonical form, silent 1x, round-trips", () => {
  assert.equal(foodName("Eggs", 2, "x"), "Eggs 2x");
  assert.equal(foodName("Eggs", 1, "x"), "Eggs");
  assert.equal(foodName("Speck", 30, "g"), "Speck 30g");
  assert.deepEqual(parseFoodInput(foodName("Speck", 30, "g")), { base: "Speck", qty: 30, unit: "g" });
});

test("buildFoodMemory: per-unit basis from the newest row, counts all rows", () => {
  const mem = buildFoodMemory(
    rowsOf([
      "2026-07-20,Eggs 3x,240,18",
      "2026-07-21,Eggs 2x,150,13", // newer row wins the basis
      "2026-07-21,Magerspeck 30g,33,6",
    ])
  );
  const eggs = mem.find((m) => m.base === "Eggs")!;
  assert.equal(eggs.perKcal, 75);
  assert.equal(eggs.lastQty, 2);
  assert.equal(eggs.count, 2);
  const speck = mem.find((m) => m.base === "Magerspeck")!;
  assert.equal(speck.unit, "g");
  assert.equal(speck.perKcal, 1.1);
});

test("buildFoodMemory: exercise rows are separate, kcal positive", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Gym,-300,", "2026-07-21,Gym,650,20"]));
  assert.equal(mem.length, 2);
  const ex = mem.find((m) => m.exercise)!;
  assert.equal(ex.perKcal, 300);
  assert.equal(ex.lastProtein, null);
});

test("fillFor: no qty typed → last portion; x scales; g scales per-unit", () => {
  const [speck] = buildFoodMemory(rowsOf(["2026-07-21,Magerspeck 30g,33,6"]));
  assert.deepEqual(fillFor(speck, null, null), { name: "Magerspeck 30g", kcal: 33, protein: 6 });
  assert.deepEqual(fillFor(speck, 100, "g"), { name: "Magerspeck 100g", kcal: 110, protein: 20 });
  // x against a weight entry multiplies the whole last portion
  assert.deepEqual(fillFor(speck, 2, "x"), { name: "Magerspeck 60g", kcal: 66, protein: 12 });
  const [eggs] = buildFoodMemory(rowsOf(["2026-07-21,Eggs 3x,230,19"]));
  assert.deepEqual(fillFor(eggs, 2, "x"), { name: "Eggs 2x", kcal: 153, protein: 13 });
  // g against an x entry has no honest conversion
  assert.equal(fillFor(eggs, 100, "g").kcal, null);
});

test("suggestFoods: prefix beats substring, recency ranks, one pool (SUB-702)", () => {
  const mem = buildFoodMemory(
    rowsOf([
      "2026-07-19,Toast,100,2",
      "2026-07-20,Tortellini,780,32",
      "2026-07-21,Chevretta Toast,250,9",
      "2026-07-21,Gym,-300,",
    ])
  );
  const s = suggestFoods(mem, "to");
  assert.deepEqual(
    s.map((m) => m.base),
    ["Tortellini", "Toast", "Chevretta Toast"] // prefixes first, then substring
  );
  // exercise memories suggest from the same pool, filling negative
  assert.deepEqual(suggestFoods(mem, "gy").map((m) => m.base), ["Gym"]);
  assert.equal(fillFor(suggestFoods(mem, "gy")[0], null, null).kcal, -300);
  assert.deepEqual(suggestFoods(mem, ""), []);
  // quantity tokens don't break matching
  assert.equal(suggestFoods(mem, "2x toa")[0].base, "Toast");
});

test("autoFill: exact base only, scales, null on unknown or unit mismatch", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Eggs 3x,230,19", "2026-07-21,Gym,-300,"]));
  assert.deepEqual(autoFill(mem, "eggs 2x"), { name: "Eggs 2x", kcal: 153, protein: 13 });
  assert.deepEqual(autoFill(mem, "Eggs"), { name: "Eggs 3x", kcal: 230, protein: 19 });
  assert.equal(autoFill(mem, "Egg"), null); // prefix is not exact
  assert.equal(autoFill(mem, "Eggs 100g"), null); // unit mismatch
  assert.equal(autoFill(mem, "Gym")!.kcal, -300); // exercise resolves negative
});

test("autoFill: a base logged as food AND exercise resolves to the newer row", () => {
  // "Spinning" the food (2026-07-19) vs "Spinning" the class (2026-07-21)
  const mem = buildFoodMemory(
    rowsOf(["2026-07-19,Spinning,120,4", "2026-07-21,Spinning,-250,"])
  );
  assert.equal(autoFill(mem, "Spinning")!.kcal, -250); // newer exercise row wins
  // same-day tie keeps the food reading, the safer default
  const tie = buildFoodMemory(rowsOf(["2026-07-21,Wrap,300,12", "2026-07-21,Wrap,-300,"]));
  assert.equal(autoFill(tie, "Wrap")!.kcal, 300);
});

test("isExerciseName: activity words read as exercise, whole-word only (SUB-702)", () => {
  assert.equal(isExerciseName("Gym"), true);
  assert.equal(isExerciseName("workout"), true);
  assert.equal(isExerciseName("Walking"), true);
  assert.equal(isExerciseName("Morning run"), true);
  assert.equal(isExerciseName("Joggen"), true);
  assert.equal(isExerciseName("Krafttraining"), true);
  assert.equal(isExerciseName("Rad 45min"), true); // quantity token stripped first
  assert.equal(isExerciseName("Burn"), true);
  // food stays food — substrings and compounds don't trigger
  assert.equal(isExerciseName("Chicken bowl"), false);
  assert.equal(isExerciseName("Radler"), false);
  assert.equal(isExerciseName("Bratwurst"), false);
  assert.equal(isExerciseName("Sportgetränk"), false);
  assert.equal(isExerciseName(""), false);
});

// ---- food DB merge (SUB-408) ----

test("buildFoodMemory db: never-logged food joins with the basis as portion", () => {
  const mem = buildFoodMemory([], [
    { name: "Chevroux", kcal: 265, per: "100g", protein: 18, g: null, idx: 0 },
    { name: "Eggs", kcal: 80, per: "x", protein: 7, g: null, idx: 1 },
  ]);
  const ch = mem.find((m) => m.base === "Chevroux")!;
  assert.equal(ch.unit, "g");
  assert.equal(ch.perKcal, 2.65);
  assert.equal(ch.lastQty, 100); // "no qty typed" defaults to the basis itself
  assert.equal(ch.lastKcal, 265);
  assert.equal(ch.lastDate, ""); // ranks below any logged food
  assert.equal(ch.exercise, false);
  const eggs = mem.find((m) => m.base === "Eggs")!;
  assert.deepEqual(fillFor(eggs, 2, "x"), { name: "Eggs 2x", kcal: 160, protein: 14 });
  assert.deepEqual(autoFill(mem, "chevroux 150g"), {
    name: "Chevroux 150g",
    kcal: 398, // 265 × 1.5 = 397.5 rounds
    protein: 27,
  });
});

test("buildFoodMemory db: overrides the logged basis, keeps the portion (g↔ml)", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Magerspeck 30g,33,6"]), [
    { name: "magerspeck", kcal: 150, per: "100g", protein: 20, g: null, idx: 0 },
  ]);
  const speck = mem.find((m) => m.base === "Magerspeck")!;
  assert.equal(speck.perKcal, 1.5); // DB wins, not the logged 1.1
  assert.equal(speck.lastQty, 30); // same unit kind → remembered portion kept
  assert.equal(speck.lastKcal, 45); // …priced at the DB basis
  assert.equal(speck.lastDate, "2026-07-21"); // log recency kept
  assert.deepEqual(fillFor(speck, 100, "g"), { name: "Magerspeck 100g", kcal: 150, protein: 20 });
});

test("buildFoodMemory db: unit-kind switch falls back to the basis portion", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Eggs 2x,150,13"]), [
    { name: "Eggs", kcal: 140, per: "100g", protein: 13, g: null, idx: 0 },
  ]);
  const eggs = mem.find((m) => m.base === "Eggs")!;
  assert.equal(eggs.unit, "g");
  assert.equal(eggs.lastQty, 100); // 2x can't convert into grams honestly
  assert.equal(eggs.lastKcal, 140);
});

test("buildFoodMemory db: zero/negative kcal entries don't suggest", () => {
  const mem = buildFoodMemory([], [
    { name: "Water", kcal: 0, per: "100ml", protein: null, g: null, idx: 0 },
    { name: "Weird", kcal: -50, per: "x", protein: null, g: null, idx: 1 },
  ]);
  assert.equal(mem.length, 0);
});

test("buildFoodMemory db: exercise memory untouched, db ranks below logged", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Gym,-300,", "2026-07-20,Gouda 40g,140,10"]), [
    { name: "Gym", kcal: 250, per: "x", protein: null, g: null, idx: 0 },
    { name: "Gouda jung", kcal: 330, per: "100g", protein: 25, g: null, idx: 1 },
  ]);
  const ex = mem.find((m) => m.exercise)!;
  assert.equal(ex.perKcal, 300); // the log's exercise row, not the db's "Gym"
  // one pool (SUB-702): the exercise Gym (logged, newest) ranks first; the
  // db's food "Gym" is a distinct memory and still surfaces, dateless-last
  const s = suggestFoods(mem, "g");
  assert.deepEqual(
    s.map((m) => `${m.base}${m.exercise ? "−" : ""}`),
    ["Gym−", "Gouda", "Gouda jung", "Gym"]
  );
});

// ---- kcal expressions in the food field (SUB-629) ----

test("parseKcalExpr: per-hundred basis prices the typed weight/volume", () => {
  assert.deepEqual(parseKcalExpr("goulash 200g 100ph"), {
    name: "goulash 200g",
    kcal: 200,
    protein: null,
  });
  assert.deepEqual(parseKcalExpr("Milch 250ml 60ph"), {
    name: "Milch 250ml",
    kcal: 150,
    protein: null,
  });
  assert.equal(parseKcalExpr("Skyr 150g 55ph")!.kcal, 83); // 82.5 rounds
  // decimal comma, spaced unit, uppercase PH
  assert.equal(parseKcalExpr("Quark 350 g 61,5 PH")!.kcal, 215);
  // no weight/volume → no honest answer
  assert.equal(parseKcalExpr("goulash 100ph"), null);
  assert.equal(parseKcalExpr("Eggs 2x 50ph"), null);
  assert.equal(parseKcalExpr("100ph"), null);
  // ph must be trailing
  assert.equal(parseKcalExpr("100ph goulash 200g"), null);
  // a rounded-to-zero portion is no answer either (review finding)
  assert.equal(parseKcalExpr("Chicken bowl 200g 0ph"), null);
  assert.equal(parseKcalExpr("Skyr 1g 40ph"), null); // 0.4 rounds to 0
});

test("parseKcalExpr: trailing math evaluates, leading text stays the name", () => {
  assert.deepEqual(parseKcalExpr("10*400"), { name: "10*400", kcal: 4000, protein: null });
  assert.deepEqual(parseKcalExpr("23+23"), { name: "23+23", kcal: 46, protein: null });
  assert.deepEqual(parseKcalExpr("Pizza 2*180"), { name: "Pizza", kcal: 360, protein: null });
  assert.equal(parseKcalExpr("(10+5)*20")!.kcal, 300);
  assert.equal(parseKcalExpr("400/2")!.kcal, 200);
  assert.equal(parseKcalExpr("1,5*100")!.kcal, 150);
  assert.equal(parseKcalExpr("Snack 100 + 50")!.kcal, 150); // spaces inside
  assert.equal(parseKcalExpr("2×150")!.kcal, 300); // × alias
  assert.deepEqual(parseKcalExpr("goulash, 100+100")!.name, "goulash"); // stray comma trimmed
});

test("parseKcalExpr: names and quantities are never expressions", () => {
  assert.equal(parseKcalExpr("Chicken bowl"), null);
  assert.equal(parseKcalExpr("Area 51"), null); // bare trailing number, no operator
  assert.equal(parseKcalExpr("Cola 0,5"), null); // decimal comma is not an operator
  assert.equal(parseKcalExpr("Eggs 2x"), null); // quantity grammar, not math
  assert.equal(parseKcalExpr("Magerspeck 30g"), null);
  assert.equal(parseKcalExpr("Vitamin B12"), null);
  assert.equal(parseKcalExpr("goulash - 23"), null); // non-positive result
  assert.equal(parseKcalExpr("100/0"), null); // not finite
  assert.equal(parseKcalExpr("2*"), null); // malformed
  // ":" is not a division alias — clock times and ratios stay names (review)
  assert.equal(parseKcalExpr("Kaffee 12:30"), null);
  assert.equal(parseKcalExpr("Mittag 13:45"), null);
  assert.equal(parseKcalExpr("Rind 70:30"), null);
  assert.equal(parseKcalExpr("500:2"), null);
  // results that round to zero would log a 0-kcal row — refused (review)
  assert.equal(parseKcalExpr("Snack 400/1000"), null);
  assert.equal(parseKcalExpr("Riegel 1/1000"), null);
});

test("parseKcalExpr: a ph-logged row teaches the memory the per-gram basis", () => {
  const fill = parseKcalExpr("goulash 200g 100ph")!;
  const mem = buildFoodMemory(rowsOf([`2026-07-21,${fill.name},${fill.kcal},`]));
  // next time a different portion scales off the learned 1 kcal/g
  assert.deepEqual(autoFill(mem, "goulash 350g"), {
    name: "goulash 350g",
    kcal: 350,
    protein: null,
  });
});

// ---- expression protein from the memory basis (SUB-634) ----

test("parseKcalExpr: a resolved name scales its protein by the typed quantity", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Skyr 100g,60,10"]));
  // ph form: the expression states the kcal, the memory states the protein
  assert.deepEqual(parseKcalExpr("Skyr 300g 60ph", mem), {
    name: "Skyr 300g",
    kcal: 180,
    protein: 30,
  });
  // math form, same scaling
  assert.deepEqual(parseKcalExpr("Skyr 250g 2*90", mem), {
    name: "Skyr 250g",
    kcal: 180,
    protein: 25,
  });
  // no quantity typed → the remembered portion, like accepting would fill
  assert.deepEqual(parseKcalExpr("Skyr 2*90", mem), { name: "Skyr", kcal: 180, protein: 10 });
});

test("parseKcalExpr: per-x and per-100 bases both scale, rounded", () => {
  const perX = buildFoodMemory(rowsOf(["2026-07-21,Eggs 3x,230,19"]));
  // 19/3 per egg × 2 = 12.67 → 13
  assert.equal(parseKcalExpr("Eggs 2x 80+80", perX)!.protein, 13);
  const perHundred = buildFoodMemory([], [
    { name: "Magerquark", kcal: 67, per: "100g", protein: 12, g: null, idx: 0 },
  ]);
  assert.equal(parseKcalExpr("Magerquark 250g 67ph", perHundred)!.protein, 30);
});

test("parseKcalExpr: protein stays null without an honest basis", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Skyr 100g,60,10", "2026-07-21,Gym,-300,"]));
  // no memory passed at all — the SUB-629 behaviour, unchanged
  assert.equal(parseKcalExpr("Skyr 300g 60ph")!.protein, null);
  // unknown name, and a prefix is not an exact match
  assert.equal(parseKcalExpr("Eintopf 300g 60ph", mem)!.protein, null);
  assert.equal(parseKcalExpr("Sky 300g 60ph", mem)!.protein, null);
  // nameless expression — nothing to resolve against
  assert.equal(parseKcalExpr("23+23", mem)!.protein, null);
  // unit mismatch: an x-based memory can't price grams
  const perX = buildFoodMemory(rowsOf(["2026-07-21,Eggs 3x,230,19"]));
  assert.equal(parseKcalExpr("Eggs 100g 140ph", perX)!.protein, null);
  // a remembered row without protein stays null
  const noP = buildFoodMemory(rowsOf(["2026-07-21,Pizza 1x,800,"]));
  assert.equal(parseKcalExpr("Pizza 2*180", noP)!.protein, null);
  // exercise memory is never a protein source
  assert.equal(parseKcalExpr("Gym 2*150", mem)!.protein, null);
});

// ---- piece↔gram bridging via the DB's gram weight (SUB-687) ----

test("buildFoodMemory db: gram weight rides x-based entries only", () => {
  const mem = buildFoodMemory([], [
    { name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55, idx: 0 },
    { name: "Chevroux", kcal: 265, per: "100g", protein: 18, g: 300, idx: 1 }, // nonsense, ignored
    { name: "Ayran", kcal: 37, per: "100ml", protein: null, g: null, idx: 2 },
  ]);
  assert.equal(mem.find((m) => m.base === "Eggs")!.gPerUnit, 55);
  assert.equal(mem.find((m) => m.base === "Chevroux")!.gPerUnit, null);
  assert.equal(mem.find((m) => m.base === "Ayran")!.gPerUnit, null);
});

test("fillFor: grams against a piece-based entry convert via the DB weight", () => {
  const mem = buildFoodMemory([], [{ name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55, idx: 0 }]);
  const eggs = mem.find((m) => m.base === "Eggs")!;
  // 110 g = 2 eggs; the name keeps the typed grams, the log row then teaches
  // the per-gram basis
  assert.deepEqual(fillFor(eggs, 110, "g"), { name: "Eggs 110g", kcal: 160, protein: 14 });
  assert.equal(fillFor(eggs, 30, "g")!.kcal, 44); // 80 × 30/55 = 43.6 rounds
  // x keeps working unchanged, and ml bridges through the kitchen 1:1
  assert.deepEqual(fillFor(eggs, 2, "x"), { name: "Eggs 2x", kcal: 160, protein: 14 });
  // no gram weight → the honest null, as before
  const memNoG = buildFoodMemory([], [{ name: "Eggs", kcal: 80, per: "x", protein: 7, g: null, idx: 0 }]);
  assert.equal(fillFor(memNoG[0], 100, "g").kcal, null);
});

test("autoFill + exprProtein resolve through the bridge", () => {
  const mem = buildFoodMemory([], [{ name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55, idx: 0 }]);
  assert.deepEqual(autoFill(mem, "eggs 110g"), { name: "Eggs 110g", kcal: 160, protein: 14 });
  // SUB-634's protein path runs fillFor, so a ph expression prices grams
  // against a piece basis now too
  assert.equal(parseKcalExpr("Eggs 110g 145ph", mem)!.protein, 14);
});

// SUB-691: an expression above the sanity bound is a slipped digit, not a
// meal — null like any other invalid form, so the memory auto-fill gets its say.
test("parseKcalExpr: rejects results above the kcal sanity bound", () => {
  assert.equal(parseKcalExpr("X 999999999*999999999"), null);
  assert.equal(parseKcalExpr("Pizza 100*1000"), null); // 100.000
  // at/under the bound still parses
  assert.equal(parseKcalExpr("Feast 2*10000")!.kcal, KCAL_MAX);
  assert.equal(parseKcalExpr("Feast 19999+0")!.kcal, 19999);
  assert.equal(parseKcalExpr("Feast 20000+1"), null);
  // the per-hundred path shares the bound
  assert.equal(parseKcalExpr("Oil 1000g 900ph")!.kcal, 9000);
  assert.equal(parseKcalExpr("Oil 100000g 900ph"), null);
});

// ---- basis-drift tripwire (SUB-688) ----

test("detectDrift: a contradicting row fires with both bases", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Babybell 6x,330,24"]));
  const d = detectDrift(mem, { food: "Babybell 2x", kcal: 330 })!;
  assert.equal(d.base, "Babybell");
  assert.equal(d.unit, "x");
  assert.equal(d.prevPerKcal, 55);
  assert.equal(d.nextPerKcal, 165);
  assert.equal(d.fromDb, false);
});

test("detectDrift: quiet for the autocomplete path, new foods, exercise", () => {
  const mem = buildFoodMemory(rowsOf(["2026-07-21,Babybell 6x,330,24"]));
  // a row logged from the memory's own fill reproduces the basis
  assert.equal(detectDrift(mem, { food: "Babybell 2x", kcal: 110 }), null);
  // unknown food — nothing to contradict
  assert.equal(detectDrift(mem, { food: "Kebab", kcal: 900 }), null);
  // exercise rows never trip it
  assert.equal(detectDrift(mem, { food: "Babybell 9x", kcal: -500 }), null);
  // small deviation under 25%
  assert.equal(detectDrift(mem, { food: "Babybell 1x", kcal: 65 }), null);
});

test("detectDrift: kind-specific absolute floors keep small-row noise out", () => {
  const mem = buildFoodMemory(
    rowsOf(["2026-07-21,Eggs 1x,80,7", "2026-07-21,Speck 30g,33,6"])
  );
  // x: 31% relative but ±25 kcal/piece clears the ±20 floor → fires
  assert.notEqual(detectDrift(mem, { food: "Eggs 1x", kcal: 105 }), null);
  // g: 82% relative on a 60-kcal row → noise floor, quiet
  assert.equal(detectDrift(mem, { food: "Speck 30g", kcal: 60 }), null);
  // g: same deviation on a 200-kcal row → fires
  const d = detectDrift(mem, { food: "Speck 100g", kcal: 200 })!;
  assert.equal(d.unit, "g");
  assert.equal(Math.round(d.prevPerKcal * 100), 110);
  assert.equal(Math.round(d.nextPerKcal * 100), 200);
});

test("detectDrift: DB-backed bases report fromDb, cross-kind rows stay quiet", () => {
  const mem = buildFoodMemory([], [
    { name: "Eggs", kcal: 80, per: "x", protein: 7, g: null, idx: 0 },
  ]);
  const d = detectDrift(mem, { food: "Eggs 2x", kcal: 400 })!;
  assert.equal(d.fromDb, true);
  // grams against an x-based memory isn't a comparable basis (yet)
  assert.equal(detectDrift(mem, { food: "Eggs 100g", kcal: 500 }), null);
});
