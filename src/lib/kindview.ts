/* The saved-view facet of a kind's ctx (vault-format §5.8).

   Here rather than inline in `CustomKindPane` for the reason `kindfx.ts` is:
   the shape is then pinnable without a render.

   The point of the door is that it is the SAME evaluator: `vieweval.ts` is
   what the database pane paints and what the headless view reader prints, so
   a kind asking for a pin gets the rows the user sees in the app, in the same
   order, with the cells painted the same way. Before this a kind that wanted
   "the open tasks" re-implemented membership, the filter grammar and the sort
   — three chances to disagree with the table beside it.

   Read-only, and the whole door: nothing here writes, and a kind cannot
   create, rename or delete a pin. */

import type { NoteMeta, SavedView, SchemaConfig, ViewsConfig } from "./types.ts";
import { evaluateSavedView, type EvaluatedView } from "./vieweval.ts";
import { byFoldedKey, typeSchemaFor } from "./schemalookup.ts";
import type { FxResolver } from "./formula.ts";
import type { NumberLocale } from "./numberLocale.ts";

export interface KindViewOptions {
  /** The vault's stored display prefs, keyed by database name — the same map
      the pane and the headless reader look the pin's database up in. The one
      the pin's database carries is composed under the pin (`savedViewPref`),
      so what it contributes is grouping when the pin captured none. */
  prefs?: ViewsConfig;
  today?: string;
  fx?: FxResolver;
  locale?: NumberLocale;
}

/** A saved view by name, evaluated, or the sentence the pane refuses with.
 *
 *  Names fold, the way every user-authored identity in the vault folds: the
 *  name in a bundle's source and the name the user typed into the pin dialog
 *  are two hand-written spellings of one thing. First match wins — two pins
 *  may legally share a folded name, and picking one quietly beats refusing to
 *  answer at all.
 *
 *  The database's display pref rides along, because the pane composes the pin
 *  over it (`savedViewPref`) and a kind that got no pref painted a flat table
 *  where the pane paints sections — the one place a kind's table could differ
 *  from the app's. What it contributes is grouping: `table_group_by` when the
 *  pin captured none. What it still does not reach a kind is the presentation
 *  nothing a kind draws could honour anyway — footer aggregations, column
 *  widths, wrap. The rows, their order and their cells are the pin's own
 *  either way.
 *
 *  What comes back is the kind's to keep: `sorts` are copied out of the stored
 *  pin, because everything else in the payload is freshly built and that one
 *  array is the SavedView's own — a kind sorting it in place would reorder
 *  App's live pin and could persist through a later rename or column edit. */
export function kindView(
  name: string,
  views: SavedView[],
  notes: NoteMeta[],
  schema: SchemaConfig,
  opts: KindViewOptions = {},
): { view: EvaluatedView } | { refusal: string } {
  const want = name.trim().toLowerCase();
  const found = views.find((v) => v.name.trim().toLowerCase() === want);
  if (!found) return { refusal: `no saved view named “${name}”` };
  const out = evaluateSavedView(found, notes, typeSchemaFor(schema, found.db) ?? {}, {
    pref: byFoldedKey(opts.prefs, found.db),
    today: opts.today,
    fx: opts.fx,
    locale: opts.locale,
  });
  return { view: { ...out, sorts: out.sorts.map((s) => ({ ...s })) } };
}
