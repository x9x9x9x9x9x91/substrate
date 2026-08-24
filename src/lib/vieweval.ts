/** One evaluation of a saved database view — the composition order the table
    pane paints, in one place.
 *
 *  Every step here already lived in a pure module (columns, rollups, filter,
 *  sort, grouping, cell display); what did NOT live anywhere was the ORDER
 *  they compose in, which was spelled out inside the pane's memo chain. A
 *  second reader of a saved view — an export, a headless verb — had to
 *  re-spell it, and a re-spelling drifts the day someone changes the pane.
 *  So the order lives here and the pane calls it. How far that reaches is
 *  worth stating plainly, because it is not yet the whole view: the COLUMN
 *  set (`viewColumns`) and the ROW ORDER, grouping included
 *  (`viewOrderedRows`), are shared code — the pane cannot drift from a
 *  headless reader on those without the shared function moving. The steps
 *  around them — the pane's own membership, filter and rollup chain versus
 *  `viewModel`/`viewRows` here — are still spelled twice and held together by
 *  the component test next to this file, which paints the pane and compares
 *  it cell for cell. Same eyes, then: by construction where it says so, by a
 *  test that would fail loudly everywhere else.
 *
 *  Pure TS: no DOM, no Tauri, no IPC. It runs inside the app, under
 *  `node --test`, and inside the headless view verb. Session inputs the app
 *  has and a headless reader does not — the live fx rates, the number
 *  locale, today's date — arrive as options rather than as imports, so the
 *  core never reaches for a browser.
 */

import type { DbLayout, NoteMeta, PropSchema, SavedView, SavedViewSort, ViewPref } from "./types.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import { canonicalViewPref, dbColumns, effectiveColumns, hiddenForLayout, orderedColumns } from "./dbcolumns.ts";
import { rollupColumns, rollupProps, withRollups } from "./rollup.ts";
import { filterByQuery } from "./views.ts";
import { restingCmp, sortCmpFor } from "./dbsort.ts";
import { groupKey, orderedGroups, tableGroupBy, tableGroups } from "./dbgroup.ts";
import { byFoldedKey, isBuiltinDateName } from "./schemalookup.ts";
import { displayValue } from "./display.ts";
import { propList } from "./relation.ts";
import { DEFAULT_NUMBER_LOCALE, type NumberLocale } from "./numberLocale.ts";
import type { FxResolver } from "./formula.ts";
import { todayIso } from "./dates.ts";

/** The identity of the evaluated-view payload, so a reader can tell what it
    is holding before it reads it. Bumped when the payload's shape changes in
    a way an existing reader cannot ignore. */
export const VIEW_EVAL_SCHEMA = "substrate.view/1";

/** What a database's rows look like before any view narrows them: the
    column union and the rows with derived columns folded in.
 *
 *  Split out from the rest so the pane can keep memoizing this half on
 *  `notes`/`typeSchema` alone — a keystroke in the filter bar must not
 *  recompute rollups over the whole vault. */
export interface ViewModel {
  columns: string[];
  /** The stored pref canonicalized against the live columns, or undefined. */
  pref: ViewPref | undefined;
  /** Rows with rollup columns derived — filtering happens over THESE, so a
      view whose query reads a rollup column matches what the table shows. */
  dispNotes: NoteMeta[];
}

/** Derive a database's columns and rollup-folded rows.
 *
 *  Rollups are derived over the database's own rows but looked up across
 *  `allNotes` — a rollup follows a relation out of its own database. */
export function viewModel(
  notes: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  allNotes: NoteMeta[] = notes,
  pref?: ViewPref
): ViewModel {
  const columns = dbColumns(notes, typeSchema);
  const rollups = rollupProps(typeSchema);
  const rolled = rollupColumns(notes, typeSchema, allNotes);
  return {
    columns,
    pref: pref ? canonicalViewPref(pref, columns) : undefined,
    dispNotes: rolled ? withRollups(notes, rolled, Object.keys(rollups)) : notes,
  };
}

/** The columns a table paints, from the union and the stored pref.
 *
 *  Pin mode is the difference that matters: a saved view carries its OWN
 *  curated column list and ignores the database's hidden-column prefs — a
 *  database is a living surface where a new prop shows by default, a pin is
 *  a capture where it does not. */
