import { test } from "node:test";
import assert from "node:assert/strict";
import type { PropSchema } from "./types.ts";
import { orderedPropKeys } from "./proporder.ts";

test("type leads, schema props follow in insertion order, created last", () => {
  const props = {
    created: "2026-07-17",
    "cat#": "SMP-030",
    type: "release",
    released: "2026-08-02",
    status: "in review",
  };
  const schema: Record<string, PropSchema> = {
    released: { options: [], kind: "date" },
    status: { options: [] },
    format: { options: [], kind: "multi" },
  };
  // `format` is schema'd but not on the note — no row for it; `cat#` is
  // unschema'd and drops into the alphabetical section
  assert.deepEqual(orderedPropKeys(props, schema), [
    "type",
    "released",
    "status",
    "cat#",
    "created",
  ]);
});

test("unschema'd props sort alphabetically between schema props and the tail", () => {
  const props = { type: "t", zebra: "1", alpha: "2", mid: "3", created: "c" };
  assert.deepEqual(orderedPropKeys(props, {}), ["type", "alpha", "mid", "zebra", "created"]);
});

test("plain note (no schema): type first, props alphabetical, created/updated last", () => {
  const props = { updated: "u", mood: "m", created: "c", status: "s" };
  assert.deepEqual(orderedPropKeys(props, undefined), ["mood", "status", "created", "updated"]);
  assert.deepEqual(orderedPropKeys(props, null), ["mood", "status", "created", "updated"]);
});

test("updated follows created at the tail, unschema'd or not", () => {
  const props = { updated: "u", created: "c", a: "1" };
  assert.deepEqual(orderedPropKeys(props), ["a", "created", "updated"]);
});

test("reserved schema keys never become rows, created/updated in schema stay pinned last", () => {
  const props = { type: "zhome", status: "Active", created: "c" };
  const schema: Record<string, PropSchema> = {
    icon: { emoji: "🧪" } as unknown as PropSchema,
    home: "ZHome" as unknown as PropSchema,
    created: { options: [], kind: "date" },
    status: { options: [] },
  };
  assert.deepEqual(orderedPropKeys(props, schema), ["type", "status", "created"]);
});

test("title is the note's name, never a property row", () => {
  const props = { title: "X", type: "t", a: "1" };
  assert.deepEqual(orderedPropKeys(props), ["type", "a"]);
});

test("empty note has no rows", () => {
  assert.deepEqual(orderedPropKeys({}), []);
});

test("folded built-ins and schema props keep their semantic row order", () => {
  const props = { Created: "c", status: "live", Type: "RELEASE", Updated: "u" };
  const schema: Record<string, PropSchema> = {
    Status: { options: [] },
    CREATED: { options: [], kind: "date" },
  };
  assert.deepEqual(orderedPropKeys(props, schema), ["Type", "status", "Created", "Updated"]);
});

test("property ordering keeps exact spelling authoritative over folded duplicates", () => {
  const props = { Type: "legacy", type: "release", Status: "first", status: "exact" };
  const schema: Record<string, PropSchema> = { status: { options: [] } };
  assert.deepEqual(orderedPropKeys(props, schema), ["type", "status", "Status", "Type"]);
});
