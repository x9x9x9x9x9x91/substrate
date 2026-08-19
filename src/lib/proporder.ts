import type { PropSchema } from "./types.ts";

/* Note property rows: the note pane's chip wrap grew into a vertical
   property table (one row per property, fixed muted label column), so row
   order is part of the design. Deterministic: the Database row (`type`)
   first, schema-defined props in schema.json insertion order, unschema'd
   props alphabetically, `created`/`updated` pinned last. `title` is the
   note's name, never a row. */

/** Reserved schema.json keys that aren't props (`icon`,
    `home`, `parent`) — the same set templates.ts guards at create time. */
const RESERVED_SCHEMA_KEYS = new Set(["icon", "home", "parent"]);

/** Row order for a note's property list. `typeSchema` is the note's own
    type's schema entry (`schema[props.type]`) — absent for plain notes. */
export function orderedPropKeys(
  props: Record<string, unknown>,
  typeSchema?: Record<string, PropSchema> | null
): string[] {
  const keys = new Set(Object.keys(props));
  // Every identity is exact-first, then folded. That keeps a genuine exact
  // key authoritative when a hand edit left case-only duplicates, while a
  // lone `Type`/`Created` still receives the reserved row semantics.
  const take = (want: string): string | undefined => {
    if (keys.delete(want)) return want;
    const folded = want.toLowerCase();
    const found = [...keys].find((key) => key.toLowerCase() === folded);
    if (found !== undefined) keys.delete(found);
    return found;
  };
  take("title");
  // notion_id is the importer's dedupe stamp (import-notion.ts) — pure
  // bookkeeping on every migrated row, never a data row (same rule as
  // dbColumns' column union)
  take("notion_id");
  const out: string[] = [];
  const type = take("type");
  if (type !== undefined) out.push(type);
  for (const k of Object.keys(typeSchema ?? {})) {
    const folded = k.toLowerCase();
    if (RESERVED_SCHEMA_KEYS.has(folded) || folded === "created" || folded === "updated")
      continue;
    const actual = take(k);
    if (actual !== undefined) out.push(actual);
  }
  const created = take("created");
  const updated = take("updated");
  const rest = [...keys];
  rest.sort((a, b) => a.localeCompare(b));
  out.push(...rest);
  if (created !== undefined) out.push(created);
  if (updated !== undefined) out.push(updated);
  return out;
}