export function viewColumns(
  columns: string[],
  pref: ViewPref | undefined,
  opts: { pinMode?: boolean; layout?: DbLayout; columnSelection?: string[] | null } = {}
): string[] {
  const layout: DbLayout = opts.layout ?? pref?.view ?? "table";
  const visible = (): string[] => {
    // the hidden set is built once, not once per column: this runs on the
    // pane's render path
    const hidden = new Set(hiddenForLayout(pref, layout));
    return columns.filter((c) => !hidden.has(c));
  };
  const base = opts.pinMode
    ? opts.columnSelection
      ? effectiveColumns({ columns: opts.columnSelection }, columns)
      : columns
    : visible();
  return orderedColumns(base, pref?.col_order);
}

/** Where a grouped table's sections start and how long they run. */
export interface RowGroup {
  value: string | null;
  start: number;
  count: number;
  /** Section folded shut: its rows are absent from `rows` entirely, so
      `start` is where the NEXT section begins and the header stands alone
      there. `count` still counts the whole section — see `viewOrderedRows`. */
  collapsed: boolean;
}

/** Rows in painted order, plus the comparator that produced it.
 *
 *  Grouping sorts WITHIN each section: sections follow the group column's
 *  own order (schema options first, then extras, then the rows with no
 *  value), and the view's sort orders the rows inside them. An ungrouped
 *  table sorts the whole set. `rows` stays one flat sequence either way —
 *  keyboard nav, exports and headless readers address it by index.
 *
 *  The order is TOTAL: once the sort keys (or the resting title order) are
 *  exhausted, the note's path decides. Without that last key a run of rows
 *  sharing a sort value would keep whatever order the input arrived in —
 *  and the input order is not a property of the view: the pane is handed the
 *  index's order and mutates it as rows are edited, while a file reader
 *  walks the folder. Same view, two orders, neither wrong. Path is the one
 *  key both readers hold and no edit moves.
 *
 *  `arrange` lets the pane re-order each sorted run AFTER the sort — the
 *  sub-item tree interleaves parents and children, and a collapsed parent
 *  takes its children off screen. It returns two orders: `shown` is what is
 *  painted (`rows`), `full` is the same arrangement with every fold opened
 *  (`fullRows`) — folding is a view state, so exports, footer tallies and a
 *  grouped section's header `count` all read the full order. Headless
 *  readers pass no `arrange` and get the sorted order in both. */
