// View embeds: a ```view fence inside a note body renders a read-only
// inline database table in the editor — the hub-page primitive. Config is
// hand-editable key: value text, one per line:
//
//   ```view
//   type: release              # a database type
//   query: status:unreleased   # the filter-bar language (optional)
//   view: table                # accepted; only table renders in v1
//   sort: released:desc        # optional
//   limit: 5                   # optional
//   columns: status, artist    # optional
//   ```
//
// or the one-key saved form, referencing a pinned view by id (or name):
//
//   ```view
//   saved: umbra-unreleased
//   ```
//
// Unknown keys and malformed lines are parse ERRORS — a fence
// that says `sortt:` used to render silently unsorted, which is the worst of
// both worlds. Errors, malformed values and unknown references all render as
// a quiet inline error card, never a crash and never a broken sibling. The
// fence is plain markdown — the widget snapshot rebuilds on doc edits/remounts
// and on every vault change (the vault epoch rides the widget identity,
// identity).
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { canonicalColumn, dbColumns, effectiveColumns } from "./dbcolumns.ts";
import { sortCmpFor } from "./dbsort.ts";
import { displayValue } from "./display.ts";
import { numberLocale } from "./numberLocale.ts";
import { filterInherits, parseQuery } from "./query.ts";
import {
  byFoldedKey,
  foldedObjectKey,
  isBuiltinDateName,
  isSystemPropName,
  typeSchemaFor,
} from "./schemalookup.ts";
import { filterByQuery } from "./views.ts";
import {
  isJoinName,
  joinResolverFor,
  joinSortKeyFor,
  joinSortSchema,
  type JoinResolver,
  type ResolvedJoin,
} from "./viewjoin.ts";
import { foldedPropStr } from "./types.ts";
import type {
  NoteMeta,
  PropSchema,
  SavedView,
  SavedViewSort,
  SchemaConfig,
} from "./types.ts";

/** The spec a ```view fence declares — every key optional. */
export interface EmbedSpec {
  type?: string;
  query?: string;
  saved?: string;
  /** accepted but v1 renders table regardless */
  view?: string;
  /** One ordering key, `sort: <prop>` or `sort: <prop>:desc`. The
      property is resolved (and the ordering itself run) against the database's
      own columns at query time, not here. */
  sort?: SavedViewSort;
  /** The fence's own row cut, applied after filtering and sorting.
      Distinct from the surface's safety cap — see `EmbedResult.cut`. */
  limit?: number;
  /** Explicit column pick and order, matched case-insensitively
      against the database's columns. Wins over a `saved:` pin's own list. */
  columns?: string[];
}

/** A parsed fence: its spec, or the first thing wrong with the text.
    Malformed and unknown keys are errors now rather than silent no-ops — a
    fence that says `sortt:` used to render, unsorted, with nothing to show for
    the typo. The error travels as a value through `embedQueryFor` into the
    same quiet card an unknown database gets; nothing throws. */
export type ViewSpecResult = EmbedSpec | { error: string };

const KNOWN_KEYS = ["type", "query", "saved", "view", "sort", "limit", "columns"] as const;

export interface EmbedRow {
  path: string;
  title: string;
  /** display strings, aligned 1:1 with `columns` */
  cells: string[];
  /** the note's raw props. Editing a cell needs the value behind the
      display string — a checkbox's boolean, a multi's list, a date's ISO — plus
      the note's own spelling of the key. Carrying the props verbatim lets the
      widget derive all of that with the same helpers the database table uses
      instead of re-deriving a parallel set of per-cell fields here. */
  props: Record<string, unknown>;
}

/** A resolved embed: the table model the widget renders, or a quiet error.
    `savedId`/`savedName` are present when the embed came from a `saved:` pin —
    the widget shows the pin's name and click-through opens the saved view, so
    two cuts of the same database stay distinguishable on one page. */
