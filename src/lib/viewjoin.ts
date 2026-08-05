/** View-fence joins (SUB-829): a dotted `relation.prop` name inside a ```view
    fence's `columns:` or `sort:` shows a stored property of the row this
    row's relation names — "the date of the release this master points at".
    Where a rollup (SUB-678) folds MANY linked rows into one number, a join
    lines up ONE linked row's stored value beside the base row. Rows never
    multiply: a join only ever adds a column.

    The resolution rules are the rollup's, verbatim: the target database is
    matched case-insensitively by `type:`, its rows by title OR stem,
    case-insensitive and trimmed — two rows sharing a title are
    indistinguishable, the first wins. A dangling value (a trashed or
    renamed-away target) links nothing. Joins read STORED values only, so a
    join naming a rollup prop reads nothing, exactly as a rollup naming
    another rollup does.

    Missing data is never an error: no relation value, a dangling target, or a
    target row without the property all render as a blank cell. So does a
    property the target database can't vouch for either way — a target type
    with no schema has no vocabulary to call a name wrong with. Errors are
    reserved for authoring mistakes the vault can actually prove: a base prop
    that isn't a relation, a name a SCHEMA'd target doesn't declare or hold,
    and more than one hop.

    Pure TS, no DOM/node imports: runs in the app and under `node --test`. */

import { canonicalColumn, dbColumns } from "./dbcolumns.ts";
import { sortCmpFor } from "./dbsort.ts";
import { displayValue } from "./display.ts";
import { propList } from "./relation.ts";
import {
  isBuiltinDateName,
  isReservedSchemaName,
  isSystemPropName,
  typeSchemaFor,
} from "./schemalookup.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import type { NoteMeta, PropSchema, SchemaConfig } from "./types.ts";

/** Is this fence name a join — a dot to follow — or this database's own
    column that merely has a dot in it?

    Nothing forbids a dot in a vault property name. Frontmatter is hand-written
    YAML and a key like `v1.2` is perfectly legal there; the charclass that
    excludes `.` belongs to the QUERY grammar (src/lib/query.ts), which governs
    filter tokens, not stored keys. So the dot alone can't decide: a stored
    column always wins, and only a dotted name this database does NOT have is
    read as `relation.property`. A join is the fallback meaning of a dot, never
    its first one — otherwise adding this feature would have broken every vault
    already storing a dotted key. */
export const isJoinName = (name: string, dbCols: string[]): boolean =>
  name.includes(".") && canonicalColumn(dbCols, name) === undefined;

/** A resolved one-hop lookup. */
export interface ResolvedJoin {
  /** the canonical `relation.prop` spelling this column renders under */
  name: string;
  /** the relation prop's canonical schema key on the base database */
  rel: string;
  /** the relation's target database type */
  targetType: string;
  /** the looked-up property's canonical name on the target database. `title`
      resolves here too: the target row's display name is a value that
      database sorts by without it being a column, and a lookup reads it the
      same way. */
  prop: string;
  /** the target property's schema entry, when the target type declares one */
  schema: PropSchema | undefined;
}

export type JoinResult = ResolvedJoin | { error: string };

export interface JoinResolver {
  /** Resolve a dotted name against the base database, or say what's wrong
      with it. Errors travel as values into the fence's existing quiet card. */
  resolve(
    name: string,
    dbType: string,
    typeSchema: Record<string, PropSchema>
  ): JoinResult;
  /** The stored target values for one base row, in the relation's stored
      order. Empty for every missing-data condition. */
  rawValues(n: NoteMeta, join: ResolvedJoin): string[];
  /** The row's cell text: each looked-up value through the same
      `displayValue` pipeline the target database's own table uses, several
      values comma-joined in stored order. */
  cellText(n: NoteMeta, join: ResolvedJoin): string;
}

