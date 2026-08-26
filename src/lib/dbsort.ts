import type { NoteMeta, PropSchema, SavedViewSort } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { parseStrictNumber } from "./aggregate.ts";
import { splitDayTime } from "./calendar.ts";
import { byFoldedKey } from "./schemalookup.ts";

/** Multi-key table sorts cap at three keys — past that the ordinal
    badges stop earning their header space. */
export const MAX_SORT_KEYS = 3;

/* One shared collator for every table sort. `a.localeCompare(b, undefined,
   {numeric, base})` constructs a fresh Intl.Collator per call — over a
   1400-row sort that's ~15k constructions, the top line in the keystroke
   profile (~45ms → ~5ms). Collator.compare with the same options
   is the specified semantics of that localeCompare call, so orderings are
   byte-identical. */
const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const collate = (a: string, b: string): number => sortCollator.compare(a, b);

/** A date-kind cell, normalized for ordering. The vault's date
    grammar accepts both separators — `2026-08-01T09:30` and `2026-08-01 09:30`
    are the same instant written two ways — but the collator sorts them by
    their raw text, and "T" lands after " ", so the earlier T-form fell BELOW a
    later space-form on the same day. Normalizing the separator makes the
    remaining comparison plain ISO order, which is already chronological.
    Values that aren't date-shaped pass through untouched; the comparator
    classifies them out before ever asking for a normalized form, so they
    collate among themselves behind every real date.

    A range sorts by its START: `splitDayTime` returns the opening
    endpoint, so a span and a single date on the same day sit together and the
    end never reorders the column. */
function normalizeDateSortValue(v: string): string {
  const split = splitDayTime(v);
  return split ? `${split.day} ${split.time ?? ""}` : v;
}

/** Lexicographic comparator over an ordered key list: compare by key 1,
    tie-break by key 2, and so on. Per key the single-sort semantics hold —
    missing values sort last in BOTH directions, strings compare with
    `localeCompare` (numeric, base sensitivity). Returns null for an empty
    list, so callers can skip the sort pass entirely.

    ONE POLICY for every typed key (number, rollup, select, date): a cell is first
    CLASSIFIED — orderable by the column's own scheme, or not — and only then
    compared. `dir` flips comparisons WITHIN a class; it never flips the
    classification. So descending means "the orderable rows reversed", with
    unorderable cells still behind them and genuinely-missing values still
    last, exactly like the missing-values rule one paragraph up. Untyped keys
    have a single class (everything collates), so there dir does flip the whole
    column, like localeCompare.

    With `typeSchema` given, a key naming a single-select prop
    (kindless schema entry with options — `PropKind` carries no "select";
    kind = undefined + options IS the discriminator, SelectMenu derives its
    draft kind the same way) compares by the value's index in
    `schema.options` (case-insensitive), the order dbgroup already groups by.
    Values outside the options list are the unorderable class: they follow all
    known options in both directions, lexicographic among themselves.
    Multi-kind and every other kind stay lexicographic; no schema (or a key
    without one) keeps the old behavior byte for byte.

    A key whose schema says `kind: "number"` compares by numeric VALUE, using
    the same `parseStrictNumber` coercion the table footer's Sum/Min/Max
    already agree with. The collator can't stand in for that: `numeric: true`
    compares each RUN of digits as an integer, so place value is lost after
    the decimal point (1299.5 lands before 1299.45 — .5 vs .45 reads as 5 vs
    45) and "-" is punctuation rather than a sign (negatives order by
    magnitude). A cell that isn't a number in a number column is the
    unorderable class here: it trails all numbers in both directions,
    collating among its own kind, and still precedes genuinely-missing
    values. */
