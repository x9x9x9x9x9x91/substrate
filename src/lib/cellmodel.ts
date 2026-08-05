/* One derivation of "what does editing this cell mean".

   The database table has answered this: given a note's props, a
   column name and the type's schema, which kind is it, what's the raw value,
   what's the note's own spelling of the key, is the checkbox on. The inline
   ```view widget now edits cells too, and two copies of that derivation would
   drift the first time a kind is added — so both surfaces read it here.

   Pure TS, no DOM/React: runs in the app and under `node --test`. */

import { propList } from "./relation.ts";
import { byFoldedKey, isBuiltinDateName } from "./schemalookup.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import type { PropKind, PropSchema } from "./types.ts";

export interface CellModel {
  /** the note's own spelling of the column key — what a write must target */
  actualKey: string;
  /** the raw value as a display-independent string ("" when absent) */
  val: string;
  /** the column's schema entry, when the type declares one */
  schema: PropSchema | undefined;
  /** the effective kind: schema first, then the built-in date meta props
      (created/updated read as dates unless the schema overrides) */
  kind: PropKind | undefined;
  /** multi/relation values as a list ([] for every other kind) */
  list: string[];
  /** checkbox only: on iff the raw prop is the YAML bool `true` — `false`,
      missing and empty all read as unchecked */
  checked: boolean;
}

export function cellModel(
  props: Record<string, unknown>,
  column: string,
  typeSchema: Record<string, PropSchema>
): CellModel {
  const actualKey = foldedPropKey(props, column);
  const schema = byFoldedKey(typeSchema, column);
  const kind = schema?.kind ?? (isBuiltinDateName(column) ? "date" : undefined);
  return {
    actualKey,
    val: foldedPropStr(props, column) ?? "",
    schema,
    kind,
    list: kind === "multi" || kind === "relation" ? propList(props, actualKey) : [],
    checked: kind === "checkbox" && props[actualKey] === true,
  };
}

/** Does a plain click on this cell open an editor? Rollups are derived
 and checkboxes toggle in place, so neither opens one. */
export function cellOpensEditor(kind: PropKind | undefined): boolean {
  return kind !== "rollup" && kind !== "checkbox";
}
