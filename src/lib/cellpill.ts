/* Which pill a cell value wears.

   Design principle 4 — one concept, one treatment: a status value must read
   the same wherever it appears. A hub's hand-typed markdown table and the
   live ```view table beside it show the same `status: shipped`, so they must
   paint the same pill. They arrive at it from different directions, which is
   why both answers live here rather than one of them living privately in a
   component:

   - a markdown table knows only a column HEADER, so it searches every type's
     schema for a prop of that name whose options hold the value;
   - a live embed knows exactly which database it queried, so it asks that
     type's schema directly.

   Pure TS, no DOM/React: runs in the app and under `node --test`. */

import { byFoldedKey } from "./schemalookup.ts";
import type { PropSchema, SchemaConfig, SelectOption } from "./types.ts";

/** The option color a value carries, matched case-insensitively (a note may
    spell its own value however it likes). No option → no color → no pill:
    dates, numbers and free text never pill. */
export function optionColor(
  options: SelectOption[] | undefined,
  value: string
): string | undefined {
  return options?.find((o) => o.value.toLowerCase() === value.toLowerCase())?.color;
}

/** Pill color for a markdown-table cell, matched by column-header prop name
    across all type schemas and then by cell value. Several types may share a
    prop name (task.status vs release.status), so the first schema whose
    OPTIONS actually hold the value decides. */
export function schemaPillColor(
  schema: SchemaConfig | undefined,
  header: string,
  value: string
): string | undefined {
  if (!schema) return undefined;
  const want = header.trim().toLowerCase();
  if (want === "" || value.trim() === "") return undefined;
  for (const props of Object.values(schema)) {
    for (const [name, ps] of Object.entries(props)) {
      if (name.toLowerCase() !== want) continue;
      const color = optionColor(ps.options, value);
      if (color !== undefined) return color;
    }
  }
  return undefined;
}

/** Pill color for a live ```view cell. The embed resolved a database, so the
    guesswork above is unnecessary: this column's own schema entry answers.
    A joined column's value belongs to another type — callers skip those
    rather than letting a same-named local prop answer for them. */
export function embedPillColor(
  typeSchema: Record<string, PropSchema> | undefined,
  column: string,
  value: string
): string | undefined {
  if (value.trim() === "") return undefined;
  return optionColor(byFoldedKey(typeSchema, column)?.options, value);
}
