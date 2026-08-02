import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFoodDb, removeFoodDbEntry, upsertFoodDbEntry } from "./fooddb.ts";

function bodyWith(rows: string[], header = "name,kcal,per,protein"): string {
  return ["Food bases.", "", "```csv", header, ...rows, "```", ""].join("\n");
}

test("parseFoodDb: typed rows, sheet order, optional protein", () => {
  const rows = parseFoodDb(bodyWith(["Chevroux,265,100g,18", "Eggs,80,x,"]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "Chevroux", kcal: 265, per: "100g", protein: 18, g: null, idx: 0 });
  assert.equal(rows[1].protein, null);
  assert.equal(rows[1].per, "x");
});

test("parseFoodDb: grams-per-unit column (SUB-687) — canonical and alias headers", () => {
  const rows = parseFoodDb(bodyWith(["Eggs,80,x,7,55"], "name,kcal,per,protein,g"));
  assert.deepEqual(rows[0], { name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55, idx: 0 });
  const alias = parseFoodDb(bodyWith(["Eggs,80,x,7,55"], "name,kcal,per,protein,g_per_unit"));
  assert.equal(alias[0].g, 55);
  // a bad gram cell reads as unknown, never as a row-killer
  const bad = parseFoodDb(bodyWith(["Eggs,80,x,7,abc"], "name,kcal,per,protein,g"));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].g, null);
});

test("upsertFoodDbEntry: grams-per-unit adds and fills the g column (SUB-687)", () => {
  const body = bodyWith(["Chevroux,265,100g,18"]);
  const next = upsertFoodDbEntry(body, { name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55 });
  assert.ok(next.includes("name,kcal,per,protein,g"));
  const rows = parseFoodDb(next);
  assert.equal(rows[1].g, 55);
  assert.equal(rows[0].g, null); // old row untouched
  // re-adding without g clears the bridge — keyed replace writes what it's given
  const cleared = upsertFoodDbEntry(next, { name: "eggs", kcal: 80, per: "x", protein: 7, g: null });
  assert.equal(parseFoodDb(cleared)[1].g, null);
  // a hand-made g_per_unit header is filled, not duplicated
  const aliasBody = bodyWith(["Eggs,80,x,7,"], "name,kcal,per,protein,g_per_unit");
  const aliased = upsertFoodDbEntry(aliasBody, { name: "Eggs", kcal: 80, per: "x", protein: 7, g: 55 });
  assert.ok(!aliased.includes("g_per_unit,g"));
  assert.equal(parseFoodDb(aliased)[0].g, 55);
});

test("parseFoodDb: header order is free, protein column optional", () => {
  const rows = parseFoodDb(bodyWith(["100ml,Ayran,37"], "per,name,kcal"));
  assert.deepEqual(rows, [{ name: "Ayran", kcal: 37, per: "100ml", protein: null, g: null, idx: 0 }]);
});

test("parseFoodDb: 'unit' reads as x, casing is free", () => {
  const rows = parseFoodDb(bodyWith(["Eggs,80,Unit,", "Quark,60,100G,"]));
  assert.equal(rows[0].per, "x");
  assert.equal(rows[1].per, "100g");
});

test("parseFoodDb: malformed rows are skipped, idx tracks csv position", () => {
  const rows = parseFoodDb(
    bodyWith([",100,100g,", "Mystery,abc,100g,", "Weird,100,handful,", "Skyr,60,100g,11"])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Skyr");
  assert.equal(rows[0].idx, 3); // csv data-row index, skipped rows still count
});

test("parseFoodDb: strict kcal parse — 1e3/Infinity stay text (SUB-221)", () => {
  const rows = parseFoodDb(bodyWith(["A,1e3,100g,", "B,Infinity,x,", "C,650,x,"]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "C");
});

test("parseFoodDb: no fence, no rows", () => {
  assert.deepEqual(parseFoodDb("Just prose."), []);
});

test("upsertFoodDbEntry: appends inside the fence, preserves prose", () => {
  const body = bodyWith(["Chevroux,265,100g,18"]);
  const next = upsertFoodDbEntry(body, { name: "Skyr", kcal: 60, per: "100g", protein: 11, g: null });
  assert.ok(next.startsWith("Food bases."));
  assert.ok(next.includes("Chevroux,265,100g,18"));
  assert.ok(next.includes("Skyr,60,100g,11"));
  assert.equal(parseFoodDb(next).length, 2);
});

test("upsertFoodDbEntry: same-name row is replaced in place, case-insensitive", () => {
  const body = bodyWith(["Chevroux,265,100g,18", "Eggs,80,x,7"]);
  const next = upsertFoodDbEntry(body, { name: "chevroux", kcal: 250, per: "100g", protein: 17, g: null });
  const rows = parseFoodDb(next);
  assert.equal(rows.length, 2); // no dupe
  assert.equal(rows[0].name, "chevroux"); // position + new casing kept
  assert.equal(rows[0].kcal, 250);
  assert.equal(rows[1].name, "Eggs");
});

test("upsertFoodDbEntry: creates fence + header on a bare note", () => {
  const next = upsertFoodDbEntry("Fresh DB.", { name: "Eggs", kcal: 80, per: "x", protein: 7, g: null });
  assert.ok(next.includes("```csv\nname,kcal,per,protein\nEggs,80,x,7\n```"));
  assert.equal(parseFoodDb(next).length, 1);
});

test("upsertFoodDbEntry: maps cells into a reordered header, adds missing protein column", () => {
  const body = bodyWith(["100g,Chevroux,265"], "per,name,kcal");
  const next = upsertFoodDbEntry(body, { name: "Skyr", kcal: 60, per: "100g", protein: 11, g: null });
  assert.ok(next.includes("per,name,kcal,protein"));
  const rows = parseFoodDb(next);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, "Skyr");
  assert.equal(rows[1].protein, 11);
  assert.equal(rows[0].protein, null); // old row untouched
});

test("upsertFoodDbEntry: commas in names round-trip quoted", () => {
  const next = upsertFoodDbEntry("x", { name: "Quark, vanilla", kcal: 90, per: "100g", protein: null, g: null });
  const rows = parseFoodDb(next);
  assert.equal(rows[0].name, "Quark, vanilla");
});

test("removeFoodDbEntry: removes by data index; stale index is a no-op", () => {
  const body = bodyWith(["A,100,100g,", "B,200,x,"]);
  const next = removeFoodDbEntry(body, 0);
  const rows = parseFoodDb(next);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "B");
  assert.equal(removeFoodDbEntry(body, 5), body);
  assert.equal(removeFoodDbEntry(body, -1), body);
});