export type EmbedResult =
  | {
      dbType: string;
      columns: string[];
      rows: EmbedRow[];
      total: number;
      savedId?: string;
      savedName?: string;
      /** the type's resolved schema — the widget's cell editors read
          kinds, options, formats and relation targets from it, exactly as the
          database table does. `{}` for an undeclared type. */
      typeSchema: Record<string, PropSchema>;
      /** the effective query after a `saved:` pin resolves — "+ New"
          seeds a row from it, and a pinned embed must seed from the pin's own
          filter, not from the fence's (absent) `query:` line */
      query: string;
      /** The join columns among `columns`, by their canonical
          dotted name. A joined cell is a stored value read off ANOTHER row,
          so it is read-only wherever cells are editable — the widget asks
          this set, exactly as it asks the schema for a rollup. Absent when
          the fence declares no joins. */
      joins?: string[];
      /** Why `rows` is shorter than `total`, when it is. The two
          reasons are not the same fact and must not read the same way: a
          `limit:` is the author SAYING "top 5", a cap is the surface refusing
          to paint 4000 rows in a note. Absent when nothing was cut. */
      cut?: { kind: "limit" | "cap"; shown: number };
    }
  | { error: string };

/** Display caps: the title column plus the first N data columns, at most M rows. */
export const EMBED_MAX_COLS = 4;
export const EMBED_MAX_ROWS = 50;

const KEY_RE = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/;

/** `sort: released` / `sort: released:desc` — direction optional, either case. */
const SORT_RE = /^(.*?)(?::\s*(asc|desc))?$/i;

/** Parse one fence body into its spec, or the first error in its text.
    Never throws: a bad fence is a VALUE the render path turns into
    the same quiet card an unknown database gets.

    Blank selector values (`query:`, for example) stay draftable. Empty
    option values (`sort:`, `limit:`, `columns:`) are malformed, but the editor
    shows raw source while the caret is inside the fence, so that error never
    flashes over the keystroke that creates it.

    Errors quote what the author actually typed, because the fix is a text edit
    and the card is the only place they'll read it. */
export function parseViewSpec(inner: string): ViewSpecResult {
  const spec: EmbedSpec = {};
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = KEY_RE.exec(line);
    if (!m) return { error: `Not a key: value line — “${line}”` };
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      return { error: `Unknown key “${m[1]}” — try ${KNOWN_KEYS.join(", ")}` };
    }
    // Existing selector keys keep their tolerant empty-value behavior while
    // a fence is being drafted. The three option keys are only meaningful
    // with values, though, and the editor shows source while the caret is in
    // the fence, so reporting these as malformed never flashes over typing.
    if (!value) {
      if (key === "sort") return { error: "Malformed sort: add <prop> or <prop>:desc" };
      if (key === "limit") return { error: "Malformed limit: add a whole number of rows" };
      if (key === "columns") return { error: "Malformed columns: add a comma-separated list" };
      continue;
    }
    switch (key) {
      case "type":
        spec.type = value;
        break;
      case "query":
        spec.query = value;
        break;
      case "saved":
        spec.saved = value;
        break;
      case "view":
        spec.view = value;
        break;
      case "sort": {
        const s = SORT_RE.exec(value);
        const prop = s?.[1].trim();
        if (!prop) return { error: `Malformed sort: “${value}” — want <prop> or <prop>:desc` };
        spec.sort = { key: prop, dir: s?.[2]?.toLowerCase() === "desc" ? -1 : 1 };
        break;
      }
      case "limit": {
        // a limit is a count of rows: a positive whole number and nothing else.
        // "0" is rejected rather than read as "show nothing" — nobody writes a
        // fence to hide its own table, so it's a typo every time.
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n === 0) {
          return { error: `Malformed limit: “${value}” — want a whole number of rows` };
        }
        spec.limit = n;
        break;
      }
      case "columns": {
        const names = value
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== "");
        if (names.length === 0) {
          return { error: `Malformed columns: “${value}” — want a comma-separated list` };
        }
        spec.columns = names;
        break;
      }
    }
  }
  return spec;
}

