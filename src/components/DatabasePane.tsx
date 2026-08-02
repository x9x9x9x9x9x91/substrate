import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AggKind, DbIcon, DbLayout, NoteMeta, NumberFormat, PropKind, PropSchema, RollupConfig, SavedView, SavedViewSort, SchemaConfig, SelectOption, ViewPref } from "../lib/types";
import { foldedPropKey, foldedPropStr, typeHome } from "../lib/types";
import { isTyping, isTypingNow } from "../lib/dom";
import { cycleSortKeys, restingCmp, sortCmpFor } from "../lib/dbsort";
import { rangePaths, togglePath } from "../lib/bulkselect";
import { aggregationKind, aggregateColumns, normalizeNumberInput, updateAggregation } from "../lib/aggregate";
import { pathExists, vaultCreate, vaultTemplateRead } from "../lib/ipc";
import { setPropUndoable, setPropUndoableBulk } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { nextUndoId } from "../lib/undo";
import { completeFilter, filterCompletions, filterDeadEndHint, filterInherits, filterLabel, matchesFilters, parseQuery } from "../lib/query";
import { filterByQuery } from "../lib/views";
import { exportDbCsv } from "../lib/export";
import { todayIso } from "../lib/dates";
import { displayColLabel, displayValue } from "../lib/display";
import {
  chipCommitValue,
  propList,
  propListValue,
  toggleValue,
  type RelationCandidate,
} from "../lib/relation";
import { rollupColumns, rollupProps, withRollups } from "../lib/rollup";
import { byFoldedKey, isBuiltinDateName, typeSchemaFor } from "../lib/schemalookup";
import { buildEntryBody, buildEntryProps, homeFolderFor, mergeEntryProp } from "../lib/templates";
import { boardGroupBy, canonicalViewPref, dbColumns, effectiveColumns, hiddenForLayout } from "../lib/dbcolumns";
import {
  bucketByProp,
  distinctNotes,
  extraValues,
  tableGroupBy,
  tableGroups,
} from "../lib/dbgroup";
import SelectMenu, { anchorFrom, type AnchorRect } from "./SelectMenu";
import PropForm from "./PropForm";
import DotsMenu from "./DotsMenu";
import InlineEdit from "./InlineEdit";
import IconPicker from "./IconPicker";
import TypeIcon from "./TypeIcon";
import ContextMenu from "./ContextMenu";
import DbBoardLayout from "./DbBoardLayout";
import DbGalleryLayout from "./DbGalleryLayout";
import DbListLayout from "./DbListLayout";
import DbTableLayout from "./DbTableLayout";
import {
  AGG_OPTIONS,
  cardSubtitle,
  ColMenu,
  ColumnsMenu,
  colWidthRule,
  EMPTY_SEL,
  LAYOUT_ICON,
  MAX_COL_W,
  MIN_COL_W,
  PropVisMenu,
  WIN_HEAD_H,
  WIN_MIN,
  WIN_OVERSCAN,
  WIN_ROW_H,
  type Focus,
} from "./DbPaneShared";

export { cardSubtitle };
import { ColumnsIcon, DbIcon as DbGlyphIcon, ExportIcon, EyeOffIcon, FilterIcon, PenIcon, PinIcon, PlusIcon, TrashIcon, XIcon } from "./Icons";

interface DatabasePaneProps {
  dbType: string;
  /** the database's own rows (a saved view's subset when pinned) */
  notes: NoteMeta[];
  /** every vault note (SUB-678: a rollup's linked rows live in other
      databases — the derivation reads them from here) */
  allNotes: NoteMeta[];
  pref: ViewPref | undefined;
  typeSchema: Record<string, PropSchema>;
  /** the whole vault schema (SUB-678: the rollup schema editor lists the
      related database's props from it) */
  schema: SchemaConfig;
  /** the database's icon (SUB-27); clicking the header icon edits it */
  icon?: DbIcon;
  onSaveIcon: (icon: DbIcon | null) => void;
  usedValues: (key: string) => string[];
  onSaveSchema: (prop: string, options: SelectOption[], kind: PropKind | null, notify?: boolean, target?: string, format?: NumberFormat, description?: string, rollup?: RollupConfig | null) => void;
  /** entries of a relation column's target database (picker source) */
  relationCandidates: (dbType: string) => RelationCandidate[];
  /** create a new entry of a database inline from the relation picker */
  onCreateEntry: (dbType: string, title: string) => Promise<NoteMeta>;
  /** all database types — the schema editor's relation target picker */
  dbTypes: string[];
  openPath: string | null;
  /** bumped by App when ⌘N fires inside this database view */
  newSignal: number;
  /** App points this at the current view's CSV export so the palette can call it */
  exportRef?: React.MutableRefObject<(() => void) | null>;
  /** the global `db-grid` setting (SUB-607) — what tables do when this
      database's pref carries no `grid` override of its own */
  gridDefault: boolean;
  onPrefChange: (pref: ViewPref) => void;
  onOpenNote: (path: string) => void;
  /** right-click on any row/card — App's note context menu (SUB-108) */
  onNoteMenu: (path: string, x: number, y: number) => void;
  /** SUB-272: the table bulk bar's Move to Trash — App owns the per-note
      fan-out, the one refresh, and the summary toast with Undo */
  onTrashNotes: (paths: string[]) => void;
  onMutated: () => void;
  /** saved-view seeds (SUB-18): the pane opens with the pin's query;
      edits stay session-local until re-saved. The pin's sort arrives on
      `pref.sorts` (SUB-326) — same channel as a database's remembered sort. */
  initialQuery?: string;
  /** SUB-212: the pin's curated display columns — a seed like initialQuery;
      absent = the dbColumns union. Toggles stay session-local unless App
      also wires onColumnsChange (it does when a pin is open) */
  initialColumns?: string[];
  /** SUB-212: persist the open pin's column curation; `undefined` restores
      the default union. Fires on every Columns-popover toggle */
  onColumnsChange?: (columns: string[] | undefined) => void;
  /** prefill for the save-view name field (the open pin's name) */
  saveViewSeed?: string;
  /** "Save view…" capture: current filter text, ordered sort keys,
      effective layout, and the curated columns when they differ from the
      default union (SUB-212) */
  onSaveView: (
    name: string,
    capture: { query: string; sorts: SavedViewSort[]; view: DbLayout; groupBy?: string; tableGroupBy?: string; columns?: string[] }
  ) => void;
  /* SUB-160: the view tab bar — this db's pins (App filters), the open pin's
     id for the active tab, the two tab actions (open / context menu — App
     owns the menu's items), and the "All" tab's way back to the plain db
     from inside a pin */
  savedViews: SavedView[];
  activeViewId?: string;
  onOpenView: (id: string) => void;
  onViewMenu: (id: string, x: number, y: number) => void;
  /** SUB-677: pin id → its ⌘-digit keycap ("⌘5"…"⌘9"), from App's pinIds —
      the same order the view-pins shortcut fires on. Only pins with a live
      shortcut have an entry; unpinned tabs render exactly as before. Empty
      on mobile, where no ⌘ exists. */
  pinKeys: Record<string, string>;
  /** the "All" tab leaves the open pin for its database (App only wires this
      on the saved-view pane; on a plain db the tab is already active) */
  onOpenDb?: () => void;
  /* SUB-43 database management — App owns the dialogs and the sweeps */
  onRenameDb: () => void;
  onDeleteDb: () => void;
  onRenameProp: (prop: string) => void;
  onRemoveProp: (prop: string) => void;
  /** SUB-234: App's toast — a created entry the active filter still hides
      announces itself instead of vanishing silently; SUB-273: the optional
      action carries Undo after a board drag move */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
}

