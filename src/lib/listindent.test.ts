import { test } from "node:test";
import assert from "node:assert/strict";
import { listLinePrefix } from "./listindent.ts";

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
  // tabs render to positional stops the measurement can't model — left alone
  assert.equal(listLinePrefix("\t- child"), null);
  assert.equal(listLinePrefix("  \t- child"), null);
  assert.equal(listLinePrefix("-\titem"), null);
  // thematic breaks satisfy the marker grammar but are rules
  assert.equal(listLinePrefix("- - -"), null);
  assert.equal(listLinePrefix("* * *"), null);
  assert.equal(listLinePrefix("---"), null);
});
