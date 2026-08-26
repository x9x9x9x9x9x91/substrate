import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { styleSheetNames } from "./styles-source.ts";

/* The entry stylesheet is an import list over the themed sheets in
   src/styles/, and that list IS the cascade. Three things can quietly break
   it and nothing else in the tree would notice: a rule written straight into
   the entry sheet (which the CSS parser then refuses to import past — an
   @import may not follow a rule, so every sheet below it would silently stop
   shipping), a sheet added on disk but never imported, and a strip fence
   split across two sheets by a move, which aborts the mirror build. */

const ENTRY = "src/styles.css";
const DIR = "src/styles";

const entry = readFileSync(ENTRY, "utf8");
const imports = styleSheetNames();

test("the entry stylesheet is an import list and nothing else", () => {
  // strip the comments and the imports; a rule left over is the bug
  const rest = entry
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import "\.\/styles\/[a-z]+\.css";/g, "")
    .trim();
  assert.equal(rest, "", `${ENTRY} carries rules of its own — they belong in a themed sheet`);
});

test("every themed sheet is imported exactly once, tokens first", () => {
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".css")).sort();
  assert.deepEqual([...imports].sort(), onDisk, "sheets on disk and sheets imported have drifted");
  assert.equal(imports.length, new Set(imports).size, "a sheet is imported twice");
  assert.equal(imports[0], "tokens.css", "tokens lead the cascade — everything after them reads them");
});

test("no strip fence is split across two sheets", () => {
  // assembled, not written out: a literal marker here would fence this test
  const START = ["share-mirror", "strip-start"].join(":");
  const END = ["share-mirror", "strip-end"].join(":");
  for (const sheet of imports) {
    const text = readFileSync(`${DIR}/${sheet}`, "utf8");
    let depth = 0;
    for (const line of text.split("\n")) {
      if (line.includes(START)) depth++;
      else if (line.includes(END)) depth--;
      assert.ok(depth === 0 || depth === 1, `${sheet}: nested or stray strip fence`);
    }
    assert.equal(depth, 0, `${sheet}: a fence opens here and closes in another sheet`);
  }
});
