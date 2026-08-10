import type { NumberLocale } from "../lib/numberLocale";
import { Fragment } from "react";
import type { AggKind, NoteMeta, NumberFormat, PropKind, PropSchema, RollupConfig, SavedViewSort, SelectOption } from "../lib/types";
import { foldedPropKey, foldedPropStr } from "../lib/types";
import { aggMarker, aggregationKind, formatAgg, type UnitAgg } from "../lib/aggregate";
import { audioFileTarget, conversionNote, displayColLabel, displayValue } from "../lib/display";
import type { FxResolver } from "../lib/formula";
import { contactHref } from "../lib/url";
import { propList, propListValue, toggleValue, type RelationCandidate } from "../lib/relation";
import { COL_DRAG_MIME, NOTE_DRAG_MIME } from "../lib/sidebar";
import { missingCls } from "../lib/mounts";
import { AudioPropButton } from "./AudioPropButton";
import DateMenu from "./DateMenu";
import FileMenu from "./FileMenu";
import RelationMenu from "./RelationMenu";
import SelectMenu, { anchorFrom, MultiValues, optionColor, OptionDot, OptionPill, RelationValues, type AnchorRect } from "./SelectMenu";
import { ChevronIcon, PlusIcon, WarnIcon, XIcon } from "./Icons";
import { AGG_OPTIONS, ColMenu, openExternalLink, WIN_INITIAL, type Focus } from "./DbPaneShared";
import { byFoldedKey, isBuiltinDateName } from "../lib/schemalookup";
import type { HopDir } from "../lib/cellhop";

/** the open cell editor (two ways it can open pre-filled:
    `seed` = the keystroke that opened it, `caretAtEnd` = F2's edit-in-place) */
type EditCellState = {
  path: string;
  key: string;
  anchor: AnchorRect;
  seed?: string;
  caretAtEnd?: boolean;
};

/** The table layout (split out of DatabasePane): the windowed
    thead/tbody/tfoot render, its group headers and spacers, the aggregation
    footer and the bulk bar with its property editors. DatabasePane stays the
    façade — every piece of state and every callback below is owned there and
    handed down, so this is presentation only. */
