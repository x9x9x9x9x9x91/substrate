import { DEFAULT_NUMBER_LOCALE, type NumberLocale } from "../lib/numberLocale";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AggKind, DbIcon, DbLayout, NoteMeta, NumberFormat, PropKind, PropSchema, PropValue, RollupConfig, SavedView, SavedViewSort, SchemaConfig, SelectOption, ViewPref } from "../lib/types";
import { foldedPropKey, foldedPropStr, typeHome } from "../lib/types";
import { isTyping, isTypingNow } from "../lib/dom";
import {
  isDeadKey,
  isPrintableKey,
  nextEditableCell,
  type HopDir,
  type HopGrid,
} from "../lib/cellhop";
import { cycleSortKeys, restingCmp, sortCmpFor } from "../lib/dbsort";
import { rangePaths, togglePath } from "../lib/bulkselect";
import { aggregationKind, aggregateColumnsUnits, formatUnit, normalizeNumberInput, updateAggregation } from "../lib/aggregate";
import { makeFxResolver } from "../lib/fx";
import { useFxRates } from "./useFx";
import { pathExists, vaultCreate, vaultTemplateRead } from "../lib/ipc";
import { setPropUndoable, setPropUndoableBulk, type BulkPropResult, type PropWriter, type UndoRecorder } from "../lib/undoprops";
import {
  addPending,
  applyPending,
  dropPending,
  NO_PENDING,
  prunePending,
  settlePending,
  type PendingProps,
  type PendingWrite,
} from "../lib/pendingprops";
import { useUndo } from "../lib/undoContext";
import { nextUndoId } from "../lib/undo";
import { completeFilter, completeKey, filterCompletions, filterDeadEndHint, filterInherits, filterLabel, keyCompletions, matchesFilters, parseQuery } from "../lib/query";
import { filterByQuery, saveViewHint } from "../lib/views";
import { exportDbCsv, exportDbPdf } from "../lib/export";
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
import { boardGroupBy, canonicalViewPref, dbColumns, effectiveColumns, hiddenForLayout, orderedColumns } from "../lib/dbcolumns";
import { reorderIds } from "../lib/sidebar";
import {
  bucketByProp,
  distinctNotes,
  extraValues,
  orderedNotes,
  tableGroupBy,
  tableGroups,
} from "../lib/dbgroup";
import SelectMenu, { anchorFrom, anchorsWentStale, type AnchorRect } from "./SelectMenu";
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
import SwitchGroup from "./SwitchGroup";
import {
  AGG_OPTIONS,
  cardSubtitle,
  ColMenu,
  ColumnsMenu,
  colWidthRule,
  EMPTY_SEL,
  FilterSyntax,
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
import { BackButton } from "./BackButton";
import EmptyState from "./EmptyState";

interface DatabasePaneProps {
  dbType: string;
  /** the database's own rows (a saved view's subset when pinned) */
  notes: NoteMeta[];
  /** every vault note (a rollup's linked rows live in other
      databases — the derivation reads them from here) */
  allNotes: NoteMeta[];
  pref: ViewPref | undefined;
  typeSchema: Record<string, PropSchema>;
  /** the whole vault schema (the rollup schema editor lists the
      related database's props from it) */
  schema: SchemaConfig;
  /** the database's icon; clicking the header icon edits it */
  icon?: DbIcon;
  onSaveIcon: (icon: DbIcon | null) => void;
  usedValues: (key: string) => string[];
  onSaveSchema: (prop: string, options: SelectOption[], kind: PropKind | null, notify?: boolean, notifyBefore?: number, target?: string, format?: NumberFormat, description?: string, rollup?: RollupConfig | null) => void;
  /** entries of a relation column's target database (picker source) */
  relationCandidates: (dbType: string) => RelationCandidate[];
  /** create a new entry of a database inline from the relation picker */
  onCreateEntry: (dbType: string, title: string) => Promise<NoteMeta>;
  /** all database types — the schema editor's relation target picker */
  dbTypes: string[];
  openPath: string | null;
  /** a row to put the view ON, asked for from outside the pane — a
      global-search hit inside a mounted file's text opens its board, and a
      board of 2,000 files that merely opens has not shown anyone anything.
      Reuses the pane's own reveal path (pendingFocus → focus → scrollIntoView),
      so a windowed table scrolls the row into view like any other reveal. `n`
      changes per request, so asking twice for the same row reveals it twice. */
  reveal?: { path: string; n: number } | null;
  /** bumped by App when ⌘N fires inside this database view */
  newSignal: number;
  /** App points this at the current view's CSV export so the palette can call it */
  exportRef?: React.MutableRefObject<(() => void) | null>;
  /** the global `db-grid` setting — what tables do when this
      database's pref carries no `grid` override of its own */
  gridDefault: boolean;
  /** App-wide numeric display dialect. */
  numberLocale?: NumberLocale;
  onPrefChange: (pref: ViewPref) => void;
  onOpenNote: (path: string) => void;
  /** right-click on any row/card — App's note context menu */
  onNoteMenu: (path: string, x: number, y: number) => void;
  /** right-click on a value cell (receipts spec §6) — passed through to the table */
  onCellMenu?: (path: string, key: string, x: number, y: number) => void;
  /** The table bulk bar's Move to Trash — App owns the per-note
      fan-out, the one refresh, and the summary toast with Undo */
  onTrashNotes: (paths: string[]) => void;
  onMutated: () => void;
  /** saved-view seeds: the pane opens with the pin's query;
      edits stay session-local until re-saved. The pin's sort arrives on
      `pref.sorts` — same channel as a database's remembered sort. */
  initialQuery?: string;
  /** The pin's curated display columns — a seed like initialQuery;
      absent = the dbColumns union. Toggles stay session-local unless App
      also wires onColumnsChange (it does when a pin is open) */
  initialColumns?: string[];
  /** Persist the open pin's column curation; `undefined` restores
      the default union. Fires on every Columns-popover toggle */
  onColumnsChange?: (columns: string[] | undefined) => void;
  /** prefill for the save-view name field (the open pin's name) */
  saveViewSeed?: string;
  /** "Save view…" capture: current filter text, ordered sort keys,
      effective layout, and the curated columns when they differ from the
      default union */
  onSaveView: (
    name: string,
    capture: { query: string; sorts: SavedViewSort[]; view: DbLayout; groupBy?: string; tableGroupBy?: string; columns?: string[] }
  ) => void;
  /* The view tab bar — this db's pins (App filters), the open pin's
     id for the active tab, the two tab actions (open / context menu — App
     owns the menu's items), and the "All" tab's way back to the plain db
     from inside a pin */
  savedViews: SavedView[];
  activeViewId?: string;
  onOpenView: (id: string) => void;
  onViewMenu: (id: string, x: number, y: number) => void;
  /** Pin id → its ⌘-digit keycap ("⌘5"…"⌘9"), from App's pinIds —
      the same order the view-pins shortcut fires on. Only pins with a live
      shortcut have an entry; unpinned tabs render exactly as before. Empty
      on mobile, where no ⌘ exists. */
  pinKeys: Record<string, string>;
  /** the "All" tab leaves the open pin for its database (App only wires this
      on the saved-view pane; on a plain db the tab is already active) */
  onOpenDb?: () => void;
  /* Database management — App owns the dialogs and the sweeps */
  onRenameDb: () => void;
  onDeleteDb: () => void;
  onRenameProp: (prop: string) => void;
  onRemoveProp: (prop: string) => void;
  /** App's toast — a created entry the active filter still hides
      announces itself instead of vanishing silently; the optional
      action carries Undo after a board drag move */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** A mounted folder's rows write through `mount_annotate` — the
      row's note may not exist until the write creates it. Absent everywhere
      else, where a plain vaultSetProp is exactly right. */
  writeProp?: PropWriter;
}

/** How long a just-written cell stays lit. Matches the cell-flash
    keyframe in styles.css — long enough to catch out of the corner of an eye,
    short enough that it is gone before the next edit. */
const CELL_FLASH_MS = 700;

/** The empty "these notes refused the write" map, shared so a reset
    is referentially stable (same trick as EMPTY_SEL). */
const EMPTY_FAILED: ReadonlyMap<string, string> = new Map();

export default function DatabasePane({
  dbType,
  notes: diskNotes,
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
  reveal,
  newSignal,
  exportRef,
  gridDefault,
  numberLocale = DEFAULT_NUMBER_LOCALE,
  onPrefChange,
  onOpenNote,
  onNoteMenu,
  onCellMenu,
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
  writeProp,
  onToast,
}: DatabasePaneProps) {
  const undo = useUndo();
  const anchorStaleScope = useId();
  // Writes in flight, laid over disk so an edit paints the frame it
  // happens instead of waiting for IPC plus the full re-sync onMutated kicks
  // off. `notes` below is that composite — every read path in this pane (the
  // filter, the sort, the board buckets, the footer, the export) sees the
  // optimistic value, exactly as it will see the disk one a moment later.
  // Entries die in prunePending when the refresh catches up, or immediately
  // on a refusal (dropPending), which is what makes a rollback visible.
  const [pending, setPending] = useState<PendingProps>(NO_PENDING);
  const notes = useMemo(() => applyPending(diskNotes, pending), [diskNotes, pending]);
  useEffect(() => {
    setPending((cur) => prunePending(cur, diskNotes));
  }, [diskNotes]);
  const layout: DbLayout = pref?.view ?? "table";
  const columns = useMemo(() => dbColumns(notes, typeSchema), [notes, typeSchema]);
  const normalizedPref = useMemo(
    () => (pref ? canonicalViewPref(pref, columns) : undefined),
    [pref, columns]
  );
  // Derive the rollup columns (computed on read, stored nowhere)
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
  // Which persistence channel column curation and sorting write to:
  // an open pin (App wires onColumnsChange) owns its curation via the
  // `columns` field and keeps sort session-local until re-saved;
  // a plain database view persists both on its ViewPref (hidden/sorts), so
  // they survive navigating away.
  const pinMode = onColumnsChange !== undefined;
  // Re-issue the pref with one field changed — every write goes through here
  // so a layout switch can never drop the sort or the hidden set.
  const patchPref = (patch: Partial<ViewPref>) => {
    onPrefChange(canonicalViewPref({
      view: layout,
      group_by: normalizedPref?.group_by,
      table_group_by: normalizedPref?.table_group_by,
      aggregations: normalizedPref?.aggregations,
      sorts: normalizedPref?.sorts,
      col_order: normalizedPref?.col_order,
      card_order: normalizedPref?.card_order,
      hidden: normalizedPref?.hidden,
      hidden_per_layout: normalizedPref?.hidden_per_layout,
      widths: normalizedPref?.widths,
      wrap: normalizedPref?.wrap,
      grid: normalizedPref?.grid,
      ...patch,
    }, columns));
  };
  // The database's persisted hidden-prop set — per-layout
  // (the table and the list curate independently; a layout with no
  // set of its own reads the flat `hidden` seed). A prop added later is
  // NOT in the set, so it shows by default — the inverse of a pin's curated
  // shown-list, on purpose (a database is a living surface, a pin a capture).
  const hidden = useMemo(
    () => new Set(pinMode ? [] : hiddenForLayout(normalizedPref, layout)),
    [pinMode, normalizedPref, layout]
  );
  // Curated display columns. null = the default union; a pin's
  // `columns` seeds the selection, toggles keep it in union order so
  // "everything on again" normalizes back to null. The selection is a
  // subset list — a prop added later joins the union but stays hidden in an
  // already-curated view until checked.
  const [colSel, setColSel] = useState<string[] | null>(() =>
    initialColumns?.length ? effectiveColumns({ columns: initialColumns }, columns) : null
  );
  // what actually renders in table/list: the pin's curated order (stale keys
  // dropped quietly by the helper), or the union minus the db's hidden set —
  // then the drag order over whichever set that produced. Ordering
  // rides the pref in BOTH channels, so a pin reorders session-locally (its
  // svPref) and lands the order in the pin's own `columns` on re-save, while
  // a database persists it through views.json.
  const shown = useMemo(() => {
    const base = pinMode
      ? colSel
        ? effectiveColumns({ columns: colSel }, columns)
        : columns
      : columns.filter((c) => !hidden.has(c));
    return orderedColumns(base, normalizedPref?.col_order);
  }, [pinMode, colSel, columns, hidden, normalizedPref?.col_order]);
  // Persist one layout's hidden set. The write materializes BOTH
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
    // db mode (a per-layout hidden set since table and list stopped sharing
    // one): flip membership in the
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
      // curation
      writeLayoutHidden([]);
    }
  };
  // Remembered column widths (prop → px, `title` = the Name column)
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
  // Vertical column rules. The db's own override wins; without one
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
  /** Header drag handle: live width via a throwaway stylesheet —
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

  /** Header drag-reorder. The gesture starts on the header LABEL
      (the 8px resize strip keeps its own mousedown, so the two never fight)
      and the live drop target is a column key + a side — the 2px accent line
      the thead paints between headers. Committed to the pref's `col_order`
      on drop, which is the full rendered order INCLUDING columns the drag
      didn't touch: a later-added prop then appends instead of jumping. */
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [colDropAt, setColDropAt] = useState<{ key: string; after: boolean } | null>(null);
  const endColDrag = () => {
    setColDrag(null);
    setColDropAt(null);
  };
  const dropColumn = (target: string, after: boolean) => {
    const dragged = colDrag;
    endColDrag();
    if (!dragged || dragged === target) return;
    const next = reorderIds(shown, dragged, target, after);
    if (next.every((c, i) => c === shown[i])) return;
    patchPref({ col_order: next });
  };

  // Save-view capture: the rendered column list, only when it differs from
  // the default union — a plain save-with-all-columns-in-default-order writes
  // no `columns` field. A pin saved off a database with hidden props inherits
  // them as a shown-list; a drag ORDER is a difference too, so
  // the same one comparison captures both curation and order.
  const colCapture =
    shown.length === columns.length && shown.every((c, i) => c === columns[i]) ? undefined : shown;
  // the active curation for checkmarks and list subtitles; undefined = the
  // default union in both channels
  const curated = pinMode ? (colSel ? shown : undefined) : hidden.size > 0 ? shown : undefined;
  // Multi-kind props can't group a board — the helper keeps them out
  // of the candidates and lands a stale views.json pref on a safe fallback.
  // Rollup props can't group either — a board drag writes the
  // group prop on drop, and a derived column has no write path
  const groupBy = boardGroupBy(columns, typeSchema, normalizedPref?.group_by);
  const groupable = columns.filter((c) => {
    const kind = byFoldedKey(typeSchema, c)?.kind;
    return kind !== "multi" && kind !== "rollup";
  });
  // The table's own grouping key — no fallback; a table stays
  // ungrouped unless the pref names a still-groupable column
  const tableGroup = tableGroupBy(columns, typeSchema, normalizedPref?.table_group_by);

  // The active sort is an ordered key list (plain header click
  // replaces it, shift-click adds/cycles a secondary key) — empty = unsorted.
  // It lives on the pref, so a database's sort persists through
  // views.json while a pin's rides its session-local svPref (App's channel
  // split) and still only lands in the pin via "Save view…".
  const sorts = useMemo(
    () => normalizedPref?.sorts ?? [],
    [normalizedPref?.sorts]
  );
  // the filter bar: a query string over this database's notes
  const [query, setQuery] = useState(initialQuery ?? "");
  const [namingView, setNamingView] = useState(false);
  // Right-click on the pane's empty space — the create menu. Rows,
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
  // Table row multi-select — the selected rows' paths plus the
  // anchor (last clicked row), stored as a path and resolved to a rows index
  // at click time so a re-sort can't strand a numeric index
  const [sel, setSel] = useState<ReadonlySet<string>>(EMPTY_SEL);
  const [selAnchor, setSelAnchor] = useState<string | null>(null);
  // Which notes a bulk write was refused on, and what the vault
  // said about each. The toast can only carry a count — "3 failed" out of 40
  // names nothing — so the reasons live on the rows themselves, and the
  // refused rows become the selection (settleBulkFailures below).
  const [writeFailed, setWriteFailed] = useState<ReadonlyMap<string, string>>(EMPTY_FAILED);
  // The bar slides in but used to vanish on the frame the selection
  // emptied. It stays mounted for the fade-out, and keeps the count it was
  // showing — a bar reading "0 selected" on its way out is worse than none
  const [bulkClosing, setBulkClosing] = useState(0);
  const lastSelSize = useRef(0);
  // The cell (or board card) a write just landed in, lit for one
  // fade. The nonce distinguishes two writes to the same cell.
  const [lastWritten, setLastWritten] = useState<{ path: string; key: string; nonce: number } | null>(
    null
  );
  const writeNonce = useRef(0);
  // the bulk bar's popovers: first the column picker, then the picked
  // column's kind editor (checkbox columns get a two-choice menu instead —
  // they have no value editor in the single-cell machinery either)
  const [bulkColMenu, setBulkColMenu] = useState<AnchorRect | null>(null);
  const [bulkEdit, setBulkEdit] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  const [bulkCheck, setBulkCheck] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  // multi/relation bulk edits commit live like the cell editors; the list
  // being built across toggles lives here (starts empty = replace semantics —
  // the picker states that plainly and every write toasts)
  const [bulkVals, setBulkVals] = useState<string[]>([]);
  // Gates the frozen Name column's edge cue — true only while the
  // table's scroller is off its left stop
  const [scrolledX, setScrolledX] = useState(false);
  const [scrolledY, setScrolledY] = useState(false);
  // Gates the right-edge fade — true only while columns hide past
  // the scroller's right edge (never at max scroll, never when it fits)
  const [moreRight, setMoreRight] = useState(false);
  // gates the view-tab strip's right-edge fade — true only while tabs hide
  // past the strip's right edge (same cue idiom as)
  const [tabsMore, setTabsMore] = useState(false);
  const [iconMenu, setIconMenu] = useState<AnchorRect | null>(null);
  const [groupMenu, setGroupMenu] = useState<AnchorRect | null>(null);
  const [editCell, setEditCell] = useState<{
    path: string;
    key: string;
    anchor: AnchorRect;
    /** Type-to-replace: the keystroke that opened this editor */
    seed?: string;
    /** F2: open on the current value, caret at its end */
    caretAtEnd?: boolean;
  } | null>(null);
  /** Where a commit-and-move is headed. The editor for the target
      cell can only open once that cell is PAINTED, and in a windowed table
 the hop routinely lands on a row that isn't in the DOM yet —
      so the landing is a small state machine, not a straight call. */
  const [pendingEdit, setPendingEdit] = useState<{
    c: number;
    r: number;
    path: string;
    key: string;
    tries: number;
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
  // The board column hosting the open draft — its group value rides
  // into commitNew so the card is born in the column it was titled in.
  // null = no column context (non-board layouts); `value: null` = the "No …"
  // column (the entry is born without the group prop).
  const [newCol, setNewCol] = useState<{ value: string | null } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // The ＋ add-property popover, and a column's schema editor opened
  // from the header caret (both anchored at the header cell they came from)
  const [addPropAt, setAddPropAt] = useState<AnchorRect | null>(null);
  const [editSchemaCol, setEditSchemaCol] = useState<{ col: string; anchor: AnchorRect } | null>(
    null
  );
  const [colMenu, setColMenu] = useState<{ col: string; anchor: AnchorRect } | null>(null);
  // The property-visibility checklist, opened by right-click on the
  // table header row (anchored where the click landed)
  const [propVisAt, setPropVisAt] = useState<AnchorRect | null>(null);
  // The aggregation picker, opened from a footer cell (up) or the
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

  // Hold the bulk bar for one fade after the selection empties (the
  // Palette's closing idiom, same 90ms). A new selection during the fade wins
  // — the timer is cleared and the bar is a live bar again.
  useEffect(() => {
    if (sel.size > 0) {
      lastSelSize.current = sel.size;
      setBulkClosing(0);
      return;
    }
    // nothing was selected to begin with (mount, or a cleared selection that
    // already faded) — no bar, nothing to fade
    if (lastSelSize.current === 0) return;
    setBulkClosing(lastSelSize.current);
    lastSelSize.current = 0;
    const t = window.setTimeout(() => setBulkClosing(0), 90);
    return () => window.clearTimeout(t);
  }, [sel]);

  // let the commit flash expire, so a re-render long after the write (a sort,
  // a filter) never relights a cell that settled minutes ago
  useEffect(() => {
    if (!lastWritten) return;
    const t = window.setTimeout(() => setLastWritten(null), CELL_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [lastWritten]);

  // the tab strip's fade tracks its scroll position and the tab count
  useEffect(() => {
    const el = tabsRef.current;
    if (el) setTabsMore(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [savedViews, activeViewId]);

  // open the title draft: a board column passes itself so the new card is
  // born with its group value; other entry points pass the first
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

  // new entries land in the type's home folder when one is set,
  // else where most of the type already lives
  const homeFolder = useMemo(() => homeFolderFor(notes, typeHome(typeSchema)), [notes, typeSchema]);

  // The create/export lanes used to end on `.catch(console.error)`,
  // so an engine refusal — a title holding [ or ], an unwritable home folder,
  // a refused export — cleared the editor and told the user nothing. Same
  // silence was removed from the cell writes, one lane over. Anything
  // that can fail after its editor has closed reports through here.
  const reportFailure = (what: string) => (err: unknown) => {
    onToast?.(`couldn’t ${what} — ${err instanceof Error ? err.message : String(err)}`);
  };

  const commitNew = () => {
    const t = (newTitle ?? "").trim();
    const col = newCol; // captured before the draft state clears
    const q = query; // for the post-create visibility check
    setNewTitle(null);
    setNewCol(null);
    if (!t) return;
    // born complete: schema-default empty chips + the type's
    // template instantiated, written in one create
    const date = todayIso();
    vaultTemplateRead(dbType)
      .then((tpl) => {
        let props = buildEntryProps({ typeSchema, typeNotes: notes, template: tpl, title: t, date });
        // born under an active filter: simple bare key:value terms pin the
        // new entry's props so it stays visible
        for (const [k, v] of filterInherits(parsedQuery.filters))
          props = mergeEntryProp(props, k, v);
        // the hosting column's group value wins over template/schema
        // defaults AND the filter inherit, so the card is born in the column
        // it was titled in; the "No …" column overrides to empty
        if (groupBy && col) props = mergeEntryProp(props, groupBy, col.value ?? "");
        return vaultCreate(t, homeFolder, dbType, props, buildEntryBody(tpl, t, date));
      })
      .then((m) => {
        setPendingFocus(m.path);
        onMutated();
        // still hidden (a text term, a skipped filter shape)? Say so —
        // otherwise the create looks dropped
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
  // dispNotes carries the derived rollup values, so a filter can
  // match a rollup column like any other
  const visible = useMemo(
    () => filterByQuery(dispNotes, query, undefined, typeSchema),
    [dispNotes, query, typeSchema]
  );
  const parsedQuery = useMemo(() => parseQuery(query, undefined, typeSchema), [query, typeSchema]);
  // a filter hiding every row renders the "No matches" empty state inside the
  // scroller (noMatch below) — every layout keeps its scroller mounted through
  // it, but the contents change size, so the fade sync
  // effect re-runs on this flag to re-read the geometry
  const filterEmpty = visible.length === 0 && query.trim() !== "" && newTitle === null;
  // Why the filter dead-ended — one muted line under "No matches",
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
  // Before any operator is typed there is nothing for the value chips to
  // complete, and a bare word is the one thing every reader types first — so
  // it offers the property KEYS it could open ("sta" → "status:"). The
  // function bails on its own once the query reaches an operator, which is
  // where `completions` above takes back over.
  const keyHints = useMemo(() => keyCompletions(columns, query), [columns, query]);

  // placeholder teaches the filter syntax with a real example from this
  // database's schema — a made-up key would just mislead. `folder:` rides
  // along verbatim: it is the one key that is real in every database (it
  // filters on placement, not on a prop), and naming it here matches the
  // search pane, which has always listed it
  const filterHint = useMemo(() => {
    for (const [key, schema] of Object.entries(typeSchema)) {
      // the type's record also carries reserved db metadata (icon/home) that
      // is NOT a PropSchema — real schema.json has it, the mock used to lack
      // it, and this loop crashed every db view on vaults with icons (0.8.0)
      if (!schema || typeof schema !== "object" || !Array.isArray(schema.options)) continue;
      const first = schema.options[0]?.value;
      if (first && !/\s/.test(first)) return `Filter — try ${key}:${first} or folder:`;
    }
    return "Filter — try folder:";
  }, [typeSchema]);

  // lexicographic over the key list: key 1 decides, ties fall
  // through to key 2, then 3 — per-key semantics live in lib/dbsort, where
  // select-kind keys compare by schema option order, not A→Z
  const sortCmp = useMemo(() => sortCmpFor(sorts, typeSchema), [sorts, typeSchema]);
  // With no active sort the view rests on title order — stable
  // across prop edits, unlike the vault_list feed (updated_ms desc), which
  // teleported an edited row to the top mid-edit
  const viewCmp = sortCmp ?? restingCmp;

  // A grouped table interleaves section header rows between runs of
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

  /* Large tables paint lazily. Above WIN_MIN rows the tbody renders
     only the scroll viewport ± WIN_OVERSCAN rows; spacer rows before and
     after keep the scroll height exact, so the scrollbar, sticky header and
     sticky footer behave like a full render. Everything semantic — keyboard
     nav, multi-select ranges, CSV export, footer aggregates, group
     partitioning — already operates on `rows`, not the DOM, so it is
     untouched. Below WIN_MIN the table renders whole: small tables never see
     a spacer (their asserted e2e row counts stay exact).
     Rows are uniform-height by CSS (.db-cell-txt is nowrap), so one measured
     row height + the group-header height derives every row's offset. */
  // A wrapped column breaks the uniform-row-height assumption the
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
  // (probe: 148ms → 260ms on the empty→full filter flip in dev)
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

  // The footer answers "how many notes, and what do their values add
  // up to" — one answer per note, not per group membership. Grouping by a
  // list-valued prop (tags, a multi-target relation) puts a note in every
  // section it belongs to, so `rows` holds it several times; a Sum that grows
  // when you group the same notes is wrong under any reading. Display,
  // windowing and focus keep the flat sequence; only the tally is deduped.
  const tallied = useMemo(() => (rowGroups ? distinctNotes(rows) : rows), [rows, rowGroups]);

  // Footer: chosen aggregations (column → kind) and their computed
  // values over the visible (filtered, sorted) notes
  const aggs = useMemo(
    () => normalizedPref?.aggregations ?? {},
    [normalizedPref?.aggregations]
  );
  // the footer's rates: a unit column folds foreign-unit rows in at
  // these, and marks the figure when it did. Linear units (kg, ms) need no
  // rates at all, so an offline table only costs currency columns.
  const { fx: fxRatesState } = useFxRates();
  const fxResolver = useMemo(() => makeFxResolver(fxRatesState), [fxRatesState]);
  const aggResults = useMemo(() => {
    return aggregateColumnsUnits(
      aggs,
      (col) => tallied.map((n) => foldedPropStr(n.props, col) ?? ""),
      (col) => formatUnit(byFoldedKey(typeSchema, col)?.format),
      fxResolver
    );
  }, [aggs, tallied, typeSchema, fxResolver]);

  const setAgg = (col: string, kind: AggKind | null) => {
    const next = updateAggregation(aggs, col, kind);
    patchPref({ aggregations: Object.keys(next).length > 0 ? next : undefined });
  };

  // an UNSORTED board rests in the order the user's own drags left
  // (`card_order`); a sorted board's order IS its sort, so the hand order
  // stays on disk and unread until the sort is cleared. One flat pref list
  // arranges every column — `orderedNotes` ignores paths that aren't here.
  const handOrder = sorts.length === 0 ? normalizedPref?.card_order : undefined;
  const boardCols = useMemo(() => {
    if (!groupBy) return [];
    const arrange = (ns: NoteMeta[]) => orderedNotes(ns.sort(viewCmp), handOrder);
    const { none, take } = bucketByProp(visible, groupBy, typeSchema);
    // schema'd grouping: every defined option is a column in option order,
    // empty ones included (they're drop targets); unknown values follow
    const options = byFoldedKey(typeSchema, groupBy)?.options ?? [];
    const cols: { value: string | null; notes: NoteMeta[] }[] = [];
    for (const o of options) {
      cols.push({ value: o.value, notes: arrange(take(o.value)) });
    }
    // Unschema'd values form columns from the FULL note set, so a
    // filter that hides every card empties the column instead of deleting it
    for (const v of extraValues(dispNotes, groupBy, options, typeSchema)) {
      cols.push({ value: v, notes: arrange(take(v)) });
    }
    // The "No …" column (drop target for clearing the prop) only
    // exists while at least one visible card actually lacks the prop — when
    // every card is grouped it would be a dead column leading the board
    if (none.length > 0) cols.unshift({ value: null, notes: arrange(none) });
    return cols;
  }, [dispNotes, visible, groupBy, typeSchema, viewCmp, handOrder]);

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
  // out of the DOM: when the focused cell isn't rendered, scroll to
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
      // An open cell editor owns focus until it closes.
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

  // Layout/db switches remount or re-fill the scroller — re-sync
  // the fade/cue gates from the live DOM node, not stale state. ResizeObserver
  // covers geometry changes that fire no scroll event: the sidebar/window
  // resizing clientWidth, the table outgrowing the pane when a property is
  // added (its own box moves scrollWidth).
  useEffect(() => {
    const body = bodyRef.current;
    const sync = () => {
      setScrolledX((body?.scrollLeft ?? 0) > 0);
      setScrolledY((body?.scrollTop ?? 0) > 0);
      setMoreRight(body ? body.scrollLeft < body.scrollWidth - body.clientWidth - 1 : false);
      // a resized scroller shows a different row band — re-window
      winSyncRef.current();
    };
    sync();
    if (!body) return;
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    return () => ro.disconnect();
  }, [layout, dbType, filterEmpty]);

  // a reveal asked for from outside enters the same queue a fresh
  // note's does. Queued rather than applied: the rows a mount board shows
  // arrive after the board itself, so the row named here is routinely not in
  // `rows` yet on the render that asks for it.
  //
  // Keyed on the request count, never on the object: a board's rows are
  // replaced wholesale on every refresh, so the caller's reveal is a fresh
  // object each time an extraction finishes or a property is edited. Keyed on
  // identity, this would re-queue the focus then and drag the user back to the
  // row they arrived on, indefinitely.
  const revealN = reveal?.n ?? 0;
  useEffect(() => {
    if (reveal) setPendingFocus(reveal.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealN]);

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
  // One row per NOTE, not per group membership: grouping
  // is a view-only concern, so a grouped export is byte-identical to the same
  // view's ungrouped one. The flat `rows` still go in — buildCsv owns the
  // de-duplication (the footer's), keeping every export path on one
  // rule; a note in two sections lands once, at its first on-screen position.
  const doExportCsv = () => {
    exportDbCsv(dbType, shown, rows).catch(reportFailure("export"));
  };
  // the CSV export's printed twin: same columns, order and de-dup
  const doExportPdf = () => {
    exportDbPdf(dbType, shown, rows).catch(reportFailure("export"));
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
  // cycles a secondary key — the state machine lives in lib/dbsort
  const cycleSort = (key: string, additive: boolean) => {
    const next = cycleSortKeys(sorts, key, additive);
    patchPref({ sorts: next.length > 0 ? next : undefined });
  };

  // A note's props AS STORED. Key resolution (foldedPropKey) has to
  // run against these and not the optimistic composite — a pending clear
  // removes the key from the composite, and a resolution that misses falls
  // back to the COLUMN's spelling, which is how a refused clear could rename
  // a note's `Role` to `role` on the next write.
  const diskPropsOf = (path: string): Record<string, unknown> =>
    diskNotes.find((n) => n.path === path)?.props ?? {};

  const startEdit = (
    path: string,
    key: string,
    el: Element | null | undefined,
    // A keystroke that opened the editor, or F2's edit-in-place
    opts?: { seed?: string; caretAtEnd?: boolean }
  ) => {
    if (!el) return;
    setEditCell({ path, key, anchor: anchorFrom(el), ...opts });
  };

  // One funnel for cell writes — a failure used to die on the
  // console after the editor had already closed; now it surfaces on App's
  // toast and re-syncs, so the grid never implies the write landed.
  // Resolves whether the write landed so callers can chain follow-ups
  // (the drag-move toast only shows on success)
  const writeCell = (
    path: string,
    key: string,
    value: string | string[] | boolean | null,
    // pre-minted id when the caller wants to point a toast at this exact entry
    id?: number
  ): Promise<boolean> => {
    // The note's OWN spelling comes off DISK, never the composite.
    // A pending clear deletes the key from the overlay, so resolving there
    // would lose the note's casing and fall back to the column's — writing
    // `role` onto a note that spells it `Role` makes a case-duplicate in the
    // file, and the undo entry's `prior` would read from the empty slot.
    const props = diskPropsOf(path);
    const actualKey = foldedPropKey(props, key);
    // Paint it now. The write below reconciles — settle on success
    // (the value holds until the refresh delivers disk truth), drop on
    // failure (the old value comes back on screen, next to the toast).
    const optimistic: PendingWrite[] = [{ path, key: actualKey, value }];
    setPending((cur) => addPending(cur, optimistic));
    // Through the undoable helper, so a mis-typed cell is one ⌘Z away
    return setPropUndoable({ path, key: actualKey, value, id, record: undo.record, keyLabel: displayColLabel(key), write: writeProp })
      .then(() => {
        setPending((cur) => settlePending(cur, optimistic));
        onMutated();
        // A write that lands silently is indistinguishable from one
        // that didn't. The cell the value went into carries one short accent
        // fade -- the same confirmation the toast gives a bulk write, at the
        // scale of a single cell. The nonce restarts it when the same cell is
        // written twice inside one flash.
        setLastWritten({ path, key, nonce: ++writeNonce.current });
        // This note just took a write, so whatever a bulk edit
        // couldn't put on it is no longer the honest thing to show
        setWriteFailed((cur) =>
          cur.has(path) ? new Map([...cur].filter(([p]) => p !== path)) : cur
        );
        return true;
      })
      .catch((err) => {
        // The vault refused it, so the value leaves the screen the
        // same frame the toast arrives — never a rejected value left sitting
        // there reading as saved
        setPending((cur) => dropPending(cur, optimistic));
        onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
        onMutated();
        return false;
      });
  };

  // Typed text lands canonical for number-kind columns — the app
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
    // what the user is editing is what the pane SHOWS (the composite), but the
    // key's real spelling only exists on disk (see diskPropsOf)
    const props = notes.find((n) => n.path === path)?.props ?? {};
    const actualKey = foldedPropKey(diskPropsOf(path), key);
    const cur = foldedPropStr(props, key) ?? "";
    if ((value ?? "") === cur) return;
    // a column with no list-shaped kind falls back to this raw text editor,
    // but the prop underneath may still hold a YAML list — the editor seeds
    // from propStr, which joins it to "Vinyl, Digital". Writing that text
    // back as a scalar collapsed the list on a save that reported success
    // (the table half of the chip fix). null still clears.
    writeCell(path, key, value === null ? null : chipCommitValue(props[actualKey], value));
  };

  // read by the scroll handlers, which run far more often than any of these
  // change — a ref keeps them off the handler's dependency list
  const activeAnchor =
    editCell?.anchor ??
    colMenu?.anchor ??
    aggMenu?.anchor ??
    propVisAt ??
    addPropAt ??
    editSchemaCol?.anchor ??
    bulkColMenu ??
    bulkEdit?.anchor ??
    bulkCheck?.anchor ??
    null;
  const anchoredOpen = useRef(false);
  // where the scroller stood when the popover opened. Opening one often moves
  // the scroller itself — clicking a header caret parked off the right edge
  // focuses it, and the browser scrolls it into view before the menu exists.
  // That scroll event lands after the menu is mounted and used to close it on
  // the frame it opened; measuring against this baseline ignores it and still
  // catches the first scroll the user actually asks for.
  const anchorScroll = useRef<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    anchoredOpen.current = activeAnchor !== null;
    anchorScroll.current = activeAnchor && el ? { top: el.scrollTop, left: el.scrollLeft } : null;
  }, [activeAnchor]);

  // Every anchored popover in the pane holds a viewport rect captured
  // when it opened. Scrolling the body moves the cell out from under it and the
  // menu stays put, pointing at an unrelated row. The scroll handlers call this:
  // anchorsWentStale() first, so a SelectMenu applies its own click-away
  // contract (a dirty free-text cell commits, a picker just closes), then the
  // pane drops the menus it owns outright.
  const dismissAnchored = useCallback(() => {
    // a scroll fires this every frame; with nothing anchored open there is
    // nothing to say, and the stale-anchor event should not reach popovers
    // outside this pane
    if (!anchoredOpen.current) return;
    const el = bodyRef.current;
    const base = anchorScroll.current;
    if (el && base && el.scrollTop === base.top && el.scrollLeft === base.left) return;
    anchorsWentStale(anchorStaleScope);
    setEditCell(null);
    setSchemaEditCell(false);
    setColMenu(null);
    setAggMenu(null);
    setPropVisAt(null);
    setAddPropAt(null);
    setEditSchemaCol(null);
    setBulkColMenu(null);
    setBulkEdit(null);
    setBulkCheck(null);
  }, [anchorStaleScope]);

  // list-valued cells (relation, multi) commit live as the picker
  // toggles (menu stays open); current values re-read from the latest notes
  // each commit
  const commitListCell = (path: string, key: string, values: string[]) => {
    writeCell(path, key, propListValue(values));
  };

  // The grid the hop arithmetic walks — the columns the view SHOWS,
  // the rows it currently lists, and each column's kind so derived (rollup)
  // columns can be stepped over.
  const hopGrid = (): HopGrid => ({
    cols: shown.length,
    rows: rows.length,
    kindAt: (i) => {
      const key = shown[i];
      return key ? byFoldedKey(typeSchema, key)?.kind : undefined;
    },
  });

  /** Enter/Tab inside an editor: the value has already been committed through
      the one write door, and this carries the editor to the next
      cell. Focus moves first — a windowed table may not have the
      target row in the DOM at all, and the focus effect is what scrolls and
      repaints the window around it. `pendingEdit` then opens the editor on
      the frame the cell actually exists. */
  const hopEdit = (from: { path: string; key: string }, dir: HopDir) => {
    if (layout !== "table") return;
    const c = shown.indexOf(from.key) + 1;
    const r = rows.findIndex((n) => n.path === from.path);
    if (c < 1 || r < 0) return;
    const next = nextEditableCell({ c, r }, dir, hopGrid());
    // the end of the column/table: the value is saved, the editor closes, and
    // focus stays where it was — the spreadsheet behaviour
    if (!next) return;
    const path = rows[next.r]?.path;
    const key = shown[next.c - 1];
    if (!path || !key) return;
    setFocus({ c: next.c, r: next.r, path });
    setPendingEdit({ c: next.c, r: next.r, path, key, tries: 0 });
  };

  // Land the hop. The target cell may need a repaint (windowed
  // table) or simply a frame; retry a bounded number of times against the
  // live DOM, and give up quietly rather than leave a hop half-done.
  useEffect(() => {
    if (!pendingEdit) return;
    const { c, r, path, key, tries } = pendingEdit;
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-fc="${c}"][data-fr="${r}"]`
    );
    // never open an editor over a row that moved under the coordinate
    if (el && el.dataset.focusPath === path) {
      setPendingEdit(null);
      const kind = byFoldedKey(typeSchema, key)?.kind;
      // a checkbox is toggled, never typed into — the hop lands
      // focus on it and stops there rather than opening a text editor
      if (kind !== "checkbox" && kind !== "rollup") startEdit(path, key, el);
      return;
    }
    if (tries > 8) {
      setPendingEdit(null);
      return;
    }
    winSyncRef.current();
    const t = setTimeout(() => setPendingEdit((cur) => (cur ? { ...cur, tries: cur.tries + 1 } : cur)), 16);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEdit, win, rows]);

  // checkbox cells: one click toggles and saves immediately, no
  // editor popup — checked stores the YAML scalar `true`, unchecked REMOVES
  // the prop (never writes `false`); a stored `false` reads as unchecked
  const toggleCheckboxCell = (path: string, key: string) => {
    // the checked state is what the pane shows (a pending toggle counts), but
    // the key spelling comes off disk (see diskPropsOf)
    const props = notes.find((n) => n.path === path)?.props ?? {};
    const cur = props[foldedPropKey(diskPropsOf(path), key)] === true;
    writeCell(path, key, cur ? null : true);
  };

  // Row multi-select. ⌘/ctrl-click toggles one row, shift-click
  // ranges from the anchor (last clicked row) over `rows` indices — a grouped
  // table interleaves header rows in the DOM, so siblings would lie. Plain
  // clicks keep today's behavior and end any selection (the callers below).
  const clearSel = () => {
    setSel(EMPTY_SEL);
    setSelAnchor(null);
    // The failure marks ride with the selection they narrowed, so
    // dismissing the selection is also how the user says "seen it" — no mark
    // can outlive the rows it was pointing at.
    setWriteFailed(EMPTY_FAILED);
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
    // Same for the failure marks — a renamed or deleted note takes
    // its reason with it rather than stranding it on a path nothing renders
    setWriteFailed((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(rows.map((n) => n.path));
      const next = new Map([...cur].filter(([p]) => live.has(p)));
      return next.size === cur.size ? cur : next;
    });
  }, [rows]);

  // Escape clears the selection FIRST — before the pane's focus-clear and
  // App's esc-close, both bubble-phase listeners registered earlier, so only
  // a capture listener can preempt them. Menus/overlays own their own Esc:
  // while one is in the DOM this stays out of the way. ⌘⌫ rides the same
  // capture slot: with rows selected it trashes the selection —
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
      setWriteFailed(EMPTY_FAILED);
      if (bulkTrash) onTrashNotes(paths);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel, onTrashNotes]);

  // bulk bar writes: one vaultSetProp per selected path (no bulk IPC), ONE
  // refresh at the end. N writes record ONE undo entry, so the
  // app's most destructive everyday action takes a single ⌘Z to reverse.
  // Success toasts too — a live multi/relation write REPLACES each
  // note's list, and a silent replace read as additive (the old failure-only
  // toast is why that could bite); same wording as bulkCommit below.
  const bulkKeysByPath = (paths: string[], key: string): Record<string, string> =>
    // spelling off disk, not the optimistic composite (diskPropsOf)
    Object.fromEntries(paths.map((path) => [path, foldedPropKey(diskPropsOf(path), key)]));

  // A bulk set paints across every selected row at once, then
  // reconciles per row — the writes are sequential (each is a read-modify-
  // write of a file), so waiting for the last one is exactly the visible wait
  // this issue is about. Rows whose write was refused roll back individually;
  // the toast already names how many of N landed.
  const bulkPending = (paths: string[], key: string, value: PropValue): PendingWrite[] => {
    const keys = bulkKeysByPath(paths, key);
    return paths.map((path) => ({ path, key: keys[path] ?? key, value }));
  };
  const reconcileBulk = (optimistic: PendingWrite[], res: BulkPropResult) => {
    const landed = new Set(res.ok.map((o) => o.path));
    setPending((cur) => {
      const next = settlePending(
        cur,
        optimistic.filter((w) => landed.has(w.path))
      );
      return dropPending(
        next,
        optimistic.filter((w) => !landed.has(w.path))
      );
    });
  };

  /* What happens to the notes a bulk write was refused on.
     `setPropUndoableBulk` has always returned the reason per path; the pane
     used to throw all of it away and report a bare count, so on a 40-note
     edit "3 failed" left no route at all to the three.

     The refused paths BECOME the selection. That reuses the machinery the
     pane already owns end to end — setSel/setSelAnchor for the narrowing,
     pendingFocus → focus → scrollIntoView for the reveal (windowed rows
     included) — and it leaves the user somewhere useful rather than merely
     informed: the bulk bar comes back holding exactly the notes that still
     need the edit, so the same edit retries on exactly them. Each row then
     carries its own reason (DbTableLayout's marker).

     The alternative the issue offers — an action on the toast that selects
     them — needs this same selection code underneath anyway, and hangs the
     only route to the failures off something that auto-dismisses in 4s. */
  const settleBulkFailures = (res: BulkPropResult) => {
    if (res.failed.length === 0) {
      setWriteFailed(EMPTY_FAILED);
      return;
    }
    const failed = new Map(res.failed.map((f) => [f.path, f.error]));
    setWriteFailed(failed);
    setSel(new Set(failed.keys()));
    // topmost as the table shows it, not first in write order: the selection
    // a bulk write reads is a Set, whose order is click order
    const first = rows.find((n) => failed.has(n.path))?.path ?? res.failed[0].path;
    setSelAnchor(first);
    setPendingFocus(first);
  };

  const bulkWriteLive = (key: string, value: string | string[] | boolean | null) => {
    const paths = [...sel];
    if (paths.length === 0) return;
    const label = displayColLabel(key);
    const optimistic = bulkPending(paths, key, value);
    // These rows are being written again — no stale "didn't save"
    // mark may sit on a row while its retry is in flight
    setWriteFailed(EMPTY_FAILED);
    setPending((cur) => addPending(cur, optimistic));
    setPropUndoableBulk({
      paths,
      key,
      keysByPath: bulkKeysByPath(paths, key),
      value,
      record: undo.record,
      keyLabel: label,
      write: writeProp,
    }).then((res) => {
      const ok = res.ok.length;
      reconcileBulk(optimistic, res);
      settleBulkFailures(res);
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
    // same number-kind normalization as the single-cell path: the
    // bulk editor is the same free-text SelectMenu over the same column
    const value = typeof raw === "string" ? commitText(key, raw) : raw;
    const paths = [...sel];
    setBulkEdit(null);
    setBulkCheck(null);
    clearSel();
    if (paths.length === 0) return;
    const label = displayColLabel(key);
    const optimistic = bulkPending(paths, key, value);
    setPending((cur) => addPending(cur, optimistic));
    setPropUndoableBulk({ paths, key, keysByPath: bulkKeysByPath(paths, key), value, record: undo.record, keyLabel: label, write: writeProp }).then((res) => {
      const ok = res.ok.length;
      reconcileBulk(optimistic, res);
      settleBulkFailures(res);
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
  // matching editor anchored where the picker was. A rollup column
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

  // A board drag used to commit silently — name the target column on
  // App's toast and offer an Undo. That Undo pops the very entry
  // ⌘Z would pop (by id) rather than making its own inverse write, so the two
  // paths can't drift and undoing twice doesn't double-revert.
  const dropOn = (value: string | null) => {
    const path = dragPath;
    setDragPath(null);
    setDropCol(null);
    setCardDropAt(null);
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
          : displayValue(
              value,
              byFoldedKey(typeSchema, groupBy)?.kind,
              byFoldedKey(typeSchema, groupBy)?.format,
              undefined,
              numberLocale
            );
      onToast?.(`“${note?.title ?? path}” → ${label}`, {
        label: "Undo",
        run: () => undo.runById(id),
      });
    });
  };

  /** within-column drag on an UNSORTED board. The live target is a
      card path + a side — the 2px accent line the column paints between
      cards — and the drop commits view-side order ONLY: no note is written,
      so the vault format stays untouched by an arrangement. A sorted board
      never sets this (its order is its sort); a cross-column drag keeps
      going through `dropOn`'s prop write, unchanged. */
  const [cardDropAt, setCardDropAt] = useState<{ path: string; after: boolean } | null>(null);
  const dropCard = (target: string, after: boolean) => {
    const path = dragPath;
    setDragPath(null);
    setDropCol(null);
    setCardDropAt(null);
    if (!path || path === target) return;
    const prev = normalizedPref?.card_order;
    // The move REWRITES the saved arrangement, so it has to start from that
    // arrangement — not from what the board happens to be showing. Reading the
    // rendered columns alone would hand `patchPref` a list holding only the
    // notes that survived the current filter, and every hidden card's slot
    // would be gone for good (the field is the whole board's order, and the
    // write replaces it wholesale). So: the saved order leads, and every note
    // it doesn't name follows in the view's resting order — which is exactly
    // the sequence `orderedNotes` renders each column from, so this list is
    // the board as it stands, hidden cards included, before the move.
    const seen = new Set<string>();
    const flat: string[] = [];
    for (const p of [...(prev ?? []), ...[...dispNotes].sort(viewCmp).map((n) => n.path)]) {
      if (seen.has(p)) continue;
      seen.add(p);
      flat.push(p);
    }
    const next = reorderIds(flat, path, target, after);
    if (next.every((c, i) => c === flat[i])) return;
    const id = nextUndoId();
    patchPref({ card_order: next });
    const title = notes.find((n) => n.path === path)?.title ?? path;
    // the pre-minted id rides along so the toast's button and ⌘Z pop the
    // SAME entry — `record` takes it through the wider recorder type
    const record: UndoRecorder = undo.record;
    record({
      id,
      label: `Move “${title}”`,
      scope: "vault",
      at: Date.now(),
      // no note changed — the move lives in the view's prefs alone
      paths: [],
      undo: async () => patchPref({ card_order: prev }),
      redo: async () => patchPref({ card_order: next }),
    });
    onToast?.(`“${title}” moved`, { label: "Undo", run: () => undo.runById(id) });
  };

  // arrows / hjkl move cell/card focus; Enter opens the note (or edits a
  // table cell); App hands database views this keyboard surface wholesale
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      if (isTyping(e.target) || editCell) return;
      // Option is a character modifier on macOS, not a command one —
      // a German layout types `@` as ⌥L and `[` as ⌥5, and those have to open a
      // cell editor like any other character. So an Option chord is let through
      // ONLY to the openers at the bottom of this handler; nav, Enter and
      // Escape stay bare-key, exactly as before.
      const onDataCell = layout === "table" && !!focus && focus.c > 0;
      if (e.altKey && !(onDataCell && (isPrintableKey(e) || isDeadKey(e)))) return;
      // Header buttons, external links, and the named card/list controls own
      // native activation. Never apply Enter to a stale composite coordinate.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        (e.key === "Enter" || e.key === " ") &&
        target?.closest("button, a[href], [role='button'], summary")
      )
        return;
      // On a focused DATA cell of a table, a bare letter is the
      // start of a value, not vim nav — h/j/k/l have to be typeable into a
      // cell. The arrows still move there, and hjkl keeps moving everywhere
      // else (the title column, boards, galleries, lists).
      const vimNav = !(layout === "table" && focus && focus.c > 0);
      const horiz =
        layout === "list"
          ? 0
          : e.key === "ArrowRight" || (vimNav && e.key === "l")
            ? 1
            : e.key === "ArrowLeft" || (vimNav && e.key === "h")
              ? -1
              : 0;
      // gallery wraps a flat row index into a responsive grid — column count
      // comes from the rendered tracks, so nav always matches what's on screen
      const galleryCols = () => {
        const grid = bodyRef.current;
        if (!grid) return 1;
        return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      };
      const vert =
        e.key === "ArrowDown" || (vimNav && e.key === "j")
          ? 1
          : e.key === "ArrowUp" || (vimNav && e.key === "k")
            ? -1
            : 0;
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
            // string editor never opens for them
            if (enterKind === "checkbox") toggleCheckboxCell(n.path, key);
            // a rollup cell is derived — read-only, no editor
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
        return;
      }
      // The two openers a spreadsheet has that this grid lacked.
      // Both need a focused DATA cell in a table, and both refuse the cells
      // with no text editor behind them (checkbox toggles, rollup is derived).
      if (layout !== "table" || !focus || focus.c === 0) return;
      const n = rows[focus.r];
      const key = shown[focus.c - 1];
      if (!n || !key) return;
      const kind = byFoldedKey(typeSchema, key)?.kind;
      if (kind === "checkbox" || kind === "rollup") return;
      const cellEl = () =>
        bodyRef.current?.querySelector(`[data-fc="${focus.c}"][data-fr="${focus.r}"]`);
      // F2: edit what's there, caret at the end — the one opener that does
      // NOT replace, which is exactly why a spreadsheet has it
      if (e.key === "F2") {
        e.preventDefault();
        startEdit(n.path, key, cellEl(), { caretAtEnd: true });
        return;
      }
      // a dead key (`´`, `` ` ``, `^` — bare on German/intl layouts,
      // ⌥e/⌥i on US) produces no character here, so `é` used to cost the accent.
      // Open the editor empty and let the composition finish inside the input.
      // Deliberately NOT preventDefault: the browser has to keep the pending
      // dead key for the next keystroke.
      if (isDeadKey(e)) {
        startEdit(n.path, key, cellEl(), { seed: "" });
        return;
      }
      // type-to-replace: a printable key opens the editor already carrying it.
      // Free text/number cells read it as the new value; optioned, date and
      // relation cells read it as the picker's filter query.
      if (isPrintableKey(e)) {
        e.preventDefault();
        startEdit(n.path, key, cellEl(), { seed: e.key });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, shown, rows, boardCols, focus, editCell, onOpenNote, typeSchema]);

  const focusedCls = (c: number, r: number) =>
    focus && focus.c === c && focus.r === r ? " focused" : "";

  // One entry point per composite. Once focus enters, the active coordinate
  // alone stays tabbable and arrow/HJKL moves that real DOM focus.
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
      <BackButton />
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
      {/* The kind word disambiguates this header from a folder's */}
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
            {/* The pin's ⌘-digit rides its tab — the tab strip is the
                one surface every pin (homed database included) renders on */}
            {pinKeys[v.id] && <span className="key">{pinKeys[v.id]}</span>}
          </button>
        ))}
        <button className="db-tab-add" title="Save view…" onClick={() => setNamingView(true)}>
          <PlusIcon />
        </button>
      </div>
      <div className="db-tools">
        <SwitchGroup className="db-layouts" label="Layout">
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
        </SwitchGroup>
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
              // Per-database grid-lines override; the label states
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
              { label: "Export PDF…", icon: <ExportIcon />, run: doExportPdf },
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

  // the filter bar: live narrowing as you type; "Save view…" swaps it
  // for a name field that pins the current query/sort/layout to the sidebar
  const filterBar = (
    <div className="db-filter">
      <FilterIcon />
      {namingView ? (
        <InlineEdit
          initial={saveViewSeed ?? ""}
          placeholder="Name this view…"
          /* saving upserts by name, and the field opens seeded with the open
             pin's — so the common press REPLACES a pin rather than adding one.
             Say so while the name still matches. */
          hint={(typed) => saveViewHint(savedViews, dbType, typed)}
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
              } else if (e.key === "Tab" && keyHints.length > 0) {
                // same key, one rung earlier: the word becomes the operator
                e.preventDefault();
                setQuery(completeKey(query, keyHints[0]));
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
          {/* The grammar, on demand. Unlike Save/Clear it never fades: what
              you can type is the question you have BEFORE there is a query */}
          <FilterSyntax />
          {/* Both actions stay mounted at their full size — they used
              to appear with the first keystroke, which re-laid-out the row the
              cursor was sitting in (design-principles.md 4). They fade in with
              the query, and are disabled while there is nothing to save or
              clear, so an invisible button is never a tab stop or a click
              target */}
          <button
            className={`db-filter-save${query ? "" : " is-off"}`}
            disabled={!query}
            aria-hidden={query ? undefined : true}
            onMouseDown={(e) => e.preventDefault() /* keep the input's focus */}
            onClick={() => setNamingView(true)}
            title="Pin this filter to the sidebar"
          >
            Save view
          </button>
          <button
            className={`db-filter-clear${query ? "" : " is-off"}`}
            disabled={!query}
            aria-hidden={query ? undefined : true}
            onClick={() => setQuery("")}
            title="Clear filter"
          >
            <XIcon />
          </button>
        </>
      )}
    </div>
  );

  // One chip row, two rungs of the same ladder: with an operator typed the
  // chips are that property's VALUES, and before one they are the property
  // KEYS the word could open. Values win when both could apply — the reader
  // has already committed to a key by then.
  const completionRow = !(namingView || !filterFocused) ? (
    parsedQuery.trailing && completions.length > 0 ? (
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
    ) : keyHints.length > 0 ? (
      <div className="search-completions db-key-completions">
        {keyHints.map((k) => (
          <button
            key={k}
            className="search-completion"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setQuery(completeKey(query, k))}
          >
            {k}:
          </button>
        ))}
      </div>
    ) : null
  ) : null;

  // The completion chips hang off the filter row instead of sitting
  // in the column flow — a band that opens and closes as you type used to
  // push the whole table down under the cursor (design-principles.md 4)
  const bar = showFilter ? (
    <div className="db-filter-wrap">
      {filterBar}
      {completionRow}
    </div>
  ) : null;

  const noMatch = filterEmpty ? (
    /* the dead-end hint is its own control when it can fix the filter, so it
       rides the shell's bespoke slot rather than the plain hint line */
    <EmptyState icon={<FilterIcon />} title="No matches">
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
    </EmptyState>
  ) : null;

  const draftRow =
    newTitle !== null ? <div className="row db-draft">{draftInput}</div> : null;

  // Admin popovers — rendered in every layout branch: the ＋ add-
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
          onSave={(name, o, k, n, nb, t, f, d, r) => {
            setAddPropAt(null);
            onSaveSchema(name, o, k, n, nb, t, f, d, r);
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
            // Per-column wrap toggle — the label states the action,
            // so a wrapped column offers "Clip text" and vice versa
            {
              label: wrapSet.has(colMenu.col) ? "Clip text" : "Wrap text",
              run: () => toggleWrap(colMenu.col),
            },
            // Hides the column, never the data — the visibility
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
          staleScope={anchorStaleScope}
          anchor={editSchemaCol.anchor}
          value=""
          options={byFoldedKey(typeSchema, editSchemaCol.col)?.options ?? []}
          used={usedValues(editSchemaCol.col)}
          canEditSchema
          kind={byFoldedKey(typeSchema, editSchemaCol.col)?.kind}
          notify={byFoldedKey(typeSchema, editSchemaCol.col)?.notify}
          notifyBefore={byFoldedKey(typeSchema, editSchemaCol.col)?.notifyBefore}
          target={byFoldedKey(typeSchema, editSchemaCol.col)?.type}
          format={byFoldedKey(typeSchema, editSchemaCol.col)?.format}
          description={byFoldedKey(typeSchema, editSchemaCol.col)?.description}
          databases={dbTypes}
          rollupRelations={rollupRelations}
          rollupPropsFor={rollupPropsFor}
          rollup={editSchemaCol ? rollups[editSchemaCol.col] : undefined}
          startEditing
          onCommit={() => undefined}
          onSaveSchema={(o, k, n, nb, t, f, d, r) => onSaveSchema(editSchemaCol.col, o, k, n, nb, t, f, d, r)}
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
          <EmptyState
            icon={<DbGlyphIcon />}
            title="Nothing here yet"
            hint={`Notes in the “${dbType}” database show up here`}
            action={{ label: "New entry", onClick: () => setNewTitle("") }}
          />
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
        fx={fxResolver}
        fxAsOf={fxRatesState?.asOf}
        numberLocale={numberLocale}
        openPath={openPath}
        lastWritten={lastWritten}
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
        dismissAnchored={dismissAnchored}
        dragPath={dragPath}
        setDragPath={setDragPath}
        dropCol={dropCol}
        setDropCol={setDropCol}
        dropOn={dropOn}
        handOrder={sorts.length === 0}
        cardDropAt={cardDropAt}
        setCardDropAt={setCardDropAt}
        dropCard={dropCard}
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
        fx={fxResolver}
        fxAsOf={fxRatesState?.asOf}
        numberLocale={numberLocale}
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
        fx={fxResolver}
        fxAsOf={fxRatesState?.asOf}
        numberLocale={numberLocale}
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
      scrolledY={scrolledY}
      setScrolledY={setScrolledY}
      moreRight={moreRight}
      setMoreRight={setMoreRight}
      dismissAnchored={dismissAnchored}
      anchorStaleScope={anchorStaleScope}
      cycleSort={cycleSort}
      startResize={startResize}
      resetWidth={resetWidth}
      colDrag={colDrag}
      setColDrag={setColDrag}
      colDropAt={colDropAt}
      setColDropAt={setColDropAt}
      dropColumn={dropColumn}
      endColDrag={endColDrag}
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
      onCellMenu={onCellMenu}
      onTrashNotes={onTrashNotes}
      sel={sel}
      writeFailed={writeFailed}
      lastWritten={lastWritten}
      bulkClosing={bulkClosing}
      clearSel={clearSel}
      editCell={editCell}
      setEditCell={setEditCell}
      schemaEditCell={schemaEditCell}
      setSchemaEditCell={setSchemaEditCell}
      startEdit={startEdit}
      hopEdit={hopEdit}
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
      fxAsOf={fxRatesState?.asOf}
      fx={fxResolver}
      numberLocale={numberLocale}
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