/** Props a new row created from a fence should start with, read off
    the fence's own `query:`. A fence that shows `status:mastering` is a
    statement about what belongs in it, so "+ New" seeds the row to match —
    otherwise the row is created and immediately filtered back out of the
    table you created it from.

    Which terms pin is `filterInherits`' call, not a second opinion: this is
    the same question the database pane answers when an entry is born under an
    active filter, and two copies of that rule would drift. So
    negations, comparisons, OR-lists, phrases and bare words seed nothing.

    Two things a fence needs on top of the pane's rule:
    - `type:`/`title:`/`created:` never seed — the create path owns those, and
      a fence's `type:` lives on its own line anyway;
    - values arrive lowercased from the parse, so a schema option that differs
      only in case is restored to the schema's spelling — a `status:mastering`
      fence seeds the declared "Mastering" rather than inventing a second
      casing of it. Same for the key. */
export function seedPropsFromQuery(
  query: string,
  typeSchema: Record<string, PropSchema> = {}
): [string, string][] {
  const parsed = parseQuery(query);
  // a committed fence query ends without trailing space, so the parse reads
  // its LAST term as a still-typing stub — merged back in the way
  // filterByQuery does, or the single-filter fence (the common one) would
  // seed nothing at all
  const t = parsed.trailing;
  const filters =
    t && t.partial && t.values.length === 0 && t.op === ":" && !t.neg
      ? [...parsed.filters, { key: t.key, values: [t.partial] }]
      : parsed.filters;
  const out: [string, string][] = [];
  for (const [key, value] of filterInherits(filters)) {
    if (isSystemPropName(key)) continue;
    const declared = foldedObjectKey(typeSchema, key) ?? key;
    const option = typeSchema[declared]?.options?.find(
      (o) => o.value.toLowerCase() === value
    )?.value;
    out.push([declared, option ?? value]);
  }
  return out;
}

/** Resolve a saved-view reference: exact id first, then name — both
    case-insensitive, so `umbra-unreleased` and `Umbra Unreleased`
    find the same pin. */
export function findSavedView(savedViews: SavedView[], ref: string): SavedView | undefined {
  const wanted = ref.trim().toLowerCase();
  return (
    savedViews.find((v) => v.id.toLowerCase() === wanted) ??
    savedViews.find((v) => v.name.toLowerCase() === wanted)
  );
}

/** Resolve a parsed spec against a vault snapshot into the widget's table
    model. Never throws — a parse error, an unknown database/saved reference
    and an empty spec all come back as quiet errors, so a caller can hand the
    `parseViewSpec` result straight in.

    Columns follow the database table's own set (dbColumns over every note of
    the type) — or the fence's own `columns:`, else the pin's own
    `columns` when a `saved:` view curates them — capped at
    EMBED_MAX_COLS.

    Rows are the query matches, ordered by `sort:` when the fence names one
    and otherwise in vault order, then cut. `total` always holds the full
    match count, before any cut; `cut` says which cut fired (see EmbedResult).
    Ordering runs BEFORE the cut, which is the only reading that makes
    `sort: released:desc` + `limit: 5` mean "the five newest". */
