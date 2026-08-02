import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore } from "./fuzzy.ts";

test("non-BMP chars match by code point (SUB-236)", () => {
  // 🛒 is a surrogate pair — UTF-16 unit scanning never matched it
  assert.ok(fuzzyScore("🛒shop", "🛒 Shopping List") > -1);
  assert.ok(fuzzyScore("🛒", "my 🛒 list") > -1);
});

test("empty query matches everything", () => {
  assert.equal(fuzzyScore("", "anything"), 1);
});

test("prefix beats substring beats subsequence", () => {
  const prefix = fuzzyScore("shop", "shopping list");
  const substring = fuzzyScore("shop", "the shop list");
  const subsequence = fuzzyScore("shop", "so happy people");
  assert.ok(prefix > substring, `${prefix} should beat ${substring}`);
  assert.ok(substring > subsequence, `${substring} should beat ${subsequence}`);
  assert.ok(subsequence > -1);
});

test("no match scores -1", () => {
  assert.equal(fuzzyScore("xyz", "shopping list"), -1);
});
