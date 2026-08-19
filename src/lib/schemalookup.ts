// Case-folded schema lookups. Database types and prop
// names are user-authored on both sides — the note/fence text and
// `.vault/schema.json` — and nothing keeps their casing in step. A raw
// `schema[type]` therefore misses silently: no error, just a type that
// quietly loses its schema-driven kinds, options and formats. Every surface
// reading a schema entry by a user-supplied key goes through here.
//
// Exact match always wins first, so exact-cased keys never change meaning;
// only a miss falls back to the case-insensitive scan.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import type { PropSchema, SchemaConfig } from "./types.ts";

const SYSTEM_PROP_NAMES = new Set(["type", "title", "created"]);
const RESERVED_SCHEMA_NAMES = new Set(["icon", "home", "parent"]);
const BUILTIN_DATE_NAMES = new Set(["created", "updated"]);

/** Built-in/reserved identities are case-insensitive for the same reason
    schema lookups are: their spelling may come from hand-authored YAML/JSON. */
export const isSystemPropName = (name: string): boolean =>
  SYSTEM_PROP_NAMES.has(name.toLowerCase());

export const isReservedSchemaName = (name: string): boolean =>
  RESERVED_SCHEMA_NAMES.has(name.toLowerCase());

export const isBuiltinDateName = (name: string): boolean =>
  BUILTIN_DATE_NAMES.has(name.toLowerCase());

export const isTypePropName = (name: string): boolean => name.toLowerCase() === "type";

/** Key in `obj` matching `want`, exact first and then case-insensitively. */
export function foldedObjectKey<T>(
  obj: Record<string, T> | undefined,
  want: string
): string | undefined {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, want)) return want;
  const w = want.toLowerCase();
  return Object.keys(obj).find((key) => key.toLowerCase() === w);
}

/** Value of the object key matching `want` case-insensitively (exact hit
    first, so exact-cased keys never change meaning). */
export function byFoldedKey<T>(obj: Record<string, T> | undefined, want: string): T | undefined {
  const key = foldedObjectKey(obj, want);
  return key === undefined ? undefined : obj?.[key];
}

/** The prop map a database type declares, resolving the type name
    case-insensitively. Undefined when no such type is in the schema — callers
    that treat "no schema" as "no rules" use `?? {}`. */
export function typeSchemaFor(
  schema: SchemaConfig,
  type: string
): Record<string, PropSchema> | undefined {
  return byFoldedKey(schema, type);
}

/** One prop's schema entry, resolving both the type and the prop name
    case-insensitively. Undefined when either level is genuinely absent. */
export function propSchemaFor(
  schema: SchemaConfig,
  type: string,
  prop: string
): PropSchema | undefined {
  return byFoldedKey(typeSchemaFor(schema, type), prop);
}
