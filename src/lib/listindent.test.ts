import { test } from "node:test";
import assert from "node:assert/strict";
import { listLinePrefix, walkSpan, type TabPin } from "./listindent.ts";

test("listLinePrefix: every plain marker shape, indent kept", () => {
  assert.deepEqual(listLinePrefix("- item"), { text: "- ", indent: "", task: false });
  assert.deepEqual(listLinePrefix("* item"), { text: "* ", indent: "", task: false });
  assert.deepEqual(listLinePrefix("+ item"), { text: "+ ", indent: "", task: false });
  assert.deepEqual(listLinePrefix("1. item"), { text: "1. ", indent: "", task: false });
  assert.deepEqual(listLinePrefix("12) item"), { text: "12) ", indent: "", task: false });
  // nesting: the leading whitespace is part of the hang
  assert.deepEqual(listLinePrefix("  - child"), { text: "  - ", indent: "  ", task: false });
});

test("listLinePrefix: a task's checkbox joins the prefix and is flagged", () => {
  assert.deepEqual(listLinePrefix("- [ ] open"), { text: "- [ ] ", indent: "", task: true });
  assert.deepEqual(listLinePrefix("- [x] done"), { text: "- [x] ", indent: "", task: true });
  assert.deepEqual(listLinePrefix("  3. [X] done"), {
    text: "  3. [X] ",
    indent: "  ",
    task: true,
  });
  // a bracket that is not a checkbox is content
  assert.deepEqual(listLinePrefix("- [link](url)"), { text: "- ", indent: "", task: false });
});

test("listLinePrefix: what is not a hangable list line", () => {
  assert.equal(listLinePrefix("prose"), null);
  assert.equal(listLinePrefix("-no space"), null);
  assert.equal(listLinePrefix("-"), null);
  // quoted lists are the callout machinery's ground — left alone
  assert.equal(listLinePrefix("> - quoted"), null);
  // thematic breaks satisfy the marker grammar but are rules
  assert.equal(listLinePrefix("- - -"), null);
  assert.equal(listLinePrefix("* * *"), null);
  assert.equal(listLinePrefix("---"), null);
});

test("listLinePrefix: tab-bearing indents and marker gaps are prefixes too", () => {
  assert.deepEqual(listLinePrefix("\t- child"), { text: "\t- ", indent: "\t", task: false });
  assert.deepEqual(listLinePrefix("\t\t* deep"), { text: "\t\t* ", indent: "\t\t", task: false });
  // mixed space+tab, in both orders
  assert.deepEqual(listLinePrefix("  \t- child"), { text: "  \t- ", indent: "  \t", task: false });
  assert.deepEqual(listLinePrefix("\t  1. child"), { text: "\t  1. ", indent: "\t  ", task: false });
  // a tab in the marker gap
  assert.deepEqual(listLinePrefix("-\titem"), { text: "-\t", indent: "", task: false });
  assert.deepEqual(listLinePrefix("\t2)\titem"), { text: "\t2)\t", indent: "\t", task: false });
});

test("listLinePrefix: tabs around a task checkbox", () => {
  assert.deepEqual(listLinePrefix("\t- [ ] open"), { text: "\t- [ ] ", indent: "\t", task: true });
  assert.deepEqual(listLinePrefix("- [x]\tdone"), { text: "- [x]\t", indent: "", task: true });
  assert.deepEqual(listLinePrefix("  \t- [X]\t done"), {
    text: "  \t- [X]\t ",
    indent: "  \t",
    task: true,
  });
});

/* A stand-in for the content font: every character is 10px wide, so an
   expected advance reads as "characters, times ten". */
const mono = (run: string) => run.length * 10;
const STOP = 40; // tab-size 4 in that font

function walk(span: string, from = 0, at = 0) {
  const pins: TabPin[] = [];
  const width = walkSpan(span, at, from, STOP, mono, pins);
  return { width, pins };
}

test("walkSpan: a tab snaps to the next stop, never to nothing", () => {
  assert.deepEqual(walk("\t"), { width: 40, pins: [{ at: 0, width: 40 }] });
  assert.deepEqual(walk("\t- "), { width: 60, pins: [{ at: 0, width: 40 }] });
  // already sitting on a stop: a whole stop, not a zero-width tab
  assert.deepEqual(walk("\t\t"), {
    width: 80,
    pins: [
      { at: 0, width: 40 },
      { at: 1, width: 40 },
    ],
  });
  assert.deepEqual(walk("abcd\tx"), { width: 90, pins: [{ at: 4, width: 40 }] });
});

test("walkSpan: mixed space+tab is where a fixed per-tab advance would be wrong", () => {
  // two spaces (20px) then a tab: the tab is worth 20px here, not a full stop
  assert.deepEqual(walk("  \t- "), { width: 60, pins: [{ at: 2, width: 20 }] });
  // five characters overshoot the first stop, so the tab reaches the second
  assert.deepEqual(walk("     \t"), { width: 80, pins: [{ at: 5, width: 30 }] });
});

test("listLinePrefix: tab-indented thematic breaks are rules, not lists", () => {
  assert.equal(listLinePrefix("\t- - -"), null);
  assert.equal(listLinePrefix("  \t* * *"), null);
  assert.equal(listLinePrefix(" \t_ _ _"), null);
});

test("walkSpan: a run a hair short of a stop still buys the tab a whole stop", () => {
  // run widths and the stop round to 0.01px independently: four 7.8051px
  // spaces measure 31.22 while the stop reads 31.24 — on the stop in the
  // browser, two hundredths short on paper. The tab must advance a whole
  // stop, not the sliver.
  const pins: TabPin[] = [];
  const width = walkSpan("\t", 4, 31.22, 31.24, () => 0, pins);
  assert.deepEqual(pins, [{ at: 4, width: 31.26 }]);
  assert.equal(Math.round(width * 100) / 100, 62.48);
});

test("walkSpan: tab-free spans measure as plain text, with no pins", () => {
  assert.deepEqual(walk("  - "), { width: 40, pins: [] });
  assert.deepEqual(walk(""), { width: 0, pins: [] });
});

test("walkSpan: a resting task's tail resumes from the widget's advance", () => {
  // indent walked from 0, then the checkbox widget, then the tail: offsets
  // stay line-relative so the caller can pin them where they actually sit
  const pins: TabPin[] = [];
  let width = walkSpan("\t", 0, 0, STOP, mono, pins);
  width += 21; // the toggle's advance
  width = walkSpan("\t", 7, width, STOP, mono, pins);
  assert.equal(width, 80);
  assert.deepEqual(pins, [
    { at: 0, width: 40 },
    { at: 7, width: 19 },
  ]);
});

test("walkSpan: a zero stop leaves tabs flat rather than dividing by it", () => {
  const pins: TabPin[] = [];
  assert.equal(walkSpan("\t- ", 0, 0, 0, mono, pins), 20);
  assert.deepEqual(pins, [{ at: 0, width: 0 }]);
});