export default function DbTableLayout({
  sorts,
  rows,
  rowGroups,
  windowed,
  win,
  winMetrics,
  rowTops,
  tbodyTotal,
  newTitle,
  shown,
  tableGroup,
  typeSchema,
  notes,
  dbTypes,
  openPath,
  bgMenuProps,
  head,
  tabRow,
  bar,
  noMatch,
  adminPop,
  draftInput,
  bodyRef,
  winSyncRef,
  colCss,
  gridOn,
  scrolledX,
  setScrolledX,
  scrolledY,
  setScrolledY,
  moreRight,
  setMoreRight,
  dismissAnchored,
  anchorStaleScope,
  cycleSort,
  startResize,
  resetWidth,
  colDrag,
  setColDrag,
  colDropAt,
  setColDropAt,
  dropColumn,
  endColDrag,
  colMenu,
  setColMenu,
  setPropVisAt,
  setAddPropAt,
  setAggMenu,
  focusedCls,
  tabIndexFor,
  setFocus,
  selClick,
  plainCellClick,
  onOpenNote,
  onNoteMenu,
  onCellMenu,
  onTrashNotes,
  sel,
  writeFailed,
  lastWritten,
  bulkClosing,
  clearSel,
  editCell,
  setEditCell,
  schemaEditCell,
  setSchemaEditCell,
  startEdit,
  hopEdit,
  commitCell,
  commitListCell,
  toggleCheckboxCell,
  fileOk,
  usedValues,
  onSaveSchema,
  rollupRelations,
  rollupPropsFor,
  relationCandidates,
  createRelationTarget,
  onCreateEntry,
  reportFailure,
  tallied,
  aggs,
  aggResults,
  fxAsOf,
  fx,
  numberLocale,
  bulkColMenu,
  setBulkColMenu,
  bulkCheck,
  setBulkCheck,
  bulkEdit,
  setBulkEdit,
  bulkVals,
  setBulkVals,
  bulkCommit,
  bulkWriteLive,
  pickBulkCol,
}: {
  sorts: SavedViewSort[];
  rows: NoteMeta[];
  rowGroups: { value: string | null; start: number; count: number }[] | null;
  windowed: boolean;
  win: { start: number; end: number } | null;
  winMetrics: { rowH: number; groupH: number; draftH: number; headH: number; tbodyTop: number };
  rowTops: number[];
  tbodyTotal: number;
  newTitle: string | null;
  shown: string[];
  tableGroup: string | undefined;
  typeSchema: Record<string, PropSchema>;
  notes: NoteMeta[];
  dbTypes: string[];
  openPath: string | null;
  bgMenuProps: { onContextMenu: (e: React.MouseEvent) => void };
  head: React.ReactNode;
  tabRow: React.ReactNode;
  bar: React.ReactNode;
  noMatch: React.ReactNode;
  adminPop: React.ReactNode;
  draftInput: React.ReactNode;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  winSyncRef: React.MutableRefObject<() => void>;
  colCss: string;
  gridOn: boolean;
  scrolledX: boolean;
  setScrolledX: (v: boolean) => void;
  scrolledY: boolean;
  setScrolledY: (v: boolean) => void;
  moreRight: boolean;
  setMoreRight: (v: boolean) => void;
  /** Drop every popover anchored to a rect this scroller just moved */
  dismissAnchored: () => void;
  /** scopes SelectMenu's scroll-dismiss event to this database pane */
  anchorStaleScope: string;
  cycleSort: (key: string, additive: boolean) => void;
  startResize: (key: string, e: React.MouseEvent) => void;
  resetWidth: (key: string) => void;
  /** Column drag-reorder: the key being dragged, the live drop slot
      (the 2px accent line), and the three transitions the headers drive. */
  colDrag: string | null;
  setColDrag: (v: string | null) => void;
  colDropAt: { key: string; after: boolean } | null;
  setColDropAt: (v: { key: string; after: boolean } | null) => void;
  dropColumn: (target: string, after: boolean) => void;
  endColDrag: () => void;
  colMenu: { col: string; anchor: AnchorRect } | null;
  setColMenu: (v: { col: string; anchor: AnchorRect } | null) => void;
  setPropVisAt: (v: AnchorRect | null) => void;
  setAddPropAt: (v: AnchorRect | null) => void;
  setAggMenu: (v: { col: string; anchor: AnchorRect; up: boolean } | null) => void;
  focusedCls: (c: number, r: number) => string;
  tabIndexFor: (c: number, r: number) => number;
  setFocus: (f: Focus | null) => void;
  selClick: (r: number, path: string, range: boolean) => void;
  plainCellClick: (path: string, go: () => void) => void;
  onOpenNote: (path: string) => void;
  onNoteMenu: (path: string, x: number, y: number) => void;
  /** right-click on a value cell — the cell IS a (note, key) fact, so its menu
      leads with that fact's receipts (receipts spec §6) */
  onCellMenu?: (path: string, key: string, x: number, y: number) => void;
  onTrashNotes: (paths: string[]) => void;
  sel: ReadonlySet<string>;
  /** Notes a bulk write was refused on, each mapped to what the
      vault said. These rows are also what's selected, so the bar's count and
      the marked rows describe one thing. */
  writeFailed: ReadonlyMap<string, string>;
  /** The cell a write just landed in, lit for one fade */
  lastWritten: { path: string; key: string; nonce: number } | null;
  /** While >0 the selection just emptied and the bar is fading out,
      still showing this count */
  bulkClosing: number;
  clearSel: () => void;
  editCell: EditCellState | null;
  setEditCell: (v: EditCellState | null) => void;
  schemaEditCell: boolean;
  setSchemaEditCell: (v: boolean) => void;
  startEdit: (
    path: string,
    key: string,
    el: Element | null | undefined,
    opts?: { seed?: string; caretAtEnd?: boolean }
  ) => void;
  /** An editor committed and asked to carry on to the next cell */
  hopEdit: (from: { path: string; key: string }, dir: HopDir) => void;
  commitCell: (value: string | null) => void;
  commitListCell: (path: string, key: string, values: string[]) => void;
  toggleCheckboxCell: (path: string, key: string) => void;
  fileOk: Record<string, boolean>;
  usedValues: (key: string) => string[];
  onSaveSchema: (
    prop: string,
    options: SelectOption[],
    kind: PropKind | null,
    notify?: boolean,
    notifyBefore?: number,
    target?: string,
    format?: NumberFormat,
    description?: string,
    rollup?: RollupConfig | null
  ) => void;
  /** the rollup schema editor's pickers: followable relation props
      of this database, and the props of a relation's target database */
  rollupRelations: string[];
  rollupPropsFor: (relation: string) => string[];
  relationCandidates: (dbType: string) => RelationCandidate[];
  createRelationTarget: (path: string, key: string, targetDb: string, title: string) => void;
  onCreateEntry: (dbType: string, title: string) => Promise<NoteMeta>;
  reportFailure: (what: string) => (err: unknown) => void;
  tallied: NoteMeta[];
  aggs: Record<string, AggKind>;
  /** Per-column footer aggregation: the value plus what the
      conversion cost — `converted` names the foreign units folded in,
      `skipped` the ones that couldn't be. Both empty on a unitless column. */
  aggResults: Record<string, UnitAgg | undefined>;
  /** As-of date of the rates cells and the footer converted at, for the
      markers' hover text; empty when nothing is known about it. */
  fxAsOf?: string;
  /** Rates for unit columns: a cell stored in a foreign unit
      renders converted into its column's. Absent → currency cells render as
      typed, never as a wrong number. */
  fx?: FxResolver;
  /** Number formatting the vault is set to — footer figures follow
      the same convention as the cells above them. */
  numberLocale: NumberLocale;
  bulkColMenu: AnchorRect | null;
  setBulkColMenu: (v: AnchorRect | null) => void;
  bulkCheck: { key: string; anchor: AnchorRect } | null;
  setBulkCheck: (v: { key: string; anchor: AnchorRect } | null) => void;
  bulkEdit: { key: string; anchor: AnchorRect } | null;
  setBulkEdit: (v: { key: string; anchor: AnchorRect } | null) => void;
  bulkVals: string[];
  setBulkVals: (v: string[]) => void;
  bulkCommit: (key: string, value: string | string[] | boolean | null) => void;
  bulkWriteLive: (key: string, value: string | string[] | boolean | null) => void;
  pickBulkCol: (key: string, anchor: AnchorRect) => void;
}) {
  // arrow for any active key; with 2+ keys a muted ordinal marks each key's
  // place in the lexicographic order
  const sortArrow = (key: string) => {
    const i = sorts.findIndex((s) => s.key === key);
    if (i === -1) return null;
    return (
      <span className="db-sort">
        {sorts[i].dir === 1 ? "↑" : "↓"}
        {sorts.length >= 2 && <span className="db-sort-ord">{i + 1}</span>}
      </span>
    );
  };

  // Row index → the section starting at it (empty when ungrouped,
  // so the flat render below never looks). Plain const, not a hook — the
  // layout branches above return early, hooks can't live down here.
  const groupStartAt = new Map((rowGroups ?? []).map((g) => [g.start, g] as const));

  /* The painted slice. Unwindowed tables take the whole row set; a
     windowed one takes win (or the WIN_INITIAL first slice until winSync
     runs), clamped to the live row count and stretched to keep an open cell
     editor's row painted — unmounting it would kill its menu mid-edit. The
     spacers stand in for the rows outside the slice: their heights come from
     rowTops, so scroll geometry matches a full render row-for-row. */
  let winStart = 0;
  let winEnd = rows.length;
  if (windowed) {
    winStart = Math.min(win?.start ?? 0, rows.length - 1);
    winEnd = Math.min(Math.max(win?.end ?? WIN_INITIAL, winStart + 1), rows.length);
    if (editCell) {
      const editRow = rows.findIndex((n) => n.path === editCell.path);
      if (editRow !== -1) {
        if (editRow < winStart) winStart = editRow;
        if (editRow >= winEnd) winEnd = editRow + 1;
      }
    }
  }
  const winTopH = windowed
    ? rowTops[winStart] -
      (newTitle !== null ? winMetrics.draftH : 0) -
      (groupStartAt.has(winStart) ? winMetrics.groupH : 0)
    : 0;
  const winBottomH = windowed ? tbodyTotal - (rowTops[winEnd - 1] + winMetrics.rowH) : 0;
  const spacerRow = (h: number, cls: string) => (
    <tr className={`db-win-spacer ${cls}`} aria-hidden="true">
      <td colSpan={shown.length + 2} style={{ height: h }} />
    </tr>
  );

  // a section header row spans the full table width: option dot, label,
  // muted count — the board column header's type scale and casing. It
  // carries no data-fc/data-fr, so arrow-key focus glides over it.
  const groupHeaderRow = (value: string | null, count: number) => {
    const groupSchema = tableGroup ? byFoldedKey(typeSchema, tableGroup) : undefined;
    const converted =
      value !== null && groupSchema?.kind === "number"
        ? conversionNote(value, groupSchema.format, fx, fxAsOf)
        : null;
    return <tr className="db-group-tr">
      <td colSpan={shown.length + 2}>
        <span className="db-group-head">
          {value !== null ? (
            <span className="db-group-label">
              <OptionDot
                color={optionColor(groupSchema?.options, value)}
              />
              {/* The column's format too, like the board header —
                  without it a number section read raw "1200" over cells
                  rendering "1.200,00 €" */}
              {displayValue(
                value,
                groupSchema?.kind,
                groupSchema?.format,
                fx,
                numberLocale
              )}
              {converted && <span className="prop-conv" title={converted}>*</span>}
            </span>
          ) : (
            <span className="db-group-label db-group-none">No {tableGroup}</span>
          )}
          <span className="db-group-count">{count}</span>
        </span>
      </td>
    </tr>;
  };

  /* Header drag-reorder. Only the LABEL button is draggable — the
     8px resize strip keeps its own mousedown, so a grab near the edge still
     resizes and never starts a reorder. The whole th is the drop zone (the
     pointer lands anywhere across a wide header), and the side is decided by
     the pointer's half, matching the sidebar's reorder gesture. The Name
     column is frozen first: no drag source, no drop target. */
  const colDragProps = (c: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(COL_DRAG_MIME, c);
      e.dataTransfer.effectAllowed = "move";
      setColDrag(c);
    },
    onDragEnd: endColDrag,
  });
  const sideOf = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  const colDropProps = (c: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!colDrag || !e.dataTransfer.types.includes(COL_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = sideOf(e);
      if (colDropAt?.key !== c || colDropAt.after !== after) setColDropAt({ key: c, after });
    },
    onDrop: (e: React.DragEvent) => {
      if (!colDrag || !e.dataTransfer.types.includes(COL_DRAG_MIME)) return;
      e.preventDefault();
      dropColumn(c, sideOf(e));
    },
  });
  // the 2px accent insertion line, painted on the header the pointer is over.
  // A drop that would land the column back where it started paints nothing —
  // the line would promise a move that the commit correctly refuses.
  const colDropCls = (c: string) => {
    if (!colDrag || colDropAt?.key !== c) return "";
    const i = shown.indexOf(colDrag);
    const j = shown.indexOf(c);
    if (c === colDrag) return "";
    if (colDropAt.after && j === i - 1) return "";
    if (!colDropAt.after && j === i + 1) return "";
    return colDropAt.after ? " db-th-drop-after" : " db-th-drop-before";
  };

  // The bulk bar's column editor reuses the single-cell machinery
  // (SelectMenu/DateMenu/RelationMenu/FileMenu), anchored at the bar button
  // it was opened from — near the bottom edge every menu flips up on its own.
  // Checkbox columns never reach this: pickBulkCol gave them a choice menu.
  const bulkKey = bulkEdit?.key ?? null;
  const bulkSchema = bulkKey ? byFoldedKey(typeSchema, bulkKey) : undefined;
  const bulkKind = bulkKey
    ? bulkSchema?.kind ?? (isBuiltinDateName(bulkKey) ? "date" : undefined)
    : undefined;
  const closeBulkEdit = () => {
    setBulkEdit(null);
    clearSel();
  };
  // A bulk multi/relation write REPLACES each selected note's whole
  // list with the picked set, but the picker's toggles read as additive. The
  // write semantics stay; the picker states them plainly, naming the column
  // and the selection size (the selection can't change while the menu rides).
  const bulkReplace =
    bulkKey && (bulkKind === "multi" || bulkKind === "relation")
      ? `Replaces the ${displayColLabel(bulkKey)} of all ${sel.size} selected ${sel.size === 1 ? "note" : "notes"}`
      : undefined;

  return (
    <div className="db" {...bgMenuProps}>
      {head}
      {tabRow}
      {bar}
      <div
        className={`db-body${scrolledX ? " db-scrolled-x" : ""}${scrolledY ? " db-scrolled-y" : ""}${moreRight ? " db-more-x" : ""}`}
        ref={bodyRef}
        // Scroll events aren't cancelable, so this can't block
        // scrolling; an unchanged boolean bails out of re-render, meaning the
        // pane only re-renders when one of the fade/cue gates actually flips.
        // winSync re-windows the painted rows — same bail-out math.
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrolledX(el.scrollLeft > 0);
          // The sticky header only reads as a lid once rows have gone
          // under it -- same gate idiom as the freeze line, same bail-out
          setScrolledY(el.scrollTop > 0);
          setMoreRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
          // Cell editors and header menus hold a rect captured at open
          // -- once the rows slide under them they point at the wrong cell
          dismissAnchored();
          winSyncRef.current();
        }}
      >
        {colCss && <style>{colCss}</style>}
        <table className={`db-table${gridOn ? " db-grid" : ""}`}>
          <thead
            // Right-click anywhere on the header row opens the
            // property-visibility checklist, anchored at the pointer
            onContextMenu={(e) => {
              e.preventDefault();
              setPropVisAt({ left: e.clientX, top: e.clientY, bottom: e.clientY });
            }}
          >
            <tr>
              <th>
                <button
                  type="button"
                  className="db-th-title"
                  aria-label="Sort by Name"
                  onClick={(e) => cycleSort("title", e.shiftKey)}
                >
                  Name {sortArrow("title")}
                </button>
                <span
                  className="db-th-resize"
                  title="Drag to resize; double-click to reset"
                  onMouseDown={(e) => startResize("title", e)}
                  onDoubleClick={() => resetWidth("title")}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              {shown.map((c) => (
                <th
                  key={c}
                  className={`${colDrag === c ? "db-th-dragging" : ""}${colDropCls(c)}`.trim() || undefined}
                  {...colDropProps(c)}
                >
                  <button
                    type="button"
                    className="db-th-label"
                    aria-label={`Sort by ${displayColLabel(c)}`}
                    title={`${displayColLabel(c)} — click to sort, drag to reorder`}
                    onClick={(e) => cycleSort(c, e.shiftKey)}
                    {...colDragProps(c)}
                  >
                    {displayColLabel(c)} {sortArrow(c)}
                  </button>
                  <button
                    className={`db-th-caret${colMenu?.col === c ? " active" : ""}`}
                    title={`${c} — property actions`}
                    onClick={(e) => setColMenu({ col: c, anchor: anchorFrom(e.currentTarget) })}
                  >
                    <ChevronIcon />
                  </button>
                  <span
                    className="db-th-resize"
                    title="Drag to resize; double-click to reset"
                    onMouseDown={(e) => startResize(c, e)}
                    onDoubleClick={() => resetWidth(c)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
              <th className="db-th-add">
                <button
                  className="db-add-btn"
                  title="Add property"
                  onClick={(e) => setAddPropAt(anchorFrom(e.currentTarget))}
                >
                  <PlusIcon />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {newTitle !== null && (
              <tr className="db-draft-tr">
                <td className="db-cell db-title">{draftInput}</td>
                {shown.map((c) => (
                  <td key={c} className="db-cell" />
                ))}
                <td className="db-cell db-add-cell" />
              </tr>
            )}
            {windowed && winTopH > 0 && spacerRow(winTopH, "db-win-top")}
            {rows.slice(winStart, winEnd).map((n, winIdx) => {
              const r = winStart + winIdx;
              const g = groupStartAt.get(r);
              return (
                <Fragment key={n.path}>
                  {g ? groupHeaderRow(g.value, g.count) : null}
              <tr
                className={
                  `${openPath === n.path ? "db-open" : ""}${sel.has(n.path) ? " is-selected" : ""}${missingCls(n)}`.trim() ||
                  undefined
                }
                // a row hosting an open cell editor stays undraggable — the
                // menu inside it owns the mouse
                draggable={editCell?.path !== n.path}
                onDragStart={(e) => {
                  e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onNoteMenu(n.path, e.clientX, e.clientY);
                }}
              >
                <td
                  data-fc={0}
                  data-fr={r}
                  data-focus-path={n.path}
                  className={`db-cell db-title${focusedCls(0, r)}`}
                  tabIndex={tabIndexFor(0, r)}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget) setFocus({ c: 0, r, path: n.path });
                  }}
                  onClick={(e) => {
                    // A modifier turns the click into a selection
                    // gesture only (no open/edit); plain click = as before
                    if (e.shiftKey || e.metaKey || e.ctrlKey) {
                      e.preventDefault();
                      selClick(r, n.path, e.shiftKey);
                      return;
                    }
                    plainCellClick(n.path, () => {
                      setFocus({ c: 0, r, path: n.path });
                      onOpenNote(n.path);
                    });
                  }}
                >
                  <span className="db-cell-txt db-title-txt">{n.title}</span>
                  {/* The bulk toast counts the failures; this is
                      where THIS note's own reason lives, on the row it
                      happened to. Title text so the reason is readable
                      without a pointer, and reachable by screen readers. */}
                  {writeFailed.has(n.path) ? (
                    <span
                      className="db-fail"
                      title={`Not saved — ${writeFailed.get(n.path)}`}
                      aria-label={`Not saved — ${writeFailed.get(n.path)}`}
                      role="img"
                    >
                      <WarnIcon />
                    </span>
                  ) : null}
                </td>
                {shown.map((c, i) => {
                  const isEditing = editCell?.path === n.path && editCell.key === c;
                  const actualKey = foldedPropKey(n.props, c);
                  const val = foldedPropStr(n.props, c) ?? "";
                  const cschema = byFoldedKey(typeSchema, c);
                  const copts = cschema?.options ?? [];
                  // created/updated are built-in meta props: date-kind unless the
                  // schema overrides, so they format and style like
                  // schema'd dates instead of leaking raw ISO
                  const ckind = cschema?.kind ?? (isBuiltinDateName(c) ? "date" : undefined);
                  const multiVals = ckind === "multi" ? propList(n.props, actualKey) : [];
                  const relVals = ckind === "relation" ? propList(n.props, actualKey) : [];
                  const broken = ckind === "file" && !!val && fileOk[val] === false;
                  // audio-valued file prop: the cell carries a
                  // compact play/pause next to the path text
                  const audioTarget = ckind === "file" && val ? audioFileTarget(val) : null;
                  // checkbox: checked iff the raw prop is the YAML
                  // bool true — `false`/missing/empty all read as unchecked
                  const checked = ckind === "checkbox" && n.props[actualKey] === true;
                  const closeCell = () => {
                    setEditCell(null);
                    setSchemaEditCell(false);
                  };
                  // Enter/Tab in this cell's editor commit and carry
                  // on to the next one. Bound to the CELL, not the editor —
                  // the editor has already closed itself by the time this runs
                  const hop = (dir: HopDir) => hopEdit({ path: n.path, key: c }, dir);
                  // A write that just landed here lights the cell for
                  // one fade -- the confirmation a single-cell edit never got
                  const flashed = lastWritten?.path === n.path && lastWritten.key === c;
                  return (
                    <td
                      key={c}
                      data-fc={i + 1}
                      data-fr={r}
                      data-focus-path={n.path}
                      className={`db-cell${focusedCls(i + 1, r)}${isEditing ? " editing" : ""}${flashed ? " db-flashing" : ""}`}
                      tabIndex={tabIndexFor(i + 1, r)}
                      onFocus={(e) => {
                        if (e.target === e.currentTarget)
                          setFocus({ c: i + 1, r, path: n.path });
                      }}
                      title={(ckind === "file" || ckind === "url" || ckind === "email" || ckind === "phone") && val ? val : undefined}
                      onContextMenu={(e) => {
                        if (!onCellMenu) return;
                        // the row menu is on the <tr>; this cell's own menu
                        // carries it plus the fact's receipts, so stop the
                        // bubble rather than show both
                        e.preventDefault();
                        e.stopPropagation();
                        onCellMenu(n.path, actualKey || c, e.clientX, e.clientY);
                      }}
                      onClick={(e) => {
                        // Same selection-gesture branch as the title
                        // cell — a modified click never toggles/starts an edit
                        if (e.shiftKey || e.metaKey || e.ctrlKey) {
                          e.preventDefault();
                          selClick(r, n.path, e.shiftKey);
                          return;
                        }
                        plainCellClick(n.path, () => {
                          setFocus({ c: i + 1, r, path: n.path });
                          // checkbox cells toggle in place — the whole cell is
                          // the one obvious affordance, no raw-string editor
                          if (ckind === "checkbox") toggleCheckboxCell(n.path, c);
                          // a rollup cell is derived — read-only,
                          // no editor; the value recomputes from the vault
                          else if (ckind !== "rollup") startEdit(n.path, c, e.currentTarget);
                        });
                      }}
                    >
                      {/* keyed on the nonce so a second write to the same cell
                          restarts the fade instead of sitting through it; a
                          decorative span, so remounting costs no focus */}
                      {flashed && <span key={lastWritten.nonce} className="db-cell-flash" aria-hidden="true" />}
                      <span
                        className={`db-cell-txt${broken ? " file-broken" : ""}${ckind === "date" ? " cell-mono" : ""}${ckind === "checkbox" ? " cell-check" : ""}${ckind === "number" || ckind === "rollup" ? " cell-num" : ""}`}
                      >
                        {ckind === "checkbox" ? (
                          <span className={`prop-check${checked ? " on" : ""}`} aria-label={checked ? "Checked" : "Unchecked"} />
                        ) : ckind === "multi" ? (
                          <MultiValues values={multiVals} options={copts} />
                        ) : ckind === "relation" ? (
                          <RelationValues values={relVals} />
                        ) : (ckind === "url" || ckind === "email" || ckind === "phone") && val ? (
                          // the link text opens externally; the rest of the
                          // cell still starts the raw-string editor
                          <a
                            className="url-link"
                            href={ckind === "url" ? val : contactHref(ckind, val)}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openExternalLink(ckind === "url" ? val : contactHref(ckind, val));
                            }}
                          >
                            {displayValue(val, ckind, cschema?.format)}
                          </a>
                        ) : audioTarget ? (
                          // The button stops its own propagation, so
                          // the rest of the cell still starts the editor
                          <span className="prop-audio">
                            <AudioPropButton name={audioTarget} />
                            <OptionPill color={optionColor(copts, val)}>
                              <span className="prop-audio-name">{displayValue(val, ckind, cschema?.format)}</span>
                            </OptionPill>
                          </span>
                        ) : (
                          <OptionPill color={optionColor(copts, val)}>
                            {displayValue(val, ckind, cschema?.format, fx, numberLocale)}
                            {/* A cell rendered in the column's unit
                                but STORED in another says so on hover — the
                                file still holds exactly what was typed */}
                            {(() => {
                              const note =
                                ckind === "number"
                                  ? conversionNote(val, cschema?.format, fx, fxAsOf)
                                  : null;
                              return note ? (
                                <span className="prop-conv" title={note}>
                                  *
                                </span>
                              ) : null;
                            })()}
                          </OptionPill>
                        )}
                      </span>
                      {isEditing && editCell && (
                        schemaEditCell ? (
                          <SelectMenu
                            staleScope={anchorStaleScope}
                            anchor={editCell.anchor}
                            value={val}
                            options={copts}
                            used={usedValues(c)}
                            canEditSchema
                            kind={ckind}
                            notify={cschema?.notify}
                            notifyBefore={cschema?.notifyBefore}
                            target={cschema?.type}
                            format={cschema?.format}
                            description={cschema?.description}
                            databases={dbTypes}
                            rollupRelations={rollupRelations}
                            rollupPropsFor={rollupPropsFor}
                            startEditing
                            onCommit={(v) => commitCell(v)}
                            onSaveSchema={(o, nk, nf, nb, t, f, d, r) => onSaveSchema(c, o, nk, nf, nb, t, f, d, r)}
                            onClose={closeCell}
                          />
                        ) : ckind === "relation" && cschema?.type ? (
                          <RelationMenu
                            anchor={editCell.anchor}
                            values={propList(n.props, actualKey)}
                            candidates={relationCandidates(cschema.type)}
                            targetType={cschema.type}
                            seed={editCell.seed}
                            onHop={hop}
                            onCommit={(vals) => commitListCell(n.path, c, vals)}
                            onCreate={(t) => createRelationTarget(n.path, c, cschema.type!, t)}
                            onClear={() => commitCell(null)}
                            onEditSchema={() => setSchemaEditCell(true)}
                            onClose={closeCell}
                          />
                        ) : ckind === "date" ? (
                          <DateMenu
                            anchor={editCell.anchor}
                            value={val}
                            seed={editCell.seed}
                            onHop={hop}
                            onCommit={(v) => commitCell(v)}
                            onClear={() => commitCell(null)}
                            onEditSchema={() => setSchemaEditCell(true)}
                            onClose={closeCell}
                          />
                        ) : ckind === "file" ? (
                          <FileMenu
                            anchor={editCell.anchor}
                            value={val}
                            exists={val ? fileOk[val] ?? null : null}
                            seed={editCell.seed}
                            onHop={hop}
                            onCommit={(v) => commitCell(v)}
                            onClear={() => commitCell(null)}
                            onEditSchema={() => setSchemaEditCell(true)}
                            onClose={closeCell}
                          />
                        ) : (
                          <SelectMenu
                            staleScope={anchorStaleScope}
                            anchor={editCell.anchor}
                            value={val}
                            options={copts}
                            used={usedValues(c)}
                            canEditSchema
                            kind={ckind}
                            notify={cschema?.notify}
                            notifyBefore={cschema?.notifyBefore}
                            target={cschema?.type}
                            format={cschema?.format}
                            description={cschema?.description}
                            databases={dbTypes}
                            rollupRelations={rollupRelations}
                            rollupPropsFor={rollupPropsFor}
                            label={`Pick ${c}`}
                            cell
                            seed={editCell.seed}
                            caretAtEnd={editCell.caretAtEnd}
                            onHop={hop}
                            values={ckind === "multi" ? multiVals : undefined}
                            onToggle={
                              ckind === "multi"
                                ? (nv) =>
                                    commitListCell(
                                      n.path,
                                      c,
                                      toggleValue(
                                        propList(
                                          notes.find((x) => x.path === n.path)?.props ?? {},
                                          foldedPropKey(
                                            notes.find((x) => x.path === n.path)?.props ?? {}, c
                                          )
                                        ),
                                        nv
                                      )
                                    )
                                : undefined
                            }
                            onCommit={(v) => commitCell(v)}
                            onClear={() => commitCell(null)}
                            onSaveSchema={(o, nk, nf, nb, t, f, d, r) => onSaveSchema(c, o, nk, nf, nb, t, f, d, r)}
                            onClose={closeCell}
                          />
                        )
                      )}
                    </td>
                  );
                })}
                <td className="db-cell db-add-cell" />
              </tr>
                </Fragment>
              );
            })}
            {windowed && winBottomH > 0 && spacerRow(winBottomH, "db-win-bottom")}
          </tbody>
          {/* The footer is always here. It used to mount with the
              first aggregation, so the table's geometry jumped the moment you
              set one and there was nothing to discover the feature from
              (design-principles.md 4 + 5). At rest it states the row count;
              the per-column "Calc" ghost reveals on hover/focus and keeps its
              space, like every other row action */}
          <tfoot>
              <tr>
                <td className="db-agg-cell db-agg-title">{tallied.length === 1 ? "1 row" : `${tallied.length} rows`}</td>
                {shown.map((c) => {
                  const kind = aggregationKind(aggs, c);
                  const agg = kind ? aggResults[c] : undefined;
                  const res = agg?.value;
                  // the marker: a footer figure that folded foreign
                  // units in — or had to leave some out — says so rather than
                  // passing for a plain single-unit total
                  const mark = aggMarker(agg, fxAsOf);
                  return (
                    <td key={c} className="db-agg-cell" data-col={c}>
                      <button
                        className="db-agg-btn"
                        title={`${c} — calculate`}
                        tabIndex={kind ? 0 : -1}
                        onClick={(e) =>
                          setAggMenu({ col: c, anchor: anchorFrom(e.currentTarget), up: true })
                        }
                      >
                        {kind ? (
                          <>
                            <span className="db-agg-kind">
                              {AGG_OPTIONS.find((o) => o.kind === kind)?.label}
                            </span>
                            {res != null && (
                              // Keyed on the value so a recompute
                              // remounts the span and fades the new figure in
                              // -- a number that silently swaps reads as a
                              // misread rather than a result
                              <span key={res} className="db-agg-value">
                                {formatAgg(
                                  res,
                                  kind,
                                  byFoldedKey(typeSchema, c)?.format,
                                  numberLocale
                                )}
                                {mark && (
                                  <span className="db-agg-mark" title={mark}>
                                    *
                                  </span>
                                )}
                              </span>
                            )}
                            {/* no figure at all, but cells were left out: the
                                marker carries the only explanation there is, so
                                a column of text says so instead of showing a
                                bare "Sum" beside nothing */}
                            {res == null && mark && (
                              <span className="db-agg-mark" title={mark}>
                                *
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="db-agg-ghost">Calc</span>
                        )}
                      </button>
                    </td>
                  );
                })}
                <td className="db-agg-cell db-add-cell" />
              </tr>
          </tfoot>
        </table>
        {noMatch}
      </div>
      {adminPop}
      {(sel.size > 0 || bulkClosing > 0) && (
        <div className={`bulkbar${sel.size === 0 ? " closing" : ""}`}>
          {/* After a partial bulk failure the selection IS the
              failures, so the bar says why it narrowed instead of leaving a
              silently smaller "N selected" behind. */}
          <span className={`bulkbar-count${writeFailed.size > 0 ? " is-fail" : ""}`}>
            {sel.size || bulkClosing} {writeFailed.size > 0 ? "didn’t save" : "selected"}
          </span>
          <button type="button" onClick={(e) => setBulkColMenu(anchorFrom(e.currentTarget))}>
            Set property…
          </button>
          <button
            type="button"
            onClick={() => {
              const paths = [...sel];
              clearSel();
              onTrashNotes(paths);
            }}
          >
            Move to Trash
          </button>
          <button
            type="button"
            className="bulkbar-x"
            title="Clear selection (Esc)"
            aria-label="Clear selection"
            onClick={clearSel}
          >
            <XIcon />
          </button>
        </div>
      )}
      {bulkColMenu && (
        <ColMenu
          anchor={bulkColMenu}
          up
          items={shown
            // a rollup column is derived — no write path, so no
            // bulk edit
            .filter((c) => typeSchema[c]?.kind !== "rollup")
            .map((c) => ({
              label: displayColLabel(c),
              run: () => pickBulkCol(c, bulkColMenu),
            }))}
          onClose={() => setBulkColMenu(null)}
        />
      )}
      {bulkCheck && (
        <ColMenu
          anchor={bulkCheck.anchor}
          up
          items={[
            { label: "Checked", run: () => bulkCommit(bulkCheck.key, true) },
            { label: "Unchecked", run: () => bulkCommit(bulkCheck.key, null) },
          ]}
          onClose={() => setBulkCheck(null)}
        />
      )}
      {bulkEdit &&
        bulkKey &&
        (bulkKind === "relation" && bulkSchema?.type ? (
          <RelationMenu
            anchor={bulkEdit.anchor}
            values={bulkVals}
            bulkNote={bulkReplace}
            candidates={relationCandidates(bulkSchema.type)}
            targetType={bulkSchema.type}
            onCommit={(vals) => {
              setBulkVals(vals);
              bulkWriteLive(bulkKey, propListValue(vals));
            }}
            onCreate={(t) => {
              onCreateEntry(bulkSchema.type!, t)
                .then((m) => {
                  const next = toggleValue(bulkVals, m.title);
                  setBulkVals(next);
                  bulkWriteLive(bulkKey, propListValue(next));
                })
                .catch(reportFailure(`create “${t}”`));
            }}
            onClear={() => {
              setBulkVals([]);
              bulkWriteLive(bulkKey, null);
            }}
            onClose={closeBulkEdit}
          />
        ) : bulkKind === "date" ? (
          <DateMenu
            anchor={bulkEdit.anchor}
            value=""
            onCommit={(v) => bulkCommit(bulkKey, v)}
            onClear={() => bulkCommit(bulkKey, null)}
            onClose={closeBulkEdit}
          />
        ) : bulkKind === "file" ? (
          <FileMenu
            anchor={bulkEdit.anchor}
            value=""
            exists={null}
            onCommit={(v) => bulkCommit(bulkKey, v)}
            onClear={() => bulkCommit(bulkKey, null)}
            onClose={closeBulkEdit}
          />
        ) : (
          <SelectMenu
            staleScope={anchorStaleScope}
            anchor={bulkEdit.anchor}
            value=""
            options={bulkSchema?.options ?? []}
            used={usedValues(bulkKey)}
            canEditSchema
            kind={bulkKind}
            notify={bulkSchema?.notify}
            notifyBefore={bulkSchema?.notifyBefore}
            target={bulkSchema?.type}
            format={bulkSchema?.format}
            description={bulkSchema?.description}
            databases={dbTypes}
            rollupRelations={rollupRelations}
            rollupPropsFor={rollupPropsFor}
            label={`Pick ${bulkKey}`}
            values={bulkKind === "multi" ? bulkVals : undefined}
            bulkNote={bulkReplace}
            onToggle={
              bulkKind === "multi"
                ? (nv) => {
                    const next = toggleValue(bulkVals, nv);
                    setBulkVals(next);
                    bulkWriteLive(bulkKey, propListValue(next));
                  }
                : undefined
            }
            onCommit={(v) => bulkCommit(bulkKey, v)}
            onClear={() => bulkCommit(bulkKey, null)}
            onSaveSchema={(o, nk, nf, nb, t, f, d, r) => onSaveSchema(bulkKey, o, nk, nf, nb, t, f, d, r)}
            onClose={closeBulkEdit}
          />
        ))}
    </div>
  );
}
