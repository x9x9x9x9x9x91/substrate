import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFoodEntry,
  bandState,
  dayLabel,
  foodData,
  KCAL_MAX,
  kcalInRange,
  parseFoodRows,
  removeFoodEntry,
} from "./food.ts";

const FLOOR = 1900;
const CEIL = 2300;

function bodyWith(rows: string[], header = "date,food,kcal,protein_g"): string {
  return ["Log intro.", "", "```csv", header, ...rows, "```", ""].join("\n");
}

test("parseFoodRows: typed rows, log order, optional protein", () => {
  const rows = parseFoodRows(
    bodyWith(["2026-07-21,Chicken bowl,650,45", "2026-07-21,Skyr,180,"])
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: "2026-07-21", food: "Chicken bowl", kcal: 650, protein: 45, idx: 0 });
  assert.equal(rows[1].protein, null);
});

test("parseFoodRows: header order is free, protein_g column optional", () => {
  const rows = parseFoodRows(bodyWith(["Toast,2026-07-21,300"], "food,date,kcal"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].food, "Toast");
  assert.equal(rows[0].kcal, 300);
  assert.equal(rows[0].protein, null);
});

test("parseFoodRows: malformed date or kcal rows are skipped, idx tracks csv position", () => {
  const rows = parseFoodRows(
    bodyWith(["yesterday,Bad,500,", "2026-07-21,,abc,", "2026-07-21,Good,400,"])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].food, "Good");
  assert.equal(rows[0].idx, 2); // csv data-row index, skipped rows still count
});

test("bandState: floor and ceiling are inclusive-in", () => {
  assert.equal(bandState(1899, FLOOR, CEIL), "under");
  assert.equal(bandState(1900, FLOOR, CEIL), "in");
  assert.equal(bandState(2300, FLOOR, CEIL), "in");
  assert.equal(bandState(2301, FLOOR, CEIL), "over");
});

test("foodData: today totals, protein, headroom, state", () => {
  const d = foodData(
    bodyWith(["2026-07-21,Chicken bowl,650,45", "2026-07-21,Gym,-300,", "2026-07-21,Skyr,180,12"]),
    "2026-07-21",
    FLOOR,
    CEIL
  );
  assert.equal(d.todayKcal, 530); // net: exercise row subtracts
  assert.equal(d.todayProtein, 57);
  assert.equal(d.headroom, CEIL - 530);
  assert.equal(d.todayState, "under");
  assert.equal(d.today.length, 3);
});

test("foodData: toGoal and todayBurn (SUB-374)", () => {
  const d = foodData(
    bodyWith(["2026-07-21,Chicken bowl,650,45", "2026-07-21,Gym,-300,", "2026-07-21,Run,-150,"]),
    "2026-07-21",
    FLOOR,
    CEIL
  );
  assert.equal(d.todayKcal, 200);
  assert.equal(d.toGoal, FLOOR - 200); // distance to the goal floor
  assert.equal(d.todayBurn, 450); // exercise rows summed as positive burn
});

