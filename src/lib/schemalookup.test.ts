import { test } from "node:test";
import assert from "node:assert/strict";
import type { SchemaConfig } from "./types.ts";
import { foldedPropKey, foldedPropStr, foldedTypeName } from "./types.ts";
import {
  byFoldedKey,
  foldedObjectKey,
  isBuiltinDateName,
  isReservedSchemaName,
  isSystemPropName,
  isTypePropName,
  typeSchemaFor,
} from "./schemalookup.ts";

test("foldedObjectKey returns the stored key and exact matches win", () => {
  const values = { Release: 1, release: 2, Task: 3 };
  assert.equal(foldedObjectKey(values, "release"), "release");
  assert.equal(foldedObjectKey(values, "RELEASE"), "Release");
  assert.equal(foldedObjectKey(values, "task"), "Task");
  assert.equal(foldedObjectKey(values, "missing"), undefined);
  assert.equal(byFoldedKey(values, "task"), 3);
});

test("note-pane lookup path folds Type and schema props while preserving stored keys", () => {
  const schema: SchemaConfig = {
    Release: { Status: { options: [{ value: "live" }] } },
  };
  const props = { Type: "RELEASE", status: "live" };

  assert.equal(foldedPropStr(props, "type"), "RELEASE");
  assert.equal(foldedPropKey(props, "type"), "Type", "writes reuse the existing key");
  const releaseSchema = typeSchemaFor(schema, foldedPropStr(props, "type")!);
  assert.equal(byFoldedKey(releaseSchema, "status")?.options[0]?.value, "live");
  assert.equal(foldedPropKey(props, "Status"), "status", "property writes avoid duplicates");
});

test("missing prototype-shaped props stay absent, while own values still read", () => {
  const empty = {};
  for (const key of ["__proto__", "constructor", "toString"]) {
    assert.equal(foldedPropKey(empty, key), key, `${key}: writes keep the requested key`);
    assert.equal(foldedPropStr(empty, key), undefined, `${key}: inherited values never read`);
  }

  const props = Object.create(null) as Record<string, unknown>;
  props["__proto__"] = "stored";
  props["constructor"] = "built";
  assert.equal(foldedPropStr(props, "__proto__"), "stored");
  assert.equal(foldedPropStr(props, "CONSTRUCTOR"), "built");
});

test("built-in and reserved identities fold without broad near-matches", () => {
  for (const key of ["type", "Type", "TITLE", "Created"])
    assert.equal(isSystemPropName(key), true, key);
  for (const key of ["type", "TYPE", "Type"])
    assert.equal(isTypePropName(key), true, key);
  for (const key of ["created", "CREATED", "Updated"])
    assert.equal(isBuiltinDateName(key), true, key);
  for (const key of ["icon", "ICON", "Home"])
    assert.equal(isReservedSchemaName(key), true, key);
  for (const key of ["types", "updated-at", "homepage", "icons"])
    assert.equal(
      isSystemPropName(key) || isBuiltinDateName(key) || isReservedSchemaName(key),
      false,
      key
    );
});

test("foldedTypeName folds the type VALUE, not just its key (SUB-1187)", () => {
  // surfaces that dispatch on the type word compare it to a lowercase literal;
  // `Type: Sheet` and `type: sheet ` name the same database
  assert.equal(foldedTypeName({ Type: "Sheet" }), "sheet");
  assert.equal(foldedTypeName({ type: " sheet " }), "sheet");
  assert.equal(foldedTypeName({ type: "Dashboard" }), "dashboard");
  // no type and a blank one both read as "no type declared"
  assert.equal(foldedTypeName({}), undefined);
  assert.equal(foldedTypeName({ type: "   " }), undefined);
  // a scalar reads as the word it prints, exactly as every other prop does
  assert.equal(foldedTypeName({ type: 3 }), "3");
});
