// View embeds (SUB-86): a ```view fence inside a note body renders a read-only
// inline database table in the editor — the hub-page primitive. Config is
// hand-editable key: value text, one per line:
//
//   ```view
//   type: release              # a database type
//   query: status:unreleased   # the SUB-7 filter-bar language (optional)
//   view: table                # accepted; only table renders in v1
//   ```
//
// or the one-key saved form, referencing a pinned view by id (or name):
//
//   ```view
//   saved: umbra-unreleased
//   ```
//
// Unknown keys are ignored. Malformed/unknown references render as a quiet
// inline error card, never a crash. The fence is plain markdown — the widget
// snapshot rebuilds on doc edits/remounts and on every vault change (the
// vault epoch rides the widget identity, SUB-122).
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { dbColumns, effectiveColumns } from "./dbcolumns.ts";
import { displayValue } from "./display.ts";
import { byFoldedKey, isBuiltinDateName, typeSchemaFor } from "./schemalookup.ts";
import { filterByQuery } from "./views.ts";
import { foldedPropStr } from "./types.ts";
import type { NoteMeta, SavedView, SchemaConfig } from "./types.ts";

/** The spec a ```view fence declares — every key optional, unknown keys dropped. */
export interface EmbedSpec {
  type?: string;
  query?: string;
  saved?: string;
  /** accepted but v1 renders table regardless */
  view?: string;
}

export interface EmbedRow {
  path: string;
  title: string;
  /** display strings, aligned 1:1 with `columns` */
  cells: string[];
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
    }
  | { error: string };

/** Display caps: the title column plus the first N data columns, at most M rows. */
export const EMBED_MAX_COLS = 4;
export const EMBED_MAX_ROWS = 50;

const KEY_RE = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/;

/** Parse one fence body into its spec. Never throws — unknown keys and
    malformed lines are ignored, so a half-typed fence is simply an empty spec. */
export function parseViewSpec(inner: string): EmbedSpec {
  const spec: EmbedSpec = {};
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = KEY_RE.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    switch (m[1].toLowerCase()) {
      case "type":
        if (value) spec.type = value;
        break;
      case "query":
        if (value) spec.query = value;
        break;
      case "saved":
        if (value) spec.saved = value;
        break;
      case "view":
        if (value) spec.view = value;
        break;
      // unknown keys ignored (forward-compat)
    }
  }
  return spec;
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
    model. Never throws — unknown database/saved references and empty specs
    come back as quiet errors. Columns follow the database table's own set
    (dbColumns over every note of the type) — or the pin's own `columns` when
    a `saved:` view curates them (SUB-212) — capped at EMBED_MAX_COLS; rows
    are the query matches in vault order, capped at EMBED_MAX_ROWS with
    `total` holding the full count. */
export function embedQueryFor(
  spec: EmbedSpec,
  notes: NoteMeta[],
  schema: SchemaConfig,
  savedViews: SavedView[],
  // display caps default to the inline widget's; a full-page surface
  // (workbook view pages, SUB-464) passes wider ones
  caps: { cols: number; rows: number } = { cols: EMBED_MAX_COLS, rows: EMBED_MAX_ROWS }
): EmbedResult {
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
  // schema entry resolves case-insensitively (SUB-696) — a mis-cased fence
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
  // a pin with curated columns (SUB-212) renders those — its order, unknown
  // keys dropped — instead of the union; either way capped for the widget
  const columns = effectiveColumns(pin, dbColumns(ofType, typeSchema)).slice(0, caps.cols);
  // cells go through the same displayValue pipeline as the database table
  // (SUB-179): dates human, files/embeds by basename — created/updated are
  // date-kind unless the schema overrides, matching the table (SUB-167)
  const kinds = columns.map(
    (c) =>
      byFoldedKey(typeSchema, c)?.kind ??
      (isBuiltinDateName(c) ? "date" : undefined)
  );
  return {
    dbType,
    ...(savedId !== undefined ? { savedId, savedName } : {}),
    columns,
    total: matched.length,
    rows: matched.slice(0, caps.rows).map((n) => ({
      path: n.path,
      title: n.title,
      cells: columns.map((c, i) => {
        const v = foldedPropStr(n.props, c) ?? "";
        return v ? displayValue(v, kinds[i], byFoldedKey(typeSchema, c)?.format) : "";
      }),
    })),
  };
}