export function viewOrderedRows(
  visible: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  opts: {
    sorts?: SavedViewSort[];
    layout?: DbLayout;
    tableGroup?: string;
    /** hand-dragged section order, section values in the order they sit in */
    groupOrder?: string[];
    /** sections folded shut, by section value (`""` = the "No …" section) */
    collapsedGroups?: readonly string[];
    arrange?: (ns: NoteMeta[]) => { shown: NoteMeta[]; full: NoteMeta[] };
  } = {}
): {
  cmp: (a: NoteMeta, b: NoteMeta) => number;
  rows: NoteMeta[];
  fullRows: NoteMeta[];
  rowGroups: RowGroup[] | null;
} {
  const keyed = sortCmpFor(opts.sorts ?? [], typeSchema) ?? restingCmp;
  const cmp = (a: NoteMeta, b: NoteMeta): number =>
    keyed(a, b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const apply = (ns: NoteMeta[]): NoteMeta[] => [...ns].sort(cmp);
  const arrange = opts.arrange ?? ((ns: NoteMeta[]) => ({ shown: ns, full: ns }));
  const layout: DbLayout = opts.layout ?? "table";
  if (layout !== "table" || !opts.tableGroup) {
    const one = arrange(apply(visible));
    return { cmp, rows: one.shown, fullRows: one.full, rowGroups: null };
  }
  const rowGroups: RowGroup[] = [];
  const rows: NoteMeta[] = [];
  const fullRows: NoteMeta[] = [];
  const options = byFoldedKey(typeSchema, opts.tableGroup)?.options ?? [];
  const collapsed = new Set((opts.collapsedGroups ?? []).map(groupKey));
  const sections = orderedGroups(
    tableGroups(visible, opts.tableGroup, options, typeSchema),
    opts.groupOrder
  );
  for (const g of sections) {
    const sorted = arrange(apply(g.notes));
    const shut = collapsed.has(groupKey(g.value));
    // `start` indexes `rows` (the painted sequence, so the geometry and the
    // header's position stay exact); `count` is the section's FULL size — a
    // fold is a view state, and a header count that shrank while the footer
    // tally beside it held would put two disagreeing counts of the same
    // notes on one screen. A collapsed section contributes no painted rows,
    // so its `start` is the index its successor starts at too — the header
    // still belongs before that row, and several headers can share one.
    rowGroups.push({ value: g.value, start: rows.length, count: sorted.full.length, collapsed: shut });
    if (!shut) rows.push(...sorted.shown);
    // `fullRows` ignores the fold exactly as it ignores a tree fold: the
    // footer tally and the exports answer for the whole section either way
    fullRows.push(...sorted.full);
  }
  return { cmp, rows, fullRows, rowGroups };
}

/** The session inputs a view's rows depend on beyond the stored pref. */
export interface ViewRowsOptions {
  layout?: DbLayout;
  /** The filter-bar text. A saved view's own query arrives here. */
  query?: string;
  /** Pin mode: a saved view carries its own column list and ignores the
      database's hidden-column prefs. */
  pinMode?: boolean;
  /** The pin's column selection, when it has one. */
  columnSelection?: string[] | null;
  /** Reference day for date comparisons in the query. */
  today?: string;
  /** Sort keys, when the caller holds them outside the pref. */
  sorts?: SavedViewSort[];
}

/** A view's rows, in painted order, with the section boundaries a grouped
    table draws. */
export interface ViewRows {
  /** Columns the table renders, after hiding and ordering. */
  shown: string[];
  /** Rows the query kept, before sorting. */
  visible: NoteMeta[];
  /** The row comparator in force — the view's sort keys, else resting order. */
  cmp: (a: NoteMeta, b: NoteMeta) => number;
  /** The column the table groups by, when the pref still names a groupable one. */
  tableGroup: string | undefined;
  rows: NoteMeta[];
  rowGroups: RowGroup[] | null;
}

/** Narrow, sort and group a model's rows — the whole sequence the table pane
 *  walks, in the order it walks it: columns, then grouping key, then the
 *  query over the rollup-folded rows, then the sort.
 *
 *  The filter runs over `dispNotes` rather than the raw notes on purpose: a
 *  view whose query reads a rollup column would otherwise match nothing. */
export function viewRows(
  model: ViewModel,
  typeSchema: Record<string, PropSchema>,
  opts: ViewRowsOptions = {}
): ViewRows {
  const layout: DbLayout = opts.layout ?? model.pref?.view ?? "table";
  const shown = viewColumns(model.columns, model.pref, {
    pinMode: opts.pinMode,
    layout,
    columnSelection: opts.columnSelection,
  });
  const tableGroup = tableGroupBy(model.columns, typeSchema, model.pref?.table_group_by);
  const visible = filterByQuery(model.dispNotes, opts.query ?? "", opts.today, typeSchema);
  const { cmp, rows, rowGroups } = viewOrderedRows(visible, typeSchema, {
    sorts: opts.sorts ?? model.pref?.sorts ?? [],
    layout,
    tableGroup,
    // the hand-dragged section order is part of the stored view, so a
    // headless reader reports the sections in the order the pane paints
    // them. The FOLD set deliberately is not: a fold is a UI state, and a
    // reader that dropped folded rows would answer for less than the view
    // holds.
    groupOrder: model.pref?.group_order,
  });
  return { shown, visible, cmp, tableGroup, rows, rowGroups };
}

/** One cell of an evaluated row: what is stored, and what the table paints. */
export interface ViewCell {
  /** The stored value as the table reads it — raw, never reshaped. */
  raw: string;
  /** The painted string: dates humanized, numbers in the display dialect. */
  display: string;
  kind?: string;
  /** The individual entries of a multi/relation cell, which the table paints
      as separate chips rather than as one string. */
  values?: string[];
}

export interface ViewRow {
  path: string;
  title: string;
  folder: string;
  cells: Record<string, ViewCell>;
}

export interface ViewGroup {
  /** The group's stored value, null for the rows that have none. */
  value: string | null;
  /** The section header as the table draws it, count excluded. */
  label: string;
  count: number;
  rows: ViewRow[];
}

/** A saved view, evaluated. */
export interface EvaluatedView {
  schema: typeof VIEW_EVAL_SCHEMA;
  view: { id: string; name: string; db: string; query: string };
  columns: string[];
  sorts: SavedViewSort[];
  group_by: string | null;
  total: number;
  groups: ViewGroup[];
  rows: ViewRow[];
}

export interface EvaluateOptions {
  /** The vault's whole note set, when the database's rows are a slice of it —
      rollups follow relations out of the database. */
  allNotes?: NoteMeta[];
  /** The database's stored display pref, for column order and grouping. */
  pref?: ViewPref;
  today?: string;
  fx?: FxResolver;
  locale?: NumberLocale;
}

/** The rows a saved view stands for and the cells it paints.
 *
 *  `notes` may be the whole vault: membership is decided here, the way the
 *  app decides it — a note belongs to the view's database when its `type`
 *  matches case-insensitively. */
/** A saved view's own display pref: its stored layout, grouping and sorts
    over the database's, and its sorts NEVER falling back to it — a pin with
    no sort keys rests, it does not inherit whatever the database was last
    sorted by.
 *
 *  The keys the database contributes are listed one by one rather than
 *  spread: a pin is a capture, so the database's CURATION — its hidden sets
 *  and its dragged column order — must not reach it, while the presentation
 *  keys nobody captures per pin (footer aggregations, column widths, wrap,
 *  the grid override) do follow the database. Spreading the whole pref
 *  would quietly hand a pin the column order of whoever last dragged a
 *  header. This is the one spelling of that composition: the pane calls it
 *  too, so pin mode on screen and pin mode headless cannot disagree. */
export function savedViewPref(view: SavedView, dbPref?: ViewPref): ViewPref {
  return {
    view: view.view ?? dbPref?.view ?? "table",
    group_by: view.group_by ?? dbPref?.group_by,
    table_group_by: view.table_group_by ?? dbPref?.table_group_by,
    aggregations: dbPref?.aggregations,
    sorts: view.sorts ?? (view.sort ? [view.sort] : []),
    widths: dbPref?.widths,
    wrap: dbPref?.wrap,
    grid: dbPref?.grid,
  };
}

/** A saved view's rows, evaluated but not yet rendered into cells — the step
    every reader of a pin shares, whether it paints a table, exports a link
    folder or prints the view headless.
 *
 *  Membership is decided here the way the app decides it: a note belongs to
 *  the view's database when its `type` matches case-insensitively, so
 *  `notes` may be the whole vault. */
export function savedViewRowSet(
  view: SavedView,
  notes: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  opts: EvaluateOptions = {}
): { pref: ViewPref; model: ViewModel; evaluated: ViewRows } {
  const db = view.db.toLowerCase();
  const typed = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === db);
  const pref = savedViewPref(view, opts.pref);
  const model = viewModel(typed, typeSchema, opts.allNotes ?? notes, pref);
  const evaluated = viewRows(model, typeSchema, {
    layout: "table",
    query: view.query ?? "",
    pinMode: true,
    columnSelection: view.columns ?? null,
    today: opts.today ?? todayIso(),
  });
  return { pref, model, evaluated };
}

