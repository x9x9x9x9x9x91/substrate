import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_KEYS, suggestPropKeys } from "./propkeys.ts";

const SCHEMA = {
  status: { options: [], kind: "multi" as const },
  due: { options: [], kind: "date" as const },
  brief: { options: [], kind: "text" as const, description: "One line on what this is for" },
  icon: { options: [] },
};

test("the note's own database comes first, the app's keys behind it", () => {
  const out = suggestPropKeys("", SCHEMA, {});
  assert.deepEqual(out.slice(0, 3).map((s) => s.key), ["status", "due", "brief"]);
  assert.ok(out.some((s) => s.key === "pages"));
  // schema housekeeping is not a note property
  assert.ok(!out.some((s) => s.key === "icon"));
});

test("schema housekeeping keys stay out however they are cased", () => {
  const out = suggestPropKeys("", { Icon: { options: [] }, Home: { options: [] }, note: { options: [] } }, {});
  assert.deepEqual(out.map((s) => s.key).filter((k) => /^(icon|home)$/i.test(k)), []);
  assert.ok(out.some((s) => s.key === "note"));
});

test("a prop's own description beats the kind name as its hint", () => {
  const out = suggestPropKeys("", SCHEMA, {});
  assert.equal(out.find((s) => s.key === "brief")?.hint, "One line on what this is for");
  assert.equal(out.find((s) => s.key === "due")?.hint, "Date");
});

test("keys the note already carries are not offered again — case folded", () => {
  const out = suggestPropKeys("", SCHEMA, { Status: "live", Pages: [] });
  assert.ok(!out.some((s) => s.key.toLowerCase() === "status"));
  assert.ok(!out.some((s) => s.key.toLowerCase() === "pages"));
});

test("typing filters by prefix first, mid-word matches ride behind", () => {
  const out = suggestPropKeys("repeat", undefined, {});
  assert.deepEqual(out.map((s) => s.key), ["repeat", "repeat_until", "repeat_skip"]);
  const mid = suggestPropKeys("until", undefined, {});
  assert.deepEqual(mid.map((s) => s.key), ["repeat_until"]);
});

test("a typed-past-the-key draft suggests nothing — the value is the chip's own job", () => {
  assert.deepEqual(suggestPropKeys("repeat: we", undefined, {}), []);
  assert.deepEqual(suggestPropKeys("repeat:", SCHEMA, {}), []);
});

test("an untyped note still gets the app's documented vocabulary", () => {
  const out = suggestPropKeys("", undefined, {});
  assert.deepEqual(out.map((s) => s.key), APP_KEYS.map((s) => s.key));
  assert.ok(out.every((s) => s.hint.trim() !== ""), "every suggestion says what it does");
});

test("the list is capped so the popup never runs off the pane", () => {
  assert.equal(suggestPropKeys("", SCHEMA, {}, 3).length, 3);
});
