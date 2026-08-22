import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCENT_NAMES,
  CARD_SPANS,
  CHART_SIZES,
  parseAccent,
  parseCalloutStyle,
  parseCardSpan,
  parseChartSize,
} from "./styletokens.ts";
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

test("card span takes one and two and nothing else", () => {
  assert.deepEqual([...CARD_SPANS], [1, 2]);
  assert.equal(parseCardSpan("1"), 1);
  assert.equal(parseCardSpan(" 2 "), 2);
  for (const raw of ["3", "0", "-1", "2.0", "50%", "two", "", undefined, null, 2]) {
    assert.equal(parseCardSpan(raw), undefined, `parseCardSpan(${JSON.stringify(raw)})`);
  }
});

test("a callout tail reads its tokens independently, dropping only what it can't honour", () => {
  assert.deepEqual(parseCalloutStyle("teal"), { accent: "teal" });
  assert.deepEqual(parseCalloutStyle("span:2"), { span: 2 });
  assert.deepEqual(parseCalloutStyle("teal|span:2"), { accent: "teal", span: 2 });
  // order is not a contract — the tokens are named, so either way round reads
  assert.deepEqual(parseCalloutStyle("span:2|teal"), { accent: "teal", span: 2 });
  assert.deepEqual(parseCalloutStyle(" TEAL | span : 2 "), { accent: "teal", span: 2 });
  // an unreadable token costs only itself
  assert.deepEqual(parseCalloutStyle("teal|span:7"), { accent: "teal" });
  assert.deepEqual(parseCalloutStyle("chartreuse|span:2"), { span: 2 });
  for (const tail of [undefined, "", "   ", "|", "wat", "#14b8a6", "size:tall"]) {
    assert.deepEqual(parseCalloutStyle(tail), {}, `parseCalloutStyle(${JSON.stringify(tail)})`);
  }
});