export function embedQueryFor(
  spec: ViewSpecResult,
  notes: NoteMeta[],
  schema: SchemaConfig,
  savedViews: SavedView[],
  // display caps default to the inline widget's; a full-page surface
  // (workbook view pages) passes wider ones
  caps: { cols: number; rows: number } = { cols: EMBED_MAX_COLS, rows: EMBED_MAX_ROWS }
): EmbedResult {
  if ("error" in spec) return { error: spec.error };
  let dbType = spec.type;
  let query = spec.query ?? "";
  let savedId: string | undefined;
  let savedName: string | undefined;
  let pin: SavedView | undefined;
  if (spec.saved !== undefined) {
    pin = findSavedView(savedViews, spec.saved);
    if (!pin) return { error: `Unknown saved view “${spec.saved.trim()}”` };
    dbType = pin.db;
    query = pin.query ?? "";
    savedId = pin.id;
    savedName = pin.name;
  }
  if (!dbType) return { error: "Add a type: or saved: line" };
  const foldedType = dbType.toLowerCase();
  const ofType = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === foldedType);
  // a database is real when the schema knows it or a note carries the type —
  // anything else is a typo and gets the quiet card
  // the fence's type and the schema's key are both hand-authored, so the
  // schema entry resolves case-insensitively — a mis-cased fence
  // must keep its schema-driven columns, kinds and formats instead of
  // silently falling back to no schema at all
  const declared = typeSchemaFor(schema, dbType);
  if (declared === undefined && ofType.length === 0) {
    return { error: `Unknown database “${dbType}”` };
  }
  // the same semantics as the database pane's filter bar (filterByQuery wraps
  // parseQuery/matchesFilters, trailing-stub and title-word matching included)
  const typeSchema = declared ?? {};
  const matched = query.trim() ? filterByQuery(ofType, query, undefined, typeSchema) : ofType;
  const dbCols = dbColumns(ofType, typeSchema);
  // Three sources for the column list, in falling authority: the fence's own
  // `columns:`, the pin's curated list, the full union.
  //
  // The fence's list is the only one that ERRORS on an unknown name. A pin's
  // list is persisted state that outlives prop renames, so a key falling out
  // of it stays a quiet drop; a fence's list is text the author is looking at
  // right now, and a silently-missing column there is just a wrong table.
  //
  // A dotted name MAY be a join — a lookup through the relation it
  // names rather than one of this database's own columns. A stored column of
  // that exact name wins first (`isJoinName`): frontmatter keys are allowed
  // to carry dots, and a vault already storing `v1.2` must keep rendering it.
  let resolver: JoinResolver | undefined;
  const resolveJoin = (name: string): ResolvedJoin | { error: string } => {
    resolver ??= joinResolverFor(notes, schema);
    return resolver.resolve(name, dbType as string, typeSchema);
  };
  let columns: string[];
  // Which columns are joins is decided HERE, as they're picked — never by
  // name-matching a resolved-joins map against the final column list. A
  // `sort:`-only join can share a name with a real column (`release.date`
  // stored on the base row while `release` is also a relation), and matching
  // by name would silently swap that stored column's value for the looked-up
  // one and mark the author's own prop read-only.
  let colJoins: (ResolvedJoin | undefined)[];
  if (spec.columns) {
    const picked: string[] = [];
    const pickedJoins: (ResolvedJoin | undefined)[] = [];
    const seen = new Set<string>();
    for (const name of spec.columns) {
      // Title is the table's fixed leading column, not a vault property. Let
      // authors include it in the natural left-to-right list without either
      // duplicating it or spending one of the optional-property slots.
      if (name.trim().toLowerCase() === "title") continue;
      if (isJoinName(name, dbCols)) {
        const join = resolveJoin(name);
        if ("error" in join) return { error: join.error };
        if (seen.has(join.name)) continue;
        seen.add(join.name);
        picked.push(join.name);
        pickedJoins.push(join);
        continue;
      }
      const canonical = canonicalColumn(dbCols, name);
      if (canonical === undefined) {
        return { error: `Unknown column “${name}” in “${dbType}”` };
      }
      // a name listed twice is one column, kept at its first position
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      picked.push(canonical);
      pickedJoins.push(undefined);
    }
    columns = picked;
    colJoins = pickedJoins;
  } else {
    // a pin's curated list and the default union are both made of this
    // database's own columns — nothing dotted is resolved through a relation
    columns = effectiveColumns(pin, dbCols);
    colJoins = columns.map(() => undefined);
  }
  // the cap is the surface's, not the author's — an explicit `columns:` list
  // is still bounded by what the surface can paint
  columns = columns.slice(0, caps.cols);
  colJoins = colJoins.slice(0, caps.cols);

  // Ordering: the fence's `sort:` runs through the table's own comparator
  // (dbsort), so a select column orders by its declared option order, a number
  // column numerically and a date column chronologically — exactly as clicking
  // that header in the database pane does. `title` is sortable without being a
  // column, same as there.
  //
  // A dotted `sort:` orders by the looked-up value under the TARGET
  // property's own kind. The joined values are materialized onto a shallow
  // props copy for every MATCHED row — before the cut, like every other sort
  // here, which is the only reading that makes `sort: release.date:desc` +
  // `limit: 5` mean "the five newest".
  let ordered = matched;
  if (spec.sort) {
    if (isJoinName(spec.sort.key, dbCols)) {
      const join = resolveJoin(spec.sort.key);
      if ("error" in join) return { error: join.error };
      const r = resolver as JoinResolver;
      // The looked-up value rides a THROWAWAY props copy used only for the
      // comparison — the rows handed back keep their own props, so a joined
      // column can never be mistaken for a stored one downstream, and sorting
      // by a lookup never adds it as a column. A row with nothing to look up
      // has the key absent, which sorts last in both directions (withRollups'
      // convention).
      const sortKey = joinSortKeyFor(r, join, spec.sort.dir);
      const keyed = matched.map((n) => {
        const v = sortKey(n);
        const props = { ...n.props };
        if (v === undefined) delete props[join.name];
        else props[join.name] = v;
        return { n, sortable: { ...n, props } };
      });
      const cmp = sortCmpFor([{ key: join.name, dir: spec.sort.dir }], joinSortSchema(join));
      if (cmp) keyed.sort((a, b) => cmp(a.sortable, b.sortable));
      ordered = keyed.map((k) => k.n);
    } else {
      const canonical =
        spec.sort.key.toLowerCase() === "title" ? "title" : canonicalColumn(dbCols, spec.sort.key);
      if (canonical === undefined) {
        return { error: `Unknown sort property “${spec.sort.key}” in “${dbType}”` };
      }
      const cmp = sortCmpFor([{ key: canonical, dir: spec.sort.dir }], typeSchema);
      if (cmp) ordered = [...matched].sort(cmp);
    }
  } else if (pin) {
    // A saved embed is the saved view in miniature. Preserve its persisted
    // multi-key order unless this fence/page supplies an explicit override.
    const pinSorts = pin.sorts ?? (pin.sort ? [pin.sort] : []);
    const cmp = sortCmpFor(pinSorts, typeSchema);
    if (cmp) ordered = [...matched].sort(cmp);
  }

  // The cut, after filtering and ordering. `limit` is the author's statement
  // about the table; `caps.rows` is the surface refusing to paint thousands of
  // rows inline. When both apply the tighter one wins, and `cut.kind` names
  // the one that actually fired — the row-count line reads differently for
  // each, and claiming a cap where the author wrote `limit: 5` (or the
  // reverse) is a lie about their own document.
  const allowed = Math.min(spec.limit ?? Infinity, caps.rows);
  const shown = Math.min(ordered.length, allowed);
  const cut =
    shown === ordered.length
      ? undefined
      : spec.limit !== undefined && spec.limit <= caps.rows
        ? ({ kind: "limit", shown } as const)
        : ({ kind: "cap", shown } as const);
  // cells go through the same displayValue pipeline as the database table
  // dates human, files/embeds by basename — created/updated are
  // date-kind unless the schema overrides, matching the table
  const kinds = columns.map((c, i) =>
    colJoins[i]
      ? undefined
      : byFoldedKey(typeSchema, c)?.kind ?? (isBuiltinDateName(c) ? "date" : undefined)
  );
  // a joined column's cells come from the target row, not this one,
  // and it is a join because it was PICKED as one — not because its name
  // happens to match one that resolved
  const joinNames = columns.filter((_, i) => colJoins[i] !== undefined);
  return {
    dbType,
    ...(savedId !== undefined ? { savedId, savedName } : {}),
    columns,
    ...(joinNames.length > 0 ? { joins: joinNames } : {}),
    total: matched.length,
    ...(cut !== undefined ? { cut } : {}),
    typeSchema,
    query,
    rows: ordered.slice(0, shown).map((n) => ({
      path: n.path,
      title: n.title,
      props: n.props,
      cells: columns.map((c, i) => {
        const join = colJoins[i];
        if (join) return (resolver as JoinResolver).cellText(n, join);
        const v = foldedPropStr(n.props, c) ?? "";
        // the dial, not de-DE: an embedded view sits beside the database pane
        // that renders the same rows, and two dialects on one screen is the
        // exact failure the single seam exists to prevent. Module
        // binding rather than a threaded prop because nothing threads props
        // into a fence snapshot; ViewWidget's identity carries the vault
        // epoch, which a Settings.md write bumps, so the fence repaints.
        return v
          ? displayValue(v, kinds[i], byFoldedKey(typeSchema, c)?.format, undefined, numberLocale())
          : "";
      }),
    })),
  };
}