/** A join resolver over one vault snapshot. Target maps and target column
    sets are built lazily, once per referenced target database, and live only
    as long as this resolver — the render is single-pass and nothing is
    memoized across renders, exactly like the rollup derivation. */
export function joinResolverFor(allNotes: NoteMeta[], schema: SchemaConfig): JoinResolver {
  // lowercased title/stem → the note it names (the rollup/rename-sweep matching)
  const targetMaps = new Map<string, Map<string, NoteMeta>>();
  const targetMapFor = (targetType: string): Map<string, NoteMeta> => {
    const key = targetType.toLowerCase();
    let map = targetMaps.get(key);
    if (!map) {
      map = new Map<string, NoteMeta>();
      for (const n of allNotes) {
        if ((foldedPropStr(n.props, "type") ?? "").toLowerCase() !== key) continue;
        const title = n.title.trim().toLowerCase();
        const stem = n.stem.trim().toLowerCase();
        if (title && !map.has(title)) map.set(title, n);
        if (stem && !map.has(stem)) map.set(stem, n);
      }
      targetMaps.set(key, map);
    }
    return map;
  };

  // the target database's own column union — the same set its table shows, so
  // "does that property exist over there" is one question with one answer
  const targetCols = new Map<
    string,
    { cols: string[]; schema: Record<string, PropSchema>; declares: boolean }
  >();
  const targetColsFor = (targetType: string) => {
    const key = targetType.toLowerCase();
    let entry = targetCols.get(key);
    if (!entry) {
      const ts = typeSchemaFor(schema, targetType) ?? {};
      const rows = allNotes.filter(
        (n) => (foldedPropStr(n.props, "type") ?? "").toLowerCase() === key
      );
      // Does this database declare a vocabulary at all? `icon`/`home` are
      // reserved schema keys and `type`/`title`/`created` are system-owned —
      // a schema entry holding only those has named no properties, so it
      // can't call a lookup name wrong.
      const declares = Object.keys(ts).some(
        (k) => !isReservedSchemaName(k) && !isSystemPropName(k)
      );
      entry = { cols: dbColumns(rows, ts), schema: ts, declares };
      targetCols.set(key, entry);
    }
    return entry;
  };

  return {
    resolve(name, dbType, typeSchema): JoinResult {
      const parts = name.split(".").map((p) => p.trim());
      if (parts.length > 2) {
        return { error: `“${name}” goes more than one hop — a join follows one relation` };
      }
      if (parts.some((p) => p === "")) {
        return { error: `Malformed column “${name}” — want relation.property` };
      }
      const [relRaw, propRaw] = parts;
      // the relation to follow, resolved case-folded like every schema read —
      // but keyed by its CANONICAL schema name, since relation values are read
      // from the row's props by schema-key casing (the rollup's rule)
      const relEntry =
        Object.entries(typeSchema).find(([k]) => k === relRaw) ??
        Object.entries(typeSchema).find(([k]) => k.toLowerCase() === relRaw.toLowerCase());
      const relSchema = relEntry?.[1];
      if (!relEntry || relSchema?.kind !== "relation") {
        return { error: `“${relRaw}” isn't a relation property on “${dbType}”` };
      }
      const targetType = relSchema.type;
      if (!targetType) {
        return { error: `“${relEntry[0]}” names no target database on “${dbType}”` };
      }
      const { cols, schema: targetSchema, declares } = targetColsFor(targetType);
      // `title` is the target row's display name — not one of its props, and
      // so not in `cols`, exactly as it isn't a column of that database's own
      // table. It still sorts and reads over there, so a lookup resolves it.
      if (propRaw.toLowerCase() === "title") {
        return {
          name: `${relEntry[0]}.title`,
          rel: relEntry[0],
          targetType,
          prop: "title",
          schema: undefined,
        };
      }
      const prop = canonicalColumn(cols, propRaw);
      if (prop === undefined) {
        // A name the target can't vouch for is an authoring error ONLY when
        // that database has a vocabulary to be wrong against: a declared
        // schema. Without one — a schemaless type, or one whose rows are all
        // still empty — "no such property" and "nobody has filled it in yet"
        // are the same observation, and a data condition is never an error.
        // Blank cells; the column appears and fills itself as rows arrive.
        if (declares) {
          return { error: `Unknown property “${propRaw}” on “${targetType}”` };
        }
        return {
          name: `${relEntry[0]}.${propRaw}`,
          rel: relEntry[0],
          targetType,
          prop: propRaw,
          schema: undefined,
        };
      }
      return {
        name: `${relEntry[0]}.${prop}`,
        rel: relEntry[0],
        targetType,
        prop,
        schema: targetSchema[prop],
      };
    },

    rawValues(n, join) {
      const targets = targetMapFor(join.targetType);
      const out: string[] = [];
      for (const v of propList(n.props, foldedPropKey(n.props, join.rel))) {
        const t = targets.get(v.trim().toLowerCase());
        // a dangling value links nothing; a target without the property
        // contributes nothing — both are blank, never an error
        if (!t) continue;
        // `title` is the row's display name, not a prop — read it the way
        // that database's own table does
        if (join.prop === "title") {
          const title = t.title.trim();
          if (title) out.push(title);
          continue;
        }
        // fold like the target table's own cell read — hand-cased frontmatter
        // must feed the join exactly as it renders over there
        const s = foldedPropStr(t.props, join.prop);
        if (s) out.push(s);
      }
      return out;
    },

    cellText(n, join) {
      const kind = join.schema?.kind ?? (isBuiltinDateName(join.prop) ? "date" : undefined);
      return this.rawValues(n, join)
        .map((v) => displayValue(v, kind, join.schema?.format))
        .filter((v) => v !== "")
        .join(", ");
    },
  };
}