export function sortCmpFor(
  sorts: SavedViewSort[],
  typeSchema?: Record<string, PropSchema>
): ((a: NoteMeta, b: NoteMeta) => number) | null {
  if (sorts.length === 0) return null;
  // key → (lowercase option value → option index), select keys only
  const optionOrder = new Map<string, Map<string, number>>();
  const numericKeys = new Set<string>();
  const dateKeys = new Set<string>();
  for (const { key } of sorts) {
    if (key === "title" || optionOrder.has(key) || numericKeys.has(key) || dateKeys.has(key))
      continue;
    const schema = byFoldedKey(typeSchema, key);
    // a rollup column sorts by its derived numeric value too — the
    // derivation feeds the same canonical strings the strict parser reads
    if (schema?.kind === "number" || schema?.kind === "rollup") {
      numericKeys.add(key);
      continue;
    }
    if (schema?.kind === "date") {
      dateKeys.add(key);
      continue;
    }
    // the type record also carries reserved metadata (icon/home) that is NOT
    // a PropSchema — require a real options array (DatabasePane filterHint)
    if (schema?.kind === undefined && Array.isArray(schema?.options) && schema.options.length > 0) {
      optionOrder.set(key, new Map(schema.options.map((o, i) => [o.value.toLowerCase(), i])));
    }
  }
  return (a, b) => {
    for (const { key, dir } of sorts) {
      const av = key === "title" ? a.title : foldedPropStr(a.props, key);
      const bv = key === "title" ? b.title : foldedPropStr(b.props, key);
      if (av === undefined && bv === undefined) continue; // tie — the next key decides
      if (av === undefined) return 1; // missing values sort last in both directions
      if (bv === undefined) return -1;
      const order = optionOrder.get(key);
      let c: number;
      if (dateKeys.has(key)) {
        const ad = splitDayTime(av);
        const bd = splitDayTime(bv);
        if (ad && bd) c = collate(normalizeDateSortValue(av), normalizeDateSortValue(bv));
        else if (ad) return -1; // dates before cells that aren't dates
        else if (bd) return 1;
        else c = collate(av, bv);
      } else if (numericKeys.has(key)) {
        const an = parseStrictNumber(av);
        const bn = parseStrictNumber(bv);
        if (an !== null && bn !== null) c = an < bn ? -1 : an > bn ? 1 : 0;
        else if (an !== null) return -1; // numbers before cells that aren't numbers
        else if (bn !== null) return 1;
        else c = collate(av, bv);
      } else if (order) {
        const ai = order.get(av.toLowerCase());
        const bi = order.get(bv.toLowerCase());
        if (ai !== undefined && bi !== undefined) c = ai - bi;
        else if (ai !== undefined) return -1; // known options before unschema'd values
        else if (bi !== undefined) return 1;
        else c = collate(av, bv);
      } else {
        c = collate(av, bv);
      }
      c *= dir;
      if (c !== 0) return c;
    }
    return 0;
  };
}

/** The resting order of a view with no active sort keys: by title,
    with the same locale collation as explicit sorts. Unlike the vault_list
    feed (updated_ms desc) it doesn't move when a prop edit bumps updated_ms,
    so a row never teleports out from under an edit. */
export const restingCmp = (a: NoteMeta, b: NoteMeta): number => collate(a.title, b.title);

/** The header-click state machine. Plain click (`additive` false) replaces
    the list: a fresh key starts asc as the only key; the lone active key
    cycles asc → desc → none. Shift-click (`additive`) keeps the existing
    keys: a key already in the list cycles its own dir (asc → desc → removed
    from the list); a new key appends asc, up to MAX_SORT_KEYS. */
export function cycleSortKeys(
  cur: SavedViewSort[],
  key: string,
  additive: boolean
): SavedViewSort[] {
  if (!additive) {
    if (cur.length === 1 && cur[0].key === key) {
      if (cur[0].dir === 1) return [{ key, dir: -1 }];
      return [];
    }
    return [{ key, dir: 1 }];
  }
  const i = cur.findIndex((s) => s.key === key);
  if (i === -1) {
    if (cur.length >= MAX_SORT_KEYS) return cur;
    return [...cur, { key, dir: 1 }];
  }
  if (cur[i].dir === 1) return cur.map((s, j) => (j === i ? { ...s, dir: -1 } : s));
  return cur.filter((_, j) => j !== i);
}
