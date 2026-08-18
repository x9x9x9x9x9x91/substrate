import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calloutAccentOptions,
  calloutInsert,
  calloutKindOptions,
  calloutQuery,
} from "./callouts.ts";
import { ACCENT_NAMES } from "./styletokens.ts";

test("calloutQuery: the kind slot, only on a blockquote line", () => {
  assert.deepEqual(calloutQuery("> [!"), { slot: "kind", query: "" });
  assert.deepEqual(calloutQuery("body\n>  [!no"), { slot: "kind", query: "no" });
  assert.deepEqual(calloutQuery("  > [!WARN"), { slot: "kind", query: "WARN" });
  // a closed header, a bare quote and prose are all past it
  assert.equal(calloutQuery("> [!note] Title"), null);
  assert.equal(calloutQuery("> just a quote"), null);
  assert.equal(calloutQuery("[!note"), null);
});

test("calloutQuery: the accent slot opens once a real kind carries a pipe", () => {
  assert.deepEqual(calloutQuery("> [!note|"), { slot: "accent", query: "" });
  assert.deepEqual(calloutQuery("> [!Idea|te"), { slot: "accent", query: "te" });
  // only the three kinds take an accent — a typo'd kind is not a callout yet
  assert.equal(calloutQuery("> [!noteish|te"), null);
});

test("calloutKindOptions: the three kinds, menu order kept", () => {
  assert.deepEqual(
    calloutKindOptions("").map((k) => k.name),
    ["note", "warn", "idea"]
  );
  assert.deepEqual(
    calloutKindOptions("id").map((k) => k.name),
    ["idea"]
  );
  assert.deepEqual(calloutKindOptions("zzz"), []);
});

test("calloutAccentOptions: the roster, and nothing off it", () => {
  assert.deepEqual(calloutAccentOptions(""), [...ACCENT_NAMES]);
  assert.deepEqual(calloutAccentOptions("te"), ["teal"]);
  // an off-roster hue is never offered, because it would never be honoured
  assert.deepEqual(calloutAccentOptions("crimson"), []);
});

test("calloutInsert: closes the header once, never twice", () => {
  assert.equal(calloutInsert("note", ""), "note] ");
  assert.equal(calloutInsert("note", " Title"), "note] ");
  assert.equal(calloutInsert("note", "] Title"), "note");
  // retyping the kind of an already-accented callout must not strand the hue
  assert.equal(calloutInsert("warn", "|teal] Title"), "warn");
});
