import type {
  DbLayout,
  NoteMeta,
  PropSchema,
  SavedView,
  SavedViewSort,
  ViewPref,
} from "./types.ts";
import { byFoldedKey } from "./schemalookup.ts";
import { MAX_SORT_KEYS } from "./dbsort.ts";

/** Props that lead every table regardless of alphabet — the release-shaped
    columns people scan first. */
export const COLUMN_ORDER = ["status", "cat#", "artist", "category", "created"];

/** Resolve a persisted/user-supplied column name to the casing currently
    canonical for this database. Exact wins; a genuine miss stays missing. */
export function canonicalColumn(columns: string[], key: string): string | undefined {
  if (columns.includes(key)) return key;
  const folded = key.toLowerCase();
  return columns.find((candidate) => candidate.toLowerCase() === folded);
}

/** Normalize known persisted column identities without admitting unknown
    names into the rendered union. Unknown keys stay byte-for-byte intact so
    a typo remains stale instead of gaining meaning. */
function canonicalColumnKeys(columns: string[], keys: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const canonical = canonicalColumn(columns, key) ?? key;
    const identity = canonicalColumn(columns, key) ? canonical.toLowerCase() : `exact:${canonical}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(canonical);
  }
  return out;
}

/** Map counterpart of canonicalColumnKeys. When hand-edited prefs carry
    case-only duplicates, the exact canonical key wins regardless of JSON
    insertion order; otherwise the first folded spelling supplies the value. */
export function canonicalColumnRecord<T>(
  columns: string[],
  record: Readonly<Record<string, T>>
): Record<string, T> {
  const out: Record<string, T> = {};
  const exact = new Set<string>();
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(out, key);
  // Assignment to `__proto__` on an ordinary object invokes its legacy
  // prototype setter. Define own data properties instead so every legal
  // database property name round-trips without changing `out`'s prototype.
  const write = (key: string, value: T) =>
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  for (const [key, value] of Object.entries(record)) {
    const canonical = canonicalColumn(columns, key);
    if (canonical === undefined) {
      write(key, value);
      continue;
    }
    if (!hasOwn(canonical) || key === canonical) write(canonical, value);
    if (key === canonical) exact.add(canonical);
    else if (exact.has(canonical)) write(canonical, record[canonical]);
  }
  return out;
}

/** The sort list a pane can actually render: keys canonicalized, then one
    entry per key and never more than the ordinal badges promise. A
    hand-edited pref can name the same column twice in different casing —
    `Status` and `status` canonicalize to one spelling, and two rows for one
    key toggle and remove together — or carry more keys than the cap, which
    would print a fourth ordinal against a three-key invariant. The first
    entry for a key wins, so the earliest stated priority is the one kept.
    Header clicks and the sort popover already guard both, so this is the
    boundary that covers the persisted path they cannot reach. */
function canonicalSortKeys(columns: string[], sorts: SavedViewSort[]): SavedViewSort[] {
  const out: SavedViewSort[] = [];
  const seen = new Set<string>();
  for (const sort of sorts) {
    // `title` is the name column, not a database prop: it never appears in
    // `columns`, so it is canonical by itself. Unknown keys stay
    // byte-for-byte, and so keep distinct spellings distinct — a typo stays
    // one stale key instead of collapsing into a real one.
    const canonical = sort.key === "title" ? "title" : canonicalColumn(columns, sort.key);
    const key = canonical ?? sort.key;
    const identity = canonical === undefined ? `exact:${key}` : key.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({ ...sort, key });
    if (out.length === MAX_SORT_KEYS) break;
  }
  return out;
}

/** Canonicalize every persisted column-bearing field before a write. */
export function canonicalViewPref(pref: ViewPref, columns: string[]): ViewPref {
  const column = (key: string | undefined) =>
    key === undefined ? undefined : (canonicalColumn(columns, key) ?? key);
  const lists = (keys: string[] | undefined) =>
    keys === undefined ? undefined : canonicalColumnKeys(columns, keys);
  // `...pref` carries card_order through untouched on purpose: it
  // holds note PATHS, not column keys, so column canonicalization would only
  // corrupt it. `group_order` and `collapsed_groups` ride through for the
  // same reason — they hold section VALUES of the grouped column.
  return {
    ...pref,
    group_by: column(pref.group_by),
    table_group_by: column(pref.table_group_by),
    aggregations:
      pref.aggregations === undefined
        ? undefined
        : canonicalColumnRecord(columns, pref.aggregations),
    sorts: pref.sorts === undefined ? undefined : canonicalSortKeys(columns, pref.sorts),
    col_order: lists(pref.col_order),
    hidden: lists(pref.hidden),
    hidden_per_layout:
      pref.hidden_per_layout === undefined
        ? undefined
        : {
            table: lists(pref.hidden_per_layout.table),
            list: lists(pref.hidden_per_layout.list),
          },
    widths:
      pref.widths === undefined ? undefined : canonicalColumnRecord(columns, pref.widths),
    wrap: lists(pref.wrap),
  };
}

/** Column set for a database table: schema-registered props (a
    column shows for every entry even with no values) ∪ prop keys in use
    across the type's notes. `type` is constant per view, `title` is the name
    column, `icon`/`home`/`parent` are reserved schema keys — none of them is a
    column. Known props lead, the rest follow alphabetically. */
export function dbColumns(notes: NoteMeta[], typeSchema: Record<string, PropSchema>): string[] {
  const seen = new Map<string, string>();
  const observed = new Set<string>();
  for (const k of Object.keys(typeSchema)) {
    const folded = k.toLowerCase();
    if (
      folded !== "type" &&
      folded !== "title" &&
      folded !== "icon" &&
      folded !== "home" &&
      folded !== "parent"
    )
      seen.set(folded, k);
  }
  for (const n of notes) {
    for (const k of Object.keys(n.props)) {
      const folded = k.toLowerCase();
      // notion_id is the importer's dedupe stamp (import-notion.ts) — pure
      // bookkeeping on every migrated row, never a data column
      if (
        folded !== "type" &&
        folded !== "title" &&
        folded !== "notion_id" &&
        !observed.has(folded)
      ) {
        // Note spelling wins over schema spelling: this is the key a later
        // cell write must reuse instead of creating a case-only duplicate.
        seen.set(folded, k);
        observed.add(folded);
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    const ia = COLUMN_ORDER.indexOf(a.toLowerCase());
    const ib = COLUMN_ORDER.indexOf(b.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/** The hidden-prop set one layout renders with: the layout's own
    per-layout set when it has one, else the flat `hidden` — which pre
    pref files carry and which therefore seeds BOTH layouts (the read-side
    migration; the first per-layout write materializes both sets and drops
    the flat key) — else nothing hidden. Board and gallery have no curation
    UI; where they need a column list at all (CSV export) they read the table
    set, the columnar layout's. */
export function hiddenForLayout(
  pref: Pick<ViewPref, "hidden" | "hidden_per_layout"> | undefined,
  layout: DbLayout
): string[] {
  const key = layout === "list" ? "list" : "table";
  return pref?.hidden_per_layout?.[key] ?? pref?.hidden ?? [];
}

/** The columns a view actually renders: the view's own `columns`
    in their stored order, filtered to keys that are still columns (a renamed
    or removed prop drops out quietly); a view without `columns` — or one
    whose list every key fell out of — gets the default dbColumns union. The
    title column is not part of this list; it always leads regardless. */
export function effectiveColumns(
  view: Pick<SavedView, "columns"> | undefined,
  dbCols: string[]
): string[] {
  if (!view?.columns || view.columns.length === 0) return dbCols;
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const key of view.columns) {
    const canonical = canonicalColumn(dbCols, key);
    if (canonical !== undefined && !seen.has(canonical)) {
      kept.push(canonical);
      seen.add(canonical);
    }
  }
  return kept.length > 0 ? kept : dbCols;
}

/** Apply a persisted table column order to a column list. Keys the
    order names lead, in its order; every other column follows in its default
    `dbColumns` position — so a prop added after the drag joins the table
    instead of vanishing, and a renamed/removed one drops out quietly. An
    absent or fully stale order leaves the default untouched. */
export function orderedColumns(columns: string[], order: string[] | undefined): string[] {
  if (!order || order.length === 0) return columns;
  const lead: string[] = [];
  const taken = new Set<string>();
  for (const key of order) {
    const canonical = canonicalColumn(columns, key);
    if (canonical !== undefined && !taken.has(canonical)) {
      lead.push(canonical);
      taken.add(canonical);
    }
  }
  if (lead.length === 0) return columns;
  return [...lead, ...columns.filter((c) => !taken.has(c))];
}

/** The prop a board groups by: the saved pref when it still names a groupable
    column, else `status`, else the first candidate. Multi-kind props
    are never candidates — a card would belong to several columns at once — so
    a stale views.json pref pointing at one falls back instead of crashing.
    Rollup props are never candidates either: a board drag WRITES
    the group prop on drop, and a derived column has no write path. */
export function boardGroupBy(
  columns: string[],
  typeSchema: Record<string, PropSchema>,
  pref?: string
): string | undefined {
  const groupable = columns.filter(
    (c) => {
      const kind = byFoldedKey(typeSchema, c)?.kind;
      return kind !== "multi" && kind !== "rollup";
    }
  );
  const preferred = pref ? canonicalColumn(groupable, pref) : undefined;
  if (preferred) return preferred;
  const status = canonicalColumn(groupable, "status");
  if (status) return status;
  return groupable[0];
}
