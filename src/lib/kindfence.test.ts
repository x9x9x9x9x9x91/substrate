import { test } from "node:test";
import assert from "node:assert/strict";

import { parseKindFence } from "./kindfence.ts";

test("names the kind from the fence's first word", () => {
  const b = parseKindFence(" gear-log", "");
  assert.equal(b.error, null);
  assert.equal(b.id, "gear-log");
  assert.deepEqual(b.config, {});
});

test("reads key: value config and hands it over verbatim", () => {
  const b = parseKindFence(" gear-log", "room: studio\nlimit: 5\n");
  assert.equal(b.error, null);
  // values stay text: the app interprets no key, so `5` is the kind's to coerce
  assert.deepEqual(b.config, { room: "studio", limit: "5" });
});

test("blank lines and # comments are not config", () => {
  const b = parseKindFence(" gear-log", "# which room\n\nroom: studio\n\n");
  assert.deepEqual(b.config, { room: "studio" });
});

test("a value may hold colons — only the first one splits", () => {
  const b = parseKindFence(" gear-log", "when: 2026-08-27T11:02:00Z\n");
  assert.deepEqual(b.config, { when: "2026-08-27T11:02:00Z" });
});

test("an empty value is a key set to nothing, not a parse error", () => {
  const b = parseKindFence(" gear-log", "room:\n");
  assert.equal(b.error, null);
  assert.deepEqual(b.config, { room: "" });
});

test("a config key spelled __proto__ is an ordinary key", () => {
  const b = parseKindFence(" gear-log", "__proto__: nope\n");
  assert.equal(b.error, null);
  assert.equal(Object.getPrototypeOf(b.config), Object.prototype);
  assert.equal(b.config["__proto__"], "nope");
});

test("a fence naming no kind says what to write instead", () => {
  const b = parseKindFence("", "room: studio\n");
  assert.equal(b.id, null);
  assert.match(b.error ?? "", /names no kind/);
});

test("a fence naming two kinds refuses rather than picking one", () => {
  const b = parseKindFence(" gear-log rack-log", "");
  assert.equal(b.id, null);
  assert.match(b.error ?? "", /one kind/);
});

test("an id outside the kind grammar reads as a typo, not as 'not installed'", () => {
  for (const bad of [
    "Gear-Log",
    "-gear",
    "gear/log",
    "gear log".slice(0, 4) + "!",
  ]) {
    const b = parseKindFence(` ${bad}`, "");
    assert.equal(b.id, null, bad);
    assert.match(b.error ?? "", /is not a kind id/, bad);
  }
});

test("a repeated key refuses instead of letting line order decide", () => {
  const b = parseKindFence(" gear-log", "room: studio\nroom: hall\n");
  assert.equal(b.id, null);
  assert.match(b.error ?? "", /twice/);
});

test("a line that is not key: value names the line it could not read", () => {
  const b = parseKindFence(" gear-log", "room studio\n");
  assert.match(b.error ?? "", /room studio/);
});

test("the config is a fresh object per parse — a kind cannot edit the next mount's", () => {
  const a = parseKindFence(" gear-log", "room: studio\n");
  const b = parseKindFence(" gear-log", "room: studio\n");
  a.config.room = "changed";
  assert.equal(b.config.room, "studio");
});