export function evaluateSavedView(
  view: SavedView,
  notes: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  opts: EvaluateOptions = {}
): EvaluatedView {
  const { pref, evaluated } = savedViewRowSet(view, notes, typeSchema, opts);

  const locale = opts.locale ?? DEFAULT_NUMBER_LOCALE;
  const cellsFor = (n: NoteMeta): Record<string, ViewCell> => {
    const cells: Record<string, ViewCell> = {};
    for (const c of evaluated.shown) {
      const actualKey = foldedPropKey(n.props, c);
      const raw = foldedPropStr(n.props, c) ?? "";
      const cschema = byFoldedKey(typeSchema, c);
      const kind = cschema?.kind ?? (isBuiltinDateName(c) ? "date" : undefined);
      const cell: ViewCell = {
        raw,
        display: displayValue(raw, kind, cschema?.format, opts.fx, locale),
      };
      if (kind) cell.kind = kind;
      if (kind === "multi" || kind === "relation") cell.values = propList(n.props, actualKey);
      cells[c] = cell;
    }
    return cells;
  };
  const rowFor = (n: NoteMeta): ViewRow => ({
    path: n.path,
    title: n.title,
    folder: n.folder,
    cells: cellsFor(n),
  });

  const rows = evaluated.rows.map(rowFor);
  const groupSchema = evaluated.tableGroup ? byFoldedKey(typeSchema, evaluated.tableGroup) : undefined;
  const groups: ViewGroup[] = (evaluated.rowGroups ?? []).map((g) => ({
    value: g.value,
    // the section header the table draws: the value as a cell would paint it,
    // and the same "No <column>" wording for the rows that have none
    label:
      g.value === null
        ? `No ${evaluated.tableGroup}`
        : displayValue(g.value, groupSchema?.kind, groupSchema?.format, opts.fx, locale),
    count: g.count,
    rows: rows.slice(g.start, g.start + g.count),
  }));

  return {
    schema: VIEW_EVAL_SCHEMA,
    view: { id: view.id, name: view.name, db: view.db, query: view.query ?? "" },
    columns: evaluated.shown,
    sorts: pref.sorts ?? [],
    group_by: evaluated.tableGroup ?? null,
    total: rows.length,
    groups,
    rows,
  };
}