test("foodData: toGoal goes negative past the floor, burn 0 without exercise", () => {
  const d = foodData(bodyWith(["2026-07-21,Feast,2000,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.toGoal, -100);
  assert.equal(d.todayBurn, 0);
});

test("foodData: weekDelta is Σnet − loggedDays×floor, logged days only (SUB-374)", () => {
  const d = foodData(
    bodyWith(["2026-07-21,A,2000,", "2026-07-19,B,2100,", "2026-07-10,Old,9999,"]),
    "2026-07-21",
    FLOOR,
    CEIL
  );
  // 2 logged days in the window: (2000 + 2100) − 2×1900 = +300
  assert.equal(d.weekDelta, 300);
});

test("foodData: weekDelta null with nothing logged in the window", () => {
  const d = foodData(bodyWith(["2026-07-01,Old,1000,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.weekDelta, null);
});

test("foodData: empty day is 'empty', not 'under'", () => {
  const d = foodData(bodyWith(["2026-07-20,Toast,300,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.todayState, "empty");
  assert.equal(d.todayKcal, 0);
});

test("foodData: avg7 covers logged days only", () => {
  const d = foodData(
    bodyWith(["2026-07-21,A,2000,", "2026-07-19,B,2100,", "2026-07-10,Old,9999,"]),
    "2026-07-21",
    FLOOR,
    CEIL
  );
  assert.equal(d.daysLogged7, 2); // 07-20 unlogged, 07-10 outside the window
  assert.equal(d.avg7, 2050);
  assert.equal(d.avg7State, "in");
});

test("foodData: avg7 null with nothing in the window", () => {
  const d = foodData(bodyWith(["2026-07-01,Old,1000,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.avg7, null);
  assert.equal(d.avg7State, "empty");
});

test("foodData: 14-day strip, ascending, empty days present with n=0", () => {
  const d = foodData(bodyWith(["2026-07-21,A,2400,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.days.length, 14);
  assert.equal(d.days[0].day, "2026-07-08");
  assert.equal(d.days[13].day, "2026-07-21");
  assert.equal(d.days[13].state, "over");
  assert.equal(d.days[12].state, "empty");
});

test("appendFoodEntry: appends inside the fence, preserves prose", () => {
  const body = bodyWith(["2026-07-20,Toast,300,"]);
  const next = appendFoodEntry(body, { date: "2026-07-21", food: "Chicken bowl", kcal: 650, protein: 45 });
  assert.ok(next.startsWith("Log intro."));
  assert.ok(next.includes("2026-07-20,Toast,300,"));
  assert.ok(next.includes("2026-07-21,Chicken bowl,650,45"));
  assert.equal(parseFoodRows(next).length, 2);
});

test("appendFoodEntry: creates fence + header on a bare note", () => {
  const next = appendFoodEntry("Fresh log.", { date: "2026-07-21", food: "Toast", kcal: 300, protein: null });
  assert.ok(next.includes("```csv\ndate,food,kcal,protein_g\n2026-07-21,Toast,300,\n```"));
  assert.equal(parseFoodRows(next).length, 1);
});

test("appendFoodEntry: maps cells into a reordered header", () => {
  const body = bodyWith(["Toast,2026-07-20,300"], "food,date,kcal");
  const next = appendFoodEntry(body, { date: "2026-07-21", food: "Chicken bowl", kcal: 650, protein: null });
  assert.ok(next.includes("Chicken bowl,2026-07-21,650"));
  const rows = parseFoodRows(next);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].food, "Chicken bowl");
  assert.equal(rows[1].kcal, 650);
});

test("appendFoodEntry: adds a missing protein_g column instead of dropping the value", () => {
  const body = bodyWith(["2026-07-20,Toast,300"], "date,food,kcal");
  const next = appendFoodEntry(body, { date: "2026-07-21", food: "Skyr", kcal: 180, protein: 30 });
  assert.ok(next.includes("date,food,kcal,protein_g"));
  const rows = parseFoodRows(next);
  assert.equal(rows[1].protein, 30);
  assert.equal(rows[0].protein, null); // old row unchanged, short cells fine
});

test("appendFoodEntry: whitespace-only fence gets the header recreated", () => {
  const body = "Log.\n\n```csv\n\n```\n";
  const next = appendFoodEntry(body, { date: "2026-07-21", food: "Toast", kcal: 300, protein: null });
  const rows = parseFoodRows(next);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kcal, 300);
});

test("parseFoodRows: strict kcal parse — 1e3/0x10/Infinity stay text (SUB-221)", () => {
  const rows = parseFoodRows(
    bodyWith(["2026-07-21,A,1e3,", "2026-07-21,B,0x10,", "2026-07-21,C,Infinity,", "2026-07-21,D,650,"])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].food, "D");
});

test("appendFoodEntry: commas in food names round-trip quoted", () => {
  const next = appendFoodEntry("x", { date: "2026-07-21", food: "Pasta, alla vodka", kcal: 815, protein: 24 });
  const rows = parseFoodRows(next);
  assert.equal(rows[0].food, "Pasta, alla vodka");
});

test("removeFoodEntry: removes by data index; stale index is a no-op", () => {
  const body = bodyWith(["2026-07-21,A,100,", "2026-07-21,B,200,"]);
  const next = removeFoodEntry(body, 0);
  const rows = parseFoodRows(next);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].food, "B");
  assert.equal(removeFoodEntry(body, 5), body);
  assert.equal(removeFoodEntry(body, -1), body);
});

test("dayLabel: local weekday + day of month", () => {
  assert.equal(dayLabel("2026-07-21"), "Tue 21");
  assert.equal(dayLabel("2026-07-20"), "Mon 20");
});

test("foodData: focus day drives the hero fields, trends stay today-anchored (SUB-408)", () => {
  const body = bodyWith([
    "2026-07-21,Today meal,500,20",
    "2026-07-20,Past feast,2300,80",
    "2026-07-20,Gym,-300,",
  ]);
  const d = foodData(body, "2026-07-21", FLOOR, CEIL, "2026-07-20");
  assert.equal(d.focusDay, "2026-07-20");
  assert.equal(d.todayKcal, 2000); // the focus day's net, not today's 500
  assert.equal(d.todayProtein, 80);
  assert.equal(d.todayBurn, 300);
  assert.equal(d.todayState, "in");
  assert.equal(d.today.length, 2);
  assert.equal(d.headroom, CEIL - 2000);
  assert.equal(d.toGoal, FLOOR - 2000);
  // avg7/weekDelta/strip stay anchored to the real today
  assert.equal(d.days[13].day, "2026-07-21");
  assert.equal(d.daysLogged7, 2);
  assert.equal(d.avg7, 1250); // (500 + 2000) / 2 logged days
  assert.equal(d.weekDelta, 500 + 2000 - 2 * FLOOR);
});

test("foodData: omitted focus is today (day-navigation default)", () => {
  const d = foodData(bodyWith(["2026-07-21,A,500,"]), "2026-07-21", FLOOR, CEIL);
  assert.equal(d.focusDay, "2026-07-21");
  assert.equal(d.todayKcal, 500);
});

// SUB-691: one absurd row pins the strip's scale and poisons two weeks of
// metrics, so implausible kcal is rejected at entry in every path.
test("kcalInRange: sanity bound, magnitude-based so exercise burn shares it", () => {
  assert.equal(KCAL_MAX, 20000);
  assert.equal(kcalInRange(650), true);
  assert.equal(kcalInRange(0), true);
  assert.equal(kcalInRange(KCAL_MAX), true); // at the bound is still in
  assert.equal(kcalInRange(KCAL_MAX + 1), false);
  assert.equal(kcalInRange(999999999), false);
  // exercise burn is typed positive and stored negative — judged by magnitude
  assert.equal(kcalInRange(-300), true);
  assert.equal(kcalInRange(-(KCAL_MAX + 1)), false);
  // non-finite stays out, as before
  assert.equal(kcalInRange(NaN), false);
  assert.equal(kcalInRange(Infinity), false);
});
