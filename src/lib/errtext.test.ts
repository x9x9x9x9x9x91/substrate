/** The reader-facing shape of a caught failure (`errtext.ts`).

    Both cases were found by reading the sentences these strings land in: an
    Error built with no message left "launchd refresh failed — " ending on
    air, and a message carrying its own full stop met the sentence's and
    printed two. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { errText, midSentence } from "./errtext.ts";

test("an Error is its message, without the class name", () => {
  assert.equal(errText(new Error("no note named “Nowhere”")), "no note named “Nowhere”");
  assert.equal(errText(new TypeError("x is not a function")), "x is not a function");
});

test("an Error with nothing to say still says something", () => {
  // String(e) would have printed "Error" here; e.message prints nothing at all
  assert.equal(errText(new Error("")), "Error");
  assert.equal(errText(new Error("   ")), "Error");
  assert.equal(errText(new TypeError("")), "TypeError");
});

test("a value that isn't an Error stringifies, and empties still land", () => {
  assert.equal(errText("vault is locked"), "vault is locked");
  assert.equal(errText(""), "unknown error");
  assert.equal(errText(undefined), "undefined");
});

test("a message keeps room for the sentence's own full stop", () => {
  assert.equal(midSentence("could not read the note."), "could not read the note");
  assert.equal(midSentence("nothing under com.substrate."), "nothing under com.substrate");
  assert.equal(midSentence("it broke"), "it broke");
  // only the end of the text is touched — mid-sentence stops stay
  assert.equal(midSentence("read e.g. this one."), "read e.g. this one");
});
