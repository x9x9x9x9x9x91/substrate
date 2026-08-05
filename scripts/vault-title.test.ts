import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedSlug, sanitizeFilename, validateNoteTitle } from "./vault-title.ts";

test("sanitizeFilename mirrors the engine: separators and illegal chars collapse", () => {
  assert.equal(sanitizeFilename("normal title"), "normal title");
  assert.equal(sanitizeFilename("a/b\\c:d"), "a b c d");
  assert.equal(sanitizeFilename('x*y?z"w<w>v|u'), "x y z w w v u");
  assert.equal(sanitizeFilename("  spaced   out  "), "spaced out");
  assert.equal(sanitizeFilename(""), "Untitled");
  assert.equal(sanitizeFilename("   "), "Untitled");
});

test("guardedSlug leaves a normal title unchanged", () => {
  assert.equal(guardedSlug("normal title"), "normal title");
});

test("leading dots are guarded — the note would be invisible to the index (SUB-223)", () => {
  assert.throws(() => guardedSlug(".hidden"), /dot/);
  assert.throws(() => guardedSlug("..."), /dot/);
});

test("brackets are guarded — they corrupt every rewritten [[link]] (SUB-223)", () => {
  assert.throws(() => guardedSlug("a]]b"), /\[ or \]/);
  assert.throws(() => guardedSlug("a[b"), /\[ or \]/);
});

test("validateNoteTitle checks the raw title for brackets, the slug for dots", () => {
  // "]" survives sanitize (not an illegal filename char) but must still fail
  assert.throws(() => validateNoteTitle("a]b", sanitizeFilename("a]b")), /\[ or \]/);
  // a sanitizing detour ("/" → " ") into a leading dot is caught on the slug
  assert.throws(() => validateNoteTitle("/.x", sanitizeFilename("/.x")), /dot/);
  assert.doesNotThrow(() => validateNoteTitle("C: temp", sanitizeFilename("C: temp")));
});

test("control characters are guarded like the engine (SUB-904)", () => {
  // \u0001 is not whitespace, so it survives the collapse into the slug;
  // the engine refuses it before any side effect (vault/mod.rs block)
  assert.throws(() => guardedSlug("bad\u0001title"), /control characters/);
  assert.throws(() => guardedSlug("del\u007fchar"), /control characters/);
  assert.throws(() => guardedSlug("c1\u009cchar"), /control characters/);
  // whitespace controls collapse away and stay fine
  assert.equal(guardedSlug("a\tb\nc"), "a b c");
});
