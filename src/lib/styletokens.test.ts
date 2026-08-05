import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCENT_NAMES, CHART_SIZES, parseAccent, parseChartSize } from "./styletokens.ts";
import { optionColorVar } from "./dbicons.ts";

test("every accent name resolves to an option color", () => {
  assert.equal(ACCENT_NAMES.length, 10);
  for (const name of ACCENT_NAMES) {
    assert.equal(parseAccent(name), name);
    assert.equal(optionColorVar(name), `var(--opt-${name})`);
  }
});

test("accents are case- and space-insensitive", () => {
  assert.equal(parseAccent("Teal"), "teal");
  assert.equal(parseAccent("  VIOLET  "), "violet");
});

test("anything off the roster is absent, never an error", () => {
  for (const raw of [
    "#14b8a6",
    "rgb(0 0 0)",
    "2px",
    "tealish",
    "",
    "   ",
    // the injection shape the roster gate exists to refuse: no fragment of
    // this may ever reach CSS as an interpolated var() name
    "red; content: 'x'",
    undefined,
    null,
    7,
    true,
    ["teal"],
    { accent: "teal" },
  ]) {
    assert.equal(parseAccent(raw), undefined, `parseAccent(${JSON.stringify(raw)})`);
  }
});

test("chart size takes tall and nothing else", () => {
  assert.deepEqual([...CHART_SIZES], ["tall"]);
  assert.equal(parseChartSize("tall"), "tall");
  assert.equal(parseChartSize(" TALL "), "tall");
  for (const raw of ["400px", "big", "short", "", undefined, null, 400]) {
    assert.equal(parseChartSize(raw), undefined, `parseChartSize(${JSON.stringify(raw)})`);
  }
});
