/** Rollup columns: a rollup prop derives its value from the rows a
    relation prop of the SAME database links to — follow `relation`, read
    `prop` on each linked row, fold with `agg` (the footer Calculate's
    vocabulary, src/lib/aggregate.ts). Computed on read, stored nowhere: the
    derivation here runs against the in-memory note set and folds the results
    into the database pane's display model, so no frontmatter value ever
    lands and every downstream surface (filter, sort, footer, CSV) sees the
    column through the one prop-value path.

    Matching mirrors related() and the rename sweep — which retargets both
    `relation` and, across databases, `prop` with the
    same case-folding: the related database is
    matched case-insensitively by `type:`, its rows by title OR stem,
    case-insensitive and trimmed — two rows sharing a title are
    indistinguishable, the first wins. A dangling value (a trashed or
    renamed-away target) links nothing and is skipped. Rollups read STORED
    values only — a rollup naming another rollup as its target prop reads
    nothing, since derived values never land in props. */

import type { NoteMeta, PropSchema, RollupConfig } from "./types.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import { aggregate } from "./aggregate.ts";
import { propList } from "./relation.ts";

/** The rollup props a database's schema declares, name → wiring. A
    half-written entry (hand-edited schema.json missing a field) is skipped —
    it reads as "no usable rollup", never as an error. The reserved
    icon/home keys ride the same record and fail the kind check. */
export function rollupProps(typeSchema: Record<string, PropSchema>): Record<string, RollupConfig> {
  const out: Record<string, RollupConfig> = {};
  for (const [name, ps] of Object.entries(typeSchema)) {
    if (ps?.kind !== "rollup" || !ps.relation || !ps.prop || !ps.agg) continue;
    out[name] = { relation: ps.relation, prop: ps.prop, agg: ps.agg };
  }
  return out;
}

/** One number as a canonical dot-decimal cell string — the form the shared
    `parseStrictNumber` coercion reads back, so a rollup column can itself be
    footer-aggregated and numerically sorted. JS prints extreme magnitudes in
    exponent notation, which the strict parser deliberately rejects; those
    collapse through toFixed (a magnitude no vault number reaches either
    way). */
function canonicalNumber(n: number): string {
  const s = String(n);
  if (!/[eE]/.test(s)) return s;
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/** Derive every rollup column for the notes of one database. Returns null
    when the database declares no rollup props — the zero-cost bail callers
    key on, so vaults without rollups never pay for the derivation. Otherwise
    a per-row map: path → (rollup prop → canonical number string); a prop
    ABSENT from the inner record means "no value" (an empty aggregation —
    the footer's label-without-value convention), rendered as a missing
    cell. `notes` are the database's own rows; `allNotes` is the vault-wide
    set the linked rows come from; `typeSchema` is the database's own schema
    slice — the relation's target type is schema-driven, and the pane holds
    it already, so no wider schema lookup is needed. */
export function rollupColumns(
  notes: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  allNotes: NoteMeta[]
): Map<string, Record<string, string>> | null {
  const rollups = rollupProps(typeSchema);
  const names = Object.keys(rollups);
  if (names.length === 0) return null;

  // the linked-row lookup, built once per related database: lowercased
  // title/stem → the note it names (the related()/rename-sweep matching)
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

  const out = new Map<string, Record<string, string>>();
  for (const n of notes) {
    let rec: Record<string, string> | undefined;
    for (const name of names) {
      const cfg = rollups[name];
      // the relation to follow, resolved case-folded like every schema read
      // — but keyed by its CANONICAL schema name: relation values are read
      // from the row's props by schema-key casing, exactly like the table's
      // own relation column does. Anything but a relation-kind prop links
      // no rows
      const relEntry =
        Object.entries(typeSchema).find(([k]) => k === cfg.relation) ??
        Object.entries(typeSchema).find(
          ([k]) => k.toLowerCase() === cfg.relation.toLowerCase()
        );
      const relSchema = relEntry?.[1];
      const targetType = relSchema?.kind === "relation" ? relSchema.type : undefined;
      if (!relEntry || !targetType) continue;
      const targets = targetMapFor(targetType);
      const values: string[] = [];
      for (const v of propList(n.props, foldedPropKey(n.props, relEntry[0]))) {
        const t = targets.get(v.trim().toLowerCase());
        // fold like the table's own cell read — hand-cased
        // frontmatter must feed the rollup exactly as it renders
        if (t) values.push(foldedPropStr(t.props, cfg.prop) ?? "");
      }
      // the footer's own convention: sum/avg/min/max over zero numeric
      // inputs read as no value; count always has one (zero links → 0)
      const r = aggregate(cfg.agg, values);
      if (r !== null) (rec ??= {})[name] = canonicalNumber(r);
    }
    if (rec) out.set(n.path, rec);
  }
  return out;
}

/** Fold derived rollup values into a row set for display. Each note gets a
    shallow props copy with the derived strings set — a hand-authored value
    stored under the rollup's name is overridden (the column is computed,
    stored nowhere), and a note with no derived value has the key DELETED so
    it reads as genuinely missing (sorts last, renders blank), not as an
    empty string. Notes no rollup touches keep their identity. */
export function withRollups(
  notes: NoteMeta[],
  rolled: Map<string, Record<string, string>>,
  names: string[]
): NoteMeta[] {
  return notes.map((n) => {
    const rec = rolled.get(n.path);
    let props: Record<string, unknown> | undefined;
    for (const name of names) {
      const v = rec?.[name];
      if (v !== undefined) {
        if (n.props[name] === v) continue;
        (props ??= { ...n.props })[name] = v;
      } else if (name in n.props) {
        props ??= { ...n.props };
        delete props[name];
      }
    }
    return props ? { ...n, props } : n;
  });
}