export default function DatabasePane({
  dbType,
  notes,
  allNotes,
  pref,
  typeSchema,
  schema,
  icon,
  onSaveIcon,
  usedValues,
  onSaveSchema,
  relationCandidates,
  onCreateEntry,
  dbTypes,
  openPath,
  newSignal,
  exportRef,
  gridDefault,
  onPrefChange,
  onOpenNote,
  onNoteMenu,
  onTrashNotes,
  onMutated,
  initialQuery,
  initialColumns,
  onColumnsChange,
  saveViewSeed,
  onSaveView,
  savedViews,
  activeViewId,
  onOpenView,
  onViewMenu,
  pinKeys,
  onOpenDb,
  onRenameDb,
  onDeleteDb,
  onRenameProp,
  onRemoveProp,
  onToast,
}: DatabasePaneProps) {
  const undo = useUndo();
  const layout: DbLayout = pref?.view ?? "table";
  const columns = useMemo(() => dbColumns(notes, typeSchema), [notes, typeSchema]);
  const normalizedPref = useMemo(
    () => (pref ? canonicalViewPref(pref, columns) : undefined),
    [pref, columns]
  );
  // SUB-678: derive the rollup columns (computed on read, stored nowhere)
  // and fold them into the display model — every downstream surface
  // (filter, sort, footer, CSV, board/list/gallery) reads the derived
  // values through the one prop-value path. `rolled` stays null when the
  // schema declares no rollup prop, so vaults without rollups never pay
  // for the derivation.
  const rollups = useMemo(() => rollupProps(typeSchema), [typeSchema]);
  const rolled = useMemo(
    () => rollupColumns(notes, typeSchema, allNotes),
    [notes, typeSchema, allNotes]
  );
  const dispNotes = useMemo(
    () => (rolled ? withRollups(notes, rolled, Object.keys(rollups)) : notes),
    [notes, rolled, rollups]
  );
  // the rollup schema editor's pickers: the relation props of THIS database
  // a rollup can follow, and the (non-rollup — a rollup reads stored values
  // only) props of whichever related database the picked relation points at
  const rollupRelations = useMemo(
    () =>
      Object.entries(typeSchema)
        .filter(([, ps]) => ps?.kind === "relation")
        .map(([k]) => k),
    [typeSchema]
  );
  const rollupPropsFor = useCallback(
    (relation: string): string[] => {
      const target = byFoldedKey(typeSchema, relation)?.type;
      if (!target) return [];
      return Object.entries(typeSchemaFor(schema, target) ?? {})
        .filter(([k, ps]) => k !== "icon" && k !== "home" && ps?.kind !== "rollup")
        .map(([k]) => k);
    },
    [typeSchema, schema]
  );
  // Which persistence channel column curation and sorting write to (SUB-326):
  // an open pin (App wires onColumnsChange) owns its curation via the
  // SUB-212 `columns` field and keeps sort session-local until re-saved;
  // a plain database view persists both on its ViewPref (hidden/sorts), so
  // they survive navigating away.
  const pinMode = onColumnsChange !== undefined;
  // Re-issue the pref with one field changed — every write goes through here
  // so a layout switch can never drop the sort or the hidden set (SUB-326).
  const patchPref = (patch: Partial<ViewPref>) => {
    onPrefChange(canonicalViewPref({
      view: layout,
      group_by: normalizedPref?.group_by,
      table_group_by: normalizedPref?.table_group_by,
      aggregations: normalizedPref?.aggregations,
      sorts: normalizedPref?.sorts,
      hidden: normalizedPref?.hidden,
      hidden_per_layout: normalizedPref?.hidden_per_layout,
      widths: normalizedPref?.widths,
      wrap: normalizedPref?.wrap,
      grid: normalizedPref?.grid,
      ...patch,
    }, columns));
  };
  // SUB-326: the database's persisted hidden-prop set — per-layout since
  // SUB-642 (the table and the list curate independently; a layout with no
  // set of its own reads the flat `hidden` seed). A prop added later is
  // NOT in the set, so it shows by default — the inverse of a pin's curated
  // shown-list, on purpose (a database is a living surface, a pin a capture).
  const hidden = useMemo(
    () => new Set(pinMode ? [] : hiddenForLayout(normalizedPref, layout)),
    [pinMode, normalizedPref, layout]
  );
  // SUB-212: curated display columns. null = the default union; a pin's
  // `columns` seeds the selection, toggles keep it in union order so
  // "everything on again" normalizes back to null. The selection is a
  // subset list — a prop added later joins the union but stays hidden in an
  // already-curated view until checked.
  const [colSel, setColSel] = useState<string[] | null>(() =>
    initialColumns?.length ? effectiveColumns({ columns: initialColumns }, columns) : null
  );
  // what actually renders in table/list: the pin's curated order (stale keys
  // dropped quietly by the helper), or the union minus the db's hidden set
  const shown = useMemo(() => {
    if (pinMode) return colSel ? effectiveColumns({ columns: colSel }, columns) : columns;
    return columns.filter((c) => !hidden.has(c));
  }, [pinMode, colSel, columns, hidden]);
  // SUB-642: persist one layout's hidden set. The write materializes BOTH
  // layouts — a layout with no set of its own seeds from the flat `hidden`,
  // which the write then drops (the read-side migration made durable: once
  // written, the per-layout shape wins). Empty sets collapse to absent, so
  // views.json never carries `[]`.
  const writeLayoutHidden = (next: string[]) => {
    const cur = layout === "list" ? "list" : "table";
    const sets = {
      table: cur === "table" ? next : hiddenForLayout(normalizedPref, "table"),
      list: cur === "list" ? next : hiddenForLayout(normalizedPref, "list"),
    };
    const perLayout: ViewPref["hidden_per_layout"] = {};
    if (sets.table.length > 0) perLayout.table = sets.table;
    if (sets.list.length > 0) perLayout.list = sets.list;
    patchPref({
      hidden: undefined,
      hidden_per_layout: perLayout.table || perLayout.list ? perLayout : undefined,
    });
  };
  // Column toggles: uncheck removes, recheck reinserts at the union
  // position. The last visible column stays — an empty table is not a
  // reachable state in either channel.
  const toggleColumn = (c: string) => {
    if (pinMode) {
      const cur = colSel ?? columns;
      const next = cur.includes(c)
        ? cur.filter((x) => x !== c)
        : columns.filter((x) => cur.includes(x) || x === c);
      if (next.length === 0) return;
      const norm = next.length === columns.length ? null : next;
      setColSel(norm);
      onColumnsChange?.(norm ?? undefined);
      return;
    }
    // db mode (SUB-326, per-layout since SUB-642): flip membership in the
    // current layout's hidden set; stale names (renamed/removed props) in
    // the stored list ride along untouched
    const cur = hiddenForLayout(normalizedPref, layout);
    const nextHidden = hidden.has(c) ? cur.filter((x) => x !== c) : [...cur, c];
    if (columns.every((x) => nextHidden.includes(x))) return;
    writeLayoutHidden(nextHidden);
  };
  const showAllColumns = () => {
    if (pinMode) {
      setColSel(null);
      onColumnsChange?.(undefined);
    } else {
      // clears the CURRENT layout's set only — the other layout keeps its
      // curation (SUB-642)
      writeLayoutHidden([]);
    }
  };
  // SUB-404: remembered column widths (prop → px, `title` = the Name column)
  // and the wrap set. Both live on the pref like the sort, so they persist
  // through views.json in db mode and ride the session-local svPref in a pin.
  const widths = useMemo(
    () => normalizedPref?.widths ?? {},
    [normalizedPref?.widths]
  );
  const wrapSet = useMemo(
    () => new Set(normalizedPref?.wrap ?? []),
    [normalizedPref?.wrap]
  );
  const toggleWrap = (key: string) => {
    const cur = normalizedPref?.wrap ?? [];
    const next = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    patchPref({ wrap: next.length > 0 ? next : undefined });
  };
  // SUB-607: vertical column rules. The db's own override wins; without one
  // the table follows the global `db-grid` setting. Toggling back to the
  // global value clears the override rather than pinning it, so the database
  // keeps following the global from then on.
  const gridOn = normalizedPref?.grid ?? gridDefault;
  const toggleGrid = () => {
    const next = !gridOn;
    patchPref({ grid: next === gridDefault ? undefined : next });
  };
  const resetWidth = (key: string) => {
    const m = { ...(normalizedPref?.widths ?? {}) };
    delete m[key];
    patchPref({ widths: Object.keys(m).length > 0 ? m : undefined });
  };
  // A column's position in the rendered row: Name = 1, shown props follow.
  // 0 = not rendered (hidden prop with a stale width entry) — callers skip.
  const colIdx = (key: string) => {
    if (key === "title") return 1;
    const i = shown.indexOf(key);
    return i === -1 ? 0 : i + 2;
  };
  // The committed widths/wrap as one stylesheet over nth-child positions —
  // cheaper than per-cell inline styles (a windowed table repaints ~100 rows)
  // and the live drag can mutate a sibling stylesheet without re-rendering.
  // Only `.db-cell-txt` descendants are targeted, so group headers, spacer
  // rows and the draft row (no such span) never catch a rule.
  const colCss = useMemo(() => {
    const lines: string[] = [];
    for (const [k, w] of Object.entries(widths)) {
      const i = colIdx(k);
      if (i > 0 && w > 0) lines.push(colWidthRule(i, w));
    }
    for (const k of wrapSet) {
      const i = colIdx(k);
      if (i > 0)
        lines.push(
          `.db-table td:nth-child(${i}) .db-cell-txt { white-space: normal; overflow-wrap: anywhere; }`
        );
    }
    return lines.join("\n");
  }, [widths, wrapSet, shown]);
  /** Header drag handle (SUB-404): live width via a throwaway stylesheet —
      zero React re-renders while dragging — committed to the pref on mouseup.
      Double-click resets to auto (the handle's onDoubleClick). */
  const startResize = (key: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = colIdx(key);
    if (idx === 0) return;
    const th = (e.currentTarget as HTMLElement).closest("th");
    const startW = th?.getBoundingClientRect().width ?? 120;
    const startX = e.clientX;
    const style = document.createElement("style");
    document.head.appendChild(style);
    document.body.classList.add("col-resizing");
    let w = Math.round(startW);
    const onMove = (ev: MouseEvent) => {
      w = Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, startW + ev.clientX - startX)));
      style.textContent = colWidthRule(idx, w, true);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
      style.remove();
      // a no-move click (or dblclick's paired mousedowns) commits nothing
      if (Math.abs(w - startW) >= 1)
        patchPref({ widths: { ...(normalizedPref?.widths ?? {}), [key]: w } });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Save-view capture: the curation, only when it differs from the default
  // union — a plain save-with-all-columns writes no `columns` field. A pin
  // saved off a database with hidden props inherits them as a shown-list.
  const colCapture = pinMode
    ? colSel && !(colSel.length === columns.length && colSel.every((c, i) => c === columns[i]))
      ? colSel
      : undefined
    : hidden.size > 0
      ? shown
      : undefined;
  // the active curation for checkmarks and list subtitles; undefined = the
  // default union in both channels
  const curated = pinMode ? (colSel ? shown : undefined) : hidden.size > 0 ? shown : undefined;
  // SUB-79: multi-kind props can't group a board — the helper keeps them out
  // of the candidates and lands a stale views.json pref on a safe fallback.
  // Rollup props (SUB-678) can't group either — a board drag writes the
  // group prop on drop, and a derived column has no write path
  const groupBy = boardGroupBy(columns, typeSchema, normalizedPref?.group_by);
  const groupable = columns.filter((c) => {
    const kind = byFoldedKey(typeSchema, c)?.kind;
    return kind !== "multi" && kind !== "rollup";
  });
  // SUB-184: the table's own grouping key — no fallback; a table stays
  // ungrouped unless the pref names a still-groupable column
  const tableGroup = tableGroupBy(columns, typeSchema, normalizedPref?.table_group_by);

  // SUB-199: the active sort is an ordered key list (plain header click
  // replaces it, shift-click adds/cycles a secondary key) — empty = unsorted.
  // SUB-326: it lives on the pref, so a database's sort persists through
  // views.json while a pin's rides its session-local svPref (App's channel
  // split) and still only lands in the pin via "Save view…".
  const sorts = useMemo(
    () => normalizedPref?.sorts ?? [],
    [normalizedPref?.sorts]
  );
  // the filter bar: a SUB-7 query string over this database's notes (SUB-18)
  const [query, setQuery] = useState(initialQuery ?? "");
  const [namingView, setNamingView] = useState(false);
  // SUB-590: right-click on the pane's empty space — the create menu. Rows,
  // cards, chips and the header row all preventDefault in their own handlers
  // first (bubbling), so a prevented event means "already handled here".
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const bgMenuProps = {
    onContextMenu: (e: ReactMouseEvent) => {
      // text fields (filter, draft entry, cell edits) keep the native menu —
      // and while ANY of them is live (isTypingNow), the menu stands down
      // entirely: taking focus would blur-commit the half-typed value
      if (e.defaultPrevented || isTyping(e.target) || isTypingNow()) return;
      e.preventDefault();
      setBgMenu({ x: e.clientX, y: e.clientY });
    },
  };
  // completion chips are a typing aid — hidden unless the input has focus,
  // so an opened pin doesn't flash a stray row under its query
  const [filterFocused, setFilterFocused] = useState(false);
  // the funnel toggle: the filter row renders only while it has content, is
  // focused, or was toggled open — an empty untouched bar reclaims its space
  const [filterOpen, setFilterOpen] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  // SUB-272: table row multi-select — the selected rows' paths plus the
  // anchor (last clicked row), stored as a path and resolved to a rows index
  // at click time so a re-sort can't strand a numeric index
  const [sel, setSel] = useState<ReadonlySet<string>>(EMPTY_SEL);
  const [selAnchor, setSelAnchor] = useState<string | null>(null);
  // the bulk bar's popovers: first the column picker, then the picked
  // column's kind editor (checkbox columns get a two-choice menu instead —
  // they have no value editor in the single-cell machinery either)
  const [bulkColMenu, setBulkColMenu] = useState<AnchorRect | null>(null);
  const [bulkEdit, setBulkEdit] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  const [bulkCheck, setBulkCheck] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  // multi/relation bulk edits commit live like the cell editors; the list
  // being built across toggles lives here (starts empty = replace semantics —
  // the picker states that plainly and every write toasts, SUB-635)
  const [bulkVals, setBulkVals] = useState<string[]>([]);
  // SUB-194: gates the frozen Name column's edge cue — true only while the
  // table's scroller is off its left stop
  const [scrolledX, setScrolledX] = useState(false);
  // SUB-195: gates the right-edge fade — true only while columns hide past
  // the scroller's right edge (never at max scroll, never when it fits)
  const [moreRight, setMoreRight] = useState(false);
  // gates the view-tab strip's right-edge fade — true only while tabs hide
  // past the strip's right edge (same cue idiom as SUB-195)
  const [tabsMore, setTabsMore] = useState(false);
  const [iconMenu, setIconMenu] = useState<AnchorRect | null>(null);
  const [groupMenu, setGroupMenu] = useState<AnchorRect | null>(null);
  const [editCell, setEditCell] = useState<{
    path: string;
    key: string;
    anchor: AnchorRect;
  } | null>(null);
  // cell whose kind/options editor was opened from a date/file menu
  const [schemaEditCell, setSchemaEditCell] = useState(false);
  // file-kind cell targets: value → does it exist on disk (broken-link state)
  const [fileOk, setFileOk] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const vals = new Set<string>();
    for (const [prop, ps] of Object.entries(typeSchema)) {
      if (ps.kind !== "file") continue;
      for (const n of notes) {
        const v = foldedPropStr(n.props, prop);
        if (v) vals.add(v);
      }
    }
    if (vals.size === 0) return;
    let gone = false;
    Promise.all([...vals].map((v) => pathExists(v).then((ok) => [v, ok] as const)))
      .then((pairs) => {
        if (!gone) setFileOk(Object.fromEntries(pairs));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [notes, typeSchema]);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState<string | null>(null); // null = no draft entry
  // SUB-243: the board column hosting the open draft — its group value rides
  // into commitNew so the card is born in the column it was titled in.
  // null = no column context (non-board layouts); `value: null` = the "No …"
  // column (the entry is born without the group prop).
  const [newCol, setNewCol] = useState<{ value: string | null } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // SUB-43: the ＋ add-property popover, and a column's schema editor opened
  // from the header caret (both anchored at the header cell they came from)
  const [addPropAt, setAddPropAt] = useState<AnchorRect | null>(null);
  const [editSchemaCol, setEditSchemaCol] = useState<{ col: string; anchor: AnchorRect } | null>(
    null
  );
  const [colMenu, setColMenu] = useState<{ col: string; anchor: AnchorRect } | null>(null);
  // SUB-326: the property-visibility checklist, opened by right-click on the
  // table header row (anchored where the click landed)
  const [propVisAt, setPropVisAt] = useState<AnchorRect | null>(null);
  // SUB-74: the aggregation picker, opened from a footer cell (up) or the
  // column header caret's "Calculate…" (down)
  const [aggMenu, setAggMenu] = useState<{ col: string; anchor: AnchorRect; up: boolean } | null>(
    null
  );
  const seenSignal = useRef(newSignal);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dotsWrapRef = useRef<HTMLSpanElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // opening the filter via the funnel lands the caret in the input
  useEffect(() => {
    if (filterOpen) filterInputRef.current?.focus();
  }, [filterOpen]);

  // the tab strip's fade tracks its scroll position and the tab count
  useEffect(() => {
    const el = tabsRef.current;
    if (el) setTabsMore(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [savedViews, activeViewId]);

  // open the title draft: a board column passes itself so the new card is
  // born with its group value (SUB-243); other entry points pass the first
  // column (the keyboard path's default) or nothing outside the board
  const startDraft = (col?: { value: string | null }) => {
    setNewCol(col ?? null);
    setNewTitle((cur) => cur ?? "");
  };

  // ⌘N while this database is the active view opens the draft entry
  useEffect(() => {
    if (newSignal !== seenSignal.current) {
      seenSignal.current = newSignal;
      startDraft(layout === "board" ? boardCols[0] : undefined);
    }
  }, [newSignal]);

  // new entries land in the type's home folder when one is set (SUB-85),
  // else where most of the type already lives
  const homeFolder = useMemo(() => homeFolderFor(notes, typeHome(typeSchema)), [notes, typeSchema]);

  // SUB-564: the create/export lanes used to end on `.catch(console.error)`,
  // so an engine refusal — a title holding [ or ], an unwritable home folder,
  // a refused export — cleared the editor and told the user nothing. Same
  // silence SUB-240 removed from the cell writes, one lane over. Anything
  // that can fail after its editor has closed reports through here.
  const reportFailure = (what: string) => (err: unknown) => {
    onToast?.(`couldn’t ${what} — ${err instanceof Error ? err.message : String(err)}`);
  };

  const commitNew = () => {
    const t = (newTitle ?? "").trim();
    const col = newCol; // captured before the draft state clears (SUB-243)
    const q = query; // for the post-create visibility check (SUB-234)
    setNewTitle(null);
    setNewCol(null);
    if (!t) return;
    // born complete (SUB-17): schema-default empty chips + the type's
    // template instantiated, written in one create
    const date = todayIso();
    vaultTemplateRead(dbType)
      .then((tpl) => {
        let props = buildEntryProps({ typeSchema, typeNotes: notes, template: tpl, title: t, date });
        // born under an active filter: simple bare key:value terms pin the
        // new entry's props so it stays visible (SUB-234)
        for (const [k, v] of filterInherits(parsedQuery.filters))
          props = mergeEntryProp(props, k, v);
        // the hosting column's group value wins over template/schema
        // defaults AND the filter inherit, so the card is born in the column
        // it was titled in (SUB-243); the "No …" column overrides to empty
        if (groupBy && col) props = mergeEntryProp(props, groupBy, col.value ?? "");
        return vaultCreate(t, homeFolder, dbType, props, buildEntryBody(tpl, t, date));
      })
      .then((m) => {
        setPendingFocus(m.path);
        onMutated();
        // still hidden (a text term, a skipped filter shape)? Say so —
        // otherwise the create looks dropped (SUB-234)
        if (q.trim() && filterByQuery([m], q, undefined, typeSchema).length === 0)
          onToast?.(`Created “${t}” — hidden by filter`);
      })
      .catch(reportFailure(`create “${t}”`));
  };

  const draftInput = (
    <input
      className="db-draft-input"
      autoFocus
      placeholder={`New ${dbType}…`}
      value={newTitle ?? ""}
      onChange={(e) => setNewTitle(e.target.value)}
      onBlur={commitNew}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitNew();
        if (e.key === "Escape") {
          setNewTitle(null);
          setNewCol(null);
        }
      }}
    />
  );

  // the notes the current filter query lets through; columns stay derived
  // from the full set so a narrow filter doesn't collapse the table.
  // dispNotes carries the derived rollup values (SUB-678), so a filter can
  // match a rollup column like any other
  const visible = useMemo(
    () => filterByQuery(dispNotes, query, undefined, typeSchema),
    [dispNotes, query, typeSchema]
  );
  const parsedQuery = useMemo(() => parseQuery(query, undefined, typeSchema), [query, typeSchema]);
  // a filter hiding every row swaps the body for the "No matches" empty state
  // (noMatch below) — the board's branch unmounts its scroller for it, so the
  // SUB-194/195 fade sync effect re-runs on this flag to re-attach
  const filterEmpty = visible.length === 0 && query.trim() !== "" && newTitle === null;
  // SUB-266: why the filter dead-ended — one muted line under "No matches",
  // clickable when there's a corrected query to apply
  const deadEndHint = useMemo(
    () => (filterEmpty ? filterDeadEndHint(dispNotes, columns, typeSchema, query) : null),
    [filterEmpty, dispNotes, columns, typeSchema, query]
  );
  const completions = useMemo(() => {
    if (!parsedQuery.trailing) return [];
    const source = parsedQuery.filters.length
      ? dispNotes.filter((n) => matchesFilters(n, parsedQuery.filters, undefined, typeSchema))
      : dispNotes;
    return filterCompletions(source, parsedQuery.trailing.key, parsedQuery.trailing.partial);
  }, [dispNotes, parsedQuery, typeSchema]);

  // placeholder teaches the filter syntax with a real example from this
  // database's schema — a made-up key would just mislead
  const filterHint = useMemo(() => {
    for (const [key, schema] of Object.entries(typeSchema)) {
      // the type's record also carries reserved db metadata (icon/home) that
      // is NOT a PropSchema — real schema.json has it, the mock used to lack
      // it, and this loop crashed every db view on vaults with icons (0.8.0)
      if (!schema || typeof schema !== "object" || !Array.isArray(schema.options)) continue;
      const first = schema.options[0]?.value;
      if (first && !/\s/.test(first)) return `Filter — try ${key}:${first}`;
    }
    return "Filter…";
  }, [typeSchema]);

  // lexicographic over the key list (SUB-199): key 1 decides, ties fall
  // through to key 2, then 3 — per-key semantics live in lib/dbsort, where
  // select-kind keys compare by schema option order (SUB-309), not A→Z
  const sortCmp = useMemo(() => sortCmpFor(sorts, typeSchema), [sorts, typeSchema]);
  // SUB-265: with no active sort the view rests on title order — stable
  // across prop edits, unlike the vault_list feed (updated_ms desc), which
  // teleported an edited row to the top mid-edit
  const viewCmp = sortCmp ?? restingCmp;

  // SUB-184: a grouped table interleaves section header rows between runs of
  // data rows. `rows` stays the flat, focus-addressable sequence — sections
  // in option order, the view's sort within each — and `rowGroups` marks
  // where each section starts and how long it runs, so keyboard nav, Enter
  // and CSV export work on `rows` exactly as before.
  const { rows, rowGroups } = useMemo(() => {
    const apply = (ns: NoteMeta[]) => [...ns].sort(viewCmp);
    if (layout !== "table" || !tableGroup) return { rows: apply(visible), rowGroups: null };
    const rowGroups: { value: string | null; start: number; count: number }[] = [];
    const rows: NoteMeta[] = [];
    for (const g of tableGroups(visible, tableGroup, byFoldedKey(typeSchema, tableGroup)?.options ?? [], typeSchema)) {
      const sorted = apply(g.notes);
      rowGroups.push({ value: g.value, start: rows.length, count: sorted.length });
      rows.push(...sorted);
    }
    return { rows, rowGroups };
  }, [layout, tableGroup, visible, typeSchema, viewCmp]);

  /* SUB-310: large tables paint lazily. Above WIN_MIN rows the tbody renders
     only the scroll viewport ± WIN_OVERSCAN rows; spacer rows before and
     after keep the scroll height exact, so the scrollbar, sticky header and
     sticky footer behave like a full render. Everything semantic — keyboard
     nav, multi-select ranges, CSV export, footer aggregates, group
     partitioning — already operates on `rows`, not the DOM, so it is
     untouched. Below WIN_MIN the table renders whole: small tables never see
     a spacer (their asserted e2e row counts stay exact).
     Rows are uniform-height by CSS (.db-cell-txt is nowrap), so one measured
     row height + the group-header height derives every row's offset. */
  // SUB-404: a wrapped column breaks the uniform-row-height assumption the
  // offset math above rests on — wrap opts the table out of windowing (the
  // full render is the price of wrapped cells; toggling wrap off restores it)
  const wrapActive = wrapSet.has("title") || shown.some((c) => wrapSet.has(c));
  const windowed = layout === "table" && rows.length > WIN_MIN && !wrapActive;
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const [winMetrics, setWinMetrics] = useState({
    rowH: WIN_ROW_H,
    groupH: WIN_ROW_H,
    draftH: WIN_ROW_H,
    headH: WIN_HEAD_H,
    tbodyTop: 0,
  });

  // rowTops[r] = the row's offset inside the tbody (the draft row leads when
  // open, group headers interleave); tbodyTotal is the full-height tbody the
  // spacers stand in for. Rows re-sort on every refresh, but offsets only
  // move with the row COUNT, the grouping and the measured heights.
  const { rowTops, tbodyTotal } = useMemo(() => {
    const tops = new Array<number>(rows.length);
    const gs = rowGroups ?? [];
    let gi = 0;
    let acc = newTitle !== null ? winMetrics.draftH : 0;
    for (let r = 0; r < rows.length; r++) {
      while (gi < gs.length && gs[gi].start <= r) {
        acc += winMetrics.groupH;
        gi++;
      }
      tops[r] = acc;
      acc += winMetrics.rowH;
    }
    return { rowTops: tops, tbodyTotal: acc };
  }, [rows.length, rowGroups, winMetrics, newTitle !== null]);

  // the window [start, end) covering the scroll viewport ± overscan. Binary
  // searches over rowTops; a no-change result bails out of re-render, so
  // this is safe to call from every scroll event.
  const winSync = () => {
    const body = bodyRef.current;
    if (!body || !windowed) return;
    const n = rows.length;
    const over = WIN_OVERSCAN * winMetrics.rowH;
    const v0 = body.scrollTop - winMetrics.tbodyTop - over;
    const v1 = body.scrollTop - winMetrics.tbodyTop + body.clientHeight + over;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (rowTops[m] <= v0) lo = m + 1;
      else hi = m;
    }
    const start = Math.max(0, lo - 1);
    lo = start;
    hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (rowTops[m] < v1) lo = m + 1;
      else hi = m;
    }
    const end = Math.max(start + 1, Math.min(lo, n));
    setWin((cur) => (cur && cur.start === start && cur.end === end ? cur : { start, end }));
  };
  // same fresh-ref idiom as exportNow below: scroll/resize handlers and the
  // focus effect always reach the latest closure without re-subscribing
  const winSyncRef = useRef(winSync);
  winSyncRef.current = winSync;

  // window state is only valid for the row set that produced it: a stale
  // mid-table window paired with a clamped scrollTop mounts the wrong slice
  // for a frame. Reset on db/layout switches and when windowing drops out.
  useEffect(() => {
    setWin(null);
  }, [layout, dbType, windowed]);

  // measure the real row/header geometry once rows paint, then re-window.
  // Deliberately a PASSIVE effect, not a layout effect: the fallback metrics
  // make the first frame accurate to the pixel, and a layout effect's
  // synchronous re-render chain measurably delays first paint on big tables
  // (SUB-310 probe: 148ms → 260ms on the empty→full filter flip in dev)
  useEffect(() => {
    if (!windowed) return;
    const body = bodyRef.current;
    const tbody = body?.querySelector("tbody");
    if (!body || !tbody) return;
    const rowH =
      tbody
        .querySelector("tr:not(.db-group-tr):not(.db-win-spacer):not(.db-draft-tr)")
        ?.getBoundingClientRect().height || WIN_ROW_H;
    const groupH =
      tbody.querySelector("tr.db-group-tr")?.getBoundingClientRect().height || rowH;
    const draftH =
      tbody.querySelector("tr.db-draft-tr")?.getBoundingClientRect().height || rowH;
    const headH = body.querySelector("thead")?.getBoundingClientRect().height || WIN_HEAD_H;
    const tbodyTop =
      tbody.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    setWinMetrics((cur) =>
      Math.abs(cur.rowH - rowH) < 0.5 &&
      Math.abs(cur.groupH - groupH) < 0.5 &&
      Math.abs(cur.draftH - draftH) < 0.5 &&
      Math.abs(cur.headH - headH) < 0.5 &&
      Math.abs(cur.tbodyTop - tbodyTop) < 0.5
        ? cur
        : { rowH, groupH, draftH, headH, tbodyTop }
    );
    winSyncRef.current();
  }, [windowed, rows.length, rowGroups, newTitle === null, winMetrics]);

  // SUB-561: the footer answers "how many notes, and what do their values add
  // up to" — one answer per note, not per group membership. Grouping by a
  // list-valued prop (tags, a multi-target relation) puts a note in every
  // section it belongs to, so `rows` holds it several times; a Sum that grows
  // when you group the same notes is wrong under any reading. Display,
  // windowing and focus keep the flat sequence; only the tally is deduped.
  const tallied = useMemo(() => (rowGroups ? distinctNotes(rows) : rows), [rows, rowGroups]);

  // SUB-74 footer: chosen aggregations (column → kind) and their computed
  // values over the visible (filtered, sorted) notes
  const aggs = useMemo(
    () => normalizedPref?.aggregations ?? {},
    [normalizedPref?.aggregations]
  );
  const hasAggs = Object.keys(aggs).length > 0;
  const aggResults = useMemo(() => {
    return aggregateColumns(aggs, (col) =>
      tallied.map((n) => foldedPropStr(n.props, col) ?? "")
    );
  }, [aggs, tallied]);

  const setAgg = (col: string, kind: AggKind | null) => {
    const next = updateAggregation(aggs, col, kind);
    patchPref({ aggregations: Object.keys(next).length > 0 ? next : undefined });
  };

  const boardCols = useMemo(() => {
    if (!groupBy) return [];
    const { none, take } = bucketByProp(visible, groupBy, typeSchema);
    // schema'd grouping: every defined option is a column in option order,
    // empty ones included (they're drop targets); unknown values follow
    const options = byFoldedKey(typeSchema, groupBy)?.options ?? [];
    const cols: { value: string | null; notes: NoteMeta[] }[] = [];
    for (const o of options) {
      cols.push({ value: o.value, notes: take(o.value).sort(viewCmp) });
    }
    // SUB-106: unschema'd values form columns from the FULL note set, so a
    // filter that hides every card empties the column instead of deleting it
    for (const v of extraValues(dispNotes, groupBy, options, typeSchema)) {
      cols.push({ value: v, notes: take(v).sort(viewCmp) });
    }
    // SUB-168: the "No …" column (drop target for clearing the prop) only
    // exists while at least one visible card actually lacks the prop — when
    // every card is grouped it would be a dead column leading the board
    if (none.length > 0) cols.unshift({ value: null, notes: none.sort(viewCmp) });
    return cols;
  }, [dispNotes, visible, groupBy, typeSchema, viewCmp]);

  const focusAt = (c: number, r: number): Focus | null => {
    const path = layout === "board" ? boardCols[c]?.notes[r]?.path : rows[r]?.path;
    return path ? { c, r, path } : null;
  };

  // Coordinates are paint details; note identity is durable. Sorting,
  // filtering, grouping, and a board drag can all relocate the focused note.
  // Follow it to its new coordinate, or clear focus when it left the view.
  useEffect(() => {
    if (!focus) return;
    if (layout === "board") {
      for (let c = 0; c < boardCols.length; c++) {
        const r = boardCols[c].notes.findIndex((n) => n.path === focus.path);
        if (r === -1) continue;
        if (focus.c !== c || focus.r !== r) setFocus({ c, r, path: focus.path });
        return;
      }
      setFocus(null);
      return;
    }
    const r = rows.findIndex((n) => n.path === focus.path);
    if (r === -1) {
      setFocus(null);
      return;
    }
    const c = layout === "table" ? Math.min(focus.c, shown.length) : 0;
    if (focus.c !== c || focus.r !== r) setFocus({ c, r, path: focus.path });
  }, [layout, rows, boardCols, shown.length, focus]);

  // keep the focused cell/card on screen. A windowed table keeps most rows
  // out of the DOM (SUB-310): when the focused cell isn't rendered, scroll to
  // its computed offset instead — the same block:"nearest" semantics — and
  // winSync repaints the window around it (the Enter-to-edit path then finds
  // the cell). Rendered cells keep the exact pre-windowing behavior.
  useEffect(() => {
    if (!focus) return;
    const active = document.activeElement;
    const compositeOwnsFocus =
      active === document.body ||
      (active instanceof HTMLElement && active.matches("[data-fc][data-fr]"));
    // A stale coordinate may remain while Tab has moved to a header/link.
    // Window re-paints must never steal focus back from that native control.
    if (!compositeOwnsFocus || editCell) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-fc="${focus.c}"][data-fr="${focus.r}"]`
    );
    // A data change renders before the identity-reconciliation effect can
    // update coordinates. Never focus a different note during that frame.
    if (el?.dataset.focusPath !== focus.path) return;
    if (el) {
      // The composite's focus used to be paint-only: arrows moved the accent
      // class while document.activeElement stayed on <body>. Move real DOM
      // focus with the roving tab stop so AT announces the active card/cell.
      // An open cell editor owns focus until it closes (SUB-359).
      if (active !== el) el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (!windowed) return;
    const body = bodyRef.current;
    if (!body || focus.r < 0 || focus.r >= rowTops.length) return;
    const top = winMetrics.tbodyTop + rowTops[focus.r];
    const bottom = top + winMetrics.rowH;
    const lo = body.scrollTop + winMetrics.headH;
    const hi = body.scrollTop + body.clientHeight;
    if (top < lo) body.scrollTop = top - winMetrics.headH;
    else if (bottom > hi) body.scrollTop = bottom - body.clientHeight;
    winSyncRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, win, editCell]);

  // SUB-194/195: layout/db switches remount or re-fill the scroller — re-sync
  // the fade/cue gates from the live DOM node, not stale state. ResizeObserver
  // covers geometry changes that fire no scroll event: the sidebar/window
  // resizing clientWidth, the table outgrowing the pane when a property is
  // added (its own box moves scrollWidth).
  useEffect(() => {
    const body = bodyRef.current;
    const sync = () => {
      setScrolledX((body?.scrollLeft ?? 0) > 0);
      setMoreRight(body ? body.scrollLeft < body.scrollWidth - body.clientWidth - 1 : false);
      // a resized scroller shows a different row band — re-window (SUB-310)
      winSyncRef.current();
    };
    sync();
    if (!body) return;
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    return () => ro.disconnect();
  }, [layout, dbType, filterEmpty]);

  // once a just-created note shows up in the view, move focus onto its row/card
  useEffect(() => {
    if (!pendingFocus) return;
    if (layout === "board") {
      for (let c = 0; c < boardCols.length; c++) {
        const r = boardCols[c].notes.findIndex((n) => n.path === pendingFocus);
        if (r !== -1) {
          setFocus({ c, r, path: pendingFocus });
          setPendingFocus(null);
          return;
        }
      }
    } else {
      const r = rows.findIndex((n) => n.path === pendingFocus);
      if (r !== -1) {
        setFocus({ c: 0, r, path: pendingFocus });
        setPendingFocus(null);
      }
    }
  }, [pendingFocus, layout, rows, boardCols]);

  // exports what the table shows: current columns, view filter, current sort.
  // One row per NOTE, not per group membership (SUB-563): grouping
  // is a view-only concern, so a grouped export is byte-identical to the same
  // view's ungrouped one. The flat `rows` still go in — buildCsv owns the
  // de-duplication (the footer's, SUB-561), keeping every export path on one
  // rule; a note in two sections lands once, at its first on-screen position.
  const doExportCsv = () => {
    exportDbCsv(dbType, shown, rows).catch(reportFailure("export"));
  };
  const exportNow = useRef(doExportCsv);
  exportNow.current = doExportCsv;
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = () => exportNow.current();
    return () => {
      exportRef.current = null;
    };
  }, [exportRef]);

  // plain click replaces the sort (asc → desc → none); shift-click adds or
  // cycles a secondary key — the state machine lives in lib/dbsort (SUB-199)
  const cycleSort = (key: string, additive: boolean) => {
    const next = cycleSortKeys(sorts, key, additive);
    patchPref({ sorts: next.length > 0 ? next : undefined });
  };

  const startEdit = (path: string, key: string, el: Element | null | undefined) => {
    if (!el) return;
    setEditCell({ path, key, anchor: anchorFrom(el) });
  };

  // SUB-240: one funnel for cell writes — a failure used to die on the
  // console after the editor had already closed; now it surfaces on App's
  // toast and re-syncs, so the grid never implies the write landed.
  // Resolves whether the write landed so callers can chain follow-ups
  // (SUB-273's drag-move toast only shows on success)
  const writeCell = (
    path: string,
    key: string,
    value: string | string[] | boolean | null,
    // pre-minted id when the caller wants to point a toast at this exact entry
    id?: number
  ): Promise<boolean> => {
    const props = notes.find((n) => n.path === path)?.props ?? {};
    const actualKey = foldedPropKey(props, key);
    // SUB-477: through the undoable helper, so a mis-typed cell is one ⌘Z away
    return setPropUndoable({ path, key: actualKey, value, id, record: undo.record, keyLabel: displayColLabel(key) })
      .then(() => {
        onMutated();
        return true;
      })
      .catch((err) => {
        onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
        onMutated();
        return false;
      });
  };

  // SUB-636: typed text lands canonical for number-kind columns — the app
  // renders de-DE ("1.234,56 €"), so retyping what it shows must not read as
  // en-style 1.234. Every other kind keeps its text verbatim.
  const commitText = (key: string, value: string): string =>
    byFoldedKey(typeSchema, key)?.kind === "number" ? normalizeNumberInput(value) : value;

  const commitCell = (raw: string | null) => {
    if (!editCell) return;
    const { path, key } = editCell;
    const value = raw === null ? null : commitText(key, raw);
    setEditCell(null);
    setSchemaEditCell(false);
    const props = notes.find((n) => n.path === path)?.props ?? {};
    const actualKey = foldedPropKey(props, key);
    const cur = foldedPropStr(props, key) ?? "";
    if ((value ?? "") === cur) return;
    // a column with no list-shaped kind falls back to this raw text editor,
    // but the prop underneath may still hold a YAML list — the editor seeds
    // from propStr, which joins it to "Vinyl, Digital". Writing that text
    // back as a scalar collapsed the list on a save that reported success
    // (SUB-557, the table half of SUB-553's chip fix). null still clears.
    writeCell(path, key, value === null ? null : chipCommitValue(props[actualKey], value));
  };

  // list-valued cells (relation, multi — SUB-79) commit live as the picker
  // toggles (menu stays open); current values re-read from the latest notes
  // each commit
  const commitListCell = (path: string, key: string, values: string[]) => {
    writeCell(path, key, propListValue(values));
  };

  // checkbox cells (SUB-173): one click toggles and saves immediately, no
  // editor popup — checked stores the YAML scalar `true`, unchecked REMOVES
  // the prop (never writes `false`); a stored `false` reads as unchecked
  const toggleCheckboxCell = (path: string, key: string) => {
    const props = notes.find((n) => n.path === path)?.props ?? {};
    const cur = props[foldedPropKey(props, key)] === true;
    writeCell(path, key, cur ? null : true);
  };

  // SUB-272: row multi-select. ⌘/ctrl-click toggles one row, shift-click
  // ranges from the anchor (last clicked row) over `rows` indices — a grouped
  // table interleaves header rows in the DOM, so siblings would lie. Plain
  // clicks keep today's behavior and end any selection (the callers below).
  const clearSel = () => {
    setSel(EMPTY_SEL);
    setSelAnchor(null);
    setBulkColMenu(null);
    setBulkEdit(null);
    setBulkCheck(null);
  };

  const selClick = (r: number, path: string, range: boolean) => {
    if (range) {
      const aIdx = selAnchor === null ? -1 : rows.findIndex((n) => n.path === selAnchor);
      if (aIdx !== -1) {
        // anchor survives re-sorts as a path; the range replaces the selection
        setSel(rangePaths(rows, aIdx, r));
        return;
      }
      // no live anchor yet (fresh table, or it was renamed away): the shift
      // click behaves like a plain toggle of the clicked row
      setSel(new Set([path]));
      setSelAnchor(path);
      return;
    }
    setSel((cur) => togglePath(cur, path));
    setSelAnchor(path);
  };

  // a plain cell click: today's behavior — plus it re-anchors and ends any
  // active selection. `go` is the cell's own action (open note / start edit).
  const plainCellClick = (path: string, go: () => void) => {
    setSel(EMPTY_SEL);
    setSelAnchor(path);
    go();
  };

  // the selection dies with the view: layout flips and database switches
  // remount the row set, so stale paths would point at nothing
  useEffect(() => {
    clearSel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dbType]);

  // …and a refresh prunes rows that vanished (a rename changes the path, so
  // without this a stale selection would linger on a row that no longer is)
  useEffect(() => {
    setSel((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(rows.map((n) => n.path));
      const next = new Set([...cur].filter((p) => live.has(p)));
      return next.size === cur.size ? cur : next;
    });
  }, [rows]);

  // Escape clears the selection FIRST — before the pane's focus-clear and
  // App's esc-close, both bubble-phase listeners registered earlier, so only
  // a capture listener can preempt them. Menus/overlays own their own Esc:
  // while one is in the DOM this stays out of the way. ⌘⌫ rides the same
  // capture slot (SUB-392): with rows selected it trashes the selection —
  // ahead of App's single-note trash-note shortcut.
  useEffect(() => {
    if (sel.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const bulkTrash =
        e.key === "Backspace" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (e.key !== "Escape" && !bulkTrash) return;
      if (isTyping(e.target)) return;
      if (document.querySelector(".overlay, .selmenu, .colmenu, .dots-menu")) return;
      e.preventDefault();
      e.stopPropagation();
      const paths = [...sel];
      setSel(EMPTY_SEL);
      setSelAnchor(null);
      if (bulkTrash) onTrashNotes(paths);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel, onTrashNotes]);

  // bulk bar writes: one vaultSetProp per selected path (no bulk IPC), ONE
  // refresh at the end. SUB-477: N writes record ONE undo entry, so the
  // app's most destructive everyday action takes a single ⌘Z to reverse.
  // SUB-635: success toasts too — a live multi/relation write REPLACES each
  // note's list, and a silent replace read as additive (the old failure-only
  // toast is why SUB-635 could bite); same wording as bulkCommit below.
  const bulkKeysByPath = (paths: string[], key: string): Record<string, string> =>
    Object.fromEntries(paths.map((path) => {
      const props = notes.find((n) => n.path === path)?.props ?? {};
      return [path, foldedPropKey(props, key)];
    }));

  const bulkWriteLive = (key: string, value: string | string[] | boolean | null) => {
    const paths = [...sel];
    if (paths.length === 0) return;
    const label = displayColLabel(key);
    setPropUndoableBulk({
      paths,
      key,
      keysByPath: bulkKeysByPath(paths, key),
      value,
      record: undo.record,
      keyLabel: label,
    }).then((res) => {
      const ok = res.ok.length;
      onMutated();
      onToast?.(
        ok < paths.length
          ? `Set ${ok} of ${paths.length} — ${paths.length - ok} failed`
          : value === null
            ? `Cleared ${label} on ${ok === 1 ? "1 note" : `${ok} notes`}`
            : `Set ${label} on ${ok === 1 ? "1 note" : `${ok} notes`}`
      );
    });
  };

  // one-shot bulk commit (select/text/date/file/url/…, checkbox): the write
  // consumes the selection and reports on App's toast
  const bulkCommit = (key: string, raw: string | string[] | boolean | null) => {
    // same number-kind normalization as the single-cell path (SUB-636): the
    // bulk editor is the same free-text SelectMenu over the same column
    const value = typeof raw === "string" ? commitText(key, raw) : raw;
    const paths = [...sel];
    setBulkEdit(null);
    setBulkCheck(null);
    clearSel();
    if (paths.length === 0) return;
    const label = displayColLabel(key);
    setPropUndoableBulk({ paths, key, keysByPath: bulkKeysByPath(paths, key), value, record: undo.record, keyLabel: label }).then((res) => {
      const ok = res.ok.length;
      onMutated();
      onToast?.(
        ok < paths.length
          ? `Set ${ok} of ${paths.length} — ${paths.length - ok} failed`
          : value === null
            ? `Cleared ${label} on ${ok === 1 ? "1 note" : `${ok} notes`}`
            : `Set ${label} on ${ok === 1 ? "1 note" : `${ok} notes`}`
      );
    });
  };

  // column picked in the bulk bar's picker: checkbox kinds get a Checked /
  // Unchecked choice (they have no value editor), everything else opens the
  // matching editor anchored where the picker was. A rollup column (SUB-678)
  // never reaches the picker — the bulk bar filters derived columns out
  // (they have no write path); the guard stays so a stale menu can't open
  // one either
  const pickBulkCol = (key: string, anchor: AnchorRect) => {
    const kind =
      byFoldedKey(typeSchema, key)?.kind ?? (isBuiltinDateName(key) ? "date" : undefined);
    if (kind === "rollup") return;
    if (kind === "checkbox") setBulkCheck({ key, anchor });
    else {
      setBulkVals([]);
      setBulkEdit({ key, anchor });
    }
  };

  const createRelationTarget = (path: string, key: string, targetDb: string, title: string) => {
    onCreateEntry(targetDb, title)
      .then((m) => {
        const props = notes.find((n) => n.path === path)?.props ?? {};
        const cur = propList(props, foldedPropKey(props, key));
        commitListCell(path, key, toggleValue(cur, m.title));
      })
      .catch(reportFailure(`create “${title}”`));
  };

  // SUB-273: a board drag used to commit silently — name the target column on
  // App's toast and offer an Undo. SUB-477: that Undo now pops the very entry
  // ⌘Z would pop (by id) rather than making its own inverse write, so the two
  // paths can't drift and undoing twice doesn't double-revert.
  const dropOn = (value: string | null) => {
    const path = dragPath;
    setDragPath(null);
    setDropCol(null);
    if (!path || !groupBy) return;
    const note = notes.find((n) => n.path === path);
    const cur = foldedPropStr(note?.props ?? {}, groupBy) || null;
    if (cur === value) return;
    const id = nextUndoId();
    writeCell(path, groupBy, value, id).then((ok) => {
      if (!ok) return;
      const label =
        value === null
          ? `No ${groupBy}`
          : displayValue(value, byFoldedKey(typeSchema, groupBy)?.kind, byFoldedKey(typeSchema, groupBy)?.format);
      onToast?.(`“${note?.title ?? path}” → ${label}`, {
        label: "Undo",
        run: () => undo.runById(id),
      });
    });
  };

  // arrows / hjkl move cell/card focus; Enter opens the note (or edits a
  // table cell); App hands database views this keyboard surface wholesale
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || editCell) return;
      // Header buttons, external links, and the named card/list controls own
      // native activation. Never apply Enter to a stale composite coordinate.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        (e.key === "Enter" || e.key === " ") &&
        target?.closest("button, a[href], [role='button'], summary")
      )
        return;
      const horiz =
        layout === "list" ? 0 : e.key === "ArrowRight" || e.key === "l" ? 1 : e.key === "ArrowLeft" || e.key === "h" ? -1 : 0;
      // gallery wraps a flat row index into a responsive grid — column count
      // comes from the rendered tracks, so nav always matches what's on screen
      const galleryCols = () => {
        const grid = bodyRef.current;
        if (!grid) return 1;
        return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      };
      const vert = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (horiz || vert) {
        e.preventDefault();
        const cur = focus ?? { c: 0, r: -1 };
        if (layout === "table") {
          const c = Math.min(Math.max(cur.c + horiz, 0), shown.length);
          const r = Math.min(Math.max(cur.r + vert, 0), rows.length - 1);
          setFocus(focusAt(c, r));
        } else if (layout === "board") {
          let { c, r } = cur;
          if (vert) {
            const len = boardCols[c]?.notes.length ?? 0;
            r = Math.min(Math.max(r + vert, 0), Math.max(len - 1, 0));
          } else {
            const nc = Math.min(Math.max(c + horiz, 0), boardCols.length - 1);
            const len = boardCols[nc]?.notes.length ?? 0;
            if (len > 0) {
              c = nc;
              r = Math.min(r < 0 ? 0 : r, len - 1);
            }
          }
          setFocus(focusAt(c, r));
        } else if (layout === "gallery") {
          let r = cur.r;
          if (cur.r === -1) r = 0;
          else if (horiz) r = Math.min(Math.max(cur.r + horiz, 0), rows.length - 1);
          else {
            const t = cur.r + vert * galleryCols();
            if (t >= 0 && t < rows.length) r = t;
            else if (vert > 0 && t < rows.length + galleryCols() - 1) r = rows.length - 1;
          }
          setFocus(focusAt(0, r));
        } else {
          const r = Math.min(Math.max(cur.r + vert, 0), rows.length - 1);
          setFocus(focusAt(0, r));
        }
        return;
      }
      if (e.key === "Enter" && focus) {
        e.preventDefault();
        if (layout === "table") {
          const n = rows[focus.r];
          if (!n) return;
          if (focus.c === 0) onOpenNote(n.path);
          else {
            const key = shown[focus.c - 1];
            const enterKind = byFoldedKey(typeSchema, key)?.kind;
            // checkbox cells toggle on Enter like they do on click — the raw
            // string editor never opens for them (SUB-173)
            if (enterKind === "checkbox") toggleCheckboxCell(n.path, key);
            // a rollup cell is derived (SUB-678) — read-only, no editor
            else if (enterKind !== "rollup")
              startEdit(
                n.path,
                key,
                bodyRef.current?.querySelector(`[data-fc="${focus.c}"][data-fr="${focus.r}"]`)
              );
          }
        } else if (layout === "board") {
          const n = boardCols[focus.c]?.notes[focus.r];
          if (n) onOpenNote(n.path);
        } else {
          const n = rows[focus.r];
          if (n) onOpenNote(n.path);
        }
        return;
      }
      if (e.key === "Escape" && focus) {
        setFocus(null);
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.matches("[data-fc][data-fr]")) active.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, shown, rows, boardCols, focus, editCell, onOpenNote]);

  const focusedCls = (c: number, r: number) =>
    focus && focus.c === c && focus.r === r ? " focused" : "";

  // One entry point per composite. Once focus enters, the active coordinate
  // alone stays tabbable and arrow/HJKL moves that real DOM focus (SUB-359).
  const tabIndexFor = (c: number, r: number) =>
    focus ? (focus.c === c && focus.r === r ? 0 : -1) : c === 0 && r === 0 ? 0 : -1;
  const boardTabIndexFor = (c: number, r: number) =>
    focus
      ? focus.c === c && focus.r === r
        ? 0
        : -1
      : r === 0 && boardCols.slice(0, c).every((col) => col.notes.length === 0)
        ? 0
        : -1;

  const head = (
    <div className="list-head" data-tauri-drag-region>
      <button
        className="db-icon-btn"
        title="Change icon"
        onClick={(e) => {
          // capture the anchor synchronously — currentTarget is null by the
          // time a deferred setState updater runs
          const anchor = anchorFrom(e.currentTarget);
          setIconMenu((cur) => (cur ? null : anchor));
        }}
      >
        <TypeIcon type={dbType} icon={icon} size={16} />
      </button>
      {iconMenu && (
        <IconPicker
          anchor={iconMenu}
          type={dbType}
          icon={icon}
          onSave={onSaveIcon}
          onClose={() => setIconMenu(null)}
        />
      )}
      {/* the title stays the database's inside a saved view — the pin's name
          rides its active tab below instead of replacing the identity row */}
      <span className="list-title">{dbType.charAt(0).toUpperCase() + dbType.slice(1)}</span>
      <span className="list-count">
        {query.trim() ? `${visible.length} of ${notes.length}` : notes.length}
      </span>
      {/* SUB-400: the kind word disambiguates this header from a folder's */}
      <span className="head-kind">Database</span>
    </div>
  );

  // the filter row renders only on demand: an active query, the naming flow,
  // keyboard focus, or the funnel toggle keep it on screen — an empty
  // untouched bar reclaims its vertical space
  const showFilter = namingView || query.trim() !== "" || filterOpen || filterFocused;

  // Row 2 — the Notion pattern: a view tab strip ("All" + one tab per saved
  // view, right-click = the pin's manage menu, ＋ = save-view naming) with
  // the consolidated icon-first tools right-aligned on the same row
  const tabRow = (
    <div className="db-tabrow">
      <div
        className={`db-tabs${tabsMore ? " db-more-x" : ""}`}
        ref={tabsRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setTabsMore(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
        }}
      >
        <button
          className={`db-tab${!activeViewId ? " active" : ""}`}
          title="All"
          aria-current={!activeViewId ? "page" : undefined}
          onClick={() => onOpenDb?.()}
        >
          All
        </button>
        {savedViews.map((v) => (
          <button
            key={v.id}
            className={`db-tab${v.id === activeViewId ? " active" : ""}`}
            title={v.name}
            aria-current={v.id === activeViewId ? "page" : undefined}
            onClick={() => onOpenView(v.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onViewMenu(v.id, e.clientX, e.clientY);
            }}
          >
            {v.name}
            {/* SUB-677: the pin's ⌘-digit rides its tab — the tab strip is the
                one surface every pin (homed database included) renders on */}
            {pinKeys[v.id] && <span className="key">{pinKeys[v.id]}</span>}
          </button>
        ))}
        <button className="db-tab-add" title="Save view…" onClick={() => setNamingView(true)}>
          <PlusIcon />
        </button>
      </div>
      <div className="db-tools">
        <div className="db-switch db-layouts">
          {(["list", "table", "board", "gallery"] as const).map((l) => (
            <button
              key={l}
              className={layout === l ? "active" : undefined}
              title={l.charAt(0).toUpperCase() + l.slice(1)}
              aria-label={l.charAt(0).toUpperCase() + l.slice(1)}
              onClick={() => patchPref({ view: l })}
            >
              {LAYOUT_ICON[l]}
            </button>
          ))}
        </div>
        {(layout === "board" || layout === "table") && groupable.length > 0 && (
          <label className="db-group">
            Group by
            <button
              className="db-group-btn"
              onClick={(e) => {
                // capture the anchor synchronously — currentTarget is null by
                // the time a deferred setState updater runs
                const anchor = anchorFrom(e.currentTarget);
                setGroupMenu((cur) => (cur ? null : anchor));
              }}
            >
              {layout === "board" ? groupBy : (tableGroup ?? "None")}
            </button>
          </label>
        )}
        {groupMenu && (layout === "board" || layout === "table") && (
          <SelectMenu
            anchor={groupMenu}
            value={layout === "board" ? (groupBy ?? "") : (tableGroup ?? "")}
            label="Group by"
            options={groupable.map((c) => ({ value: c }))}
            used={[]}
            canEditSchema={false}
            onCommit={(v) => {
              setGroupMenu(null);
              if (layout === "board") patchPref({ view: "board", group_by: v });
              else patchPref({ view: "table", table_group_by: v || undefined });
            }}
            onClear={
              layout === "table"
                ? () => {
                    setGroupMenu(null);
                    // a table has no fallback grouping — clear means ungrouped
                    patchPref({ view: "table", table_group_by: undefined });
                  }
                : undefined
            }
            onSaveSchema={() => {}}
            onClose={() => setGroupMenu(null)}
          />
        )}
        {(layout === "table" || layout === "list") && (
          <ColumnsMenu columns={columns} checked={curated ?? null} onToggle={toggleColumn} />
        )}
        <button
          className={`db-filter-toggle${showFilter ? " active" : ""}`}
          title="Filter"
          aria-label="Filter"
          onClick={() => setFilterOpen((o) => !o)}
        >
          <FilterIcon />
        </button>
        <span ref={dotsWrapRef}>
          <DotsMenu
            title="View actions"
            items={[
              {
                label: "Save view…",
                icon: <PinIcon />,
                run: () => setNamingView(true),
              },
              // SUB-607: per-database grid-lines override; the label states
              // the action, like the wrap toggle. Follows the global setting
              // until toggled away from it here.
              ...(layout === "table"
                ? [
                    {
                      label: gridOn ? "Hide grid lines" : "Show grid lines",
                      icon: <ColumnsIcon />,
                      run: toggleGrid,
                    },
                  ]
                : []),
              {
                label: "Add property…",
                icon: <PlusIcon />,
                run: () =>
                  setAddPropAt(dotsWrapRef.current ? anchorFrom(dotsWrapRef.current) : null),
              },
              { label: "Rename database…", icon: <PenIcon />, run: onRenameDb },
              { label: "Delete database…", icon: <TrashIcon />, run: onDeleteDb },
              { label: "Export CSV…", icon: <ExportIcon />, run: doExportCsv },
            ]}
          />
        </span>
        <button className="db-new" onClick={() => startDraft(layout === "board" ? boardCols[0] : undefined)} title="New entry (⌘N)">
          <PlusIcon />
          New
        </button>
      </div>
    </div>
  );

  // the filter bar (SUB-18): live narrowing as you type; "Save view…" swaps it
  // for a name field that pins the current query/sort/layout to the sidebar
  const filterBar = (
    <div className="db-filter">
      <FilterIcon />
      {namingView ? (
        <InlineEdit
          initial={saveViewSeed ?? ""}
          placeholder="Name this view…"
          onCommit={(name) => {
            setNamingView(false);
            onSaveView(name, { query: query.trim(), sorts, view: layout, groupBy, tableGroupBy: tableGroup, columns: colCapture });
          }}
          onCancel={() => setNamingView(false)}
        />
      ) : (
        <>
          <input
            className="db-filter-input"
            ref={filterInputRef}
            placeholder={filterHint}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFilterFocused(true)}
            onBlur={() => setFilterFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && parsedQuery.trailing && completions.length > 0) {
                e.preventDefault();
                setQuery(
                  completeFilter(query, parsedQuery.trailing.key, completions[0], parsedQuery.trailing.op)
                );
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (query) setQuery("");
                else {
                  // empty: close the bar outright (it may be funnel-opened)
                  setFilterOpen(false);
                  e.currentTarget.blur();
                }
              }
            }}
          />
          {query && (
            <>
              <button
                className="db-filter-save"
                onMouseDown={(e) => e.preventDefault() /* keep the input's focus */}
                onClick={() => setNamingView(true)}
                title="Pin this filter to the sidebar"
              >
                Save view
              </button>
              <button
                className="db-filter-clear"
                onClick={() => setQuery("")}
                title="Clear filter"
              >
                <XIcon />
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  const completionRow =
    !namingView && filterFocused && parsedQuery.trailing && completions.length > 0 ? (
      <div className="search-completions">
        {completions.map((v) => (
          <button
            key={v}
            className="search-completion"
            // keep the input's focus so the row doesn't vanish mid-click
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              setQuery(completeFilter(query, parsedQuery.trailing!.key, v, parsedQuery.trailing!.op))
            }
          >
            {filterLabel(parsedQuery.trailing!.key, parsedQuery.trailing!.op, [...parsedQuery.trailing!.values, v], parsedQuery.trailing!.neg)}
          </button>
        ))}
      </div>
    ) : null;

  const bar = (
    <>
      {showFilter && filterBar}
      {completionRow}
    </>
  );

  const noMatch = filterEmpty ? (
    <div className="empty">
      <span>No matches</span>
      {deadEndHint &&
        (deadEndHint.fixedQuery ? (
          <button
            type="button"
            className="empty-hint empty-hint-fix"
            title="Apply the corrected filter"
            onClick={() => setQuery(deadEndHint.fixedQuery!)}
          >
            {deadEndHint.text}
          </button>
        ) : (
          <span className="empty-hint">{deadEndHint.text}</span>
        ))}
    </div>
  ) : null;

  const draftRow =
    newTitle !== null ? <div className="row db-draft">{draftInput}</div> : null;

  // SUB-43 admin popovers — rendered in every layout branch: the ＋ add-
  // property form (anchored at the header ＋ or the view menu) and a column's
  // schema editor (anchored at its table header caret)
  const adminPop = (
    <>
      {addPropAt && (
        <PropForm
          anchor={addPropAt}
          existing={[...columns, "icon", "home"]}
          databases={dbTypes}
          rollupRelations={rollupRelations}
          rollupPropsFor={rollupPropsFor}
          onSave={(name, o, k, n, t, f, d, r) => {
            setAddPropAt(null);
            onSaveSchema(name, o, k, n, t, f, d, r);
          }}
          onClose={() => setAddPropAt(null)}
        />
      )}
      {colMenu && (
        <ColMenu
          anchor={colMenu.anchor}
          onClose={() => setColMenu(null)}
          items={[
            {
              label: "Calculate…",
              run: () => setAggMenu({ col: colMenu.col, anchor: colMenu.anchor, up: false }),
            },
            // SUB-404: per-column wrap toggle — the label states the action,
            // so a wrapped column offers "Clip text" and vice versa
            {
              label: wrapSet.has(colMenu.col) ? "Clip text" : "Wrap text",
              run: () => toggleWrap(colMenu.col),
            },
            // SUB-326: hides the column, never the data — the visibility
            // checklist (right-click the header) brings it back
            { label: "Hide property", icon: <EyeOffIcon />, run: () => toggleColumn(colMenu.col) },
            {
              label: "Edit schema…",
              icon: <PenIcon />,
              run: () => setEditSchemaCol({ col: colMenu.col, anchor: colMenu.anchor }),
            },
            { label: "Rename property…", icon: <PenIcon />, run: () => onRenameProp(colMenu.col) },
            { label: "Remove property…", icon: <TrashIcon />, run: () => onRemoveProp(colMenu.col) },
          ]}
        />
      )}
      {propVisAt && (
        <PropVisMenu
          anchor={propVisAt}
          columns={columns}
          shownSet={new Set(shown)}
          onToggle={toggleColumn}
          onShowAll={showAllColumns}
          onClose={() => setPropVisAt(null)}
        />
      )}
      {aggMenu && (
        <ColMenu
          anchor={aggMenu.anchor}
          up={aggMenu.up}
          onClose={() => setAggMenu(null)}
          items={[
            {
              label: `${aggregationKind(aggs, aggMenu.col) === undefined ? "✓ " : ""}None`,
              run: () => setAgg(aggMenu.col, null),
            },
            ...AGG_OPTIONS.map((o) => ({
              label: `${aggregationKind(aggs, aggMenu.col) === o.kind ? "✓ " : ""}${o.label}`,
              run: () => setAgg(aggMenu.col, o.kind),
            })),
          ]}
        />
      )}
      {editSchemaCol && (
        <SelectMenu
          anchor={editSchemaCol.anchor}
          value=""
          options={byFoldedKey(typeSchema, editSchemaCol.col)?.options ?? []}
          used={usedValues(editSchemaCol.col)}
          canEditSchema
          kind={byFoldedKey(typeSchema, editSchemaCol.col)?.kind}
          notify={byFoldedKey(typeSchema, editSchemaCol.col)?.notify}
          target={byFoldedKey(typeSchema, editSchemaCol.col)?.type}
          format={byFoldedKey(typeSchema, editSchemaCol.col)?.format}
          description={byFoldedKey(typeSchema, editSchemaCol.col)?.description}
          databases={dbTypes}
          rollupRelations={rollupRelations}
          rollupPropsFor={rollupPropsFor}
          rollup={editSchemaCol ? rollups[editSchemaCol.col] : undefined}
          startEditing
          onCommit={() => undefined}
          onSaveSchema={(o, k, n, t, f, d, r) => onSaveSchema(editSchemaCol.col, o, k, n, t, f, d, r)}
          onClose={() => setEditSchemaCol(null)}
        />
      )}
      {bgMenu && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          items={[
            {
              label: "New entry",
              icon: <PlusIcon />,
              hint: "⌘N",
              onSelect: () => startDraft(layout === "board" ? boardCols[0] : undefined),
            },
            {
              label: "Save view…",
              icon: <PinIcon />,
              onSelect: () => setNamingView(true),
            },
          ]}
          onClose={() => setBgMenu(null)}
        />
      )}
    </>
  );

  if (notes.length === 0) {
    return (
      <div className="db" {...bgMenuProps}>
        {head}
        {tabRow}
        {bar}
        {draftRow ? (
          <div className="db-body db-list">{draftRow}</div>
        ) : (
          <div className="empty">
            <DbGlyphIcon />
            <span>Nothing here yet</span>
            <span className="empty-hint">Notes in the “{dbType}” database show up here</span>
            <button className="empty-action" onClick={() => setNewTitle("")}>
              New entry
            </button>
          </div>
        )}
        {adminPop}
      </div>
    );
  }

  if (layout === "board") {
    return (
      <DbBoardLayout
        groupBy={groupBy}
        boardCols={boardCols}
        newTitle={newTitle}
        newCol={newCol}
        dbType={dbType}
        typeSchema={typeSchema}
        openPath={openPath}
        bgMenuProps={bgMenuProps}
        head={head}
        tabRow={tabRow}
        bar={bar}
        noMatch={noMatch}
        adminPop={adminPop}
        draftRow={draftRow}
        draftInput={draftInput}
        bodyRef={bodyRef}
        moreRight={moreRight}
        setMoreRight={setMoreRight}
        dragPath={dragPath}
        setDragPath={setDragPath}
        dropCol={dropCol}
        setDropCol={setDropCol}
        dropOn={dropOn}
        focusedCls={focusedCls}
        boardTabIndexFor={boardTabIndexFor}
        setFocus={setFocus}
        onOpenNote={onOpenNote}
        onNoteMenu={onNoteMenu}
        startDraft={startDraft}
      />
    );
  }

  if (layout === "gallery") {
    return (
      <DbGalleryLayout
        rows={rows}
        dbType={dbType}
        icon={icon}
        typeSchema={typeSchema}
        openPath={openPath}
        bgMenuProps={bgMenuProps}
        head={head}
        tabRow={tabRow}
        bar={bar}
        noMatch={noMatch}
        adminPop={adminPop}
        draftRow={draftRow}
        bodyRef={bodyRef}
        focusedCls={focusedCls}
        tabIndexFor={tabIndexFor}
        setFocus={setFocus}
        onOpenNote={onOpenNote}
        onNoteMenu={onNoteMenu}
      />
    );
  }

  if (layout === "list") {
    return (
      <DbListLayout
        rows={rows}
        typeSchema={typeSchema}
        curated={curated}
        openPath={openPath}
        bgMenuProps={bgMenuProps}
        head={head}
        tabRow={tabRow}
        bar={bar}
        noMatch={noMatch}
        adminPop={adminPop}
        draftRow={draftRow}
        bodyRef={bodyRef}
        focusedCls={focusedCls}
        tabIndexFor={tabIndexFor}
        setFocus={setFocus}
        onOpenNote={onOpenNote}
        onNoteMenu={onNoteMenu}
      />
    );
  }

  return (
    <DbTableLayout
      sorts={sorts}
      rows={rows}
      rowGroups={rowGroups}
      windowed={windowed}
      win={win}
      winMetrics={winMetrics}
      rowTops={rowTops}
      tbodyTotal={tbodyTotal}
      newTitle={newTitle}
      shown={shown}
      tableGroup={tableGroup}
      typeSchema={typeSchema}
      notes={notes}
      dbTypes={dbTypes}
      openPath={openPath}
      bgMenuProps={bgMenuProps}
      head={head}
      tabRow={tabRow}
      bar={bar}
      noMatch={noMatch}
      adminPop={adminPop}
      draftInput={draftInput}
      bodyRef={bodyRef}
      winSyncRef={winSyncRef}
      colCss={colCss}
      gridOn={gridOn}
      scrolledX={scrolledX}
      setScrolledX={setScrolledX}
      moreRight={moreRight}
      setMoreRight={setMoreRight}
      cycleSort={cycleSort}
      startResize={startResize}
      resetWidth={resetWidth}
      colMenu={colMenu}
      setColMenu={setColMenu}
      setPropVisAt={setPropVisAt}
      setAddPropAt={setAddPropAt}
      setAggMenu={setAggMenu}
      focusedCls={focusedCls}
      tabIndexFor={tabIndexFor}
      setFocus={setFocus}
      selClick={selClick}
      plainCellClick={plainCellClick}
      onOpenNote={onOpenNote}
      onNoteMenu={onNoteMenu}
      onTrashNotes={onTrashNotes}
      sel={sel}
      clearSel={clearSel}
      editCell={editCell}
      setEditCell={setEditCell}
      schemaEditCell={schemaEditCell}
      setSchemaEditCell={setSchemaEditCell}
      startEdit={startEdit}
      commitCell={commitCell}
      commitListCell={commitListCell}
      toggleCheckboxCell={toggleCheckboxCell}
      fileOk={fileOk}
      usedValues={usedValues}
      onSaveSchema={onSaveSchema}
      rollupRelations={rollupRelations}
      rollupPropsFor={rollupPropsFor}
      relationCandidates={relationCandidates}
      createRelationTarget={createRelationTarget}
      onCreateEntry={onCreateEntry}
      reportFailure={reportFailure}
      tallied={tallied}
      aggs={aggs}
      aggResults={aggResults}
      hasAggs={hasAggs}
      bulkColMenu={bulkColMenu}
      setBulkColMenu={setBulkColMenu}
      bulkCheck={bulkCheck}
      setBulkCheck={setBulkCheck}
      bulkEdit={bulkEdit}
      setBulkEdit={setBulkEdit}
      bulkVals={bulkVals}
      setBulkVals={setBulkVals}
      bulkCommit={bulkCommit}
      bulkWriteLive={bulkWriteLive}
      pickBulkCol={pickBulkCol}
    />
  );
}
