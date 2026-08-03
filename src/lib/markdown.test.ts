import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownLinkLabel, TASK_PREFIX_RE, TASK_RE } from "./markdown.ts";

test("TASK_PREFIX_RE matches plain and indented list prefixes", () => {
  assert.deepEqual(TASK_PREFIX_RE.exec("- ")?.slice(1), ["", "- "]);
  assert.deepEqual(TASK_PREFIX_RE.exec("  1. ")?.slice(1), ["  ", "1. "]);
  assert.equal(TASK_PREFIX_RE.exec("no list"), null);
});

test("TASK_PREFIX_RE captures blockquote markers with the indent (SUB-104)", () => {
  const m = TASK_PREFIX_RE.exec("> - ");
  assert.deepEqual(m?.slice(1), ["> ", "- "]);
  const nested = TASK_PREFIX_RE.exec("\t> > 2) ");
  assert.deepEqual(nested?.slice(1), ["\t> > ", "2) "]);
});

test("TASK_RE toggles tasks inside blockquotes (SUB-104)", () => {
  const m = TASK_RE.exec("> - [ ] quoted task");
  assert.equal(m?.[1], "> - [");
  assert.equal(m?.[2], " ");
  const done = TASK_RE.exec("> > 1. [x] nested");
  assert.equal(done?.[1], "> > 1. [");
  assert.equal(done?.[2], "x");
  assert.equal(TASK_RE.exec("- [ ] plain")?.[2], " ");
  assert.equal(TASK_RE.exec("not a task"), null);
});

test("markdownLinkLabel unwraps complete links with parenthesized destinations (SUB-929)", () => {
  assert.equal(markdownLinkLabel("[label](https://example.test)"), "label");
  assert.equal(
    markdownLinkLabel("[wiki](https://en.wikipedia.org/wiki/Granular_(synthesis))"),
    "wiki"
  );
  assert.equal(markdownLinkLabel("prefix [label](https://example.test)"), null);
  assert.equal(markdownLinkLabel("[broken](https://example.test_(nested_(twice)))"), null);
});