/** The sort key for one base row, built once per sort rather than per row.

    A scalar relation (the common case) sorts by its target's own value under
    the target property's kind — a date chronologically, a number numerically,
    a select by declared option order.

    A relation holding SEVERAL values sorts by whichever of them ranks best in
    the direction being sorted: the newest date under `:desc`, the oldest
    under `:asc`. Comma-joining them and sorting the joined string — which is
    what a naive reading gives — makes a row that holds the newest release
    sort as if it held nothing, because "2026-07-04, 2026-01-15" is not a
    date. Display still shows every value, comma-joined in stored order; only
    the ORDERING collapses to one. "Best" is decided by the very comparator
    the column sorts under, so a value that doesn't parse ranks exactly as it
    would if the relation held it alone.

    Undefined when there is nothing to look up, which sorts last in both
    directions. */
export function joinSortKeyFor(
  resolver: JoinResolver,
  join: ResolvedJoin,
  dir: 1 | -1
): (n: NoteMeta) => string | undefined {
  const cmp = sortCmpFor([{ key: join.name, dir }], joinSortSchema(join));
  const rank = (a: string, b: string): number =>
    cmp === null
      ? 0
      : cmp(
          { props: { [join.name]: a } } as unknown as NoteMeta,
          { props: { [join.name]: b } } as unknown as NoteMeta
        );
  return (n) => {
    const values = resolver.rawValues(n, join);
    if (values.length === 0) return undefined;
    // the value that would sort FIRST in this direction, i.e. the one that
    // decides where the row lands
    return values.reduce((best, v) => (rank(v, best) < 0 ? v : best));
  };
}

/** The schema slice the table comparator should sort a joined column under:
    the TARGET property's own entry, so ordering matches that database's
    table. Built-in date names keep their date identity without a schema. */
export function joinSortSchema(join: ResolvedJoin): Record<string, PropSchema> {
  if (join.schema) return { [join.name]: join.schema };
  if (isBuiltinDateName(join.prop)) return { [join.name]: { options: [], kind: "date" } };
  return {};
}
