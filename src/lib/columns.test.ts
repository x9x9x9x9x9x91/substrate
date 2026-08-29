/** The column markup's parse rules (`columns.ts`). What is pinned here is
    mostly what is NOT a region: the markers are comments, so a malformed one
    costs an author nothing worse than three visible lines, and no shape of
    stray marker may swallow the rest of a page. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  COLUMNS_CLOSE,
  COLUMNS_DIVIDER,
  COLUMNS_OPEN,
  isColumnsMarker,
  parseColumnRegions,
} from "./columns.ts";

const TWO = `Intro line.

${COLUMNS_OPEN}
## Left
Left body.
${COLUMNS_DIVIDER}
## Right
Right body.
${COLUMNS_CLOSE}

Outro line.`;

test("a two-column region reports its markers and each column's text", () => {
  const [region, ...rest] = parseColumnRegions(TWO);
  assert.equal(rest.length, 0, "one region");
  assert.equal(region.startLine, 2, "the opener's line");
  assert.equal(region.endLine, 8, "the closer's line");
  assert.equal(region.columns.length, 2);
  assert.equal(region.columns[0].text, "## Left\nLeft body.");
  assert.equal(region.columns[1].text, "## Right\nRight body.");
  // the line spans exclude the markers, so a caller can slice the body back
  // out of the document without re-reading them
  assert.deepEqual(
    [region.columns[0].startLine, region.columns[0].endLine],
    [3, 5]
  );
});

test("three columns, and a region with no divider is one column", () => {
  const three = `${COLUMNS_OPEN}\na\n${COLUMNS_DIVIDER}\nb\n${COLUMNS_DIVIDER}\nc\n${COLUMNS_CLOSE}`;
  assert.deepEqual(
    parseColumnRegions(three)[0].columns.map((c) => c.text),
    ["a", "b", "c"]
  );
  const one = `${COLUMNS_OPEN}\njust me\n${COLUMNS_CLOSE}`;
  assert.deepEqual(
    parseColumnRegions(one)[0].columns.map((c) => c.text),
    ["just me"],
    "a column count of one is a legal thing to write, not an error"
  );
});

test("an empty segment is an empty column, not a dropped one", () => {
  const gapped = `${COLUMNS_OPEN}\n${COLUMNS_DIVIDER}\nright\n${COLUMNS_CLOSE}`;
  assert.deepEqual(
    parseColumnRegions(gapped)[0].columns.map((c) => c.text),
    ["", "right"]
  );
});

test("markers tolerate spacing and case but must own their line", () => {
  const loose = `<!--columns-->\na\n<!--   COL   -->\nb\n<!-- /Columns -->`;
  assert.equal(parseColumnRegions(loose).length, 1, "spacing and case are the author's");

  const inProse = `Write <!-- col --> to split a column.\n\n${COLUMNS_OPEN}\na\n${COLUMNS_DIVIDER}\nb\n${COLUMNS_CLOSE}`;
  const [region] = parseColumnRegions(inProse);
  assert.equal(region.startLine, 2, "the sentence about the marker is a sentence");
  assert.equal(region.columns.length, 2);
});

test("an unclosed opener is three visible lines, never a region", () => {
  assert.deepEqual(parseColumnRegions(`${COLUMNS_OPEN}\na\n${COLUMNS_DIVIDER}\nb`), []);
  assert.deepEqual(parseColumnRegions(`${COLUMNS_DIVIDER}\nstray divider`), []);
  assert.deepEqual(parseColumnRegions(`${COLUMNS_CLOSE}\nstray closer`), []);
});

test("a stray opener above a real region costs only itself", () => {
  const body = `${COLUMNS_OPEN}\nno close here\n\n${COLUMNS_OPEN}\na\n${COLUMNS_DIVIDER}\nb\n${COLUMNS_CLOSE}`;
  const regions = parseColumnRegions(body);
  assert.equal(regions.length, 1, "the second opener still gets to be a region");
  assert.equal(regions[0].startLine, 3);
  assert.deepEqual(
    regions[0].columns.map((c) => c.text),
    ["a", "b"]
  );
});

test("columns do not nest", () => {
  const nested = `${COLUMNS_OPEN}\na\n${COLUMNS_OPEN}\nb\n${COLUMNS_DIVIDER}\nc\n${COLUMNS_CLOSE}`;
  const regions = parseColumnRegions(nested);
  assert.equal(regions.length, 1, "the inner one is the region");
  assert.equal(regions[0].startLine, 2);
});

test("a marker inside a code fence is code being shown, not layout", () => {
  const shown = [
    "```markdown",
    COLUMNS_OPEN,
    "a",
    COLUMNS_DIVIDER,
    "b",
    COLUMNS_CLOSE,
    "```",
  ].join("\n");
  assert.deepEqual(parseColumnRegions(shown), [], "the whole example is inert");

  // and a fence INSIDE a region hides markers the same way
  const fenced = [
    COLUMNS_OPEN,
    "```rust ignore",
    COLUMNS_DIVIDER,
    "```",
    COLUMNS_DIVIDER,
    "right",
    COLUMNS_CLOSE,
  ].join("\n");
  const [region] = parseColumnRegions(fenced);
  assert.equal(region.columns.length, 2, "only the divider outside the fence cut");
  assert.match(region.columns[0].text, /^```rust ignore\n/);
});

test("every spelling of a code fence hides the markers inside it", () => {
  // a tilde fence — what an author reaches for the moment the sample they are
  // showing contains backticks of its own
  const tilde = ["~~~markdown", COLUMNS_OPEN, "a", COLUMNS_DIVIDER, "b", COLUMNS_CLOSE, "~~~"].join(
    "\n"
  );
  assert.deepEqual(parseColumnRegions(tilde), [], "a tilde fence is a fence");

  // indented under a list item: still a fence, up to three spaces
  const indented = [
    "- how to write one:",
    "   ```markdown",
    "   " + COLUMNS_OPEN,
    "   a",
    "   " + COLUMNS_DIVIDER,
    "   b",
    "   " + COLUMNS_CLOSE,
    "   ```",
  ].join("\n");
  assert.deepEqual(parseColumnRegions(indented), [], "an indented fence is a fence");

  // a longer run, which is how someone fences a sample that itself contains a
  // three-backtick fence. The three-backtick line inside must NOT close it.
  const four = [
    "````markdown",
    "```",
    COLUMNS_OPEN,
    "a",
    COLUMNS_CLOSE,
    "```",
    "````",
    "",
    COLUMNS_OPEN,
    "real",
    COLUMNS_DIVIDER,
    "region",
    COLUMNS_CLOSE,
  ].join("\n");
  const after = parseColumnRegions(four);
  assert.equal(after.length, 1, "the four-backtick fence closed, so columns still work below it");
  assert.deepEqual(
    after[0].columns.map((c) => c.text),
    ["real", "region"]
  );
});

test("a fence variant INSIDE a region hides dividers the same way", () => {
  const body = [
    COLUMNS_OPEN,
    "~~~text",
    COLUMNS_DIVIDER,
    "~~~",
    COLUMNS_DIVIDER,
    "right",
    COLUMNS_CLOSE,
  ].join("\n");
  const [region] = parseColumnRegions(body);
  assert.equal(region.columns.length, 2, "only the divider outside the tilde fence cut");
});

test("an inline backtick run is prose, not an opener", () => {
  // ```` ```a``` ```` in a sentence is inline code: a backtick opener's info
  // string may not contain a backtick, so this must not swallow the region
  const body = ["Type ```a``` for code.", COLUMNS_OPEN, "a", COLUMNS_DIVIDER, "b", COLUMNS_CLOSE].join(
    "\n"
  );
  assert.equal(parseColumnRegions(body).length, 1, "the sentence stayed a sentence");
});

test("two regions in one body are both found", () => {
  const body = `${COLUMNS_OPEN}\na\n${COLUMNS_DIVIDER}\nb\n${COLUMNS_CLOSE}\n\nmiddle\n\n${COLUMNS_OPEN}\nc\n${COLUMNS_DIVIDER}\nd\n${COLUMNS_CLOSE}`;
  const regions = parseColumnRegions(body);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions.map((r) => r.startLine), [0, 8]);
});

test("CRLF bodies parse the same as LF ones", () => {
  assert.deepEqual(parseColumnRegions(TWO.replace(/\n/g, "\r\n")), parseColumnRegions(TWO));
});

test("isColumnsMarker names all three and nothing else", () => {
  for (const m of [COLUMNS_OPEN, COLUMNS_DIVIDER, COLUMNS_CLOSE]) {
    assert.ok(isColumnsMarker(m), m);
  }
  assert.ok(!isColumnsMarker("<!-- columns wide -->"), "no token vocabulary exists yet");
  assert.ok(!isColumnsMarker("text"), "prose");
});

/* ── the spec and the parser say the same three strings ────────────────── */

test("docs/vault-format.md documents the markers this module implements", () => {
  const spec = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "vault-format.md"),
    "utf8"
  );
  const section = spec.slice(spec.indexOf("### Columns"));
  assert.ok(section.length > 0, "the spec has a Columns section");
  for (const marker of [COLUMNS_OPEN, COLUMNS_DIVIDER, COLUMNS_CLOSE]) {
    assert.ok(
      section.includes(marker),
      `the spec spells ${marker} exactly as the parser reads it`
    );
  }
});
