import { DEFAULT_NUMBER_LOCALE, numberLocaleSetting, setNumberLocale, type NumberLocale } from "./lib/numberLocale";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { isTauri } from "./lib/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTyping, isTypingNow } from "./lib/dom";
import { MENU_SURFACES } from "./lib/menusurfaces";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DbIcon, DbLayout, DriveInfo, FolderListing, MountInfo, MountRow, MountScanStats, NewTypeProp, NoteMeta, NumberFormat, PropKind, PropValue, RollupConfig, SavedView, SavedViewSort, SealScopeInfo, SelectOption, SidebarOrder, TagFolder, VaultHistoryPoint, View, ViewPref } from "./lib/types";
import { foldedPropKey, foldedPropStr, FUNCTIONAL_TYPES, typeHome, viewKey } from "./lib/types";
import { tagFolderApplyTags, tagFolderMatches, tagUniverse } from "./lib/tags";
import { dbColumns } from "./lib/dbcolumns";
import { savedViewPref } from "./lib/vieweval";
import { byFoldedKey, foldedObjectKey, isTypePropName, typeSchemaFor } from "./lib/schemalookup";
import { folderDefaultIcon, iconForType, iconsByType } from "./lib/dbicons";
import { dashboardKindOption, newDashboardProps } from "./lib/newdashboard";
import { dbTypesByRecency } from "./lib/dbRecency";
import { looksLikeUrl } from "./lib/url";
import { anchorLine, parseWikiLink } from "./lib/wikilinks";
import { displayColLabel } from "./lib/display";
import {
  filterByQuery,
  findViewByName,
  isPristineScratch,
  isScratchNote,
  newViewId,
  partitionDbEntries,
  pinsInSidebarOrder,
  scratchNotes,
  type DbBlock,
} from "./lib/views";
import { exportSavedView, exportSummary, savedViewRows } from "./lib/viewexport";
import { focusSoon } from "./lib/focussoon";
import { dailyDateOf, dailyPath, journalOrder, JOURNAL_DIR } from "./lib/journal";
import { todayIso } from "./lib/dates";
import { isPickedToday, TODAY_PROP } from "./lib/today";
import {
  propList,
  propListValue,
  relationCandidates as relationCandidatesFor,
  toggleValue,
} from "./lib/relation";
import {
  assignKey,
  keyForTarget,
  keyLabel,
  splitFreeKeys,
  unassignKey,
} from "./lib/keyassign";
import { pinKeyLabels } from "./lib/shortcuts";
import { addTagsUndoable, setPropUndoable, type PropWriter, type UndoRecorder } from "./lib/undoprops";
import { addOptionAndWriteUndoable } from "./lib/undoschema";
import {
  isIntrinsic,
  MOUNT_SCHEME,
  mountStatus,
  rowMetas,
  scanStatLine,
} from "./lib/mounts";
import * as undoStack from "./lib/undo";
import { UndoContext } from "./lib/undoContext";
import { NavContext } from "./lib/navContext";
import {
  createFolderUndoable,
  moveFolderUndoable,
  moveUndoable,
  recordCreate,
  recordTrashBulk,
  renameFolderUndoable,
  renameUndoable,
  trashFolderUndoable,
  trashUndoable,
} from "./lib/undostruct";
import { announceRename } from "./lib/renamebus";
import { migrateSessionFolds } from "./lib/foldsession";
import {
  isAppFile,
  netAllowed,
  parseAutoSync,
  parseDbGrid,
  parseModHud,
  parseShowAppFiles,
  parseTaskStaleChips,
  parseTerminalActions,
  parseWindowOpacity,
  SETTINGS_PATH,
} from "./lib/settings";
import {
  appearancePreviewPending,
  applyAppearance,
  DEFAULT_APPEARANCE,
  parseAppearance,
} from "./lib/appearance";
import { DEFAULT_DATE_LOCALE, dateLocaleSetting, setDateLocale } from "./lib/dateLocale";
import { applyWindowOpacity } from "./lib/vibrancy";
import {
  historyEnter,
  historyLeave,
  historyPoints,
  historyProjectionActive,
  historyRestore,
  fileOpen,
  filePick,
  fileReveal,
  historySnapshot,
  mountAdd,
  mountAnnotate,
  mountBind,
  mountRemove,
  mountRows,
  drivesList,
  mountsList,
  recallStatus,
  urlCapture,
  vaultClearProp,
  vaultCreate,
  vaultCreateFolder,
  vaultCreateType,
  vaultDelete,
  vaultDeleteMany,
  vaultDeleteType,
  vaultFolderIconSet,
  vaultFolderMetaRead,
  vaultFolders,
  vaultList,
  vaultRead,
  vaultRemoveSealScope,
  vaultRenameProp,
  vaultRenameType,
  vaultResolve,
  vaultFolderFiles,
  vaultRoot,
  vaultSavedViewDelete,
  vaultSavedViewSet,
  vaultSavedViewsRead,
  vaultSchemaHomeSet,
  vaultSchemaParentSet,
  vaultSchemaRead,
  vaultSchemaSet,
  vaultSchemaSetIcon,
  vaultNoteAddTags,
  vaultSealScopes,
  vaultSetSidebarOrder,
  vaultSidebarOrder,
  vaultTagFoldersRead,
  vaultTagFoldersWrite,
  vaultTemplateList,
  vaultTemplateRead,
  vaultTrashRestore,
  vaultTrashRestoreFolder,
  vaultViewsRead,
  vaultViewsSet,
  vaultWriteBody,
  viewExportForget,
  viewExportTarget,
} from "./lib/ipc";
import {
  applyOrder,
  dashTreeFolder,
  migrateOrderId,
  moveId,
  orderedRootNodes,
  orderedSiblingFolders,
  pinTreeFolder,
  hiddenFromSidebar,
  splitDashboards,
  splitPins,
} from "./lib/sidebar";
import { buildNoteActions, duplicateNote as duplicateNoteInVault } from "./lib/noteactions";
import SealedNoteDialog, { type SealedNoteMode } from "./components/SealedNoteDialog";
import { buildNoteExtras, type NoteExtras } from "./lib/noteextras";
import { forgetSealed, holdSealed, relockSealed, subscribeSealed, unlockedSealedPaths } from "./lib/sealedsession";
import { exportNoteMarkdown, exportNoteOneSheet, exportNotePdf } from "./lib/export";
import { embedQueryFor, savedViewFence, type ViewSpecResult } from "./lib/embeds";
import {
  buildEntryBody,
  buildEntryProps,
  canonicalTemplateType,
  homeFolderFor,
  mergeEntryProp,
  templatePath,
  templateTypeOf,
  TEMPLATES_DIR,
} from "./lib/templates";
import { parseCsv } from "./lib/sheet";
import { parsePages } from "./lib/pages";
import { errText } from "./lib/errtext";
import {
  deleteDbOutcome,
  renameDbOutcome,
  renamePropOutcome,
  schemaOnlyClearOutcome,
  stripPropOutcome,
  withSnapshotWarning,
} from "./lib/sweep";
import { pickCsvFile } from "./lib/csvpick";
import type { CsvEntry } from "./lib/csvimport";
import ShareDialog from "./components/ShareDialog";
import SealScopeDialog from "./components/SealScopeDialog";
import TagFolderDialog from "./components/TagFolderDialog";
import TypeIcon from "./components/TypeIcon";
import Sidebar, { type FolderEdit, type MenuTarget, type Section } from "./components/Sidebar";
import ListPane from "./components/ListPane";
import MiniPlayer from "./components/MiniPlayer";
import { playableFiles } from "./lib/folderfiles";
import { getQueue, startQueue, subscribeQueue, syncQueue } from "./lib/playqueue";
import { getPrintable, subscribePrintable } from "./lib/printable";
import NotePane from "./components/NotePane";
import DashboardPane from "./components/DashboardPane";
import { useDashUndoState } from "./components/useDashUndo";
import DatabasePane from "./components/DatabasePane";
import DbManagerPane from "./components/DbManagerPane";
import CalendarPane from "./components/CalendarPane";
import TodayPane from "./components/TodayPane";
import SearchPane from "./components/SearchPane";
import TrashPane from "./components/TrashPane";
import DoctorPane from "./components/DoctorPane";
import VaultSyncPane from "./components/VaultSyncPane";
import ChangelogPane from "./components/ChangelogPane";
import CookbookPane from "./components/CookbookPane";
import AssetsPane from "./components/AssetsPane";
import ShelfPane from "./components/ShelfPane";
import Palette, { type StartStage } from "./components/Palette";
import ShortcutOverlay from "./components/ShortcutOverlay";
import KeyHints, { type HoldHudCtx } from "./components/KeyHints";
import KeyAssignHud from "./components/KeyAssignHud";
import InfoView from "./components/InfoView";
import TooltipHost from "./components/Tooltip";
import TimeTravelBar from "./components/TimeTravelBar";
import ReceiptsPeek from "./components/ReceiptsPeek";
import SettingsPane from "./components/SettingsPane";
// lazy: TerminalHud is the only xterm.js importer, and the web/mock surface
// (e2e) never renders it — code-splitting keeps xterm's parse cost out of
// every mock page load entirely; desktop fetches the chunk once at mount
const TerminalHud = lazy(() => import("./components/TerminalHud"));
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
import IconPicker from "./components/IconPicker";
import type { AnchorRect } from "./components/SelectMenu";
import {
  DeleteDatabaseDialog,
  CsvImportDialog,
  MountFolderDialog,
  NewDatabaseDialog,
  RenameDialog,
  StripPropDialog,
  UnmountDialog,
} from "./components/DbAdmin";
import { ClockIcon, CopyIcon, DbIcon as DbGlyphIcon, ExportIcon, FolderIcon, KeyboardIcon, MenuIcon, MountIcon, NoteActionGlyph, NoteIcon, PenIcon, PinIcon, PlusIcon, RepeatIcon, SidebarIcon, TableIcon, TrashIcon, XIcon, ChevronLeftIcon, ChevronUpIcon, ChevronDownIcon } from "./components/Icons";
import { HeroNote } from "./components/HeroIcons";
import EmptyState from "./components/EmptyState";
import { useSidebarHidden } from "./hooks/useSidebarHidden";
import { useZoom } from "./hooks/useZoom";
import { useTerminalHud } from "./hooks/useTerminalHud";
import { useMobileLayout } from "./hooks/useMobileLayout";
import { useUndoStack } from "./hooks/useUndoStack";
import { useViewHistory } from "./hooks/useViewHistory";
import { useVaultEvents, type SheetRowTarget } from "./hooks/useVaultEvents";
import { useAutoSync } from "./hooks/useAutoSync";
import { useShareCapture } from "./hooks/useShareCapture";
import { useShortcutRouter } from "./hooks/useShortcutRouter";
import { useToast } from "./hooks/useToast";
import { useUpdater } from "./hooks/useUpdater";
import { useWidgetSummary } from "./hooks/useWidgets";
import { useSearch } from "./hooks/useSearch";
import { useVaultIndex } from "./hooks/useVaultIndex";
import { queueViewsWrite, useVaultConfigs } from "./hooks/useVaultConfigs";
import { useSidebarOrderModel } from "./hooks/useSidebarOrderModel";

/** Membership. `tagFolders` is only consulted by the tagfolder kind — a view
    naming a folder that no longer exists matches nothing, which is what keeps
    a deleted tag folder from showing the whole vault. */
function inView(n: NoteMeta, view: View, tagFolders: TagFolder[] = []): boolean {
  switch (view.kind) {
    case "notes":
      return isScratchNote(n);
    case "all":
      return true;
    case "db":
      return foldedPropStr(n.props, "type")?.toLowerCase() === view.type.toLowerCase();
    case "folder":
      return n.folder === view.path || n.folder.startsWith(`${view.path}/`);
    case "tagfolder": {
      const folder = tagFolders.find((f) => f.id === view.id);
      return folder ? tagFolderMatches(folder, n.tags ?? []) : false;
    }
    case "tag":
      return (n.tags ?? []).some((t) => t.toLowerCase() === view.tag.toLowerCase());
    case "search":
    case "saved":
    // a mount's rows come from its index, not from the note list
    case "mount":
    case "dashboard":
    case "trash":
    case "assets":
    // a drive's rows come from its catalog, the same way a mount's come from
    // its index
    case "shelf":
    case "drive":
    case "doctor":
    case "calendar":
    case "today":
    case "vaultsync":
    case "changelog":
    case "cookbook":
    case "dbmanager":
      return false;
  }
}

/** one shared identity for "no persisted order", so the memo boundary holds */
const EMPTY_ORDER: string[] = [];

export default function App() {
  const {
    notes: indexedNotes,
    setNotes,
    notesRef,
    folders,
    setFolders,
    vaultEpoch,
    setVaultEpoch,
    changedPaths,
    setChangedPaths,
    bootError,
    lastOwnRefreshRef,
    refresh,
  } = useVaultIndex();
  // cold open lands on the Notes scratch list — Today is
  // a destination (sidebar, palette, ⌘1), never the front door
  const [view, setView] = useState<View>({ kind: "notes" });
  const [selected, setSelected] = useState<string | null>(null);
  // the open note, readable from callbacks that must not re-bind on every
  // selection change (same-note `[[#Heading]]` links)
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const {
    mobile,
    mobilePane,
    setMobilePane,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSwipeStart,
    showMobileDetail,
  } = useMobileLayout();
  /** A daily surface being viewed with no file behind it — the note
      is created on the first keystroke, never by mere navigation */
  const [ghostPath, setGhostPath] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<null | "palette" | "capture">(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timeTravelOpen, setTimeTravelOpen] = useState(false);
  const [timePoints, setTimePoints] = useState<VaultHistoryPoint[]>([]);
  const [timePoint, setTimePoint] = useState<VaultHistoryPoint | null>(null);
  const [timeBusy, setTimeBusy] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const {
    termOpen,
    termSettings,
    termInject,
    terminalActions,
    setTerminalActions,
    setTerminalSize,
    refreshTerminalSettings,
    toggleTerminal,
    terminalRun,
  } = useTerminalHud(mobile);
  const { sidebarHidden, toggleSidebar } = useSidebarHidden();
  const [paletteStart, setPaletteStart] = useState<StartStage | null>(null);
  // `mod-hud` in Settings.md, default on until a read says otherwise
  const [modHud, setModHud] = useState(true);
  // `show-agent-files` in Settings.md — the seeded
  // AGENTS.md/CLAUDE.md and Settings.md itself stay ordinary files on disk
  // (and in the engine index), but the app's own note surfaces conceal them
  // unless this is explicitly true, so a vault reads as the user's content
  // rather than the tooling's
  const [showAppFiles, setShowAppFiles] = useState(false);
  // `db-grid` in Settings.md — the global default for table grid
  // lines; a database's ViewPref `grid` overrides it either way
  const [dbGrid, setDbGrid] = useState(true);
  // `task-stale-chips` in Settings.md — the global default for the
  // Tasks board's age chips; a board's own `stale_days` and a note's
  // `stale: never` both override it
  const [taskStaleChips, setTaskStaleChips] = useState(true);
  // `auto-sync` in Settings.md — the timer lane of vault sync (push on
  // settle, pull on open/focus/interval). Inert without a remote.
  const [autoSync, setAutoSync] = useState(true);
  // `net-link-titles` in Settings.md — gates the page-title fetch
  // behind a pasted link. The capture itself is local and always happens, so
  // this only decides whether the engine then asks that site anything.
  // `net-share-relay`, the other request this app makes, is enforced inside
  // the share door, which reads Settings.md for the relay URL anyway.
  const [netLinkTitles, setNetLinkTitles] = useState(true);
  /** `number-locale`: the one dialect every number in the app is
      written in — de-DE `1.234,56` by default. Held as state as well as in the
      numberLocale.ts binding: the surfaces that take it as a prop (db cells,
      calc lines) then repaint on the next vaultEpoch bump rather than waiting
      for whatever else happens to re-render them. Rides the settings read
      below, so a pick in the ⌘, pane reaches both in the same pass. */
  const [numberLocale, setNumberLocaleState] = useState<NumberLocale>(DEFAULT_NUMBER_LOCALE);
  /** The key picker opened from a sidebar row's "Assign key…" — its
      own state, so the parent menu can close itself around it */
  const [keyPicker, setKeyPicker] = useState<{ target: string; x: number; y: number } | null>(null);
  /** the folder-icon picker set from a folder's context menu */
  const [folderIconMenu, setFolderIconMenu] = useState<{ path: string; anchor: AnchorRect } | null>(
    null
  );
  /** the db-icon picker set from a database's context menu */
  const [dbIconMenu, setDbIconMenu] = useState<{ type: string; anchor: AnchorRect } | null>(null);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  // session-local layout inside an open pin — persisted only by re-saving it
  const [svPref, setSvPref] = useState<ViewPref | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // second-stage folder picker for "Set home folder…": the row
  // menu swaps to this so the pick lands on the same spot
  const [homePicker, setHomePicker] = useState<{ dbType: string; x: number; y: number } | null>(
    null
  );
  // The dashboard row's "Move to folder…" second stage — same
  // swap-in-place pattern, scoped to the dashboards' folders
  const [dashMovePicker, setDashMovePicker] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  // The folder row's "Open as database…" second stage — pick an
  // existing database to home here, or birth a new one homed here
  const [openAsPicker, setOpenAsPicker] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [folderEdit, setFolderEdit] = useState<FolderEdit | null>(null);
  const [templateTypes, setTemplateTypes] = useState<string[]>([]);
  const [dbNote, setDbNote] = useState<string | null>(null);
  const [dbNewSeq, setDbNewSeq] = useState(0);
  const [calNewSeq, setCalNewSeq] = useState(0);
  const { toast, setToast, showToast } = useToast();
  const { zoom, applyZoom } = useZoom(showToast);
  const { checkNow: checkUpdates } = useUpdater(showToast);
  useWidgetSummary(indexedNotes, vaultEpoch);
  // Database management: which admin dialog is open (null = none);
  // create's fromSidebar marks the Folders "+" entry point — the new db is
  // homed into the tree on creation; homeFolder is the folder
  // menu's "Open as database…" birth — the new db homes on that
  // exact folder instead of an eponymous root
  const [dbDialog, setDbDialog] = useState<
    | { kind: "create"; fromSidebar?: boolean; homeFolder?: string }
    | { kind: "rename-db"; dbType: string }
    | { kind: "delete-db"; dbType: string }
    | { kind: "rename-prop"; dbType: string; prop: string }
    | {
        kind: "strip-prop";
        dbType: string;
        prop: string;
        count: number;
        wasNumber: boolean;
      }
    | null
  >(null);
  // CSV import: the picked, parsed file waiting on the import dialog
  const [csvImport, setCsvImport] = useState<{ fileName: string; rows: string[][] } | null>(null);
  // The note whose share door is open
  const [share, setShare] = useState<NoteMeta | null>(null);
  // "Mount a folder…": the dialog's open state
  const [mountDialog, setMountDialog] = useState(false);
  /** every mount in the vault, with this machine's binding resolved */
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  /** the Drive Shelf's own list — the sidebar's row count and its drive rows.
      Drives ARE mounts, but the shelf's totals and staleness come from the
      catalog rather than the registry, so it is its own read. */
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  /** the open mount's rows — its last-known index merged with its sidecars */
  const [mountRowList, setMountRowList] = useState<MountRow[]>([]);
  /** the mount whose "unmount and trash its notes" is awaiting confirmation */
  const [unmountAsk, setUnmountAsk] = useState<MountInfo | null>(null);
  const [sealScopes, setSealScopes] = useState<SealScopeInfo[]>([]);
  const [sealScopeDialog, setSealScopeDialog] = useState<{
    path: string;
    mode?: "seal" | "confirm";
  } | null>(null);
  const editorFocusRef = useRef<(() => void) | null>(null);
  // drops a block at the note pane's cursor (the saved-view pin's "Embed in
  // this note"). Null whenever no editable note pane is mounted.
  const noteInsertRef = useRef<((text: string) => boolean) | null>(null);
  // focuses the note pane's title input with the text selected (⌘N in Notes)
  const titleFocusRef = useRef<(() => void) | null>(null);
  // the open note pane's debounced-save flush: actions that read or
  // destroy the file from outside the pane (Duplicate, trash) wait for any
  // pending text to land first — the pane's own rule, app-wide.
  // The abandon lane awaits the same flush-and-settle before its
  // pristine check.
  const flushOpenRef = useRef<(() => Promise<void>) | null>(null);
  // Paths created by THIS session's ⌘N — the only notes the abandon
  // lane may ever delete; pre-existing Untitled files are never touched
  const scratchPaths = useRef(new Set<string>());
  const abandonBusy = useRef(new Set<string>());
  const dbExportRef = useRef<(() => void) | null>(null);
  const { undoState, undoDispatch, undoStateRef, runUndoEntry, undoApi } = useUndoStack(
    refresh,
    showToast
  );

  const {
    viewsConfig,
    setViewsConfig,
    sidebarOrder,
    setSidebarOrder,
    savedViews,
    setSavedViews,
    folderMeta,
    setFolderMeta,
    tagFolders,
    setTagFolders,
    schema,
    setSchema,
    reloadSidebarOrder,
    refreshConfigs,
    persistViewsConfig,
  } = useVaultConfigs(showToast);

  /* Which pins already have a link folder on THIS machine, by view
     id. Device-local state, so it is read over IPC rather than from the
     synced views config — a target path is true for one machine only. */
  const [exportTargets, setExportTargets] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    Promise.all(
      savedViews.map((v) =>
        viewExportTarget(v.id)
          .catch(() => null)
          .then((t) => [v.id, t] as const)
      )
    ).then((pairs) => {
      if (!live) return;
      setExportTargets(
        Object.fromEntries(pairs.filter((p): p is readonly [string, string] => !!p[1]))
      );
    });
    return () => {
      live = false;
    };
  }, [savedViews]);

  const reloadSealScopes = useCallback(() => {
    vaultSealScopes().then(setSealScopes).catch((e) => showToast(`couldn't read vault seals (${errText(e)})`));
  }, [showToast]);

  useEffect(() => {
    reloadSealScopes();
  }, [reloadSealScopes]);

  // Only a confirmed marker seals anything, so an unconfirmed one
  // must not hide "Seal folder…" on the rows underneath it either.
  const scopeInheritedAt = useCallback(
    (path: string) =>
      sealScopes.some(
        (scope) =>
          scope.confirmed &&
          (scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`))
      ),
    [sealScopes]
  );

  const removeSealScope = useCallback(
    (path: string, rejecting = false) => {
      vaultRemoveSealScope(path)
        .then(() => {
          reloadSealScopes();
          showToast(
            rejecting
              ? `Unconfirmed seal rejected — nothing was encrypted or purged`
              : `${path ? "Folder" : "Vault"} inheritance stopped — existing encrypted notes stay sealed`
          );
        })
        .catch((e) => showToast(errText(e)));
    },
    [reloadSealScopes, showToast]
  );

  // window drag: `data-tauri-drag-region` only fires when the
  // mousedown target IS the marked element — the header bars are mostly covered
  // by titles/counts, so drags on the text never reached it. Walk up from the
  // real target instead and start the OS drag ourselves, skipping anything
  // interactive inside the bar.
  useEffect(() => {
    if (!isTauri) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-tauri-drag-region]")) return;
      if (t.closest("button, input, select, a, textarea, [contenteditable], .chip, .selmenu")) return;
      e.preventDefault();
      getCurrentWindow().startDragging().catch(console.error);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);


  /* The Agent Ledger's props for the three shared panes, spread rather than
     named as attributes: a JSX opening tag has nowhere to put a comment, so a
     prop only the private build carries has to arrive through an object the
     strip pass can leave empty. */

  const ledgerSidebarProps: Record<string, boolean> = {};
  const ledgerPaletteProps: Record<string, boolean> = {};
  const ledgerListProps: Record<string, ReadonlySet<string>> = {};
  /* Same workaround, for the palette's lens rows: an optional prop the shared
     build does not carry at all. */
  const lensPaletteProps: Record<string, { id: string; relay: string; label: string }[]> = {};


  // palette quick actions come from Settings.md, so they must be
  // known before the palette first opens — not only when the HUD spawns. Read
  // once at boot; the HUD's own re-reads below keep it fresh after an edit.
  // The hold-⌘ HUD's off switch rides the same read, re-run on
  // vaultEpoch so toggling it in the settings pane takes effect immediately.
  useEffect(() => {
    // a dial the user is still holding has not reached the note, so
    // this read would repaint the old value over it — see lib/appearance.ts
    const overtaken = () => appearancePreviewPending();
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        setTerminalActions(parseTerminalActions(c.props));
        setModHud(parseModHud(c.props));
        setDbGrid(parseDbGrid(c.props));
        setTaskStaleChips(parseTaskStaleChips(c.props));
        setAutoSync(parseAutoSync(c.props));
        setShowAppFiles(parseShowAppFiles(c.props));
        // The appearance dials land on the document element rather
        // than in React state — they are CSS inputs, nothing renders off
        // them. This is also the write that CORRECTS the settings pane's
        // optimistic preview once the note has actually taken the value.
        // The window ground is previewed by the same drag and lost
        // the same race, so it rides the same claim — outside one, this is
        // still the write that corrects the pane's optimistic preview.
        if (!overtaken()) {
          applyAppearance(document.documentElement, parseAppearance(c.props));
          applyWindowOpacity(parseWindowOpacity(c.props));
        }
        setNetLinkTitles(netAllowed(c.props, "link-titles"));
        // both seams from the one read: the binding for the module-scope
        // formatters (sheet cells, file sizes, dashboards), the state for the
        // props-threaded ones
        {
          const locale = numberLocaleSetting(c.props);
          setNumberLocale(locale);
          setNumberLocaleState(locale);
        }
        // `date-locale` is a module binding, not React state — every
        // date formatter in the app is module-scope or inline, and this read
        // re-runs on vaultEpoch, which is also what repaints them.
        setDateLocale(dateLocaleSetting(c.props));
      })
      .catch(() => {
        setTerminalActions([]);
        // an unreadable Settings.md falls back to the shipped look rather than
        // leaving whatever happened to be applied last — unless a dial is
        // mid-drag, in which case the live preview outranks the fallback
        // the pane, not a failed read, is what the user is
        // holding, and the release repaints from the note either way.
        if (!overtaken()) applyAppearance(document.documentElement, DEFAULT_APPEARANCE);
        // the number dialect falls back the same way and for the same reason
        // a settings note we cannot read is not evidence for any
        // particular dial, and showing the shipped default is both honest and
        // recoverable — the next successful read restores the chosen dialect.
        // Numbers stay canonical dot-decimal on disk throughout, so a fallback
        // render never rewrites a file.
        setNumberLocale(DEFAULT_NUMBER_LOCALE);
        setNumberLocaleState(DEFAULT_NUMBER_LOCALE);
        setDateLocale(DEFAULT_DATE_LOCALE);
      });
  }, [vaultEpoch]);

  // What the rest of the app calls `notes` — the index minus the
  // concealed app files. One boundary here, so every downstream surface
  // (lists, palette, search, sidebar counts, wikilink completion) agrees;
  // paths that must still WORK on a concealed file (openNote by path,
  // selectedMeta, followLink) read the full index via `indexedNotes`.
  const notes = useMemo(
    () => (showAppFiles ? indexedNotes : indexedNotes.filter((n) => !isAppFile(n.path))),
    [indexedNotes, showAppFiles]
  );

  // templates are plain files edited outside the watcher, so there is no
  // vault:changed to observe — re-read the list on every overlay change
  // (opening the palette refreshes it)
  useEffect(() => {
    vaultTemplateList().then(setTemplateTypes).catch(console.error);
  }, [overlay]);

  // leaving a database closes its side note and drops pin-session overrides.
  // Only LEAVING clears: entering a db with a note already chosen —
  // a search hit opening in its home database — must not lose it to the swap.
  // A birth navigation is a db→db switch that CARRIES its note into
  // the destination — the flag suppresses that one clear (consumed once on
  // the next view change, same discipline as backNav).
  const dbNoteCarry = useRef(false);
  const viewKeyNow = viewKey(view);
  const prevViewKey = useRef(viewKeyNow);
  useEffect(() => {
    const prev = prevViewKey.current;
    prevViewKey.current = viewKeyNow;
    if (prev === viewKeyNow) return;
    const carried = dbNoteCarry.current;
    dbNoteCarry.current = false;
    if (prev.startsWith("db:") || prev.startsWith("sv:")) {
      if (!carried) setDbNote(null);
      setSvPref(null);
    }
  }, [viewKeyNow]);

  const {
    openNoteRef,
    openSheetRowRef,
    openViewRef,
  } = useVaultEvents({
    refresh,
    refreshConfigs,
    refreshSealScopes: reloadSealScopes,
    showToast,
    undoDispatch,
    setChangedPaths,
    setVaultEpoch,
    lastOwnRefreshRef,
  });

  // iOS share-sheet captures waiting in the App Group — swept before the sync
  // lane below, so anything shared while the app was away rides the next push
  useShareCapture();

  // the timer lane of vault sync — push on settle, pull on open/focus/interval
  useAutoSync(autoSync);

  // types with at least one note (dashboard excluded) — the single source of
  // truth for which types are databases: the sidebar unions
  // schema-registered types on top, the views partition takes this set
  const usedTypes = useMemo(() => {
    const counts = new Map<string, number>();
    const casing = new Map<string, string>();
    for (const n of notes) {
      const t = foldedPropStr(n.props, "type");
      if (!t || FUNCTIONAL_TYPES.has(t.toLowerCase())) continue;
      const folded = t.toLowerCase();
      const key = casing.get(folded) ?? t;
      casing.set(folded, key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [notes]);

  // every note title — the body editor's [[ wikilink completion pool
  const noteTitles = useMemo(() => notes.map((n) => n.title), [notes]);

  // the sheet notes — the name popup inside a `= … ` span, which reaches a
  // sheet's summaries and columns by title (vault-format §5.10)
  const sheetTitles = useMemo(
    () =>
      notes
        .filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === "sheet")
        .map((n) => n.title),
    [notes]
  );

  const databases = useMemo(() => {
    // schema-registered databases list even with zero notes
    const counts = new Map(usedTypes);
    const casing = new Set([...counts.keys()].map((t) => t.toLowerCase()));
    for (const t of Object.keys(schema)) {
      const folded = t.toLowerCase();
      if (!FUNCTIONAL_TYPES.has(folded) && !casing.has(folded)) {
        counts.set(t, 0);
        casing.add(folded);
      }
    }
    // A mount IS a database — its name is a schema type, so it is
    // already in `counts`, but with the sidecar count (usually 0). Its real
    // size is its index, and carrying the mount here is what lets every
    // database surface route to the mount view and wear the mount glyph.
    const byName = new Map(mounts.map((m) => [m.name.toLowerCase(), m]));
    return [...counts.entries()]
      .map(([type, count]) => {
        const mount = byName.get(type.toLowerCase());
        return mount ? { type, count: mount.files, mount } : { type, count };
      })
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [usedTypes, schema, mounts]);

  /** mount by its database name — a mount's name IS its schema type, so any
      surface holding a type string can find out it is really a mount */
  const mountByType = useMemo(
    () => new Map(mounts.map((m) => [m.name.toLowerCase(), m])),
    [mounts]
  );

  /** folded names of the mounted folders, for surfaces that only want to know
      whether a database IS one (the sidebar's glyph) */
  const mountDbNames = useMemo(() => new Set(mountByType.keys()), [mountByType]);

  /** Where a database name really goes: its mount view when the name is a
      mounted folder, its database view otherwise. Every "open this database"
      path resolves through here, so a mount is reachable from the manager,
      the sidebar and the palette without any of them knowing what a mount
      is — the callers differ only in what else their navigation does. */
  const viewForDb = useCallback(
    (type: string): View => {
      const mount = mountByType.get(type.toLowerCase());
      return mount ? { kind: "mount", id: mount.id } : { kind: "db", type };
    },
    [mountByType]
  );

  const openDatabase = useCallback((type: string) => setView(viewForDb(type)), [viewForDb]);

  /** the mount the current view is about, or null */
  const activeMount = useMemo(
    () => (view.kind === "mount" ? (mounts.find((m) => m.id === view.id) ?? null) : null),
    [view, mounts]
  );

  /** its rows in note shape, which is all DatabasePane ever wanted */
  const mountNotes = useMemo(
    () => (activeMount ? rowMetas(activeMount, mountRowList) : []),
    [activeMount, mountRowList]
  );

  const dashboards = useMemo(
    () =>
      notes
        .filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === "dashboard")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [notes]
  );

  const orderedDashboards = useMemo(
    () => applyOrder(dashboards, sidebarOrder.dashboards ?? [], (d) => d.path),
    [dashboards, sidebarOrder]
  );

  const orderedDatabases = useMemo(
    () => applyOrder(databases, sidebarOrder.databases ?? [], (d) => d.type),
    [databases, sidebarOrder]
  );

  // `folders` is optional on the Rust struct and the loaders write it
  // straight through, so a `?? []` inline at the call site would mint a fresh
  // array on every render and make memo(Sidebar) a no-op for every vault whose
  // folder order was never dragged. Pin the empty case to one identity.
  const sidebarFolderOrder = useMemo(
    () => sidebarOrder.folders ?? EMPTY_ORDER,
    [sidebarOrder.folders]
  );

  /** The Dashboards section's group headers in drag order — same
      pinned-empty-identity trick as `sidebarFolderOrder` above. */
  const sidebarDashGroupOrder = useMemo(
    () => sidebarOrder.dashgroups ?? EMPTY_ORDER,
    [sidebarOrder.dashgroups]
  );

  // Root folder paths in sidebar display order — the persisted drag
  // order with new folders appended; drives the Move up/down menu math
  const orderedRootFolders = useMemo(
    () => orderedRootNodes(folders, sidebarOrder.folders ?? []).map((n) => n.path),
    [folders, sidebarOrder.folders]
  );

  // Folder path → database type for dbs whose home folder exists.
  // A home pointing at a folder that isn't there (hand-edit, not yet
  // created) leaves the db in the flat Databases section rather than
  // vanishing from the sidebar.
  const homeDbByFolder = useMemo(() => {
    const existing = new Set(folders);
    const out = Object.create(null) as Record<string, string>;
    for (const [type, entry] of Object.entries(schema)) {
      const home = typeHome(entry);
      if (home && existing.has(home)) out[home] = type;
    }
    return out;
  }, [schema, folders]);

  // the inverse lookup — a db's home folder, for its context menu
  const homeByDb = useMemo(() => {
    const out = Object.create(null) as Record<string, string>;
    for (const [folder, type] of Object.entries(homeDbByFolder)) out[type] = folder;
    return out;
  }, [homeDbByFolder]);

  // pin ids in sidebar order — the ⌘5…⌘9 targets
  const pinIds = useMemo(
    () =>
      pinsInSidebarOrder(
        savedViews,
        orderedDatabases.map((d) => d.type)
      ).map((v) => v.id),
    [savedViews, orderedDatabases]
  );

  const viewNotes = useMemo(() => {
    if (view.kind === "notes") return scratchNotes(notes);
    const filtered = notes.filter((n) => inView(n, view, tagFolders));
    if (view.kind === "all") {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    }
    // the Journal folder lists its dailies newest-first
    if (view.kind === "folder" && view.path === JOURNAL_DIR) return journalOrder(filtered);
    return filtered;
  }, [notes, view, tagFolders]);

  // In folder and All notes views the database entries collapse into
  // per-database blocks above the loose rows; every other view lists its
  // scope as-is. Blocks are click-through only — the loose rows are the
  // selectable list. Membership follows the used-types set, so a
  // type with notes collapses even without a schema entry.
  const viewRows = useMemo<{ loose: NoteMeta[]; blocks: DbBlock[] }>(() => {
    if (view.kind === "folder" || view.kind === "all")
      return partitionDbEntries(viewNotes, new Set(usedTypes.keys()));
    return { loose: viewNotes, blocks: [] };
  }, [viewNotes, view, usedTypes]);

  const scratchCount = useMemo(() => notes.filter(isScratchNote).length, [notes]);

  useEffect(() => {
    // an open template lives outside the index — never snap away
    if (selected && templateTypeOf(selected)) return;
    // a ghost daily has no file yet, so it's never in viewNotes
    if (selected && selected === ghostPath) return;
    // a concealed app file — Settings.md via the ⌘, sheet's
    // "edit raw", an agent file opened by wikilink — has no row in
    // any view, so membership can't decide for it
    if (selected && isAppFile(selected) && !notes.some((n) => n.path === selected)) return;
    if (viewNotes.length === 0) {
      setSelected(null);
      return;
    }
    // A phone opens on the list itself. Selecting the first row here would
    // immediately skip that navigation level and reproduce the squeezed
    // desktop shell's most confusing behavior.
    if (mobile) {
      if (selected && !viewNotes.some((n) => n.path === selected))
        setSelected((cur) => (cur === selected ? null : cur));
      return;
    }
    // membership is checked against the full scope, so a db entry opened
    // explicitly (palette, search hit, restore, embed click-through) keeps
    // its selection in views where it has no row of its own; auto-select
    // still lands on the first LOOSE note
    if (!selected || !viewNotes.some((n) => n.path === selected)) {
      // This effect can flush a frame late — ⌘N seeds and selects its
      // fresh note between the render that saw no selection and this commit.
      // Resolving against the live value keeps the snap from overwriting a
      // newer selection (which sent the rename and the typing to the note that
      // happened to be open before).
      setSelected((cur) => (cur === selected ? viewRows.loose[0]?.path ?? null : cur));
    }
  }, [viewNotes, viewRows, selected, ghostPath, mobile]);

  const selectedMeta = useMemo(() => {
    // the full index, not the concealed view: a hidden agent file
    // followed by wikilink must still open in the editor
    const found = indexedNotes.find((n) => n.path === selected) ?? null;
    if (found) return found;
    // templates are unindexed: synthesize the meta NotePane needs — content
    // is read from disk by path anyway
    const type = selected ? templateTypeOf(selected) : null;
    if (type && selected) {
      return {
        path: selected,
        stem: type,
        title: type,
        folder: TEMPLATES_DIR,
        props: {},
        updated_ms: 0,
        excerpt: "",
        // synthesized surfaces have no file behind them yet, so nothing to seal
        sealed: false,
      };
    }
    // ghost daily: the dated surface exists on screen, not on disk
    if (selected && selected === ghostPath) {
      const date = dailyDateOf(selected);
      if (date) {
        return {
          path: selected,
          stem: date,
          title: date,
          folder: JOURNAL_DIR,
          props: {},
          updated_ms: 0,
          excerpt: "",
          sealed: false,
        };
      }
    }
    // Settings.md via ⌘, "edit raw": concealed from `notes`, but
    // still present in the full index — synthesize the selected meta so the
    // editor can open it by path like the other concealed app files
    if (selected === SETTINGS_PATH) {
      return {
        path: SETTINGS_PATH,
        stem: "Settings",
        title: "Settings",
        folder: "",
        props: {},
        updated_ms: 0,
        excerpt: "",
        sealed: false,
      };
    }
    return null;
  }, [indexedNotes, selected, ghostPath]);

  const selectTimePoint = useCallback(
    async (id: string) => {
      setTimeBusy(true);
      setTimeError(null);
      try {
        const snapshot = await historyEnter(id);
        setTimePoint(snapshot.point);
        setNotes(snapshot.notes);
        setFolders(snapshot.folders);
        setViewsConfig(snapshot.views);
        setSchema(snapshot.schema);
        setSidebarOrder(snapshot.sidebar_order);
        setSavedViews(snapshot.saved_views);
        setFolderMeta(snapshot.folder_meta);
        setChangedPaths(null);
        setVaultEpoch((epoch) => epoch + 1);
        setOverlay(null);
        setSettingsOpen(false);
      } catch (error) {
        setTimeError(errText(error));
      } finally {
        setTimeBusy(false);
      }
    },
    [
      setChangedPaths,
      setFolderMeta,
      setFolders,
      setNotes,
      setSavedViews,
      setSchema,
      setSidebarOrder,
      setVaultEpoch,
      setViewsConfig,
    ]
  );

  const openTimeTravel = useCallback(async () => {
    setTimeTravelOpen(true);
    setTimeError(null);
    setTimeBusy(true);
    try {
      await (flushOpenRef.current?.() ?? Promise.resolve());
      // Make the departure state a real commit before any historical restore
      // can replace a live note. A clean tree already has that restore point.
      await historySnapshot("before vault time travel");
      const points = await historyPoints();
      setTimePoints(points);
      if (points.length === 0) setTimeError("No vault snapshots yet");
    } catch (error) {
      setTimeError(errText(error));
    } finally {
      setTimeBusy(false);
    }
  }, []);

  const reloadPresent = useCallback(async (reselect: string | null) => {
    const [liveNotes, liveFolders, liveViews, liveSchema, liveSidebar, liveSaved, liveFolderMeta] =
      await Promise.all([
        vaultList(),
        vaultFolders(),
        vaultViewsRead(),
        vaultSchemaRead(),
        vaultSidebarOrder(),
        vaultSavedViewsRead(),
        vaultFolderMetaRead(),
      ]);
    setNotes(liveNotes);
    setFolders(liveFolders);
    setViewsConfig(liveViews);
    setSchema(liveSchema);
    setSidebarOrder(liveSidebar);
    setSavedViews(liveSaved);
    setFolderMeta(liveFolderMeta);
    setChangedPaths(null);
    setVaultEpoch((epoch) => epoch + 1);
    setSelected(reselect && liveNotes.some((note) => note.path === reselect) ? reselect : null);
  }, [
    setChangedPaths,
    setFolderMeta,
    setFolders,
    setNotes,
    setSavedViews,
    setSchema,
    setSidebarOrder,
    setVaultEpoch,
    setViewsConfig,
  ]);

  const returnToPresent = useCallback(async () => {
    const reselect = selected;
    setTimeBusy(true);
    setTimeError(null);
    setSelected(null);
    // Live reads begin now, but shortcuts and every IPC mutation stay blocked
    // until their results have replaced the historical projection in React.
    historyLeave(false);
    try {
      await reloadPresent(reselect);
      historyLeave();
      setTimePoint(null);
      setTimeTravelOpen(false);
    } catch (error) {
      setTimeError(errText(error));
      // Recovery must never dead-end: the guard is still on with no
      // projection behind it, so a failed re-entry would leave every write
      // blocked and no working control on screen. Re-show the past
      // if we can; otherwise release the guard and land in the present, where
      // the error message is at least actionable.
      try {
        if (!timePoint) throw new Error("no snapshot to return to");
        await selectTimePoint(timePoint.id);
      } catch {
        historyLeave();
        setTimePoint(null);
        setTimeTravelOpen(false);
      }
    } finally {
      setTimeBusy(false);
    }
  }, [reloadPresent, selected, selectTimePoint, timePoint]);

  const restoreFromTime = useCallback(
    async (note: NoteMeta) => {
      if (!timePoint) return;
      setTimeBusy(true);
      setTimeError(null);
      try {
        // the baseline is the version being restored: any live
        // file newer than it means this restore would bury someone else's
        // change, which is exactly what the detection + rescue
        // snapshot exist for. Passing 0 disabled both.
        await historyRestore(note.path, timePoint.id, note.path, note.updated_ms);
        setSelected(null);
        historyLeave(false);
        await reloadPresent(note.path);
        historyLeave();
        setTimePoint(null);
        setTimeTravelOpen(false);
        setView({ kind: "all" });
        showToast(`Restored ${note.title}`);
      } catch (error) {
        if (!historyProjectionActive() && timePoint) await selectTimePoint(timePoint.id);
        setTimeError(errText(error));
      } finally {
        setTimeBusy(false);
      }
    },
    [reloadPresent, selectTimePoint, showToast, timePoint]
  );

  useEffect(() => () => historyLeave(), []);

  // leaving a ghost daily discards it — nothing was ever written
  useEffect(() => {
    if (ghostPath && selected !== ghostPath) setGhostPath(null);
  }, [selected, ghostPath]);

  // the open pin's definition (null outside saved views and for stale ids)
  const activeSaved = useMemo(
    () => (view.kind === "saved" ? savedViews.find((v) => v.id === view.id) ?? null : null),
    [view, savedViews]
  );

  const dashMeta = useMemo(
    () => (view.kind === "dashboard" ? notes.find((n) => n.path === view.path) ?? null : null),
    [notes, view]
  );

  const openNote = useCallback(
    (path: string) => {
      // full index: "Open" from search-by-path, a wikilink, or a
      // notification must reach a concealed agent file too
      const note = indexedNotes.find((n) => n.path === path);
      // inside a database (or one of its pins), a note of that type opens in
      // the side split
      const paneType =
        view.kind === "db" ? view.type : view.kind === "saved" ? activeSaved?.db : null;
      if (note && paneType && foldedPropStr(note.props, "type")?.toLowerCase() === paneType.toLowerCase()) {
        setDbNote(path);
        showMobileDetail();
        return;
      }
      if (note && !inView(note, view, tagFolders)) setView({ kind: "all" });
      // A daily note with no file behind it has to re-open as a ghost —
      // selecting the bare path would synthesize no meta and render
      // an empty pane. This is the path the "Reopen" toast takes when the
      // failed write was a ghost's create, and it fixes any other link to a day
      // that doesn't exist yet.
      if (!note && dailyDateOf(path)) {
        setView({ kind: "folder", path: JOURNAL_DIR });
        setGhostPath(path);
      }
      setSelected(path);
      showMobileDetail();
    },
    [indexedNotes, view, activeSaved, showMobileDetail, tagFolders]
  );
  useEffect(() => {
    openNoteRef.current = openNote;
  }, [openNote]);

  /* A sheet notification's click: open the note and hand the pane
     the row to reveal. The nonce makes a second click on the same row a new
     target — the grid clears each one as it lands. */
  const [sheetReveal, setSheetReveal] = useState<(SheetRowTarget & { nonce: number }) | null>(null);
  const clearSheetReveal = useCallback(() => setSheetReveal(null), []);
  useEffect(() => {
    openSheetRowRef.current = (t) => {
      setSheetReveal((r) => ({ ...t, nonce: (r?.nonce ?? 0) + 1 }));
      openNote(t.path);
    };
  }, [openNote, openSheetRowRef]);

  const dbNoteMeta = useMemo(
    () =>
      (view.kind === "db" || (view.kind === "saved" && activeSaved)) && dbNote
        ? notes.find((n) => n.path === dbNote) ?? null
        : null,
    [notes, dbNote, view, activeSaved]
  );

  // The note on screen is a sheet — its grid owns a key surface the
  // hint panel advertises. Db views show their side note, everything else the
  // selection (same meta NotePane renders).
  const sheetOpen =
    foldedPropStr(
      (view.kind === "db" || view.kind === "saved" ? dbNoteMeta : selectedMeta)?.props ?? {},
      "type"
    )?.toLowerCase() === "sheet";

  // The open dashboard renders a workbook tab strip — ⌃⇥ / ⌃⇧⇥ steps
  // pages through the ref WorkbookPane registers while mounted
  const pageStepRef = useRef<((dir: 1 | -1) => void) | null>(null);
  // Mounted boards publish actual ⌘Z / ⌘⇧Z availability here
  // (see useDashUndo). Which board renders can depend on the note's body, and
  // mount alone says nothing about whether either history direction is live.
  const {
    store: dashUndo,
    availability: { canUndo: dashCanUndo, canRedo: dashCanRedo },
  } = useDashUndoState();
  const workbookOpen =
    view.kind === "dashboard" && dashMeta !== null && parsePages(dashMeta.props).length > 0;

  // a pin's row set: every note of its database — the pane's filter bar and
  // the pin's own query do the narrowing
  const savedNotes = useMemo(
    () =>
      view.kind === "saved" && activeSaved
        ? notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === activeSaved.db.toLowerCase())
        : [],
    [notes, view, activeSaved]
  );

  // Config files are keyed by user-authored database/property names. Reads
  // fold on a miss; writes must target that SAME stored identity or a note's
  // alternate casing creates a parallel schema/views entry.
  const schemaDbKey = useCallback(
    (db: string) => foldedObjectKey(schema, db) ?? db,
    [schema]
  );
  const schemaPropKey = useCallback(
    (db: string, prop: string) => {
      const storedDb = schemaDbKey(db);
      return foldedObjectKey(schema[storedDb], prop) ?? prop;
    },
    [schema, schemaDbKey]
  );
  const viewsDbKey = useCallback(
    (db: string) => foldedObjectKey(viewsConfig, db) ?? foldedObjectKey(schema, db) ?? db,
    [viewsConfig, schema]
  );

  const setDbPref = useCallback(
    (db: string, p: ViewPref) => {
      const storedDb = viewsDbKey(db);
      setViewsConfig((cur) => ({ ...cur, [storedDb]: p }));
      persistViewsConfig(
        () => vaultViewsSet(storedDb, p.view, p.group_by, p.table_group_by, p.aggregations, p.sorts, p.col_order, p.hidden, p.widths, p.wrap, p.grid, p.hidden_per_layout, p.card_order, p.group_order, p.collapsed_groups),
        setViewsConfig,
        vaultViewsRead,
        "Couldn't save view settings"
      );
    },
    [persistViewsConfig, viewsDbKey]
  );

  /* ----- saved views: named pins over a database ----- */

  // upsert by (db, name): re-saving under an existing name updates that pin
  const saveView = useCallback(
    (
      db: string,
      name: string,
      capture: { query: string; sorts: SavedViewSort[]; view: DbLayout; groupBy?: string; tableGroupBy?: string; columns?: string[] }
    ) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const existing = findViewByName(savedViews, db, trimmed);
      const storedDb = existing?.db ?? schemaDbKey(db);
      const view: SavedView = {
        id: existing?.id ?? newViewId(trimmed, savedViews),
        name: trimmed,
        db: storedDb,
        ...(capture.query ? { query: capture.query } : {}),
        // `sort` always mirrors the first key so older readers still
        // work; the full list persists only when 2+ keys are active
        ...(capture.sorts.length > 0 ? { sort: capture.sorts[0] } : {}),
        ...(capture.sorts.length >= 2 ? { sorts: capture.sorts } : {}),
        view: capture.view,
        ...(capture.groupBy ? { group_by: capture.groupBy } : {}),
        ...(capture.tableGroupBy ? { table_group_by: capture.tableGroupBy } : {}),
        // The pane only sends columns that differ from the default
        // union — a plain save writes no field
        ...(capture.columns?.length ? { columns: capture.columns } : {}),
      };
      setSavedViews((cur) =>
        cur.some((v) => v.id === view.id)
          ? cur.map((v) => (v.id === view.id ? view : v))
          : [...cur, view]
      );
      persistViewsConfig(
        () => vaultSavedViewSet(view),
        setSavedViews,
        vaultSavedViewsRead,
        "Couldn't save view settings"
      );
      // A fresh pin must be findable — re-expand the Saved views
      // section if it was collapsed (sections stay as the user left them).
      // Same persistence path as toggleCollapsed.
      setSidebarOrder((cur) => {
        const collapsed = cur.collapsed ?? [];
        if (!collapsed.includes("savedviews")) return cur;
        const next: SidebarOrder = {
          ...cur,
          collapsed: collapsed.filter((c) => c !== "savedviews"),
        };
        persistViewsConfig(
          () => vaultSetSidebarOrder(next),
          setSidebarOrder,
          vaultSidebarOrder,
          "Couldn't save sidebar settings"
        );
        return next;
      });
    },
    [savedViews, persistViewsConfig, schemaDbKey]
  );

  // Column curation on an open pin persists straight into the view
  // (undefined = back to the database's default column union)
  const setViewColumns = useCallback(
    (id: string, columns: string[] | undefined) => {
      const sv = savedViews.find((v) => v.id === id);
      if (!sv) return;
      const next = { ...sv, columns };
      setSavedViews((cur) => cur.map((v) => (v.id === id ? next : v)));
      persistViewsConfig(
        () => vaultSavedViewSet(next),
        setSavedViews,
        vaultSavedViewsRead,
        "Couldn't save view settings"
      );
    },
    [savedViews, persistViewsConfig]
  );

  const renameView = useCallback(
    (id: string, name: string) => {
      setRenamingViewId(null);
      const sv = savedViews.find((v) => v.id === id);
      const trimmed = name.trim();
      if (!sv || !trimmed || trimmed === sv.name) return;
      const next = { ...sv, name: trimmed };
      setSavedViews((cur) => cur.map((v) => (v.id === id ? next : v)));
      persistViewsConfig(
        () => vaultSavedViewSet(next),
        setSavedViews,
        vaultSavedViewsRead,
        "Couldn't save view settings"
      );
    },
    [savedViews, persistViewsConfig]
  );

  const removeView = useCallback(
    (id: string) => {
      const sv = savedViews.find((v) => v.id === id);
      setSavedViews((cur) => cur.filter((v) => v.id !== id));
      persistViewsConfig(
        () => vaultSavedViewDelete(id),
        setSavedViews,
        vaultSavedViewsRead,
        "Couldn't save view settings"
      );
      // The pin's remembered export target goes with it. The folder
      // on disk stays — it is the user's, and it says so on the tin.
      setExportTargets((cur) => {
        if (!(id in cur)) return cur;
        const next = { ...cur };
        delete next[id];
        return next;
      });
      void viewExportForget(id).catch(() => undefined);
      // an open pin that just got removed falls back to its database
      if (sv) {
        setView((v) => (v.kind === "saved" && v.id === id ? { kind: "db", type: sv.db } : v));
      }
    },
    [savedViews, persistViewsConfig]
  );

  const saveSchemaProp = useCallback(
    (dbType: string, prop: string, options: SelectOption[], kind: PropKind | null, notify?: boolean, notifyBefore?: number, target?: string, format?: NumberFormat, description?: string, rollup?: RollupConfig | null, review?: string) => {
      const storedDb = schemaDbKey(dbType);
      const storedProp = schemaPropKey(dbType, prop);
      // the review window rides through as the editor sent it: a canonical
      // window sets one, an empty string clears it, and undefined (every
      // caller that has no window field) leaves the stored one standing
      // Resolves true/false rather than rejecting: the toast below is how a
      // refusal reaches the USER either way, and the boolean is how a caller
      // with a step after the schema write — the row-onto-row grouping
      // prompt writes rows next — knows not to take that step.
      return vaultSchemaSet(storedDb, storedProp, options, kind ?? undefined, notify, notifyBefore, target, format, description, review, rollup)
        .then((s) => {
          setSchema(s);
          return true;
        })
        // engine refusals ("a rollup property needs a relation to follow",
        // "“mount” is set by the mount") must reach the user — the editor has
        // already closed by the time this rejects
        .catch((e) => {
          showToast(errText(e));
          return false;
        });
    },
    [schemaDbKey, schemaPropKey, showToast]
  );

  /** "Add “x” to options" on any value picker. The option is stored first and
      the value follows only if it landed; a value the vault refuses takes the
      option back out with it, and both inverses ride ONE undo entry, so a
      single ⌘Z never leaves an orphan option behind. The surface supplies its
      own value write — it alone knows which cells, notes or selection the
      value goes into — and hands its inverse to the recorder it is given. */
  const promoteSchemaOption = useCallback(
    (
      dbType: string,
      prop: string,
      add: {
        before: SelectOption[];
        after: SelectOption[];
        kind: PropKind | null;
        priorKind: PropKind | null;
        description?: string;
      },
      writeValue: (record: UndoRecorder) => Promise<void>
    ) => {
      const storedDb = schemaDbKey(dbType);
      const storedProp = schemaPropKey(dbType, prop);
      // the kind rides every write, each direction its own: putting the prior
      // options back under this action's kind would leave a column that had
      // none at all empty AND kindless, which the vault reads as "remove this
      // property" — a ⌘Z that deletes the column instead of restoring it
      const write = (state: { options: SelectOption[]; kind: PropKind | null }) =>
        vaultSchemaSet(
          storedDb,
          storedProp,
          state.options,
          state.kind ?? undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          add.description
        ).then((s) => {
          setSchema(s);
        });
      // returned, not fired and forgotten: a caller with a step after the
      // value — the row-onto-row prompt's grouping switch — waits on it
      return addOptionAndWriteUndoable({
        store: {
          before: { options: add.before, kind: add.priorKind },
          after: { options: add.after, kind: add.kind },
          write,
          // read from the vault, not from this render's schema state: undo
          // runs long after, and its guard has to see what is stored NOW
          read: () =>
            vaultSchemaRead().then(
              (s) => byFoldedKey(typeSchemaFor(s, storedDb) ?? {}, storedProp)?.options ?? []
            ),
        },
        writeValue,
        record: undoApi.record,
      }).catch((e) => showToast(errText(e)));
    },
    [schemaDbKey, schemaPropKey, showToast, undoApi]
  );

  // per-type database icons ride the same schema.json, under the
  // reserved `icon` key — derived here so every surface reads one source
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);

  const saveSchemaIcon = useCallback((dbType: string, icon: DbIcon | null) => {
    vaultSchemaSetIcon(schemaDbKey(dbType), icon).then(setSchema).catch(console.error);
  }, [schemaDbKey]);

  // a database's home folder, set/cleared from the All databases
  // manager, a folder's "Open as database…", or the
  // tree row's "Stop opening as database" — clearing is the exit
  // path back to homeless
  const setDbHome = useCallback(
    (dbType: string, home: string | null) => {
      const storedDb = schemaDbKey(dbType);
      vaultSchemaHomeSet(storedDb, home)
        .then((cfg) => {
          setSchema(cfg);
          showToast(
            home
              ? `“${dbType}” now lives in “${home}”`
              : "Folder is back to plain files — the database stays under All databases"
          );
        })
        .catch((e) => showToast(errText(e)));
    },
    [showToast, schemaDbKey]
  );

  // the relation prop a database's rows nest under — set/cleared from that
  // column's header menu, the same one-reserved-key discipline as `home`.
  // Nothing on disk moves: the mark only changes how the rows are ARRANGED
  const setDbParentProp = useCallback(
    (dbType: string, prop: string | null) => {
      vaultSchemaParentSet(schemaDbKey(dbType), prop)
        .then((cfg) => {
          setSchema(cfg);
          showToast(
            prop
              ? `Rows now nest under “${prop}” — expand a parent to see its sub-items`
              : "Sub-items off — the rows are a flat list again"
          );
        })
        .catch((e) => showToast(errText(e)));
    },
    [showToast, schemaDbKey]
  );

  // per-folder icons ride views.json under the reserved `$folders`
  // key — the setter returns the whole map, same discipline as the schema.
  // Queued like the other views.json writes so it can't interleave with a
  // pref/sidebar/pin write; not in that issue's toast list.
  const saveFolderIcon = useCallback((path: string, icon: DbIcon | null) => {
    queueViewsWrite(() => vaultFolderIconSet(path, icon)).then(setFolderMeta).catch(console.error);
  }, []);

  // the engine retargets/drops `$folders` keys behind folder renames and
  // deletes — re-read the map after one lands
  const reloadFolderMeta = useCallback(() => {
    vaultFolderMetaRead().then(setFolderMeta).catch(console.error);
  }, []);

  /* ----- reality mounts ----- */

  // the registry plus THIS machine's bindings — both halves can change
  // without a note changing, so mounts reload on their own schedule
  const reloadMounts = useCallback(
    () =>
      mountsList()
        .then(setMounts)
        .catch((e) => console.error(e)),
    []
  );

  // the registry rides the same epoch as everything else — a scan, a bind,
  // the migration at boot all bump it. Cheap: one .vault read.
  useEffect(() => {
    reloadMounts();
  }, [vaultEpoch, reloadMounts]);

  // …and the shelf, on the same epoch: the drive poller emits `vault:changed`
  // when a disk appears or vanishes, which is exactly what bumps it, so a
  // plugged-in drive reaches the sidebar without a second timer here.
  useEffect(() => {
    drivesList()
      .then(setDrives)
      .catch((e) => console.error(e));
  }, [vaultEpoch]);

  // …and the open mount's rows, which are its index merged with its sidecars.
  // Only the mount being looked at is loaded: a folder can hold thousands of
  // files, and nothing off-screen needs them.
  useEffect(() => {
    if (view.kind !== "mount") {
      setMountRowList([]);
      return;
    }
    let live = true;
    mountRows(view.id)
      .then((rows) => {
        if (live) setMountRowList(rows);
      })
      .catch((e) => {
        console.error(e);
        if (live) setMountRowList([]);
      });
    return () => {
      live = false;
    };
  }, [view, vaultEpoch]);

  /* ----- database management ----- */

  // re-read the .vault JSONs the bulk engine ops move behind the scenes
  const reloadDbMeta = useCallback(() => {
    vaultSchemaRead().then(setSchema).catch(console.error);
    vaultViewsRead().then(setViewsConfig).catch(console.error);
    vaultSidebarOrder().then(setSidebarOrder).catch(console.error);
    vaultSavedViewsRead().then(setSavedViews).catch(console.error);
  }, []);

  // Safety rail: every bulk sweep starts with an explicit snapshot; history
  // being unavailable (no git) never blocks the op — but it must not pass in
  // silence either, or a sweep runs unprotected and nothing says so.
  // Resolves false when NO restore point exists (see history_snapshot's
  // contract); each caller then appends the warning to its outcome toast — a
  // toast fired here would be replaced unseen milliseconds later by the op's
  // own (same reasoning as homeErr above).
  const presweepSnapshot = useCallback(
    (label: string): Promise<boolean> =>
      historySnapshot(label).catch((e) => {
        console.warn("pre-sweep snapshot failed:", e);
        return false;
      }),
    []
  );

  const createDatabase = useCallback(
    (name: string, props: NewTypeProp[], homeInTree?: boolean, homeFolder?: string): Promise<void> =>
      vaultCreateType(name, props).then(async (cfg) => {
        setSchema(cfg);
        setDbDialog(null);
        const type = name.trim();
        // born from the Folders "+": the db lands in the tree
        // immediately — a root folder named like its sidebar label becomes
        // its home, created now or REUSED when one already exists
        // (never "Name 2"); engine refusals surface as THE toast (the plain
        // "created" one would replace it unseen), the db itself still stands.
        // A folder's "Open as database…" skips the eponymous-root
        // dance: homeFolder IS the home, it already exists.
        let homeErr: string | null = null;
        if (homeFolder) {
          try {
            setSchema(await vaultSchemaHomeSet(type, homeFolder));
            refresh();
          } catch (e) {
            homeErr = errText(e);
          }
        } else if (homeInTree) {
          const label = type.charAt(0).toUpperCase() + type.slice(1);
          try {
            const existing = folders.find(
              (f) => !f.includes("/") && f.toLowerCase() === label.toLowerCase()
            );
            const home = existing ?? (await vaultCreateFolder(label));
            setSchema(await vaultSchemaHomeSet(type, home));
            refresh();
          } catch (e) {
            homeErr = errText(e);
          }
        }
        setView({ kind: "db", type });
        showToast(homeErr ?? `Database “${type}” created`);
      }),
    [showToast, folders, refresh]
  );

  // CSV import: pick → parse → dialog. The dialog's confirm creates
  // the type through the same vault_create_type path as "New database", then
  // one vault_create per row — best-effort per row, so a title the engine
  // guards skips that row instead of aborting the whole import
  const openCsvImport = useCallback(() => {
    pickCsvFile()
      .then((picked) => {
        if (!picked) return;
        const rows = parseCsv(picked.text);
        if (rows.length === 0) {
          showToast(`${picked.name} has no rows`);
          return;
        }
        setCsvImport({ fileName: picked.name, rows });
      })
      .catch((e) => showToast(errText(e)));
  }, [showToast]);

  const importCsv = useCallback(
    (name: string, props: NewTypeProp[], entries: CsvEntry[]): Promise<void> =>
      vaultCreateType(name, props)
        .then((cfg) => setSchema(cfg))
        .then(async () => {
          let imported = 0;
          let failed = 0;
          for (const e of entries) {
            try {
              await vaultCreate(e.title, undefined, name, e.props);
              imported++;
            } catch (rowErr) {
              failed++;
              console.error(`csv import: row "${e.title}" failed:`, rowErr);
            }
          }
          setCsvImport(null);
          setView({ kind: "db", type: name.trim() });
          refresh();
          showToast(
            failed > 0
              ? `Imported ${imported} ${imported === 1 ? "entry" : "entries"} — ${failed} skipped`
              : `Imported ${imported} ${imported === 1 ? "entry" : "entries"}`
          );
        }),
    [refresh, showToast]
  );

  // "Mount a folder…": register the mount, bind it here and scan it
  // once, all inside mount_add — then read that one scan's stats back for the
  // dialog to show inline. Nothing is imported: the scan only writes the
  // mount's own index, so the refresh is for the new database appearing.
  const mountSubmit = useCallback(
    async (name: string, path: string, globs: string[], watch: boolean): Promise<MountScanStats> => {
      const stats = await mountAdd(name, path, globs, watch);
      await reloadMounts();
      reloadDbMeta();
      refresh();
      return stats;
    },
    [reloadMounts, reloadDbMeta, refresh]
  );

  // Unmounting is two different acts. Plain "Unmount" forgets the
  // folder and leaves every sidecar behind as an ordinary note — remounting
  // the same folder reattaches them, which is why it needs no confirmation.
  // The cleanup variant trashes those notes, so it goes through a dialog and
  // a pre-sweep snapshot like every other bulk destructive op.
  const unmountNow = useCallback(
    async (mount: MountInfo, cleanup: boolean): Promise<void> => {
      const snapped = cleanup
        ? await presweepSnapshot(`before unmounting ${mount.name}`)
        : true;
      await mountRemove(mount.id, cleanup);
      setUnmountAsk(null);
      // the mount was a database: its view, its rows and its schema all go
      setView((v) => (v.kind === "mount" && v.id === mount.id ? { kind: "dbmanager" } : v));
      await reloadMounts();
      reloadDbMeta();
      refresh();
      showToast(
        withSnapshotWarning(
          cleanup
            ? `Unmounted “${mount.name}” and moved its notes to Trash`
            : `Unmounted “${mount.name}” — its notes stay in the vault`,
          snapped
        )
      );
    },
    [presweepSnapshot, reloadMounts, reloadDbMeta, refresh, showToast]
  );

  const unmount = useCallback(
    (mount: MountInfo, cleanup: boolean) => {
      if (cleanup) setUnmountAsk(mount);
      else unmountNow(mount, false).catch((e) => showToast(errText(e)));
    },
    [unmountNow, showToast]
  );

  /** the open mount's rows keyed the way the board keys them — by virtual
      path AND by sidecar path, because a row answers to whichever it has */
  const mountRowByPath = useMemo(() => {
    const by = new Map<string, MountRow>();
    if (!activeMount) return by;
    for (const r of mountRowList) {
      by.set(`${MOUNT_SCHEME}${activeMount.id}/${r.rel}`, r);
      if (r.note) by.set(r.note, r);
    }
    return by;
  }, [activeMount, mountRowList]);

  /** The mounted file a global-search hit named, on its way to its
      board. `n` distinguishes two requests for the same row, so opening the
      same hit twice reveals it twice. */
  const [mountHit, setMountHit] = useState<{ id: string; rel: string; n: number } | null>(null);

  /** Send a search hit that landed inside a mounted document to its board.
      `false` when this machine has no such mount: the vault carries the index,
      the machine carries the folder, so a hit can name a file that is real
      elsewhere and absent here — saying so beats a board that opens empty.

      The search pane never reaches that branch: it drops hits into absent
      mounts before it draws them, deliberately, so nothing there can be
      clicked. The notice is for the callers that hand over a name from
      somewhere other than a rendered row — and for the narrow race where a
      mount goes away between a row being drawn and being clicked. */
  const openMountHit = useCallback(
    (id: string, rel: string) => {
      if (!mounts.some((m) => m.id === id)) {
        showToast("That folder isn’t mounted on this machine");
        return false;
      }
      setView({ kind: "mount", id });
      setMountHit((h) => ({ id, rel, n: (h?.n ?? 0) + 1 }));
      return true;
    },
    [mounts, showToast]
  );

  /** The row the board should put itself on, once its rows are in. A row with
      a sidecar answers to the note's path and one without to the virtual path,
      so which one to reveal is only knowable from the loaded rows — and they
      arrive after the board does. Null until then, and null for a hit into
      some other mount than the open one. */
  const mountReveal = useMemo(() => {
    if (!mountHit || !activeMount || activeMount.id !== mountHit.id) return null;
    const row = mountRowList.find((r) => r.rel === mountHit.rel);
    if (!row) return null;
    return { path: row.note ?? `${MOUNT_SCHEME}${activeMount.id}/${row.rel}`, n: mountHit.n };
  }, [mountHit, activeMount, mountRowList]);

  /** Which row the board draws as open, kept apart from the request that put
      it there. The request is spent the moment the board has it — held any
      longer, every later rows fetch would hand the board the same one again
      and drag the user back to the row they arrived on, and so would leaving
      the board and coming back. The MARK has to outlive it, though: it is the
      answer to "which file was I sent to", and it stays until something else
      is opened. Kept per mount so another board never inherits it. */
  const [mountOpen, setMountOpen] = useState<{ id: string; path: string } | null>(null);

  /** The board queues the focus in its own effect, which runs before this
      one, so the request is safe to retire here. */
  useEffect(() => {
    if (!mountReveal || !mountHit) return;
    setMountOpen({ id: mountHit.id, path: mountReveal.path });
    setMountHit(null);
  }, [mountReveal, mountHit]);

  /** The row set the board was showing when a request came in — see below. */
  const mountHitRows = useRef<MountRow[] | null>(null);

  /** …and the other end of the same request: one no board can answer. A hit
      names a file the vault's index knows; the folder on this machine may not
      hold it any more, and then no rows ever carry that name. Waiting on it
      is not a wait that ends — it sits pending through the day, and the first
      rescan that does turn the name up drags whatever board is open then onto
      a row nobody asked for. So the board gets one answer: the first rows to
      land after the request, which always come, because arriving re-enters the
      board and that refetches. Rows without it retire it. */
  useEffect(() => {
    if (!mountHit) {
      mountHitRows.current = null;
      return;
    }
    // the board isn't on the requested mount yet; its rows are another mount's
    if (activeMount?.id !== mountHit.id) return;
    // the rows carry it — answered by `mountReveal`, not retired here
    if (mountRowList.some((r) => r.rel === mountHit.rel)) return;
    if (mountHitRows.current === null) mountHitRows.current = mountRowList;
    else if (mountHitRows.current !== mountRowList) setMountHit(null);
  }, [mountHit, activeMount, mountRowList]);

  /** A mount row's property write. Ordinary notes go through
      vaultSetProp; a mount row can't, because the note it would write to may
      not exist until this very edit creates it. `mount_annotate` creates the
      sidecar on demand and returns the note either way.

      Undo needs a `prior` to restore and the engine doesn't return one, so it
      comes from the row the board is showing — the same value the cell was
      displaying when it was edited. The guard vaultSetProp takes is dropped:
      a mount row's props live in a file the vault alone writes. */
  const mountWriteProp = useCallback<PropWriter>(
    async (path, key, value) => {
      if (!activeMount) throw new Error("no mounted folder is open");
      const row = mountRowByPath.get(path);
      if (!row) throw new Error("that row is no longer in the folder");
      if (isIntrinsic(key)) throw new Error(`${key} comes from the file itself`);
      const prior = (row.props[key] ?? null) as PropValue;
      const meta = await mountAnnotate(activeMount.id, row.rel, key, value);
      return { meta, prior };
    },
    [activeMount, mountRowByPath]
  );

  /** Point a mount at a folder on THIS machine — the "Locate folder…" lane,
      and the same call the board's banner offers when a bound folder has gone
      away. Binding rescans, so the rows are true again the moment it lands. */
  const locateMount = useCallback(
    (mount: MountInfo) => {
      filePick(true)
        .then(async (picked) => {
          if (!picked) return;
          const stats = await mountBind(mount.id, picked);
          await reloadMounts();
          refresh();
          showToast(`“${mount.name}” → ${picked} — ${scanStatLine(stats)}`);
        })
        .catch((e) => showToast(errText(e)));
    },
    [reloadMounts, refresh, showToast]
  );

  /** A mount row's context menu. The file is the subject, so its lanes come
      first; the sidecar note is bookkeeping and only listed once it exists. */
  const mountRowMenu = useCallback(
    (path: string, x: number, y: number) => {
      if (!activeMount) return;
      const row = mountRowByPath.get(path);
      if (!row) return;
      const abs =
        activeMount.path && !activeMount.missing && !row.missing
          ? `${activeMount.path}/${row.rel}`
          : null;
      // the menu's open lanes are the same arrival as clicking the row, so
      // they move the board's mark the same way — otherwise opening from the
      // menu leaves the mark on whatever was opened before it, and the board
      // answers "which one am I in" with a file the reader left long ago.
      const mark = () => setMountOpen({ id: activeMount.id, path });
      const items: MenuItem[] = [
        {
          label: "Open file",
          icon: <MountIcon />,
          disabled: !abs,
          onSelect: () => {
            if (!abs) return;
            mark();
            fileOpen(abs).catch((e) => showToast(errText(e)));
          },
        },
        {
          label: "Reveal in Finder",
          icon: <FolderIcon />,
          disabled: !abs,
          onSelect: () => abs && fileReveal(abs).catch((e) => showToast(errText(e))),
        },
      ];
      if (row.note) {
        items.push({
          label: "Open note",
          icon: <NoteIcon />,
          separatorAbove: true,
          onSelect: () => {
            mark();
            openNote(row.note!);
          },
        });
      }
      setMenu({ x, y, items });
    },
    [activeMount, mountRowByPath, openNote, showToast]
  );

  /** Clicking a mount row opens the FILE — the row is about the file, and its
      note (when it has one) is a place to write things down about it, reached
      from the row menu. A row whose file isn't reachable falls back to its
      note rather than doing nothing. */
  const openMountRow = useCallback(
    (path: string) => {
      if (!activeMount) return;
      const row = mountRowByPath.get(path);
      if (!row) return;
      // opening a row IS the something else the arrival mark waits for: the
      // board marks what was last opened on it, and leaving the mark on the
      // row a search sent the user to would have it still pointing there an
      // hour and a dozen files later. Moved, not cleared — the mark's job is
      // to have an answer to "which one am I in", and now that is this row.
      const mark = () => setMountOpen({ id: activeMount.id, path });
      if (activeMount.path && !activeMount.missing && !row.missing) {
        mark();
        fileOpen(`${activeMount.path}/${row.rel}`).catch((e) => showToast(errText(e)));
        return;
      }
      if (row.note) {
        mark();
        openNote(row.note);
      } else showToast(mountStatus(activeMount) ?? `${row.name} isn’t on this machine`);
    },
    [activeMount, mountRowByPath, openNote, showToast]
  );

  const renameDatabase = useCallback(
    (dbType: string, newName: string): Promise<void> =>
      presweepSnapshot(`before rename database ${dbType}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        return vaultRenameType(storedDb, newName).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          // the engine retargets a key bound to this database
          reloadSidebarOrder();
          if (sweep.failed) {
            // the rename did NOT land (the type keeps its old name) and notes
            // were partially retyped — that message must outlive a 4s toast,
            // so it rejects back into the dialog's persistent inline error
            // surface, which stays open exactly as it did pre
            return Promise.reject(
              withSnapshotWarning(renameDbOutcome(dbType, newName, sweep), snapped)
            );
          }
          setDbDialog(null);
          // an open database view follows the rename
          setView((v) =>
            v.kind === "db" && v.type.toLowerCase() === dbType.toLowerCase()
              ? { kind: "db", type: newName }
              : v
          );
          showToast(withSnapshotWarning(renameDbOutcome(dbType, newName, sweep), snapped));
        });
      }),
    [presweepSnapshot, reloadDbMeta, refresh, reloadSidebarOrder, showToast, schemaDbKey]
  );

  const deleteDatabase = useCallback(
    (dbType: string, trashNotes: boolean): Promise<void> =>
      presweepSnapshot(`before delete database ${dbType}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        return vaultDeleteType(storedDb, trashNotes).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          // …and drops it when the database goes
          reloadSidebarOrder();
          if (sweep.failed) {
            // the database survives a sweep that failed partway; the partial
            // count must outlive a 4s toast, so it rejects into the dialog's
            // inline error surface (the dialog stays open)
            return Promise.reject(
              withSnapshotWarning(deleteDbOutcome(dbType, trashNotes, sweep), snapped)
            );
          }
          setDbDialog(null);
          setView((v) =>
            v.kind === "db" && v.type.toLowerCase() === dbType.toLowerCase()
              ? { kind: "notes" }
              : v
          );
          showToast(
            withSnapshotWarning(deleteDbOutcome(dbType, trashNotes, sweep), snapped)
          );
        });
      }),
    [presweepSnapshot, reloadDbMeta, refresh, reloadSidebarOrder, showToast, schemaDbKey]
  );

  const renameProperty = useCallback(
    (dbType: string, prop: string, newName: string): Promise<void> =>
      presweepSnapshot(`before rename property ${dbType}.${prop}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        const storedProp = schemaPropKey(dbType, prop);
        return vaultRenameProp(storedDb, storedProp, newName).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          if (sweep.failed) {
            // the schema key never moved — the partial message outlives a 4s
            // toast by rejecting into the dialog's inline error (stays open,
            // the pre-change failure behavior)
            return Promise.reject(
              withSnapshotWarning(renamePropOutcome(prop, newName, sweep), snapped)
            );
          }
          setDbDialog(null);
          showToast(
            withSnapshotWarning(renamePropOutcome(prop, newName, sweep), snapped)
          );
        });
      }),
    [presweepSnapshot, reloadDbMeta, refresh, showToast, schemaDbKey, schemaPropKey]
  );

  // remove property = instant schema demote; the value strip is a separate,
  // separately-confirmed sweep offered only when notes actually carry values
  const removeProperty = useCallback(
    (dbType: string, prop: string) => {
      const storedDb = schemaDbKey(dbType);
      const storedProp = schemaPropKey(dbType, prop);
      const count = notes.filter(
        (n) =>
          foldedPropStr(n.props, "type")?.toLowerCase() === dbType.toLowerCase() &&
          Object.prototype.hasOwnProperty.call(n.props, foldedPropKey(n.props, prop))
      ).length;
      const wasNumber = byFoldedKey(typeSchemaFor(schema, storedDb), storedProp)?.kind === "number";
      vaultSchemaSet(storedDb, storedProp, [])
        .then((cfg) => {
          setSchema(cfg);
          if (count > 0)
            setDbDialog({ kind: "strip-prop", dbType: storedDb, prop: storedProp, count, wasNumber });
          else
            // There are no note values to confirm destructively, but the
            // backend still has to drop saved-view query/column references.
            vaultClearProp(storedDb, storedProp, wasNumber, false)
              .then((sweep) => {
                const outcome = schemaOnlyClearOutcome(prop, sweep);
                if (!outcome.completed) {
                  // The schema demotion already landed. Keep that local state
                  // and report the metadata failure without reloading stale
                  // saved views or claiming the whole removal completed.
                  showToast(outcome.message);
                  return;
                }
                reloadDbMeta();
                showToast(outcome.message);
              })
              .catch((e) => showToast(errText(e)));
        })
        .catch((e) => showToast(errText(e)));
    },
    [notes, reloadDbMeta, schema, showToast, schemaDbKey, schemaPropKey]
  );

  const stripPropValues = useCallback(
    (dbType: string, prop: string, wasNumber: boolean): Promise<void> =>
      presweepSnapshot(`before strip ${dbType}.${prop} values`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        const storedProp = schemaPropKey(dbType, prop);
        return vaultClearProp(storedDb, storedProp, wasNumber, true).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          if (sweep.failed) {
            // partial count outlives the toast via the dialog's inline error
            return Promise.reject(
              withSnapshotWarning(stripPropOutcome(prop, sweep), snapped)
            );
          }
          setDbDialog(null);
          showToast(withSnapshotWarning(stripPropOutcome(prop, sweep), snapped));
        });
      }),
    [presweepSnapshot, reloadDbMeta, refresh, showToast, schemaDbKey, schemaPropKey]
  );

  // union of values in use across a type — the picker's no-ceremony bootstrap;
  // for the `type` prop itself it offers the existing databases. A multi prop
  // contributes each of its values, not the joined display string.
  const usedValues = useCallback(
    (dbType: string, key: string): string[] => {
      if (isTypePropName(key)) return databases.map((d) => d.type);
      const multi = byFoldedKey(typeSchemaFor(schema, dbType), key)?.kind === "multi";
      const seen = new Set<string>();
      for (const n of notes) {
        if (foldedPropStr(n.props, "type")?.toLowerCase() !== dbType.toLowerCase()) continue;
        const actualKey = foldedPropKey(n.props, key);
        if (multi) {
          for (const v of propList(n.props, actualKey)) if (v) seen.add(v);
        } else {
          const v = foldedPropStr(n.props, key);
          if (v) seen.add(v);
        }
      }
      return [...seen].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
      );
    },
    [notes, databases, schema]
  );

  // every name a view fence's `sort:`/`columns:` accepts for one database:
  // its own columns plus `title`, then the one-hop `relation.property` joins
  // its relation props open (viewjoin.ts). Stored columns lead — a dotted
  // stored key is itself, never a join.
  const dbPropNames = useCallback(
    (dbType: string): string[] => {
      const rowsOf = (type: string) =>
        notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === type.toLowerCase());
      const ts = typeSchemaFor(schema, dbType) ?? {};
      const names = ["title", ...dbColumns(rowsOf(dbType), ts)];
      for (const [rel, ps] of Object.entries(ts)) {
        const target = ps.kind === "relation" ? ps.type : undefined;
        if (!target) continue;
        const targetTs = typeSchemaFor(schema, target) ?? {};
        for (const c of ["title", ...dbColumns(rowsOf(target), targetTs)])
          names.push(`${rel}.${c}`);
      }
      return names;
    },
    [notes, schema]
  );

  // the pin list the fence's `saved:` completes over, each with the database
  // it stands on so a pinned fence still knows whose props to offer. The id
  // rides along because a fence written by "Embed in this note" references the
  // pin BY ID whenever its name would be ambiguous (`savedViewFence`)
  const savedViewPins = useMemo(
    () => savedViews.map((v) => ({ id: v.id, name: v.name, db: v.db })),
    [savedViews]
  );

  // relation pickers list the target database's entries
  const relCandidates = useCallback(
    (dbType: string) => relationCandidatesFor(notes, dbType),
    [notes]
  );

  const dbTypes = useMemo(() => databases.map((d) => d.type), [databases]);

  // the same set, ranked for filing rather than for size — see dbRecency.ts
  const dbTypesRecent = useMemo(() => dbTypesByRecency(notes, dbTypes), [notes, dbTypes]);

  // create-new inline from a relation picker: lands in the target type's
  // home folder when one is set, else where most of it already
  // lives (the DatabasePane new-entry heuristic), typed
  const createEntry = useCallback(
    (dbType: string, title: string) => {
      const typeNotes = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === dbType.toLowerCase());
      const home = homeFolderFor(typeNotes, typeHome(typeSchemaFor(schema, dbType)));
      return vaultCreate(title, home, dbType).then((m) => {
        recordCreate({ meta: m, record: undoApi.record });
        refresh();
        return m;
      });
    },
    [notes, schema, refresh, undoApi]
  );

  // The palette closes before its create settles (Palette.tsx's
  // run() does `close(); item.run();`), so an engine refusal — a title
  // holding `[`/`]`, a dot-leading slug, an unwritable folder (vault.rs
  // create_full) — had no UI left to return to and died on
  // `.catch(console.error)`: nothing created, nothing said, typed text gone.
  // The shape createNote has had and the db/calendar drafts
  // took after it: name what failed, surface the engine's own reason, and
  // keep the user's text on the clipboard where there is text to keep.
  const reportCreateFailure = useCallback(
    (what: string, text?: string) =>
      (err: unknown) => {
        const head = `couldn’t ${what} — ${errText(err)}`;
        if (!text) {
          showToast(head);
          return;
        }
        navigator.clipboard.writeText(text).then(
          () => showToast(`${head} (text copied to clipboard)`),
          () => showToast(head)
        );
      },
    [showToast]
  );

  const createNote = useCallback(
    (title: string, folder?: string) => {
      vaultCreate(title, folder)
        .then((meta) => {
          recordCreate({ meta, record: undoApi.record });
          // seed the fresh meta synchronously: without it the
          // selection-guard effect snaps back to the old list top before
          // refresh() lands — same trick as createScratch/openJournal
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          refresh();
          if (meta.folder === "Inbox") setView({ kind: "notes" });
          setSelected(meta.path);
          showMobileDetail();
          focusSoon(() => editorFocusRef.current?.());
        })
        .catch((err) => {
          // The palette is already closed by the time this rejects,
          // so the captured text has no UI to return to — preserve it on the
          // clipboard and say so; never fail silently
          const msg = errText(err);
          navigator.clipboard.writeText(title).then(
            () => showToast(`couldn’t create note (${msg}) — captured text copied to clipboard`),
            () => showToast(`couldn’t create note — ${msg}`)
          );
        });
    },
    [refresh, showToast, showMobileDetail, undoApi]
  );

  // ⌘N inside Notes: instant untyped scratch note — no dialog, lands
  // in Inbox/ like quick capture, sorts to the top of the recency list, and
  // the cursor drops into the title with "Untitled" selected. The fresh meta
  // is seeded synchronously so the selection effect doesn't snap back before
  // the async refresh lands (same trick as openJournal).
  const createScratch = useCallback(
    // `tags` is what "create inside a tag folder" means — the note is
    // born wherever loose notes are born and the folder's tags are written
    // onto it, because a tag folder is a rule, not a place.
    (folder = "Inbox", tags: string[] = []) => {
      vaultCreate("Untitled", folder)
        .then((meta) => (tags.length > 0 ? vaultNoteAddTags(meta.path, tags) : meta))
        .then((meta) => {
          scratchPaths.current.add(meta.path); // Abandons if left pristine
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          setSelected(meta.path);
          showMobileDetail();
          refresh();
          focusSoon(() => titleFocusRef.current?.());
        })
        // Nothing typed to preserve here (the title is always
        // "Untitled"), but an unwritable folder still has to say so
        .catch(reportCreateFailure("create note"));
    },
    [refresh, showMobileDetail, reportCreateFailure]
  );

  // A ⌘N note that stayed pristine abandons itself — capture's Esc
  // never persists at all, this is the same discard one step later. Silent by
  // design (no trash toast). Flush-then-recheck: a debounced save
  // must land before the emptiness read, or typed text gets deleted under the
  // user. The path stays tracked while it has content — a later empty-out
  // still abandons it.
  const abandonScratch = useCallback(
    async (path: string) => {
      if (!scratchPaths.current.has(path) || abandonBusy.current.has(path)) return;
      abandonBusy.current.add(path);
      try {
        await flushOpenRef.current?.();
        let content;
        try {
          content = await vaultRead(path);
        } catch {
          scratchPaths.current.delete(path); // renamed/trashed underneath us
          return;
        }
        if (!isPristineScratch(path, content.body, content.props)) return;
        scratchPaths.current.delete(path);
        await vaultDelete(path).catch(() => {});
        refresh();
      } finally {
        abandonBusy.current.delete(path);
      }
    },
    [refresh]
  );

  // leaving a note — selection change, view change, app-level navigation —
  // checks the just-left (or re-viewed) note for abandonment
  const leaveRef = useRef({ selected: null as string | null, viewKey: "" });
  useEffect(() => {
    const prev = leaveRef.current;
    leaveRef.current = { selected, viewKey: viewKeyNow };
    if (prev.selected !== selected) {
      if (prev.selected) void abandonScratch(prev.selected);
    } else if (prev.viewKey !== viewKeyNow && selected) {
      void abandonScratch(selected);
    }
  }, [selected, viewKeyNow, abandonScratch]);

  // born-complete typed create: schema-default empty chips + the
  // type's template instantiated, then the entry opens in place
  const createTyped = useCallback(
    (title: string, dbType: string, focus: "editor" | "title" = "editor") => {
      const typeNotes = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === dbType.toLowerCase());
      const date = todayIso();
      const templateType = canonicalTemplateType(dbType, templateTypes, Object.keys(schema));
      vaultTemplateRead(templateType)
        .then((tpl) =>
          vaultCreate(
            title,
            homeFolderFor(typeNotes, typeHome(typeSchemaFor(schema, dbType))),
            dbType,
            buildEntryProps({ typeSchema: typeSchemaFor(schema, dbType), typeNotes, template: tpl, title, date }),
            buildEntryBody(tpl, title, date)
          )
        )
        .then((meta) => {
          recordCreate({ meta, record: undoApi.record });
          // seed the fresh meta synchronously (like openJournal) — openNote
          // would look it up in the pre-refresh notes and miss
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          if (view.kind === "db" && inView(meta, view, tagFolders)) setDbNote(meta.path);
          else {
            if (!inView(meta, view, tagFolders)) setView({ kind: "all" });
            setSelected(meta.path);
          }
          showMobileDetail();
          refresh();
          focusSoon(() => (focus === "title" ? titleFocusRef : editorFocusRef).current?.());
        })
        .catch(reportCreateFailure(`create “${title}”`, title));
    },
    [notes, schema, templateTypes, view, refresh, showMobileDetail, undoApi, reportCreateFailure, setNotes, tagFolders]
  );

  // A cell edited inside an inline ```view fence. Deliberately the
  // same call the database pane's cells make (setPropUndoable), so one ⌘Z
  // reverts it whichever surface the edit came from; docs/undo.md §6.2.
  const embedSetProp = useCallback(
    (path: string, key: string, value: PropValue) => {
      // keyLabel matches the pane's (DatabasePane commitCell): the undo toast
      // must read the same whichever surface the edit came from
      setPropUndoable({ path, key, value, record: undoApi.record, keyLabel: displayColLabel(key) })
        .then(() => refresh())
        .catch((err) => {
          showToast(`couldn’t save — ${errText(err)}`);
          refresh();
        });
    },
    [undoApi, refresh, showToast]
  );

  // the Today surface's one verb, from anywhere a note is: the row
  // menu, the open note's ⋯, the palette. Deliberately the pane's own write
  // (the ordinary `today` date prop through setPropUndoable), so one ⌘Z
  // reverts a pick made out here exactly as it reverts one made in the pane,
  // and a note with no dates at all — invisible to every candidate lane —
  // can still be picked.
  const togglePickToday = useCallback(
    (path: string, pick: boolean) => {
      setPropUndoable({
        path,
        key: TODAY_PROP,
        value: pick ? todayIso() : null,
        record: undoApi.record,
      })
        .then(() => refresh())
        .catch((err) => {
          showToast(`couldn’t save — ${errText(err)}`);
          refresh();
        });
    },
    [undoApi, refresh, showToast]
  );

  // The fence's "+ New". A born-complete typed create like ⌘N's
  // (schema defaults + template), plus the fence's own equality filters seeded
  // on top so the new row actually belongs to the table it was added from.
  // It does NOT navigate: the user is writing a note, and the row appearing in
  // place is the whole point of an inline database.
  const embedCreateEntry = useCallback(
    (dbType: string, seedProps: [string, string][], query: string) => {
      const title = "Untitled";
      const typeNotes = notes.filter(
        (n) => foldedPropStr(n.props, "type")?.toLowerCase() === dbType.toLowerCase()
      );
      const date = todayIso();
      const typeSchema = typeSchemaFor(schema, dbType);
      const templateType = canonicalTemplateType(dbType, templateTypes, Object.keys(schema));
      vaultTemplateRead(templateType)
        .then((tpl) => {
          let props = buildEntryProps({ typeSchema, typeNotes, template: tpl, title, date });
          for (const [k, v] of seedProps) props = mergeEntryProp(props, k, v);
          return vaultCreate(
            title,
            homeFolderFor(typeNotes, typeHome(typeSchema)),
            dbType,
            props,
            buildEntryBody(tpl, title, date)
          );
        })
        .then((meta) => {
          recordCreate({ meta, record: undoApi.record });
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          refresh();
          // born hidden (a text term, a filter shape the seeds can't satisfy)?
          // Say so — otherwise the create looks dropped (the pane's rule)
          if (query.trim() && filterByQuery([meta], query, undefined, typeSchema).length === 0)
            showToast(`Created “${title}” — hidden by filter`);
        })
        .catch(reportCreateFailure(`create “${title}”`, title));
    },
    [notes, schema, templateTypes, refresh, undoApi, reportCreateFailure, showToast]
  );

  // A relation cell's "create and link", inline. Same two steps the
  // database pane takes: create the target entry, then add its title to this
  // note's relation list.
  const embedCreateRelation = useCallback(
    (path: string, key: string, targetType: string, title: string) => {
      createEntry(targetType, title)
        .then((m) => {
          const props = notes.find((n) => n.path === path)?.props ?? {};
          const cur = propList(props, foldedPropKey(props, key));
          return setPropUndoable({
            path,
            key,
            value: propListValue(toggleValue(cur, m.title)),
            record: undoApi.record,
          });
        })
        .then(() => refresh())
        .catch(reportCreateFailure(`create “${title}”`, title));
    },
    [createEntry, notes, undoApi, refresh, reportCreateFailure]
  );

  // The same write path, handed to the live ```view tables a hub or
  // workbook page renders. Dashboards were the one place a fence was
  // read-only purely because nobody passed the handlers down; the handlers
  // themselves are the editor fence's (undoable write, its failure toast).
  const embedEdit = useMemo(
    () => ({
      setProp: embedSetProp,
      usedValues,
      relationCandidates: relCandidates,
      createRelation: embedCreateRelation,
    }),
    [embedSetProp, usedValues, relCandidates, embedCreateRelation]
  );

  // "New sheet…": sheets are surfaces, not database entries, so the
  // create is just title + `type: sheet` — the grid's empty state ("+ column")
  // starts the csv block. Contextual like ⌘N: an open folder view hosts the
  // new sheet, everything else lands it at the vault root next to Holdings.
  const createSheet = useCallback(
    (title: string) => {
      const folder = view.kind === "folder" ? view.path : "";
      vaultCreate(title, folder, "sheet")
        .then((meta) => {
          recordCreate({ meta, record: undoApi.record });
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          if (!inView(meta, view, tagFolders)) setView(folder ? { kind: "folder", path: folder } : { kind: "all" });
          setSelected(meta.path);
          showMobileDetail();
          refresh();
          focusSoon(() => titleFocusRef.current?.());
        })
        .catch(reportCreateFailure(`create sheet “${title}”`, title));
    },
    [view, refresh, showMobileDetail, undoApi, reportCreateFailure, setNotes, tagFolders]
  );

  // "New dashboard…": the palette picked the kind and the title, so the write
  // is `type: dashboard` + `dashboard: <kind>` over that kind's starter body.
  // No config is guessed — every kind's own empty state names what it still
  // wants, and a wrong `source:` reads as a broken board rather than a new one.
  // Lands at the vault root beside the other boards (a dashboard is a
  // destination, not a filed note), then opens it.
  const createDashboard = useCallback(
    (title: string, kind: string) => {
      const opt = dashboardKindOption(kind);
      vaultCreate(title, "", "dashboard", newDashboardProps(kind), opt?.body)
        .then((meta) => {
          recordCreate({ meta, record: undoApi.record });
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          setView({ kind: "dashboard", path: meta.path });
          setSelected(meta.path);
          showMobileDetail();
          refresh();
        })
        .catch(reportCreateFailure(`create dashboard “${title}”`, title));
    },
    [refresh, showMobileDetail, undoApi, reportCreateFailure, setNotes]
  );

  // a `type` chip commit re-homed an existing note into a database:
  // without this the note leaves the current view's scope on refresh and the
  // selection-guard snaps to another note — the user files a capture and loses
  // it. Follow the note exactly like createTyped: seed the fresh meta
  // synchronously (app state is pre-refresh stale at this instant), then
  // stay on it wherever it now lives.
  //
  // When the commit MINTS the database — the type isn't in the
  // pre-refresh `databases` list — filing quietly would teleport the note to
  // a view that exists nowhere on screen yet ("appears from under your
  // grasp"). A birth is announced: follow the note INTO the new database and
  // offer the sidebar home right there — the same eponymous root folder the
  // Folders "+" create uses (reuse-never-"Name 2").
  const followTyped = useCallback(
    (meta: NoteMeta) => {
      setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
      const type = foldedPropStr(meta.props, "type");
      if (
        type &&
        !FUNCTIONAL_TYPES.has(type.toLowerCase()) &&
        !databases.some((d) => d.type.toLowerCase() === type.toLowerCase())
      ) {
        // db→db birth: keep the note across the leave-clears effect
        dbNoteCarry.current = view.kind === "db" || view.kind === "saved";
        setView({ kind: "db", type });
        setDbNote(meta.path);
        showToast(`Moved to “${type}” — new database`, {
          label: "Add to sidebar",
          run: () => {
            const label = type.charAt(0).toUpperCase() + type.slice(1);
            const existing = folders.find(
              (f) => !f.includes("/") && f.toLowerCase() === label.toLowerCase()
            );
            (existing
              ? Promise.resolve(existing)
              : vaultCreateFolder(label).then((f) => {
                  refresh();
                  return f;
                })
            )
              // setDbHome owns the success/refusal toast (a taken
              // folder surfaces as the engine's own error text)
              .then((home) => setDbHome(type, home))
              .catch((e) => showToast(errText(e)));
          },
        });
      } else if (view.kind === "db" && inView(meta, view, tagFolders)) setDbNote(meta.path);
      else {
        if (!inView(meta, view, tagFolders)) setView({ kind: "all" });
        setSelected(meta.path);
      }
      showMobileDetail();
    },
    [view, databases, folders, refresh, setDbHome, showToast, showMobileDetail, setNotes, tagFolders]
  );

  // open a type's template as an ordinary note: the file lives
  // under hidden `.vault/templates/` — readable/writable by explicit path,
  // never indexed. A type without one gets an empty template created first.
  const openTemplate = useCallback(
    (dbType: string) => {
      const templateType = canonicalTemplateType(dbType, templateTypes, Object.keys(schema));
      const path = templatePath(templateType);
      const exists = templateTypes.includes(templateType);
      const show = () => {
        setSelected(path);
        showMobileDetail();
        focusSoon(() => editorFocusRef.current?.());
      };
      if (exists) {
        show();
        return;
      }
      vaultWriteBody(path, "")
        .then(show)
        .then(() => vaultTemplateList().then(setTemplateTypes))
        .catch(console.error);
    },
    [templateTypes, schema, showMobileDetail]
  );

  const captureUrl = useCallback(
    (url: string) => {
      // Capture is local and always works; only the title fetch is
      // gated, so a link pasted with the switch off lands as a plain URL note
      urlCapture(url, netLinkTitles)
        .then((meta) => {
          refresh();
          // reference notes are typed, so they don't show in Notes — open in
          // the full index instead
          setView({ kind: "all" });
          setSelected(meta.path);
          showMobileDetail();
        })
        .catch(reportCreateFailure(`capture ${url}`, url));
    },
    [refresh, showMobileDetail, reportCreateFailure, netLinkTitles]
  );

  // capture surfaces route pasted links to reference notes, everything else to plain notes
  const createOrCapture = useCallback(
    (title: string) => {
      if (looksLikeUrl(title)) captureUrl(title.trim());
      else createNote(title);
    },
    [captureUrl, createNote]
  );

  const onRenamed = useCallback(
    (oldPath: string, m: NoteMeta) => {
      // Session fold memory is keyed by live path — move it with
      // the note so folds survive a rename done while the note is closed
      migrateSessionFolds(oldPath, m.path);
      scratchPaths.current.delete(oldPath); // a real title never abandons
      setNotes((ns) => ns.map((n) => (n.path === oldPath ? m : n)));
      setSelected(m.path);
      setDbNote((cur) => (cur === oldPath ? m.path : cur));
      // A rename moves the FILE too (title → stem), so an open
      // dashboard view needs the same retarget the move path gets below
      setView((v) =>
        v.kind === "dashboard" && v.path === oldPath ? { ...v, path: m.path } : v
      );
      refresh();
      reloadSidebarOrder();
    },
    [refresh, reloadSidebarOrder]
  );

  // Undo/redo of a rename repairs the same state the forward rename
  // does, but only FOLLOWS the note when it was the selected one — the
  // forward rename's unconditional setSelected would turn ⌘Z of a
  // background note's rename into a navigation. Announced first so an open
  // pane relabels in place (the no-remount lane) before the path
  // swap reaches it as a prop.
  const onRenameApplied = useCallback(
    (oldPath: string, m: NoteMeta) => {
      announceRename(oldPath, m.path);
      migrateSessionFolds(oldPath, m.path);
      setNotes((ns) => ns.map((n) => (n.path === oldPath ? m : n)));
      setSelected((cur) => (cur === oldPath ? m.path : cur));
      setDbNote((cur) => (cur === oldPath ? m.path : cur));
      setView((v) =>
        v.kind === "dashboard" && v.path === oldPath ? { ...v, path: m.path } : v
      );
      refresh();
      reloadSidebarOrder();
    },
    [refresh, reloadSidebarOrder]
  );

  // Undo of Move to Trash — restore through the same IPC the Trash
  // pane uses, then re-select the note (seeded synchronously like TrashPane's
  // onRestored, so the selection effect finds it before the refresh lands).
  // By the trash id vault_delete returned, not a path scan — trash
  // the same path twice and a scan restores the wrong version.
  const restoreTrashed = useCallback(
    (id: string) => {
      vaultTrashRestore(id)
        .then((m) => {
          setNotes((ns) => [...ns.filter((n) => n.path !== m.path), m]);
          if (!inView(m, view, tagFolders)) setView({ kind: "all" });
          setSelected(m.path);
          showMobileDetail();
          refresh();
        })
        .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
    },
    [view, refresh, showToast, showMobileDetail, setNotes, tagFolders]
  );

  // The folder counterpart — undo of "Move folder to Trash" brings
  // the whole subtree back by the trash id and puts the user back in it
  const restoreTrashedFolder = useCallback(
    (id: string) => {
      vaultTrashRestoreFolder(id)
        .then((rel) => {
          setView({ kind: "folder", path: rel });
          reloadFolderMeta();
          reloadSealScopes();
          refresh();
          reloadSidebarOrder();
        })
        .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
    },
    [refresh, reloadFolderMeta, reloadSealScopes, reloadSidebarOrder, showToast]
  );

  // Feedback for the note pane's Move to Trash — a quiet toast with
  // Undo, and selection lands on the trashed note's neighbor in the current
  // list (next row, else previous) instead of snapping to the top
  // The toast's Undo runs the stack entry by id, so the button and
  // ⌘Z are one action rather than two lookalikes that could drift apart
  const onNoteTrashed = useCallback(
    (path: string, undoId: number) => {
      scratchPaths.current.delete(path); // explicit trash gets the toast
      if (selected === path) {
        const idx = viewRows.loose.findIndex((n) => n.path === path);
        const neighbor = idx >= 0 ? (viewRows.loose[idx + 1] ?? viewRows.loose[idx - 1]) : undefined;
        if (neighbor) setSelected(neighbor.path);
      }
      showToast("Moved to Trash", { label: "Undo", run: () => undoApi.runById(undoId) });
    },
    [selected, viewRows, showToast, undoApi]
  );

  // run a file-touching action only after the open pane's pending save has
  // landed (Duplicate's rule, shared by trash + exports).
  // The action's promise passes through so callers that rely on rejection
  // (rename/move, InlineEdit stays open on a failed rename) keep
  // their resolve/reject semantics
  const afterOpenFlush = useCallback(<T,>(fn: () => T | Promise<T>): Promise<T> => {
    const flush = flushOpenRef.current;
    return (flush ? flush() : Promise.resolve()).then(fn);
  }, []);

  // Duplicate a note next to itself — the engine dedupes the
  // "<title> copy" filename. The open pane's pending save lands first (the
  // copy reads the file), then the fresh copy opens in place, following the
  // same view rules as a born-complete create (createTyped)
  const duplicateNote = useCallback(
    (n: NoteMeta) => {
      afterOpenFlush(() => {
        duplicateNoteInVault(n)
          .then((m) => {
            setNotes((ns) => [...ns.filter((x) => x.path !== m.path), m]);
            if (view.kind === "db" && inView(m, view, tagFolders)) setDbNote(m.path);
            else {
              if (!inView(m, view, tagFolders)) setView({ kind: "all" });
              setSelected(m.path);
            }
            showMobileDetail();
            refresh();
            showToast("Duplicated");
          })
          .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
      });
    },
    [afterOpenFlush, view, refresh, showToast, showMobileDetail, setNotes, tagFolders]
  );

  // "Move to folder…" from any surface: the palette opens straight into its
  // folder-picker stage for the note
  const startMoveToFolder = useCallback((n: NoteMeta) => {
    setPaletteStart({ kind: "moveto", note: n });
    setOverlay("palette");
  }, []);

  // One trash path for every surface — pending text lands first,
  // then the toast with Undo + neighbor selection. The
  // note pane's own menu goes through here too (it flushes first itself)
  const trashNote = useCallback(
    (path: string) => {
      afterOpenFlush(() => {
        // the id is minted before the write so the toast and the stack entry
        // are the same action
        const undoId = undoStack.nextUndoId();
        trashUndoable({ path, id: undoId, record: undoApi.record, restore: restoreTrashed })
          .then(() => {
            // a trashed db side note must not linger as state — the pane
            // already unmounts (meta lookup fails), and a stale dbNote would
            // eat one ⌫/Esc press for nothing
            setDbNote((d) => (d === path ? null : d));
            refresh();
            reloadSidebarOrder();
            onNoteTrashed(path, undoId);
          })
          .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
      });
    },
    [afterOpenFlush, refresh, reloadSidebarOrder, onNoteTrashed, showToast, undoApi, restoreTrashed]
  );

  // Bulk trash from the table's multi-select bar — one refresh, ONE
  // summary toast. Undo restores every trashed note through the same per-note
  // restore.
  // ONE vault_delete_many, not a vault_delete per note. The per-note
  // loop stamped each note from its own clock reading, so a millisecond
  // boundary falling mid-loop under load split one click's worth of notes
  // across two `deleted_ms` groups and reordered them in the Trash pane. The
  // bulk command stamps the whole selection once.
  const trashNotes = useCallback(
    (paths: string[]) => {
      afterOpenFlush(() => {
        // a rejected call (not a per-note Err) means nothing was trashed —
        // the empty list takes the same "couldn’t move to Trash" path
        vaultDeleteMany(paths)
          .catch(() => [] as { Ok?: string; Err?: string }[])
          .then((results) => {
            const ok: { path: string; id: string }[] = [];
            results.forEach((r, i) => {
              if (r.Ok !== undefined) ok.push({ path: paths[i], id: r.Ok });
            });
            if (dbNote && ok.some((r) => r.path === dbNote)) setDbNote(null);
            refresh();
            reloadSidebarOrder();
            if (ok.length === 0) {
              showToast("couldn’t move to Trash");
              return;
            }
            const what = `${ok.length} ${ok.length === 1 ? "note" : "notes"}`;
            const undoId = undoStack.nextUndoId();
            recordTrashBulk({
              trashed: ok,
              id: undoId,
              record: undoApi.record,
              restore: restoreTrashed,
            });
            showToast(
              ok.length === paths.length
                ? `${what} moved to Trash`
                : `${what} of ${paths.length} moved to Trash`,
              { label: "Undo", run: () => undoApi.runById(undoId) }
            );
          });
      });
    },
    [afterOpenFlush, dbNote, refresh, restoreTrashed, showToast, undoApi]
  );

  // a `[[Note#Heading]]` click knows where it wants to land, but
  // the line only exists once the note's text is in hand — the anchor waits
  // here until the effect below can read the note and aim the reveal.
  const [pendingAnchor, setPendingAnchor] = useState<{ path: string; anchor: string } | null>(null);

  const followLink = useCallback(
    (name: string) => {
      // the link's NAME is the target alone: the heading anchor says where to
      // land, the display alias is prose
      const { target, anchor } = parseWikiLink(name);
      if (!target) {
        // `[[#Heading]]` points inside the note that carries it
        if (anchor && selectedRef.current) {
          setPendingAnchor({ path: selectedRef.current, anchor });
        }
        return;
      }
      vaultResolve(target).then((meta) => {
        if (meta) {
          openNote(meta.path);
          if (anchor) setPendingAnchor({ path: meta.path, anchor });
          return;
        }
        // unresolved: a database name opens that view (hub-page links,
        // links) — only a genuine miss creates the note
        const db = databases.find((d) => d.type.toLowerCase() === target.toLowerCase());
        if (db) openDatabase(db.type);
        else createNote(target, "");
      });
    },
    [openNote, createNote, databases, openDatabase]
  );

  // The body behind a wikilink's TARGET, for the editor's `[[Target#anchor`
  // popup — resolved through the same `vault_resolve` following the link uses,
  // so every heading offered is one a click would actually land on.
  //
  // Cached per target for as long as the vault snapshot holds: a completion
  // source is re-asked on keystrokes, and a note read per keystroke over IPC
  // would make typing an anchor feel like typing through mud. Misses cache as
  // null too — while a name is still half-typed, resolving to nothing is the
  // common case, not the exception.
  const linkedNoteBody = useMemo(() => {
    const cache = new Map<string, Promise<string | null>>();
    return (target: string): Promise<string | null> => {
      const key = target.trim().toLowerCase();
      let hit = cache.get(key);
      if (!hit) {
        hit = vaultResolve(target)
          .then((meta) => (meta ? vaultRead(meta.path).then((content) => content.body) : null))
          // an unreadable note offers no anchors; the popup's absence is the
          // mildest possible failure and never an error in the writer's face
          .catch(() => null);
        cache.set(key, hit);
      }
      return hit;
    };
  }, [vaultEpoch]);

  /* ----- inline view embeds in notes ----- */

  // resolve a ```view fence against the current vault snapshot; the widget
  // re-asks on every render, so this closure must follow the latest state
  const embedQuery = useCallback(
    (spec: ViewSpecResult) => embedQueryFor(spec, notes, schema, savedViews),
    [notes, schema, savedViews]
  );

  // an embed's header click opens the database — or, when the embed came
  // from a saved: pin, that saved view itself
  const openEmbedView = useCallback(
    (dbType: string, savedId?: string) =>
      setView(savedId ? { kind: "saved", id: savedId } : { kind: "db", type: dbType }),
    []
  );

  /* ----- sidebar flow: folders, moves, ordering ----- */

  // A moved dashboard keeps its manual sidebar position. The engine
  // retargets the note's PIN behind our back but not the reorder entry, and
  // `applyOrder` drops ids it can't match — so without this the row silently
  // fell to the bottom of the Dashboards lane. Re-read the order the engine
  // just rewrote, then retarget the dashboards entry in the same moment.
  const migrateSidebarOrderPath = useCallback(
    (oldPath: string, newPath: string) => {
      queueViewsWrite(vaultSidebarOrder)
        .then((order) => {
          const current = order.dashboards ?? [];
          const dashboards = migrateOrderId(current, oldPath, newPath);
          if (dashboards === current) {
            setSidebarOrder(order);
            return;
          }
          const next: SidebarOrder = { ...order, dashboards };
          setSidebarOrder(next);
          persistViewsConfig(
            () => vaultSetSidebarOrder(next),
            setSidebarOrder,
            vaultSidebarOrder,
            "Couldn't save sidebar settings"
          );
        })
        .catch(console.error);
    },
    [persistViewsConfig]
  );

  // A renamed or moved GROUP folder keeps its manual position and its
  // collapse state. The engine retargets `$sidebar.dashgroups` behind our back
  // (move_sidebar_folders) but nothing retargets `collapsed`, whose group ids
  // are keyed by folder path — and toggleCollapsed's GC then drops the orphan,
  // so the group silently reopens. Re-read what the engine wrote, retarget both
  // lanes, and write back only when something actually changed.
  const migrateSidebarGroupFolder = useCallback(
    (oldRel: string, newRel: string | null) => {
      queueViewsWrite(vaultSidebarOrder)
        .then((order) => {
          const curGroups = order.dashgroups ?? [];
          const dashgroups =
            newRel === null
              ? curGroups.filter((g) => g !== oldRel && !g.startsWith(`${oldRel}/`))
              : migrateOrderId(curGroups, oldRel, newRel);
          const curCollapsed = order.collapsed ?? [];
          const collapsed = curCollapsed.flatMap((c) => {
            if (!c.startsWith("dashgroup:")) return [c];
            const f = c.slice("dashgroup:".length);
            if (f !== oldRel && !f.startsWith(`${oldRel}/`)) return [c];
            return newRel === null ? [] : [`dashgroup:${newRel}${f.slice(oldRel.length)}`];
          });
          const changed =
            dashgroups.length !== curGroups.length ||
            dashgroups.some((g, i) => g !== curGroups[i]) ||
            collapsed.length !== curCollapsed.length ||
            collapsed.some((c, i) => c !== curCollapsed[i]);
          if (!changed) {
            setSidebarOrder(order);
            return;
          }
          const next: SidebarOrder = { ...order, dashgroups, collapsed };
          setSidebarOrder(next);
          persistViewsConfig(
            () => vaultSetSidebarOrder(next),
            setSidebarOrder,
            vaultSidebarOrder,
            "Couldn't save sidebar settings"
          );
        })
        .catch(console.error);
    },
    [persistViewsConfig]
  );

  // Rename/move of the open note wait out its pending save too —
  // otherwise the pane's late flush writes to the OLD path after the mutation
  // and dies silently, losing the typed text
  const renameNote = useCallback(
    (path: string, title: string): Promise<NoteMeta> =>
      afterOpenFlush(() =>
        renameUndoable({
          path,
          title,
          priorTitle: notesRef.current.find((n) => n.path === path)?.title ?? path,
          record: undoApi.record,
          onApplied: onRenameApplied,
        }).then((m) => {
          setRenaming(null);
          onRenamed(path, m);
          // the note's new metadata carries the path it moved to — callers
          // that renamed a row on screen follow it there
          return m;
        })
      ),
    [afterOpenFlush, onRenamed, undoApi]
  );

  // A move's undo runs long after the move recorded it, so the
  // follow decision can't ride the closure moveNote captured — it has to read
  // the view/selection as they are at ⌘Z time.
  const moveFollowRef = useRef({ view, selected, tagFolders });
  moveFollowRef.current = { view, selected, tagFolders };

  // Undo/redo apply the inverse move outside moveNote, so without
  // this the file returns and `selected` still names the dead destination —
  // the selection-guard snaps the editor to a neighbour and the next
  // keystroke lands in the wrong note (the trap, at undo time). Same
  // shape as onRenameApplied: repair every path reference, and FOLLOW the
  // view only when the note that moved is the open one and was on screen.
  const onMoveApplied = useCallback(
    (oldPath: string, m: NoteMeta) => {
      const { view: v, selected: sel, tagFolders: tf } = moveFollowRef.current;
      const prev = notesRef.current.find((n) => n.path === oldPath);
      const wasShown = sel === oldPath && !!prev && inView(prev, v, tf);
      setSelected((cur) => (cur === oldPath ? m.path : cur));
      setDbNote((cur) => (cur === oldPath ? m.path : cur));
      setRenaming((r) => (r === oldPath ? m.path : r));
      setView((cur) =>
        cur.kind === "dashboard" && cur.path === oldPath ? { ...cur, path: m.path } : cur
      );
      // seed the moved meta synchronously, same reason the
      // forward move does: app state is pre-refresh stale at this instant
      setNotes((ns) => ns.map((n) => (n.path === oldPath ? m : n)));
      if (wasShown && !inView(m, v, tf)) {
        setView(
          isScratchNote(m)
            ? { kind: "notes" }
            : m.folder
              ? { kind: "folder", path: m.folder }
              : { kind: "all" }
        );
      }
      refresh();
      migrateSidebarOrderPath(oldPath, m.path);
    },
    [refresh, migrateSidebarOrderPath, notesRef, setNotes]
  );

  const moveNote = useCallback(
    (path: string, folder: string): Promise<void> =>
      afterOpenFlush(() => {
        // Whether the view has to FOLLOW is decided against the
        // pre-move meta — a note the current view never listed (a dashboard
        // or search scope, where the guard clears instead of snapping) must
        // not yank the view, and neither must moving a background note.
        const prev = notesRef.current.find((n) => n.path === path);
        const wasShown = selected === path && !!prev && inView(prev, view, tagFolders);
        // OnApplied is undo/redo only — the forward move's repair is
        // the `.then` right below, which knows this call's own `wasShown`
        return moveUndoable({ path, folder, record: undoApi.record, onApplied: onMoveApplied }).then((m) => {
          // the file's rel path changed — follow it everywhere it's referenced
          setSelected((sel) => (sel === path ? m.path : sel));
          setDbNote((cur) => (cur === path ? m.path : cur));
          setRenaming((r) => (r === path ? m.path : r));
          // An OPEN dashboard is addressed by its path too — since
          // Dragging one between folders is a normal gesture, and a
          // view left on the old path finds no meta and falls back to the list
          setView((v) => (v.kind === "dashboard" && v.path === path ? { ...v, path: m.path } : v));
          // The OPEN note left this view's scope — left alone, the
          // selection-guard snaps the editor to a different note and the
          // next keystroke lands in it (the wrong-note editing trap). Follow
          // the note to where it now lives, exactly like followTyped does:
          // untyped Inbox/root captures belong to Notes (the createNote
          // idiom), anything else to its destination folder.
          if (wasShown && !inView(m, view, tagFolders)) {
            // seed the moved meta synchronously: app state is
            // pre-refresh stale at this instant, so the destination view has
            // no row for the note yet and the guard would snap right back
            setNotes((ns) => ns.map((n) => (n.path === path ? m : n)));
            setView(
              isScratchNote(m)
                ? { kind: "notes" }
                : m.folder
                  ? { kind: "folder", path: m.folder }
                  : { kind: "all" }
            );
          }
          refresh();
          migrateSidebarOrderPath(path, m.path);
        });
      }),
    [
      afterOpenFlush,
      refresh,
      migrateSidebarOrderPath,
      undoApi,
      onMoveApplied,
      selected,
      view,
      tagFolders,
      notesRef,
      setNotes,
    ]
  );

  const createFolder = useCallback(
    (path: string): Promise<void> =>
      createFolderUndoable({ path, record: undoApi.record }).then(() => {
        setFolderEdit(null);
        refresh();
      }),
    [refresh, undoApi]
  );

  /** A folder that changed rel (rename or move) drags every path the
      app is CURRENTLY pointing at with it — the rule that an open note or
      dashboard follows its own file through a rename, one level up. The
      open folder view, an open dashboard inside it, the selected note, the db
      side note and an armed inline rename are all addressed by path, and a
      pane left on the old rel finds no meta and silently falls back to the
      list. Rename and move share this exactly, so they share the helper. */
  const followFolderRelocation = useCallback((oldRel: string, newRel: string) => {
    if (newRel === oldRel) return;
    const prefix = `${oldRel}/`;
    const inside = (p: string) => p.startsWith(prefix);
    const retarget = (p: string) => newRel + p.slice(oldRel.length);
    setSelected((sel) => (sel && inside(sel) ? retarget(sel) : sel));
    setDbNote((cur) => (cur && inside(cur) ? retarget(cur) : cur));
    setRenaming((r) => (r && inside(r) ? retarget(r) : r));
    setView((v) => {
      if (v.kind === "folder" && (v.path === oldRel || inside(v.path))) {
        return { kind: "folder", path: retarget(v.path) };
      }
      if (v.kind === "dashboard" && inside(v.path)) return { ...v, path: retarget(v.path) };
      return v;
    });
  }, []);

  const renameFolder = useCallback(
    (path: string, name: string): Promise<void> =>
      renameFolderUndoable({
        path,
        name,
        // the notes inside move with the dir, so the entry invalidates on
        // an external edit to any of them too
        notePaths: notesRef.current
          .filter((n) => n.folder === path || n.folder.startsWith(`${path}/`))
          .map((n) => n.path),
        record: undoApi.record,
      }).then((newRel) => {
        setFolderEdit(null);
        // the open folder view — and an open dashboard inside it — follow
        followFolderRelocation(path, newRel);
        reloadFolderMeta();
        reloadSealScopes();
        refresh();
        // re-reads the order the engine just rewrote; for a dash group
        // it also carries the `dashgroup:<folder>` collapse id to the new path
        migrateSidebarGroupFolder(path, newRel);
      }),
    [
      refresh,
      reloadFolderMeta,
      reloadSealScopes,
      migrateSidebarGroupFolder,
      followFolderRelocation,
      undoApi,
    ]
  );

  /** Move a folder under `target` ("" = vault root) — the gesture
      behind dragging a Dashboards group header onto a folder tree row. The
      dashboards inside keep their filenames and re-render as that row's tree
      dashboards; a collision surfaces the engine's message. */
  const moveFolder = useCallback(
    (path: string, target: string) => {
      // The rule for directories: a pending editor save inside the folder
      // must land BEFORE the dir moves, or the late flush writes to a dead path
      afterOpenFlush(() =>
        moveFolderUndoable({
          path,
          target,
          notePaths: notesRef.current
            .filter((n) => n.folder === path || n.folder.startsWith(`${path}/`))
            .map((n) => n.path),
          record: undoApi.record,
          // runs on the move AND on undo/redo, so every direction lands the
          // views, the sidebar order and the collapse ids on the live path
          follow: (from, to) => {
            followFolderRelocation(from, to);
            reloadFolderMeta();
            reloadSealScopes();
            refresh();
            migrateSidebarGroupFolder(from, to);
          },
        }).catch((e) => showToast(String(e instanceof Error ? e.message : e)))
      );
    },
    [
      afterOpenFlush,
      refresh,
      reloadFolderMeta,
      reloadSealScopes,
      migrateSidebarGroupFolder,
      followFolderRelocation,
      showToast,
      undoApi,
    ]
  );

  // chevron-collapsible sidebar rows: the id is a section name
  // ("dashboards" | "pinned" | "folders") or a Dashboards subfolder group
  // ("dashgroup:<folder>"); state persists in `.vault/views.json` under
  // `$sidebar.collapsed`
  // The `dashgroup:<folder>` ids whose collapse state is worth keeping — a
  // subfolder counts while ANY dashboard lives in it, hidden ones included,
  // so opting rows out of the listing never forgets how the user left the
  // chevron; only a genuinely emptied folder gets its persisted id pruned
  const dashGroupIds = useMemo(
    () =>
      new Set(
        [...splitDashboards(orderedDashboards, folders).groupFolders].map((f) => `dashgroup:${f}`)
      ),
    [orderedDashboards, folders]
  );

  const {
    setSectionOrder,
    toggleCollapsed,
    collapsedIds,
    pinnedPaths,
    setPinned,
    customKeys,
    writeKeys,
  } = useSidebarOrderModel({
    sidebarOrder,
    setSidebarOrder,
    persistViewsConfig,
    dashGroupIds,
  });

  // The key HUD is open. Session-only by design — assign mode is a
  // thing you do, not a setting you keep.
  const [keyAssignOpen, setKeyAssignOpen] = useState(false);

  // the ⌘-digit each pin owns — derived from the same pinIds order
  // the shortcuts fire on, minus digits a custom key claims. DatabasePane's
  // view tabs render them: the surface a homed database's pins actually
  // appear on, which the sidebar no longer provides
  const pinKeys = useMemo(() => pinKeyLabels(pinIds, customKeys), [pinIds, customKeys]);

  // the pinned rows, in `$sidebar.pins` order. A path with no note behind it
  // (edited out of views.json, or trashed while the app was closed) simply
  // doesn't render — the same tolerance applyOrder gives dashboards
  const pinnedNotes = useMemo(
    () =>
      pinnedPaths
        .map((p) => notes.find((n) => n.path === p))
        .filter((n): n is NoteMeta => n !== undefined),
    [pinnedPaths, notes]
  );

  // Live rows behind the target tokens, so the sheet and the HUD name
  // a binding's destination instead of echoing its token
  const keyLabelCtx = useMemo(
    () => ({
      dashboards: orderedDashboards.map((d) => ({ path: d.path, title: d.title })),
      savedViews: savedViews.map((v) => ({ id: v.id, name: v.name })),
      pinned: pinnedNotes.map((n) => ({ path: n.path, title: n.title })),
      tagFolders: tagFolders.map((f) => ({ id: f.id, name: f.name })),
    }),
    [orderedDashboards, savedViews, pinnedNotes, tagFolders]
  );

  // the dashboards the sidebar and palette actually list: mobile drops the
  // desk-bound ones (sync/music/mastering) — declared here because the pin
  // split below has to key off the very same list the sidebar renders
  const mobileDashboards = useMemo(
    () =>
      mobile
        ? orderedDashboards.filter(
            (d) => !["sync", "music", "mastering"].includes(foldedPropStr(d.props, "dashboard") ?? ""),
          )
        : orderedDashboards,
    [mobile, orderedDashboards]
  );

  // Every dashboard already has a sidebar row of its own, so a pinned
  // one must not ALSO nest under a folder tree row as a pin. Exclusion is by
  // PATH and independent of WHICH surface owns the dashboard row — the
  // Dashboards section (home subtree) or, its folder's tree row.
  // Computed once from the list that reaches the Sidebar's `dashboards` prop
  // and passed down, so menu math and render can't disagree (e.g. on mobile,
  // where the filtered list moves the dashboards home).
  // A dashboard opted out of the listing has no row to collide with, so it
  // keeps the pin the tree would otherwise suppress
  const dashPaths = useMemo(
    () => new Set(mobileDashboards.filter((d) => !hiddenFromSidebar(d.props)).map((d) => d.path)),
    [mobileDashboards]
  );

  // The same three-way dashboard split the sidebar renders — shared
  // here so the row menu's Move lane is the one the row actually reorders in
  const dashSplit = useMemo(
    () => splitDashboards(mobileDashboards, folders),
    [mobileDashboards, folders]
  );

  // The group headers in the order the sidebar draws them — the menu's
  // Move up/down has to index the same list the drag lane reorders
  const orderedDashGroups = useMemo(
    () => applyOrder(dashSplit.groups, sidebarDashGroupOrder, (g) => g.folder),
    [dashSplit, sidebarDashGroupOrder]
  );

  // The split the sidebar renders pins with — flat section rows vs
  // per-folder tree groups. Shared here so pin menus run the same lane math.
  const pinSplit = useMemo(() => splitPins(pinnedNotes, dashPaths), [pinnedNotes, dashPaths]);

  // the non-drag reorder path: every reorderable sidebar lane also moves by
  // menu — dashboards, folder sibling groups at any depth (roots
  // and nested alike), and pin groups. The id list mirrors what
  // the sidebar renders for that lane, so menu math and drag math agree.
  const sectionMoveItems = useCallback(
    (section: Section, id: string): MenuItem[] => {
      const ids =
        section === "dashboards"
          ? // The section's own rows in render order (flat, then the
            // subfolder groups' members) — NOT every dashboard in the vault.
            // A tree-foldered one interleaved in the persisted order would
            // otherwise absorb the swap and Move up/down would do nothing.
            // Groups in their persisted header order, same as render
            [...dashSplit.flat, ...orderedDashGroups.flatMap((g) => g.items)].map((d) => d.path)
          : section.startsWith("dashes:")
            ? (dashSplit.byFolder.get(section.slice("dashes:".length)) ?? []).map((d) => d.path)
            : section === "dashgroups"
              ? orderedDashGroups.map((g) => g.folder)
              : section === "pins"
              ? pinSplit.flat.map((n) => n.path)
              : section.startsWith("pins:")
                ? (pinSplit.byFolder.get(section.slice("pins:".length)) ?? []).map((n) => n.path)
                : section === "folders"
                  ? orderedRootFolders
                  : orderedSiblingFolders(
                      folders,
                      sidebarFolderOrder,
                      section.slice("folders:".length)
                    );
      const i = ids.indexOf(id);
      const move = (dir: -1 | 1) => setSectionOrder(section, moveId(ids, id, dir));
      return [
        {
          label: "Move up",
          icon: <ChevronUpIcon />,
          disabled: i <= 0,
          onSelect: () => move(-1),
        },
        {
          label: "Move down",
          icon: <ChevronDownIcon />,
          disabled: i === -1 || i >= ids.length - 1,
          onSelect: () => move(1),
        },
      ];
    },
    [
      orderedRootFolders,
      folders,
      sidebarFolderOrder,
      dashSplit,
      orderedDashGroups,
      pinSplit,
      setSectionOrder,
    ]
  );

  /* ----- context menus ----- */

  const revealRel = useCallback((rel: string) => {
    vaultRoot()
      .then((root) => revealItemInDir(`${root}/${rel}`))
      .catch((e) => console.warn("reveal in Finder unavailable:", e));
  }, []);

  const copyAbsPath = useCallback((rel: string) => {
    vaultRoot()
      .then((root) => navigator.clipboard.writeText(`${root}/${rel}`))
      .catch(console.error);
  }, []);

  // Which sealed notes this session still holds an authorization for. The row
  // menu and the palette need it to answer two questions honestly: is there
  // anything to lock, and can "Remove seal…" go straight to the confirm or does
  // it have to ask for the password first (the engine only unseals a note whose
  // identity is already authorized — vault/mod.rs `unseal_note`).
  const unlockedSealed = useSyncExternalStore(subscribeSealed, unlockedSealedPaths);

  // `then: "unseal"` chains the two dialogs for "Remove seal…" on a locked
  // note: unlock, then confirm. Cancelling the confirm leaves the note
  // unlocked — the user did authorize it, and the menu now offers "Lock now".
  const [sealDialog, setSealDialog] = useState<
    { note: NoteMeta; mode: SealedNoteMode; then?: "unseal" } | null
  >(null);

  // per-note calendar opt-out, the note pane's own write (NotePane
  // `toggleCalendar`): hiding stores a real YAML `false`, showing removes the
  // prop. Through setPropUndoable so one ⌘Z reverts it whichever surface it
  // came from.
  const setCalendarHidden = useCallback(
    (n: NoteMeta, hidden: boolean) => {
      setPropUndoable({
        path: n.path,
        key: foldedPropKey(n.props, "calendar"),
        value: hidden ? false : null,
        record: undoApi.record,
        keyLabel: "calendar",
      })
        .then(() => refresh())
        .catch((err) => {
          showToast(`couldn’t save — ${errText(err)}`);
          refresh();
        });
    },
    [undoApi, refresh, showToast]
  );

  // The handlers that used to exist only on the open note's ⋯ menu.
  // One place, spread into every surface that renders the descriptors, so
  // "which verbs do I get" stops depending on where you invoked from.
  // The body lives in lib/noteextras so the flush-before-authorization-change
  // ordering can be executed by a test.
  const noteActionExtras = useCallback(
    (n: NoteMeta): NoteExtras =>
      buildNoteExtras(n, {
        unlockedSealed,
        schema,
        afterFlush: afterOpenFlush,
        openSealDialog: setSealDialog,
        relock: relockSealed,
        setCalendarHidden,
      }),
    [unlockedSealed, schema, afterOpenFlush, setCalendarHidden]
  );

  // The row menu renders the canonical note actions (lib/
  // noteactions) — same descriptors the note pane's ⋯ menu and the palette
  // actions stage show, with the row surface's full wiring (Open included)
  const noteMenuItems = useCallback(
    (n: NoteMeta): MenuItem[] =>
      buildNoteActions({
        open: () => openNote(n.path),
        moveToFolder: () => startMoveToFolder(n),
        rename: n.sealed ? undefined : () => setRenaming(n.path),
        copyPath: () => copyAbsPath(n.path),
        reveal: () => revealRel(n.path),
        duplicate: () => duplicateNote(n),
        exportMarkdown: () => afterOpenFlush(() => exportNoteMarkdown(n).catch(console.error)),
        exportPdf: () => afterOpenFlush(() => exportNotePdf(n).catch(console.error)),
        exportOneSheet: () => afterOpenFlush(() => exportNoteOneSheet(n).catch(console.error)),
        share: () => afterOpenFlush(() => setShare(n)),
        sealed: n.sealed,
        ...noteActionExtras(n),
        togglePick: () => togglePickToday(n.path, !isPickedToday(n, todayIso())),
        picked: isPickedToday(n, todayIso()),
        togglePin: () => setPinned(n.path, !pinnedPaths.includes(n.path)),
        pinned: pinnedPaths.includes(n.path),
        trash: () => trashNote(n.path),
      }).map((a) => ({
        label: a.label,
        icon: <NoteActionGlyph name={a.icon} />,
        hint: a.hint,
        danger: a.destructive,
        separatorAbove: a.separatorAbove,
        onSelect: a.run,
      })),
    [
      openNote,
      startMoveToFolder,
      duplicateNote,
      trashNote,
      copyAbsPath,
      revealRel,
      afterOpenFlush,
      togglePickToday,
      noteActionExtras,
      setPinned,
      pinnedPaths,
    ]
  );

  /** `lane` overrides which reorder lane the Move up/down entries act on.
      A Dashboards group header wears the folder menu but reorders
      against its sibling HEADERS, not against the folder tree. */
  const folderMenuItems = useCallback(
    (path: string, anchor: AnchorRect, lane?: Section): MenuItem[] => [
      { label: "Open", icon: <FolderIcon />, onSelect: () => setView({ kind: "folder", path }) },
      // The same instant scratch ⌘N makes in a folder view (2299),
      // reachable without opening the folder first. The view follows the note —
      // otherwise the selection effect snaps back to the current view's first
      // row, since the fresh note is no member of it.
      {
        label: "New note",
        icon: <NoteIcon />,
        onSelect: () => {
          setView({ kind: "folder", path });
          createScratch(path);
        },
      },
      {
        label: "New subfolder…",
        icon: <PlusIcon />,
        onSelect: () => setFolderEdit({ kind: "create", parent: path }),
      },
      // The discoverable half of homing — this folder's row
      // starts opening as a database (existing or born here). The inverse
      // lives on the db-dressed row ("Stop opening as database").
      {
        label: "Open as database…",
        icon: <DbGlyphIcon />,
        onSelect: () => setOpenAsPicker({ path, x: anchor.left, y: anchor.top }),
      },
      {
        label: "Rename…",
        icon: <PenIcon />,
        onSelect: () => setFolderEdit({ kind: "rename", path }),
      },
      {
        label: "Change icon…",
        icon: <DbGlyphIcon />,
        onSelect: () => setFolderIconMenu({ path, anchor }),
      },
      ...(sealScopes.some((scope) => scope.path === path && !scope.confirmed)
        ? [
            {
              label: "Confirm seal…",
              hint: "arrived from outside this device",
              icon: <NoteActionGlyph name="lock" />,
              onSelect: () => setSealScopeDialog({ path, mode: "confirm" as const }),
            },
            {
              label: "Reject seal",
              icon: <TrashIcon />,
              onSelect: () => removeSealScope(path, true),
            },
          ]
        : sealScopes.some((scope) => scope.path === path && scope.state === "active")
        ? [
            {
              label: "Stop seal inheritance",
              icon: <NoteActionGlyph name="lock" />,
              onSelect: () => removeSealScope(path),
            },
          ]
        : sealScopes.some((scope) => scope.path === path && scope.state === "pending")
          ? [
              {
                label: "Seal conversion pending",
                hint: "restart to resume",
                icon: <NoteActionGlyph name="lock" />,
                disabled: true,
                onSelect: () => {},
              },
            ]
        : !scopeInheritedAt(path)
          ? [
              {
                label: "Seal folder…",
                icon: <NoteActionGlyph name="lock" />,
                onSelect: () => setSealScopeDialog({ path }),
              },
            ]
          : []),
      ...(folderMeta[path]?.icon
        ? [
            {
              label: "Remove icon",
              icon: <TrashIcon />,
              onSelect: () => saveFolderIcon(path, null),
            },
          ]
        : []),
      { label: "Reveal in Finder", icon: <FolderIcon />, onSelect: () => revealRel(path) },
      // Roots and nested alike: every folder reorders by menu within
      // its own sibling group
      ...sectionMoveItems(
        lane ??
          (path.includes("/") ? `folders:${path.slice(0, path.lastIndexOf("/"))}` : "folders"),
        path
      ),
      {
        label: "Move to Trash",
        icon: <TrashIcon />,
        hint: "recoverable",
        separatorAbove: true,
        onSelect: () => {
          trashFolderUndoable({
            path,
            notePaths: notesRef.current
              .filter((n) => n.folder === path || n.folder.startsWith(`${path}/`))
              .map((n) => n.path),
            record: undoApi.record,
            restore: restoreTrashedFolder,
          })
            .then(() => {
              // an open folder view has nowhere to follow — fall back to notes
              setView((v) =>
                v.kind === "folder" && (v.path === path || v.path.startsWith(`${path}/`))
                  ? { kind: "notes" }
                  : v
              );
              reloadFolderMeta();
              reloadSealScopes();
              refresh();
              // The engine drops the trashed folder's `dashgroups`
              // entry; its `dashgroup:` collapse id goes with it, so a restored
              // group comes back open rather than remembering a stale collapse
              if (lane === "dashgroups") migrateSidebarGroupFolder(path, null);
              else reloadSidebarOrder();
            })
            .catch((e) => showToast(errText(e)));
        },
      },
    ],
    [
      revealRel,
      refresh,
      reloadSidebarOrder,
      migrateSidebarGroupFolder,
      showToast,
      folderMeta,
      saveFolderIcon,
      reloadFolderMeta,
      reloadSealScopes,
      sectionMoveItems,
      createScratch,
      undoApi,
      restoreTrashedFolder,
      sealScopes,
      scopeInheritedAt,
      removeSealScope,
    ]
  );

  const dbMenuItems = useCallback(
    (type: string, anchor: AnchorRect): MenuItem[] => {
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      const home = byFoldedKey(homeByDb, type);
      return [
        { label: "Open", icon: <DbGlyphIcon />, onSelect: () => setView({ kind: "db", type }) },
        {
          label: `New ${label}…`,
          icon: <PlusIcon />,
          onSelect: () => {
            setView({ kind: "db", type });
            setDbNewSeq((s) => s + 1);
          },
        },
        // A homed db opens as its folder's greeting view; the raw
        // file list of the home folder stays reachable here: the
        // row IS a real folder, so it grows subfolders like any other.
        ...(home
          ? [
              {
                label: "Show files",
                icon: <FolderIcon />,
                onSelect: () => setView({ kind: "folder", path: home }),
              },
              {
                label: "New subfolder…",
                icon: <PlusIcon />,
                onSelect: () => setFolderEdit({ kind: "create", parent: home }),
              },
            ]
          : []),
        {
          label: "Rename database…",
          icon: <PenIcon />,
          onSelect: () => setDbDialog({ kind: "rename-db", dbType: type }),
        },
        // same slot as the folder menu's: right below Rename…
        {
          label: "Change icon…",
          icon: <DbGlyphIcon />,
          onSelect: () => setDbIconMenu({ type, anchor }),
        },
        ...(iconForType(dbIcons, type)
          ? [
              {
                label: "Remove icon",
                icon: <TrashIcon />,
                onSelect: () => saveSchemaIcon(type, null),
              },
            ]
          : []),
        // The non-destructive exit — un-home straight from the tree
        // row, same lane as the manager picker's clear (setDbHome toasts).
        // Label: the folder row stays in the sidebar after this, so
        // "Remove from sidebar" lied — the click target reverts, that's all
        ...(home
          ? [
              {
                label: "Stop opening as database",
                icon: <XIcon />,
                separatorAbove: true,
                onSelect: () => setDbHome(type, null),
              },
            ]
          : []),
        {
          label: "Delete database…",
          icon: <TrashIcon />,
          // exactly one separator above the tail: it rides the un-home lane
          // when homed, Delete itself when not
          separatorAbove: !home,
          onSelect: () => setDbDialog({ kind: "delete-db", dbType: type }),
        },
      ];
    },
    [homeByDb, dbIcons, saveSchemaIcon, setDbHome]
  );

  // the All-databases manager's row menu: the database's standard
  // items with the home-folder lane inserted above the rename/icon/delete
  // tail; the lane swaps in the folder picker as a second-stage menu on the
  // spot. A mounted folder gets the unmount lanes there instead of
  // the home lane — its "home" is a folder outside the vault entirely.
  const dbManagerMenu = useCallback(
    (type: string, x: number, y: number) => {
      const anchor = { left: x, top: y, bottom: y };
      const base = dbMenuItems(type, anchor);
      const mount = mountByType.get(type.toLowerCase());
      const lanes: MenuItem[] = mount
        ? [
            {
              label: "Unmount",
              icon: <XIcon />,
              onSelect: () => unmount(mount, false),
            },
            {
              label: "Unmount and trash its notes…",
              icon: <TrashIcon />,
              onSelect: () => unmount(mount, true),
            },
          ]
        : [
            {
              label: typeHome(typeSchemaFor(schema, type))
                ? "Change home folder…"
                : "Set home folder…",
              icon: <FolderIcon />,
              onSelect: () => setHomePicker({ dbType: type, x, y }),
            },
          ];
      // the tail is variable (Remove icon only shows when one is set)
      const tail = base.findIndex((it) => it.label === "Rename database…");
      setMenu({ x, y, items: [...base.slice(0, tail), ...lanes, ...base.slice(tail)] });
    },
    [dbMenuItems, schema, mountByType, unmount]
  );

  // The dashboard row's "Move to folder…" — a second-stage picker on
  // the same spot (the homePicker pattern), scoped to where dashboards
  // plausibly go: their home folder, its existing subfolders, and the vault's
  // root folders. Anywhere else stays reachable through the palette's own
  // move stage, which lists every folder.
  const dashMoveItems = useCallback(
    (path: string): MenuItem[] => {
      const { home } = splitDashboards(orderedDashboards, folders);
      const cur = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      // home's existing subfolders (any depth — the sidebar groups them by
      // their first segment, but a move can still target a deeper one)
      const subs = home ? folders.filter((f) => f.startsWith(`${home}/`)).sort() : [];
      const targets = [home, ...subs, ...orderedRootFolders];
      const seen = new Set<string>();
      return targets
        .filter((f) => {
          if (seen.has(f)) return false;
          seen.add(f);
          return true;
        })
        .map((f) => ({
          label: f === "" ? "Vault root" : f,
          icon: <FolderIcon />,
          hint: f === cur ? "current" : undefined,
          disabled: f === cur,
          onSelect: () => moveNote(path, f).catch((e) => showToast(errText(e))),
        }));
    },
    [orderedDashboards, folders, orderedRootFolders, moveNote, showToast]
  );

  // the home picker's items: the vault's folders, plus the explicit clear
  // when the db has a home — the stray-exit
  const homePickerItems = useCallback(
    (dbType: string): MenuItem[] => {
      const cur = typeHome(typeSchemaFor(schema, dbType));
      // one home folder, one database: a folder already homing
      // another db stays visible but can't be picked — the tree renders a
      // folder as at most one database, so a second claim would vanish
      const takenBy = new Map<string, string>();
      for (const [t, entry] of Object.entries(schema)) {
        const h = typeHome(entry);
        if (h && t.toLowerCase() !== dbType.toLowerCase()) takenBy.set(h, t);
      }
      return [
        ...(cur
          ? [
              {
                label: "Stop opening as database",
                icon: <XIcon />,
                onSelect: () => setDbHome(dbType, null),
              },
            ]
          : []),
        ...folders.map((f) => ({
          label: f,
          icon: <FolderIcon />,
          hint: f === cur ? "current" : takenBy.get(f) ? `home of ${takenBy.get(f)}` : undefined,
          disabled: takenBy.has(f),
          onSelect: () => setDbHome(dbType, f),
        })),
      ];
    },
    [schema, folders, setDbHome]
  );

  // The folder row's "Open as database…" second stage. Databases
  // whose notes already sit in this folder float to the top (the likely
  // intent — the Newfolder case: typed notes inside, nothing homed), the
  // rest follow with their current home named; the tail births a NEW
  // database homed on this exact folder.
  const openAsItems = useCallback(
    (path: string): MenuItem[] => {
      const inFolder = new Map<string, number>();
      for (const n of notesRef.current) {
        if (n.folder !== path && !n.folder.startsWith(`${path}/`)) continue;
        const t = foldedPropStr(n.props, "type")?.toLowerCase();
        if (t && !FUNCTIONAL_TYPES.has(t)) inFolder.set(t, (inFolder.get(t) ?? 0) + 1);
      }
      const ranked = [...databases].sort(
        (a, b) => (inFolder.get(b.type.toLowerCase()) ?? 0) - (inFolder.get(a.type.toLowerCase()) ?? 0)
      );
      return [
        ...ranked.map((d) => {
          const label = d.type.charAt(0).toUpperCase() + d.type.slice(1);
          const here = inFolder.get(d.type.toLowerCase()) ?? 0;
          const home = byFoldedKey(homeByDb, d.type);
          return {
            label,
            icon: <DbGlyphIcon />,
            hint: here > 0 ? `${here} here` : home ? `now in ${home}` : undefined,
            onSelect: () => setDbHome(d.type, path),
          };
        }),
        {
          label: "New database…",
          icon: <PlusIcon />,
          separatorAbove: databases.length > 0,
          onSelect: () => setDbDialog({ kind: "create", homeFolder: path }),
        },
      ];
    },
    [databases, homeByDb, setDbHome]
  );

  // the Folders "+" menu: the plain inline-create folder flow, or
  // a database born straight into the tree — the create dialog flagged
  // fromSidebar so createDatabase homes it on an eponymous root folder.
  // "Mount a folder…" shows a real folder on disk as a database.
  /* ----- tag folders ----- */

  // the builder sheet: null = closed, { folder: null } = building a new one
  const [tagFolderEdit, setTagFolderEdit] = useState<{ folder: TagFolder | null } | null>(null);

  // every tag in the vault with its note count — the completion source for
  // both the builder's chip fields and the editor's `#`. Derived from the
  // index rather than fetched: the notes are already here and already fresh.
  const tagCounts = useMemo(() => tagUniverse(notes), [notes]);

  // the sidebar asks for the sheet with the folder itself (or null for new);
  // the wrapper object is App's own "is it open" state
  const onTagFolderEdit = useCallback((folder: TagFolder | null) => setTagFolderEdit({ folder }), []);

  // clicking an inline `#tag` — the collection exists whether or not anyone
  // ever built a folder for that tag, which is the point: the tag is the
  // grouping, a folder is only a saved one
  const openTag = useCallback((tag: string) => {
    setView({ kind: "tag", tag });
    setDbNote(null);
  }, []);

  const saveTagFolder = useCallback(
    (folder: TagFolder) => {
      // one writer, so the read-modify-write needs no queue (the views.json
      // lane's reason for one doesn't apply — see useVaultConfigs)
      const next = tagFolders.some((f) => f.id === folder.id)
        ? tagFolders.map((f) => (f.id === folder.id ? folder : f))
        : [...tagFolders, folder];
      setTagFolders(next);
      setTagFolderEdit(null);
      // a refused write (newer format.json, disk error) must not leave the
      // sidebar showing a folder disk never got — re-read to converge, the
      // persistViewsConfig pattern
      vaultTagFoldersWrite(next)
        .then(setTagFolders)
        .catch((e) => {
          showToast(errText(e));
          vaultTagFoldersRead().then(setTagFolders).catch(() => {});
        });
      setView({ kind: "tagfolder", id: folder.id });
    },
    [tagFolders, setTagFolders, showToast]
  );

  const deleteTagFolder = useCallback(
    (id: string) => {
      const next = tagFolders.filter((f) => f.id !== id);
      setTagFolders(next);
      setTagFolderEdit(null);
      vaultTagFoldersWrite(next)
        .then(setTagFolders)
        .catch((e) => {
          showToast(errText(e));
          vaultTagFoldersRead().then(setTagFolders).catch(() => {});
        });
      // standing on the folder that just went away — the deletion removed a
      // lens, not any notes, so fall back to the widest one
      setView((v) => (v.kind === "tagfolder" && v.id === id ? { kind: "all" } : v));
    },
    [tagFolders, setTagFolders, showToast]
  );

  // a note dropped on a tag folder is TAGGED, not moved — its path never
  // changes. Exclusions are not applied (that would file it straight back out).
  const onDropNoteTagFolder = useCallback(
    (path: string, id: string) => {
      const folder = tagFolders.find((f) => f.id === id);
      if (!folder) return;
      const tags = tagFolderApplyTags(folder);
      if (tags.length === 0) return;
      // undoable like every other prop edit: the inverse restores
      // the note's prior `tags:` list, not "remove what we just asked for" —
      // the add is a union, so a tag the note already had must survive undo
      addTagsUndoable({ path, tags, record: undoApi.record, onApplied: () => refresh() })
        .then(() => showToast(`Tagged ${tags.map((t) => `#${t}`).join(" ")}`))
        .catch((e) => showToast(errText(e)));
    },
    [tagFolders, showToast, undoApi, refresh]
  );

  const folderAddMenu = useCallback(
    (x: number, y: number) =>
      setMenu({
        x,
        y,
        items: [
          {
            label: "New folder",
            icon: <FolderIcon />,
            onSelect: () => setFolderEdit({ kind: "create", parent: "" }),
          },
          {
            label: "New database…",
            icon: <DbGlyphIcon />,
            onSelect: () => setDbDialog({ kind: "create", fromSidebar: true }),
          },
          {
            label: "Mount a folder…",
            icon: <MountIcon />,
            onSelect: () => setMountDialog(true),
          },
          {
            // Born in the same menu as the real folders, because it
            // is the same kind of thing to the user — a place notes show up
            label: "New tag folder…",
            icon: <TypeIcon type="tag" icon={{ glyph: "tag" }} />,
            onSelect: () => setTagFolderEdit({ folder: null }),
          },
        ],
      }),
    []
  );


  /* A pin that has been exported once knows where it exports to, so
     its menu offers Regenerate instead of asking again. The targets live on
     the machine, not in the vault (an export path is true for one machine
     only), which is why they arrive over IPC rather than off the pin. */
  const exportView = useCallback(
    async (id: string, reask = false) => {
      const v = savedViews.find((sv) => sv.id === id);
      if (!v) return;
      try {
        const rows = savedViewRows(notes, v, typeSchemaFor(schema, v.db));
        const report = await exportSavedView(v, rows, reask);
        // null = the user closed the dialog; nothing happened, say nothing
        if (!report) return;
        setExportTargets((cur) => ({ ...cur, [id]: report.dest }));
        showToast(`Exported "${v.name}" — ${exportSummary(report)}`, {
          label: "Show",
          run: () => void revealItemInDir(report.dest).catch(() => undefined),
        });
      } catch (e) {
        // the refusal to overwrite a real folder is the message worth reading
        showToast(String(e instanceof Error ? e.message : e));
      }
    },
    [savedViews, notes, schema, showToast]
  );

  // Link-folder export for the saved view on screen, so the palette carries it
  // too: the sidebar context menu was the only door to it, which
  // meant it did not exist unless you already knew where to right-click.
  const linkFolderCommand = useMemo<{ label: string; hint?: string; run: () => void } | null>(() => {
    if (view.kind !== "saved") return null;
    const id = view.id;
    const target = exportTargets[id];
    return target
      ? {
          label: "Regenerate link folder",
          hint: target.split("/").pop(),
          run: () => void exportView(id),
        }
      : { label: "Export as link folder…", run: () => void exportView(id) };
  }, [view, exportTargets, exportView]);

  const savedViewMenuItems = useCallback(
    (id: string): MenuItem[] => {
      const target = exportTargets[id];
      // "in this note" is a promise about a specific editor, so ask the insert
      // target itself rather than inferring it from which pane is open: the ref
      // is held by the main note pane only, so from a database or saved-view
      // overlay it is null and the item honestly reads "Copy embed fence".
      // Menus are built when they open, so the ref is current here.
      const embedHere = noteInsertRef.current !== null;
      return [
        { label: "Open", icon: <PinIcon />, onSelect: () => setView({ kind: "saved", id }) },
        { label: "Rename…", icon: <PenIcon />, onSelect: () => setRenamingViewId(id) },
        target
          ? {
              label: "Regenerate link folder",
              icon: <RepeatIcon />,
              hint: target.split("/").pop(),
              separatorAbove: true,
              onSelect: () => void exportView(id),
            }
          : {
              label: "Export as link folder…",
              icon: <ExportIcon />,
              separatorAbove: true,
              onSelect: () => void exportView(id),
            },
        ...(target
          ? [
              {
                label: "Export to a new location…",
                icon: <ExportIcon />,
                onSelect: () => void exportView(id, true),
              },
            ]
          : []),
        {
          label: embedHere ? "Embed in this note" : "Copy embed fence",
          icon: embedHere ? <TableIcon /> : <CopyIcon />,
          separatorAbove: true,
          onSelect: () => {
            const v = savedViews.find((sv) => sv.id === id);
            if (!v) return;
            const fence = savedViewFence(v, savedViews);
            if (embedHere && noteInsertRef.current?.(fence)) {
              showToast(`Embedded "${v.name}"`);
              return;
            }
            void navigator.clipboard
              .writeText(fence)
              .then(() => showToast(`Copied the embed for "${v.name}" — paste it into a note`))
              .catch(() => showToast("Couldn't reach the clipboard"));
          },
        },
        {
          label: "Remove pin",
          icon: <TrashIcon />,
          danger: true,
          separatorAbove: true,
          onSelect: () => removeView(id),
        },
      ];
    },
    [removeView, exportView, exportTargets, savedViews, showToast]
  );

  /* The non-drag lane for assignable keys. The HUD's drag
     is the only way to bind a key otherwise, which no keyboard-first user and
     nobody who can't drag can reach. Same plumbing as the drop — assignKey /
     unassignKey through writeKeys — so there is no parallel state; the menu
     just picks a token instead of carrying it on a DataTransfer. */
  const keyPickerItems = useCallback(
    (target: string): MenuItem[] => {
      const { open, shadowing } = splitFreeKeys(customKeys, pinIds.length);
      const bound = keyForTarget(customKeys, target);
      const pick = (token: string): MenuItem => ({
        label: keyLabel(token),
        icon: <KeyboardIcon />,
        // The warning, in the menu's own idiom: still assignable, but
        // the drop retires a live pin shortcut, so it says so
        hint: shadowing.some((k) => k.token === token) ? "used by a pinned view" : undefined,
        onSelect: () => writeKeys((cur) => assignKey(cur, token, target)),
      });
      // the row's own key stays listed and selected-looking — re-picking it is
      // a no-op rather than a dead end
      const items = [...open, ...shadowing].map((k) => pick(k.token));
      if (bound) return [pick(bound), ...items];
      // every key taken and this row has none: say so instead of an empty box
      if (items.length === 0)
        return [{ label: "No free keys — remove one first", disabled: true, onSelect: () => {} }];
      return items;
    },
    [customKeys, pinIds.length, writeKeys]
  );

  /** The "Assign key…" lane every sidebar destination row's menu carries. */
  const keyMenuItems = useCallback(
    (target: string, x: number, y: number): MenuItem[] => {
      const bound = keyForTarget(customKeys, target);
      return [
        {
          label: "Assign key…",
          icon: <KeyboardIcon />,
          hint: bound ? keyLabel(bound) : undefined,
          separatorAbove: true,
          // a flat second menu on the same spot — the context menu has no
          // submenu precedent, and the icon pickers already re-anchor this
          // way. It goes through its own state rather than setMenu: the
          // parent menu's own onClose fires AFTER onSelect and would clear a
          // menu set from inside it.
          onSelect: () => setKeyPicker({ target, x, y }),
        },
        ...(bound
          ? [
              {
                label: "Remove key",
                icon: <XIcon />,
                onSelect: () => writeKeys((cur) => unassignKey(cur, bound)),
              },
            ]
          : []),
      ];
    },
    [customKeys, writeKeys]
  );

  const onSidebarMenu = useCallback(
    (target: MenuTarget, x: number, y: number) => {
      // the key-assign lane token for this row — viewKey()'s vocabulary, the
      // same strings the drop targets use (Sidebar.tsx keyDropProps)
      // A dash group IS its folder, so it takes the folder token
      const keyTarget =
        target.kind === "folder" || target.kind === "dashgroup"
          ? `folder:${target.path}`
          : target.kind === "db"
            ? `db:${target.type}`
            : target.kind === "savedview"
              ? `sv:${target.id}`
              : target.kind === "pin"
                ? `note:${target.path}`
                : target.kind === "fixed"
                  ? target.token
                  : target.kind === "tagfolder"
                    ? `tagfolder:${target.id}`
                    : `dash:${target.path}`;
      const keyLane = keyMenuItems(keyTarget, x, y);
      if (target.kind === "fixed") {
        // nothing to act on but the key lane — no separator, it's the whole menu
        setMenu({ x, y, items: keyLane.map((it) => ({ ...it, separatorAbove: false })) });
      } else if (target.kind === "folder") {
        setMenu({
          x,
          y,
          items: [...folderMenuItems(target.path, { left: x, top: y, bottom: y }), ...keyLane],
        });
      } else if (target.kind === "dashgroup") {
        // The same folder menu, but its Move up/down rides the
        // "dashgroups" lane — the one the header actually drags in — rather
        // than the folder tree's sibling lane the folder also lives in
        setMenu({
          x,
          y,
          items: [
            ...folderMenuItems(target.path, { left: x, top: y, bottom: y }, "dashgroups"),
            ...keyLane,
          ],
        });
      } else if (target.kind === "db") {
        // db rows exist only in the Folders tree now (homed dbs) —
        // everything else goes through the All databases manager
        setMenu({
          x,
          y,
          items: [...dbMenuItems(target.type, { left: x, top: y, bottom: y }), ...keyLane],
        });
      } else if (target.kind === "savedview") {
        setMenu({ x, y, items: [...savedViewMenuItems(target.id), ...keyLane] });
      } else if (target.kind === "tagfolder") {
        // No Rename lane of its own — the rule and the name are one
        // thing here, and both live in the builder
        const f = tagFolders.find((f) => f.id === target.id);
        setMenu({
          x,
          y,
          items: [
            { label: "Open", icon: <PinIcon />, onSelect: () => setView({ kind: "tagfolder", id: target.id }) },
            ...(f
              ? [{ label: "Edit tags…", icon: <PenIcon />, onSelect: () => setTagFolderEdit({ folder: f }) }]
              : []),
            {
              label: "Delete folder",
              icon: <TrashIcon />,
              danger: true,
              separatorAbove: true,
              // says what it does NOT do: the notes keep their tags and their
              // place — only this lens goes away
              hint: "notes keep their tags",
              onSelect: () => deleteTagFolder(target.id),
            },
            ...keyLane,
          ],
        });
      } else if (target.kind === "pin") {
        // a pinned plain note — the canonical note actions, whose
        // pin entry reads "Remove pin" here; unpinning never touches the file.
        // The row also moves by menu within its own pin lane (the
        // folder group it nests under, or the flat Pinned section).
        const n = notes.find((n) => n.path === target.path);
        if (n) {
          const home = pinTreeFolder(n.folder, n.path, dashPaths);
          const lane: Section = home === null ? "pins" : `pins:${home}`;
          setMenu({
            x,
            y,
            items: [...noteMenuItems(n), ...sectionMoveItems(lane, n.path), ...keyLane],
          });
        }
      } else {
        const n = notes.find((n) => n.path === target.path);
        if (n) {
          // The dashboard row's move lane is the scoped folder picker
          // (opened on this spot), not the palette's all-folders stage
          const items = noteMenuItems(n).map((it) =>
            it.label === "Move to folder…"
              ? { ...it, onSelect: () => setDashMovePicker({ path: target.path, x, y }) }
              : it
          );
          // The Move lane is the row's OWN surface — the Dashboards
          // section, or the folder tree row it nests under
          const treeFolder = dashTreeFolder(target.path, dashSplit.home);
          const lane: Section = treeFolder === null ? "dashboards" : `dashes:${treeFolder}`;
          setMenu({
            x,
            y,
            items: [...items, ...sectionMoveItems(lane, target.path), ...keyLane],
          });
        }
      }
    },
    [
      notes,
      folderMenuItems,
      dbMenuItems,
      savedViewMenuItems,
      noteMenuItems,
      sectionMoveItems,
      keyMenuItems,
      dashPaths,
      dashSplit,
      tagFolders,
      deleteTagFolder,
    ]
  );

  /** Receipts (spec §6): the fact a peek is open on, anchored at its chip
      or cell. App owns it because a receipt row is a door into the scrubber,
      which is App's to open — and because chips and db cells reach the same
      surface. */
  const [receipts, setReceipts] = useState<{ path: string; key: string; anchor: AnchorRect } | null>(
    null
  );
  /** the peek's "Open note history" door — the pane owns that panel, so App
      names the note and bumps a nonce */
  const [historyFor, setHistoryFor] = useState<{ path: string; nonce: number } | null>(null);
  const historyNonce = useRef(0);

  /** Deep Recall is opt-in per vault per device, so the search pane cannot
      assume an index exists. Re-read on vault change and whenever Settings
      closes — that pane is where the switch is thrown. */
  const [recallEnabled, setRecallEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    recallStatus()
      .then((status) => {
        if (live) setRecallEnabled(status.enabled);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vaultEpoch, settingsOpen]);

  /** a receipt row was clicked: scrub the vault to that snapshot (§6) */
  const scrubToCommit = useCallback(
    async (commit: string) => {
      setReceipts(null);
      await openTimeTravel();
      await selectTimePoint(commit);
    },
    [openTimeTravel, selectTimePoint]
  );

  /** a Deep Recall result was clicked: put the whole vault back at the
      snapshot that version lived in, and select the note there. The past is
      read as it stood, not as a diff — which is what the scrubber already
      does for receipts. */
  const openPastVersion = useCallback(
    async (path: string, commit: string) => {
      await scrubToCommit(commit);
      setView({ kind: "all" });
      setSelected(path);
      showMobileDetail();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrubToCommit, showMobileDetail, setSelected]
  );

  const onRowMenu = useCallback(
    (path: string, x: number, y: number) => {
      const n = notes.find((n) => n.path === path);
      if (n) setMenu({ x, y, items: noteMenuItems(n) });
    },
    [notes, noteMenuItems]
  );

  /** Right-click on a database cell: the row's own actions, with the cell's
      receipts on top — a cell IS a (note, key) fact, and this is its only
      pointer-and-keyboard reachable door (receipts spec §6). */
  const onCellMenu = useCallback(
    (path: string, key: string, x: number, y: number) => {
      const n = notes.find((n) => n.path === path);
      if (!n) return;
      const rows = noteMenuItems(n).map((item, i) =>
        i === 0 ? { ...item, separatorAbove: true } : item
      );
      setMenu({
        x,
        y,
        items: [
          {
            label: "Receipts",
            icon: <ClockIcon />,
            onSelect: () => setReceipts({ path, key, anchor: { left: x, top: y, bottom: y } }),
          },
          ...rows,
        ],
      });
    },
    [notes, noteMenuItems]
  );

  const closePalette = useCallback(() => {
    setOverlay(null);
    setPaletteStart(null);
  }, []);

  // ⌘D journal: get-or-create the day's note and land in the editor. Like
  // TrashPane's restore, the fresh meta is seeded into state synchronously so
  // the selection effect doesn't snap back before the async refresh lands.
  const openJournal = useCallback(
    (date: string) => {
      const path = dailyPath(date);
      // journal opens its own folder view, from anywhere. Select
      // directly rather than via openNote: that closes over the pre-switch
      // view, and its not-in-view fallback would bounce back to All notes
      if (view.kind !== "folder" || view.path !== JOURNAL_DIR) {
        setView({ kind: "folder", path: JOURNAL_DIR });
      }
      if (notes.some((n) => n.path === path)) {
        setGhostPath(null);
        setSelected(path);
        showMobileDetail();
        return;
      }
      // Only ⌘D-today creates a file up front. Any other missing day
      // opens as a ghost — the dated surface without a file; NotePane creates
      // it on the first keystroke, so stepping through days leaves no litter
      if (date !== todayIso()) {
        setGhostPath(path);
        setSelected(path);
        showMobileDetail();
        focusSoon(() => editorFocusRef.current?.());
        return;
      }
      vaultCreate(date, JOURNAL_DIR)
        .then((meta) => {
          setGhostPath(null);
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          setSelected(meta.path);
          showMobileDetail();
          refresh();
          focusSoon(() => editorFocusRef.current?.());
        })
        .catch(console.error);
    },
    [notes, view, refresh, showMobileDetail]
  );

  // born from context: a database's home folder births that
  // database's entries, any other folder a scratch note in place. ONE closure
  // shared by ⌘N's folder branch and the header "+" — not two
  // lookalike forks that could drift apart. In the Journal, "new" means
  // today's daily (product call): one entry per day is the folder's
  // whole metaphor, so a loose Untitled beside the dailies is never the wish.
  const newInFolder = useCallback(() => {
    // Inside a tag folder there is no folder to be born into — the
    // note lands in Inbox like any scratch and wears the folder's tags, which
    // is what puts it in view
    if (view.kind === "tagfolder") {
      const folder = tagFolders.find((f) => f.id === view.id);
      if (!folder) return;
      return createScratch("Inbox", tagFolderApplyTags(folder));
    }
    if (view.kind !== "folder") return;
    if (view.path === JOURNAL_DIR) return openJournal(todayIso());
    const homeDb = homeDbByFolder[view.path];
    if (homeDb) createTyped("Untitled", homeDb, "title");
    else createScratch(view.path);
  }, [view, tagFolders, homeDbByFolder, createTyped, createScratch, openJournal]);

  // ⌘N's contextual dispatch, shared with the background menus:
  // inside a database, calendar, or folder view, "new" means a new entry
  // here, not Inbox capture; inside Notes it's an instant scratch.
  const createHere = useCallback(() => {
    if ((view.kind === "db" || view.kind === "saved") && !overlay) setDbNewSeq((s) => s + 1);
    else if (view.kind === "calendar" && !overlay) setCalNewSeq((s) => s + 1);
    else if (view.kind === "notes" && !overlay) createScratch();
    else if ((view.kind === "folder" || view.kind === "tagfolder") && !overlay) newInFolder();
    else setOverlay("capture");
  }, [view, overlay, createScratch, newInFolder]);

  // Right-click on the list pane's empty space — create where you
  // are. "New note" is newInFolder's fork (typed entry in a home-db folder,
  // today's daily in the Journal, scratch elsewhere); the folder lanes only
  // appear where there is a folder to act on.
  const onListBgMenu = useCallback(
    (x: number, y: number) => {
      const folder = view.kind === "folder" ? view.path : null;
      const items: MenuItem[] = [
        {
          label: "New note",
          icon: <NoteIcon />,
          hint: "⌘N",
          onSelect: () => {
            // a tag folder has no path, but it does have a create rule
            // newInFolder owns both forks
            if (folder || view.kind === "tagfolder") newInFolder();
            else createScratch();
          },
        },
        {
          label: folder ? "New subfolder…" : "New folder…",
          icon: <PlusIcon />,
          onSelect: () => setFolderEdit({ kind: "create", parent: folder ?? "" }),
        },
        ...(folder
          ? [
              {
                label: "Reveal in Finder",
                icon: <FolderIcon />,
                onSelect: () => revealRel(folder),
              },
            ]
          : []),
      ];
      setMenu({ x, y, items });
    },
    [view, newInFolder, createScratch, revealRel]
  );

  // A ghost daily's first keystroke created the file — seed the meta
  // synchronously (selection-effect trick as above) and drop ghost mode. The
  // path doesn't change, so selection stays put by itself; a debounced create
  // landing after the user stepped on must NOT yank them back, hence no
  // setSelected here
  const adoptGhost = useCallback(
    (meta: NoteMeta) => {
      setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
      setGhostPath((g) => (g === meta.path ? null : g));
      refresh();
    },
    [refresh]
  );

  const {
    searchQuery,
    setSearchQuery,
    searchReturn,
    searchRestore,
    setSearchRestore,
    reveal,
    setReveal,
    preSearchView,
    openSearch,
    closeSearch,
    openSearchHit,
    returnToSearch,
    onNoteEscape,
  } = useSearch({
    notes,
    view,
    selected,
    dbNote,
    setView,
    setSelected,
    setDbNote,
    showMobileDetail,
    abandonScratch,
    openMountHit,
  });

  // land a followed `#anchor` on its heading. The note is open by
  // now, so reading it is cheap and gives us the line the reveal channel
  // wants — the same channel a search hit uses, so the heading flashes the
  // way a hit does. An anchor no heading answers to leaves the note at the
  // top rather than jumping somewhere arbitrary.
  useEffect(() => {
    if (!pendingAnchor) return;
    const { path, anchor } = pendingAnchor;
    let live = true;
    vaultRead(path)
      .then((note) => {
        if (!live) return;
        // body only — reveal lines are editor coordinates, frontmatter excluded
        const line = anchorLine(note.body, anchor);
        if (line) setReveal((r) => ({ path, line, nonce: (r?.nonce ?? 0) + 1 }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setPendingAnchor(null);
      });
    return () => {
      live = false;
    };
  }, [pendingAnchor, setReveal]);

  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      // walk the listed rows — db blocks are click-through only
      const rows = viewRows.loose;
      if (rows.length === 0) return;
      const idx = rows.findIndex((n) => n.path === selected);
      const next = idx === -1 ? 0 : Math.min(Math.max(idx + dir, 0), rows.length - 1);
      setSelected(rows[next].path);
    },
    [viewRows, selected]
  );

  // Linear view history — plain ⌫ (or ⌘[) walks back through visited
  // views (see useViewHistory)
  const { viewHistory, goBack } = useViewHistory({
    view,
    viewKeyNow,
    selected,
    dbNote,
    preSearchView,
    dbNoteCarryRef: dbNoteCarry,
    setView,
    setSelected,
    setDbNote,
  });

  useEffect(() => {
    if (overlay) {
      setShortcutsOpen(false);
      setSettingsOpen(false);
    }
  }, [overlay]);

  /* One undo move and one redo move, shared by the keystrokes and
     the palette rows below. The palette is the mouse path to ⌘Z — the toast
     that carries an Undo button is gone after 4s, and until now the keystroke
     was the only way back after that. Sharing the callback rather than
     re-deriving the entry per surface keeps click and keystroke on the
     identical operation. */
  const runUndo = useCallback(() => {
    const live = undoStack.peekUndo(undoStateRef.current);
    if (live) return void runUndoEntry(live, -1);
    // nothing live left, but a stale entry explains why: say it rather than
    // no-op in silence (docs/undo.md §3.3)
    const stale = undoStack.peekStale(undoStateRef.current);
    if (stale) showToast(`Can’t undo ${stale.label} — it changed on disk`);
  }, [runUndoEntry, showToast, undoStateRef]);
  const runRedo = useCallback(
    () => void runUndoEntry(undoStack.peekRedo(undoStateRef.current), 1),
    [runUndoEntry, undoStateRef]
  );
  // the row's label names the move it would make ("Undo Role → booking"), so
  // it reads the same as the toast that announced it
  const undoCommand = useMemo(() => {
    const e = undoStack.peekUndo(undoState);
    return e ? { label: e.label, run: runUndo } : null;
  }, [undoState, runUndo]);
  const redoCommand = useMemo(() => {
    const e = undoStack.peekRedo(undoState);
    return e ? { label: e.label, run: runRedo } : null;
  }, [undoState, runRedo]);

  useShortcutRouter({
    view,
    setView,
    selected,
    selectedMeta,
    overlay,
    setOverlay,
    shortcutsOpen,
    setShortcutsOpen,
    settingsOpen,
    setSettingsOpen,
    dbNote,
    setDbNote,
    ghostPath,
    mobile,
    setMobileSidebarOpen,
    toggleSidebar,
    toggleTerminal,
    moveSelection,
    openNote,
    openSearch,
    closeSearch,
    openJournal,
    createHere,
    trashNote,
    goBack,
    viewHistory,
    searchReturn,
    returnToSearch,
    pinIds,
    customKeys,
    sheetOpen,
    workbookOpen,
    dashUndo,
    pageStepRef,
    editorFocusRef,
    undoStateRef,
    runUndo,
    runRedo,
    zoom,
    applyZoom,
  });

  /* A folder is queued in the mini-player. Drives the bar's own
     mount, the shell's reserved height (the bar is chrome WITH height, like
     the time-travel banner — never a float over the panes), and the liveness
     of the transport chords. */
  const playing = useSyncExternalStore(subscribeQueue, getQueue) !== null;

  /* The print action of whatever surface is on screen, or null where nothing
     prints — the mounted Print button registers it, so the palette's row and
     the button appear on exactly the same dashboards. */
  const printable = useSyncExternalStore(subscribePrintable, getPrintable);

  /* The hold HUD's context. The dispatcher above builds its ctx per
     keydown, which the HUD can't reuse — a held modifier is a state, not an
     event. `typing` is deliberately absent: it is knowable only at the
     moment the hold arms, so KeyHints samples the live focus itself rather than
     take a value this memo would serve stale. Overlays suppress the HUD
     outright, so anything they'd add is moot. */
  /* The header chevron's supply. The availability expression is the
     ⌫ shortcut's, verbatim including the search exclusion (SearchPane owns Esc
     and its own close), so the key and the click can never disagree about
     whether there is anywhere to go back to. Computed in render rather than
     memoized: viewHistory is a ref, and a memo would serve the depth from
     before the navigation that just happened. */
  const navApi = {
    canGoBack:
      view.kind !== "search" &&
      (viewHistory.current.length > 0 ||
        ((view.kind === "db" || view.kind === "saved") && dbNote !== null)),
    goBack,
  };

  const hudCtx: HoldHudCtx = useMemo(
    () => ({
      view,
      overlay,
      shortcutsOpen,
      settingsOpen,
      selectedMeta,
      dbNote,
      daily: selectedMeta ? dailyDateOf(selectedMeta.path) : null,
      pins: pinIds,
      searchReturn: false,
      canGoBack:
        viewHistory.current.length > 0 ||
        ((view.kind === "db" || view.kind === "saved") && dbNote !== null),
      sheetOpen,
      workbookOpen,
      customKeys,
      // Observable, not a ref read: mounts and history mutations happen below
      // App, so both must invalidate this memo to keep ownership and hints live.
      dashCanUndo,
      dashCanRedo,
      // the state itself, not the ref: the HUD is rendered output, so it has to
      // re-derive when a write lands or ⌘Z empties the stack
      canUndo: undoStack.peekUndo(undoState) !== null,
      canRedo: undoStack.peekRedo(undoState) !== null,
      playing,
    }),
    [view, overlay, shortcutsOpen, settingsOpen, selectedMeta, dbNote, pinIds, sheetOpen, workbookOpen, customKeys, dashCanUndo, dashCanRedo, undoState, playing]
  );

  const mobileDetailActive =
    mobile &&
    (((view.kind === "db" || view.kind === "saved") && dbNoteMeta !== null) ||
      (mobilePane === "detail" && selectedMeta !== null));

  /* Sidebar and ListPane are memoized, so every callback they take
     has to keep its identity across an unrelated App render — an inline arrow
     in the JSX is a new function each time and defeats the memo outright.
     These wrap the handlers that were inline; the rest are already useCallback
     or plain setState identities. */
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  const onSidebarOpenNote = useCallback(
    (p: string) => {
      setMobileSidebarOpen(false);
      openNote(p);
    },
    [openNote]
  );
  const onSidebarPinNote = useCallback((p: string) => setPinned(p, true), [setPinned]);
  const onSidebarRenameCancel = useCallback(() => {
    setRenaming(null);
    setRenamingViewId(null);
  }, []);
  const onSidebarDropNote = useCallback(
    (p: string, f: string, pinnable: boolean) => {
      // A PLAIN note dropped on the folder it already lives in has
      // nowhere to move — the gesture means "give it a sidebar row here", so
      // it pins (a drop on a FOREIGN folder row still moves the file; the
      // engine retargets any existing pin to the new path). `pinnable` is
      // false for sidebar row gestures (dashboard/pin reorders carry
      // SIDE_DRAG_MIME): a dashboard dropped on its own group header must
      // stay a no-op, or it pins into the flat section and renders twice —
      // Finding 1 (Opus review of this branch caught the reopening).
      const folder = p.slice(0, Math.max(0, p.lastIndexOf("/")));
      if (folder === f) {
        if (pinnable) setPinned(p, true);
        return;
      }
      moveNote(p, f).catch((e) => showToast(errText(e)));
    },
    [moveNote, setPinned, showToast]
  );
  const onSidebarDropDb = useCallback(
    (type: string, folder: string) => {
      // a database dropped on its own home row is a quiet no-op
      if (typeHome(typeSchemaFor(schema, type)) === folder) return;
      setDbHome(type, folder);
    },
    [schema, setDbHome]
  );
  const onSidebarJournal = useCallback(() => {
    setMobileSidebarOpen(false);
    openJournal(todayIso());
  }, [openJournal]);
  const onSidebarSearch = useCallback(() => {
    setMobileSidebarOpen(false);
    openSearch();
  }, [openSearch]);
  const onSidebarCapture = useCallback(() => {
    setMobileSidebarOpen(false);
    setOverlay("capture");
  }, []);
  const onSidebarAssignKey = useCallback(
    (token: string, target: string) => writeKeys((cur) => assignKey(cur, token, target)),
    [writeKeys]
  );
  // Grouped into one memo rather than passed inline — a fresh object
  // literal per render is a changed prop, and the memo below would reconcile
  // the whole sidebar on every unrelated App render.
  const sidebarKeyAssign = useMemo(
    () => ({ active: keyAssignOpen, keys: customKeys, onAssign: onSidebarAssignKey }),
    [keyAssignOpen, customKeys, onSidebarAssignKey]
  );

  const onListOpenDb = openDatabase;
  const onListSelect = useCallback(
    (path: string) => {
      setSelected(path);
      showMobileDetail();
    },
    [showMobileDetail]
  );
  const onListRenameCancel = useCallback(() => setRenaming(null), []);
  // the header mirrors the sidebar row: explicit icon first,
  // then the curated name default. Memoized because a fresh object literal is
  // a prop change to a memoized ListPane on every render.
  const listFolderIcon = useMemo(
    () =>
      view.kind === "folder"
        ? folderMeta[view.path]?.icon ?? folderDefaultIcon(view.path.split("/").pop() ?? "")
        : undefined,
    [view, folderMeta]
  );
  const onListActivate = useCallback(() => {
    focusSoon(() => editorFocusRef.current?.());
  }, []);

  /* ----- a folder's loose files, and the listening queue -----

     The vault index is `.md`-only by design, so non-note files come from a
     lazy per-folder call made when a folder view opens — never from the scan.
     Nothing is cached across folders: the fetch is one `read_dir`, and
     holding stale listings would only produce rows for files that moved. */
  const folderPath = view.kind === "folder" ? view.path : null;
  const [folderFiles, setFolderFiles] = useState<FolderListing>({ files: [], total: 0 });
  useEffect(() => {
    if (folderPath === null) {
      setFolderFiles({ files: [], total: 0 });
      return;
    }
    let live = true;
    vaultFolderFiles(folderPath)
      .then((listing) => {
        if (!live) return;
        setFolderFiles(listing);
        // a file added or removed under a playing queue re-seats it without
        // changing what is playing; a queue whose file vanished is dropped
        syncQueue(
          folderPath,
          playableFiles(listing.files).map((f) => ({ key: f.path, rel: f.rel, name: f.name }))
        );
      })
      .catch(() => {
        // a folder that can't be read lists no files — the notes still show,
        // which is exactly the pre-change pane rather than an error state
        if (live) setFolderFiles({ files: [], total: 0 });
      });
    return () => {
      live = false;
    };
  }, [folderPath, vaultEpoch]);

  /* Pressing play on a file row seats the queue on THIS folder's playable
     files, at that file — the row's own AudioPropButton does the playing, so
     a second press on the same row still just pauses it. */
  const onPlayFile = useCallback(
    (rel: string) => {
      if (folderPath === null) return;
      const tracks = playableFiles(folderFiles.files).map((f) => ({
        key: f.path,
        rel: f.rel,
        name: f.name,
      }));
      const at = tracks.findIndex((t) => t.rel === rel);
      if (at !== -1) startQueue(folderPath, tracks, at);
    },
    [folderPath, folderFiles]
  );
  /* ----- blind comparison -----

     A session compares two versions with the labels hidden, and lands its
     verdict on a note as plain markdown. Launched from a note (its audio
     props) or from a folder (its audio files); a folder has no note of its
     own, so one in that folder adopts the log — the note named after the
     folder if there is one, else the folder's most recently touched note,
     else a listening note made for the purpose. */

  const onOpenFile = useCallback(
    (path: string) => {
      fileOpen(path).catch((e) => showToast(errText(e)));
    },
    [showToast]
  );
  const onRevealFile = useCallback(
    (path: string) => {
      fileReveal(path).catch((e) => showToast(errText(e)));
    },
    [showToast]
  );

  // NotePane is memoized too, so its inline prop needs stable identity.
  const clearReveal = useCallback(() => setReveal(null), []);

  // Stable identity — Sidebar is memoized, and a fresh function here
  // would re-render it on every App state change.
  const navigateFromMobileChrome = useCallback((next: View) => {
    setView(next);
    setDbNote(null);
    setMobilePane("list");
    setMobileSidebarOpen(false);
  }, []);

  /* The everywhere palette jumped to a destination. Same door the sidebar
     and the ⌘K palette use, so a chord-driven jump lands exactly where a
     click would — including the mobile chrome the door resets. */
  useEffect(() => {
    openViewRef.current = navigateFromMobileChrome;
  }, [navigateFromMobileChrome, openViewRef]);

  const closeMobileDetail = () => {
    if (dbNoteMeta) {
      setDbNote(null);
      setMobilePane("list");
      return;
    }
    if (
      searchReturn &&
      searchReturn.note === selected &&
      viewKey(searchReturn.view) === viewKey(view)
    ) {
      returnToSearch(searchReturn);
    }
    setMobilePane("list");
  };

  const onMobilePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!mobileDetailActive || e.pointerType !== "touch" || e.clientX > 28) return;
    mobileSwipeStart.current = { x: e.clientX, y: e.clientY };
  };
  const onMobilePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = mobileSwipeStart.current;
    mobileSwipeStart.current = null;
    if (!start || e.pointerType !== "touch") return;
    if (e.clientX - start.x >= 72 && Math.abs(e.clientY - start.y) <= 48) {
      closeMobileDetail();
    }
  };

  return (
    <UndoContext.Provider value={undoApi}>
    <NavContext.Provider value={navApi}>
    <div
      className={`app${mobile ? " mobile" : ""}${timeTravelOpen ? " time-travel-open" : ""}${timePoint ? " viewing-past" : ""}${playing ? " has-player" : ""}`}
      onPointerDown={onMobilePointerDown}
      onPointerUp={onMobilePointerUp}
      onPointerCancel={() => {
        mobileSwipeStart.current = null;
      }}
      onBeforeInputCapture={(event) => {
        if (timePoint) event.preventDefault();
      }}
      onPasteCapture={(event) => {
        if (timePoint) event.preventDefault();
      }}
      onDropCapture={(event) => {
        if (timePoint) event.preventDefault();
      }}
      // Bare chrome answers right-click with the minimal app menu
      // instead of the webview's stock "Reload" — anything a deeper surface
      // didn't claim (those preventDefault first). The native menu survives
      // everywhere it still does a job: text fields and the editor
      // (spellcheck, system copy/paste), the terminal, images and links
      // (Save/Copy image, Copy link), and any live text selection (Copy is
      // the only way to lift text off a rendered surface).
      onContextMenu={(e) => {
        if (e.defaultPrevented) return;
        const t = e.target as HTMLElement | null;
        // .cm-editor, not isTyping's .cm-content: the margin below the last
        // line is part of the editor surface but outside the contenteditable
        if (isTyping(t) || t?.closest(`.cm-editor, .termhud, img, a[href], ${MENU_SURFACES}`)) return;
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        // a live text edit anywhere (inline rename, a draft row): the menu's
        // focus steal would blur-commit it — stand down entirely
        if (isTypingNow()) return;
        e.preventDefault();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "New note", icon: <NoteIcon />, hint: "⌘N", onSelect: createHere },
            { label: "Search", hint: "⌘⇧F", onSelect: () => openSearch() },
            { label: "Today’s journal", hint: "⌘D", onSelect: () => openJournal(todayIso()) },
          ],
        });
      }}
    >
      <div className="titlebar-drag" data-tauri-drag-region />
      {timeTravelOpen && (
        <TimeTravelBar
          points={timePoints}
          active={timePoint}
          busy={timeBusy}
          error={timeError}
          note={
            timePoint && selectedMeta && notes.some((note) => note.path === selectedMeta.path)
              ? selectedMeta
              : null
          }
          onSelect={selectTimePoint}
          onRestore={restoreFromTime}
          onPresent={returnToPresent}
          onClose={() => {
            setTimeTravelOpen(false);
            setTimeError(null);
          }}
        />
      )}
      {mobile && (
        <div className="mobile-nav" aria-label="Mobile navigation">
          {mobileDetailActive ? (
            <button className="mobile-nav-button mobile-back" onClick={closeMobileDetail}>
              <ChevronLeftIcon />
              <span>Back</span>
            </button>
          ) : (
            <button
              className="mobile-nav-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <MenuIcon />
            </button>
          )}
        </div>
      )}
      {mobile && mobileSidebarOpen && (
        <button
          className="mobile-sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      {!mobile && sidebarHidden && (
        <div className="sidebar-rail">
          <div className="sidebar-drag" data-tauri-drag-region />
          <button
            className="sidebar-new"
            onClick={toggleSidebar}
            title="Show sidebar (⌘\)"
            aria-label="Show sidebar"
          >
            <SidebarIcon />
          </button>
          <InfoView view={view} />
        </div>
      )}
      {(mobile || !sidebarHidden) && (
      <Sidebar
        view={view}
        setView={navigateFromMobileChrome}
        mobile={mobile}
        mobileOpen={mobileSidebarOpen}
        onToggleHidden={toggleSidebar}
        onMobileClose={closeMobileSidebar}
        scratchCount={scratchCount}
        drives={drives}
        collapsedIds={collapsedIds}
        onToggleCollapse={toggleCollapsed}
        icons={dbIcons}
        homeDbByFolder={homeDbByFolder}
        mountDbs={mountDbNames}
        onOpenDb={openDatabase}
        dashboards={mobileDashboards}
        dashPaths={dashPaths}
        pinned={pinnedNotes}
        onOpenNote={onSidebarOpenNote}
        selectedPath={selected}
        onPinNote={onSidebarPinNote}
        {...ledgerSidebarProps}
        savedViews={savedViews}
        folders={folders}
        folderOrder={sidebarFolderOrder}
        dashGroupOrder={sidebarDashGroupOrder}
        folderMeta={folderMeta}
        tagFolders={tagFolders}
        onTagFolderEdit={onTagFolderEdit}
        onDropNoteTagFolder={onDropNoteTagFolder}
        renaming={renaming}
        onRenameNote={renameNote}
        onRenameCancel={onSidebarRenameCancel}
        renamingView={renamingViewId}
        onRenameView={renameView}
        folderEdit={folderEdit}
        onFolderEditChange={setFolderEdit}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onMoveFolder={moveFolder}
        onDropNote={onSidebarDropNote}
        onDropDb={onSidebarDropDb}
        onAddMenu={folderAddMenu}
        onReorderSection={setSectionOrder}
        onContextMenu={onSidebarMenu}
        journalActive={view.kind === "folder" && view.path === JOURNAL_DIR}
        onJournal={onSidebarJournal}
        onOpenSearch={onSidebarSearch}
        onCapture={onSidebarCapture}
        keyAssign={sidebarKeyAssign}
        // same path as the ⌘, shortcut: any open overlay steps aside first
        onOpenSettings={() => {
          setOverlay(null);
          setSettingsOpen(true);
        }}
        onOpenTimeTravel={openTimeTravel}
        viewingPast={timePoint !== null}
      />
      )}
      {bootError && (
        <div className="boot-error" role="alert">
          <span className="err-dot" />
          Vault couldn’t be read: {bootError}
        </div>
      )}
      {view.kind === "search" ? (
        <div className="main">
          <SearchPane
            notes={notes}
            // a hit inside a mounted file names no note — its mount is what
            // makes it renderable
            mounts={mounts}
            excludeAppFiles={!showAppFiles}
            query={searchQuery}
            setQuery={setSearchQuery}
            onOpenMatch={openSearchHit}
            onClose={closeSearch}
            restoreSel={searchRestore}
            onRestoredSel={() => setSearchRestore(null)}
            onRowContextMenu={onRowMenu}
            recallEnabled={recallEnabled}
            onOpenPast={openPastVersion}
          />
        </div>
      ) : view.kind === "trash" ? (
        <div className="main">
          <TrashPane
            vaultEpoch={vaultEpoch}
            onRestored={(m) => {
              // seed the restored note into state before the async refresh so
              // the selection effect finds it and keeps it selected
              setNotes((ns) => [...ns.filter((n) => n.path !== m.path), m]);
              setView({ kind: "all" });
              setSelected(m.path);
              showMobileDetail();
              refresh();
            }}
            onRestoredFolder={(path) => {
              setView({ kind: "folder", path });
              setMobilePane("list");
              refresh();
            }}
          />
        </div>
      ) : view.kind === "vaultsync" ? (
        <div className="main">
          <VaultSyncPane autoSync={autoSync} onAutoSyncChange={setAutoSync} />
        </div>
      ) : view.kind === "changelog" ? (
        <div className="main">
          <ChangelogPane
          />
        </div>
      ) : view.kind === "cookbook" ? (
        <div className="main">
          <CookbookPane
            onOpenNote={(path) => {
              // the install just wrote it, so the index doesn't carry it yet.
              // Select only once the refreshed list holds it, or the
              // selection-guard snaps straight back to the old top row. "all"
              // is the one view guaranteed to contain it whatever folder it
              // went to.
              setView({ kind: "all" });
              refresh().then(() => {
                setSelected(path);
                showMobileDetail();
              });
            }}
          />
        </div>
      ) : view.kind === "assets" ? (
        <div className="main">
          <AssetsPane vaultEpoch={vaultEpoch} />
        </div>
      ) : view.kind === "shelf" || view.kind === "drive" ? (
        <div className="main">
          {/* One pane for both: a drive's catalog is the shelf zoomed in, and
              splitting them would double the staleness copy that is the whole
              point of the surface. */}
          <ShelfPane view={view} setView={setView} vaultEpoch={vaultEpoch} />
        </div>
      ) : view.kind === "doctor" ? (
        <div className="main">
          <DoctorPane
            vaultEpoch={vaultEpoch}
            onOpenNote={(path) => {
              // leave the report to show the note itself — "all" is the one
              // view guaranteed to contain it whatever folder it lives in
              setView({ kind: "all" });
              setSelected(path);
              showMobileDetail();
            }}
          />
        </div>
      ) : view.kind === "dbmanager" ? (
        <div className="main">
          <DbManagerPane
            databases={databases}
            icons={dbIcons}
            schema={schema}
            onOpen={openDatabase}
            onRowMenu={dbManagerMenu}
            onNewDatabase={() => setDbDialog({ kind: "create" })}
          />
        </div>
      ) : view.kind === "dashboard" && dashMeta ? (
        <div className="main">
          <DashboardPane
            meta={dashMeta}
            notes={notes}
            vaultEpoch={vaultEpoch}
            schema={schema}
            savedViews={savedViews}
            onOpenSource={openNote}
            onMutated={refresh}
            onFollowLink={followLink}
            onOpenView={openEmbedView}
            onToast={showToast}
            onCreateEntry={createEntry}
            pageStepRef={pageStepRef}
            dashUndo={dashUndo}
            taskStaleChips={taskStaleChips}
            embedEdit={embedEdit}
          />
        </div>
      ) : view.kind === "today" ? (
        <div className="main">
          <TodayPane
            notes={notes}
            schema={schema}
            icons={dbIcons}
            onOpenNote={openNote}
            onOpenJournal={() => openJournal(todayIso())}
            onMutated={refresh}
            onToast={showToast}
            onRowContextMenu={onRowMenu}
          />
        </div>
      ) : view.kind === "calendar" ? (
        <div className="main">
          <CalendarPane
            notes={notes}
            schema={schema}
            newSignal={calNewSeq}
            onOpenNote={openNote}
            onMutated={refresh}
            onTrashNote={trashNote}
            onToast={showToast}
            onRenameNote={renameNote}
            onOpenJournal={openJournal}
          />
        </div>
      ) : view.kind === "mount" ? (
        <div className="main">
          {activeMount ? (
            // A mounted folder is a database whose rows are files.
            // Same pane, same layouts, same views — the only differences are
            // where the rows come from (the mount's index, not the note list),
            // where a cell write lands (`mount_annotate`), and the banner that
            // appears when the folder isn't reachable from this machine.
            <div className="db-mount">
              {mountStatus(activeMount) && (
                <div className="mount-banner">
                  <span>{mountStatus(activeMount)}</span>
                  <button className="mount-locate" onClick={() => locateMount(activeMount)}>
                    Locate folder…
                  </button>
                </div>
              )}
              <DatabasePane
                key={view.id}
                dbType={activeMount.name}
                notes={mountNotes}
                allNotes={notes}
                schema={schema}
                pref={byFoldedKey(viewsConfig, activeMount.name)}
                typeSchema={typeSchemaFor(schema, activeMount.name) ?? {}}
                icon={iconForType(dbIcons, activeMount.name)}
                onSaveIcon={(ic) => saveSchemaIcon(activeMount.name, ic)}
                usedValues={(key) => usedValues(activeMount.name, key)}
                onSaveSchema={(prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review) => saveSchemaProp(activeMount.name, prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review)}
                onPromoteOption={(prop, add, writeValue) => promoteSchemaOption(activeMount.name, prop, add, writeValue)}
                relationCandidates={relCandidates}
                onCreateEntry={createEntry}
                dbTypes={dbTypes}
                // the row a search hit arrived on — marked as the
                // open one, and revealed (scrolled to, focused) once the
                // board's rows are in
                openPath={
                  mountReveal?.path ??
                  (mountOpen?.id === activeMount.id ? mountOpen.path : null)
                }
                reveal={mountReveal}
                newSignal={0}
                exportRef={dbExportRef}
                gridDefault={dbGrid}
                onPrefChange={(p) => setDbPref(activeMount.name, p)}
                // a row IS a file: opening one opens the file, and its cell
                // writes go through the mount's own annotate path
                onOpenNote={openMountRow}
                onNoteMenu={mountRowMenu}
                writeProp={mountWriteProp}
                // rows are the folder's contents — nothing here trashes a file
                onTrashNotes={() => showToast("A mounted folder's files are only ever read")}
                onMutated={refresh}
                onSaveView={(name, capture) => saveView(activeMount.name, name, capture)}
                savedViews={savedViews.filter(
                  (v) => v.db.toLowerCase() === activeMount.name.toLowerCase()
                )}
                pinKeys={mobile ? {} : pinKeys}
                onOpenView={(id) => setView({ kind: "saved", id })}
                onViewMenu={(id, x, y) => setMenu({ x, y, items: savedViewMenuItems(id) })}
                onRenameDb={() => setDbDialog({ kind: "rename-db", dbType: activeMount.name })}
                onDeleteDb={() => setDbDialog({ kind: "delete-db", dbType: activeMount.name })}
                onRenameProp={(prop) =>
                  setDbDialog({ kind: "rename-prop", dbType: activeMount.name, prop })
                }
                onRemoveProp={(prop) => removeProperty(activeMount.name, prop)}
                onSetParentProp={(prop) => setDbParentProp(activeMount.name, prop)}
                onToast={showToast}
              />
            </div>
          ) : (
            <div className="db">
              {/* No verb here yet: remounting is the Databases pane's verb, not
                  one this pane can run — glyph + text until copy work lands. */}
              <EmptyState
                icon={<MountIcon />}
                title="Mounted folder not found"
                hint="It may have been unmounted in another window"
              />
            </div>
          )}
        </div>
      ) : view.kind === "db" || view.kind === "saved" ? (
        <div className={`main${mobile && dbNoteMeta ? " mobile-detail" : ""}`}>
          {view.kind === "db" ? (
            <DatabasePane
              key={view.type}
              dbType={view.type}
              notes={viewNotes}
              allNotes={notes}
              schema={schema}
              pref={byFoldedKey(viewsConfig, view.type)}
              typeSchema={typeSchemaFor(schema, view.type) ?? {}}
              icon={iconForType(dbIcons, view.type)}
              onSaveIcon={(ic) => saveSchemaIcon(view.type, ic)}
              usedValues={(key) => usedValues(view.type, key)}
              onSaveSchema={(prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review) => saveSchemaProp(view.type, prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review)}
              onPromoteOption={(prop, add, writeValue) => promoteSchemaOption(view.type, prop, add, writeValue)}
              relationCandidates={relCandidates}
              onCreateEntry={createEntry}
              onRenameNote={renameNote}
              dbTypes={dbTypes}
              openPath={dbNote}
              newSignal={dbNewSeq}
              exportRef={dbExportRef}
              gridDefault={dbGrid}
              numberLocale={numberLocale}
              onPrefChange={(p) => setDbPref(view.type, p)}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
              onCellMenu={onCellMenu}
              onTrashNotes={trashNotes}
              onMutated={refresh}
              onSaveView={(name, capture) => saveView(view.type, name, capture)}
              savedViews={savedViews.filter((v) => v.db.toLowerCase() === view.type.toLowerCase())}
              // no keys on mobile — the tabs render there too, ⌘ digits don't
              pinKeys={mobile ? {} : pinKeys}
              onOpenView={(id) => setView({ kind: "saved", id })}
              onViewMenu={(id, x, y) => setMenu({ x, y, items: savedViewMenuItems(id) })}
              onRenameDb={() => setDbDialog({ kind: "rename-db", dbType: view.type })}
              onDeleteDb={() => setDbDialog({ kind: "delete-db", dbType: view.type })}
              onRenameProp={(prop) => setDbDialog({ kind: "rename-prop", dbType: view.type, prop })}
              onRemoveProp={(prop) => removeProperty(view.type, prop)}
              onSetParentProp={(prop) => setDbParentProp(view.type, prop)}
              onToast={showToast}
            />
          ) : activeSaved ? (
            <DatabasePane
              key={`sv:${activeSaved.id}`}
              dbType={activeSaved.db}
              notes={savedNotes}
              allNotes={notes}
              // A pin's pref is composed in ONE place (`savedViewPref`), the
              // same call a headless reader of the same pin makes: the pin's
              // own layout, grouping and sort over the database's, the
              // presentation keys no pin captures (aggregations, widths,
              // wrap, grid) following the database, and the database's
              // curation — hidden sets, dragged column order — staying out.
              // Until it is re-saved, `svPref` holds the session's edits.
              pref={svPref ?? savedViewPref(activeSaved, byFoldedKey(viewsConfig, activeSaved.db))}
              schema={schema}
              typeSchema={typeSchemaFor(schema, activeSaved.db) ?? {}}
              icon={iconForType(dbIcons, activeSaved.db)}
              onSaveIcon={(ic) => saveSchemaIcon(activeSaved.db, ic)}
              usedValues={(key) => usedValues(activeSaved.db, key)}
              onSaveSchema={(prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review) => saveSchemaProp(activeSaved.db, prop, opts, kind, notify, notifyBefore, target, format, description, rollup, review)}
              onPromoteOption={(prop, add, writeValue) => promoteSchemaOption(activeSaved.db, prop, add, writeValue)}
              relationCandidates={relCandidates}
              onCreateEntry={createEntry}
              onRenameNote={renameNote}
              dbTypes={dbTypes}
              openPath={dbNote}
              newSignal={dbNewSeq}
              exportRef={dbExportRef}
              gridDefault={dbGrid}
              numberLocale={numberLocale}
              onPrefChange={setSvPref}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
              onCellMenu={onCellMenu}
              onTrashNotes={trashNotes}
              onMutated={refresh}
              initialQuery={activeSaved.query}
              initialColumns={activeSaved.columns}
              onColumnsChange={(cols) => setViewColumns(activeSaved.id, cols)}
              saveViewSeed={activeSaved.name}
              onSaveView={(name, capture) => saveView(activeSaved.db, name, capture)}
              savedViews={savedViews.filter(
                (v) => v.db.toLowerCase() === activeSaved.db.toLowerCase()
              )}
              activeViewId={activeSaved.id}
              pinKeys={mobile ? {} : pinKeys}
              onOpenView={(id) => setView({ kind: "saved", id })}
              onViewMenu={(id, x, y) => setMenu({ x, y, items: savedViewMenuItems(id) })}
              onOpenDb={() => setView({ kind: "db", type: activeSaved.db })}
              onRenameDb={() => setDbDialog({ kind: "rename-db", dbType: activeSaved.db })}
              onDeleteDb={() => setDbDialog({ kind: "delete-db", dbType: activeSaved.db })}
              onRenameProp={(prop) =>
                setDbDialog({ kind: "rename-prop", dbType: activeSaved.db, prop })
              }
              onRemoveProp={(prop) => removeProperty(activeSaved.db, prop)}
              onSetParentProp={(prop) => setDbParentProp(activeSaved.db, prop)}
              onToast={showToast}
            />
          ) : (
            <div className="db">
              {/* No verb here yet: the pin is gone, and re-pinning happens on
                  the view it came from, so there is none to offer here. */}
              <EmptyState
                icon={<PinIcon />}
                title="Saved view not found"
                hint="The pin may have been removed outside the app"
              />
            </div>
          )}
          {dbNoteMeta && (
            <div className="db-note">
              <button className="db-note-x" onClick={() => setDbNote(null)} title="Close (Esc)">
                <XIcon />
              </button>
              <NotePane
                meta={dbNoteMeta}
                schema={schema}
                usedValues={usedValues}
                vaultEpoch={vaultEpoch}
                numberLocale={numberLocale}
                changedPaths={changedPaths}
                onSaveSchema={saveSchemaProp}
                onPromoteOption={promoteSchemaOption}
                relationCandidates={relCandidates}
                onCreateEntry={createEntry}
                dbTypes={dbTypes}
                dbTypesRecent={dbTypesRecent}
                onFollowLink={followLink}
                noteTitles={noteTitles}
                vaultNotes={notes}
                linkedNoteBody={linkedNoteBody}
                sheetTitles={sheetTitles}
                onOpenTag={openTag}
                tagUniverse={tagCounts}
                onOpenNote={openNote}
                embedQuery={embedQuery}
                onOpenView={openEmbedView}
                onEmbedSetProp={embedSetProp}
                onEmbedCreate={embedCreateEntry}
                onEmbedCreateRelation={embedCreateRelation}
                onRenamed={onRenamed}
                onRenameUndone={onRenameApplied}
                onMutated={refresh}
                onTrash={trashNote}
                onMoveToFolder={startMoveToFolder}
                onDuplicate={duplicateNote}
                onShare={setShare}
                onTogglePick={togglePickToday}
                onTogglePin={setPinned}
                pinned={pinnedPaths.includes(dbNoteMeta.path)}
                flushRef={flushOpenRef}
                onTyped={followTyped}
                onJournalDay={openJournal}
                editorFocusRef={editorFocusRef}
                savedViewPins={savedViewPins}
                dbPropNames={dbPropNames}
                onEscape={onNoteEscape}
                reveal={reveal}
                onRevealed={clearReveal}
                revealRow={sheetReveal}
                onRowRevealed={clearSheetReveal}
                onToast={showToast}
                readOnly={timePoint !== null}
                onReceipts={(key, anchor) =>
                  setReceipts({ path: dbNoteMeta.path, key, anchor })
                }
                openHistoryFor={historyFor}
              />
            </div>
          )}
        </div>
      ) : (
      <div className="main">
        {(!mobile || mobilePane === "list") && (
        <ListPane
          notes={viewRows.loose}
          blocks={viewRows.blocks}
          icons={dbIcons}
          onOpenDb={onListOpenDb}
          view={view}
          selected={selected}
          onSelect={onListSelect}
          renaming={renaming}
          onRenameNote={renameNote}
          onRenameCancel={onListRenameCancel}
          onRowContextMenu={onRowMenu}
          onBackgroundContextMenu={onListBgMenu}
          onActivate={onListActivate}
          {...ledgerListProps}
          folderIcon={listFolderIcon}
          onNewHere={newInFolder}
          onNewNote={createHere}
          tagFolders={tagFolders}
          mobile={mobile}
          files={folderFiles.files}
          fileTotal={folderFiles.total}
          onPlayFile={onPlayFile}
          onOpenFile={onOpenFile}
          onRevealFile={onRevealFile}
        />
        )}
        {(!mobile || mobilePane === "detail") && (selectedMeta ? (
          <NotePane
            meta={selectedMeta}
            schema={schema}
            usedValues={usedValues}
            vaultEpoch={vaultEpoch}
            numberLocale={numberLocale}
            changedPaths={changedPaths}
            onSaveSchema={saveSchemaProp}
            onPromoteOption={promoteSchemaOption}
            relationCandidates={relCandidates}
            onCreateEntry={createEntry}
            dbTypes={dbTypes}
            dbTypesRecent={dbTypesRecent}
            onFollowLink={followLink}
            noteTitles={noteTitles}
            vaultNotes={notes}
            linkedNoteBody={linkedNoteBody}
            sheetTitles={sheetTitles}
            onOpenTag={openTag}
            tagUniverse={tagCounts}
            onOpenNote={openNote}
            embedQuery={embedQuery}
            onOpenView={openEmbedView}
            onEmbedSetProp={embedSetProp}
            onEmbedCreate={embedCreateEntry}
            onEmbedCreateRelation={embedCreateRelation}
            onRenamed={onRenamed}
            onRenameUndone={onRenameApplied}
            onMutated={refresh}
            onTrash={trashNote}
            onMoveToFolder={startMoveToFolder}
            onDuplicate={duplicateNote}
            onShare={setShare}
            onTogglePick={togglePickToday}
            onTogglePin={setPinned}
            pinned={pinnedPaths.includes(selectedMeta.path)}
            flushRef={flushOpenRef}
            ghost={selectedMeta.path === ghostPath}
            onGhostCreated={adoptGhost}
            onTyped={followTyped}
            onJournalDay={openJournal}
            editorFocusRef={editorFocusRef}
            editorInsertRef={noteInsertRef}
            savedViewPins={savedViewPins}
            dbPropNames={dbPropNames}
            titleFocusRef={titleFocusRef}
            onEscape={onNoteEscape}
            reveal={reveal}
            onRevealed={clearReveal}
            revealRow={sheetReveal}
            onRowRevealed={clearSheetReveal}
            onToast={showToast}
            readOnly={timePoint !== null}
            onReceipts={(key, anchor) => setReceipts({ path: selectedMeta.path, key, anchor })}
            openHistoryFor={historyFor}
          />
        ) : (
          <div className="note">
            <EmptyState
              icon={<HeroNote />}
              title="No note selected"
              hint="⌘K to find something, ⌘N to capture"
              /* the ⌘K half of the hint, made clickable — same overlay the
                 shortcut opens, under the shortcut registry's own label */
              action={{ label: "Command palette", onClick: () => setOverlay("palette") }}
            />
          </div>
        ))}
      </div>
      )}
      {overlay && (
        <Palette
          mode={overlay}
          notes={notes}
          excludeAppFiles={!showAppFiles}
          databases={databases}
          icons={dbIcons}
          dashboards={mobileDashboards}
          folders={folders}
          savedViews={savedViews}
          tagFolders={tagFolders}
          tags={tagCounts}
          drives={drives}
          {...ledgerPaletteProps}
          {...lensPaletteProps}
          current={selectedMeta}
          startStage={paletteStart}
          templateTypes={templateTypes}
          onExportCsv={
            view.kind === "db" || view.kind === "saved" ? () => dbExportRef.current?.() : null
          }
          linkFolderCommand={linkFolderCommand}
          noteActionExtras={noteActionExtras}
          onPrint={printable}
          undoCommand={undoCommand}
          redoCommand={redoCommand}
          onClose={closePalette}
          onOpenNote={openNote}
          onSetView={navigateFromMobileChrome}
          /* the same resolution the sidebar's rows take, through the palette's
             own navigation — which also closes the mobile chrome behind it */
          onOpenDb={(type) => navigateFromMobileChrome(viewForDb(type))}
          onOpenJournal={onSidebarJournal}
          /* already in the past: the sidebar glyph is disabled for the same
             reason, and a second departure snapshot from there is meaningless */
          onOpenTimeTravel={timePoint !== null ? null : openTimeTravel}
          onOpenShortcuts={mobile ? null : () => setShortcutsOpen(true)}
          onAssignKeys={mobile ? null : () => setKeyAssignOpen(true)}
          onCreate={createOrCapture}
          onCreateFolder={(path) => createFolder(path).catch((e) => showToast(errText(e)))}
          onMoveNote={(path, folder) => moveNote(path, folder).catch((e) => showToast(errText(e)))}
          onRenameNote={(path, title) => renameNote(path, title).catch((e) => showToast(errText(e)))}
          onRenameFolder={(path, name) => renameFolder(path, name).catch((e) => showToast(errText(e)))}
          onDuplicate={duplicateNote}
          onShare={setShare}
          onTrashNote={trashNote}
          onTogglePick={togglePickToday}
          onTogglePin={setPinned}
          pinnedPaths={pinnedPaths}
          onRevealRel={revealRel}
          onCreateTyped={createTyped}
          onEditTemplate={openTemplate}
          onNewDatabase={() => setDbDialog({ kind: "create" })}
          onCreateSheet={createSheet}
          onCreateDashboard={createDashboard}
          onImportCsv={openCsvImport}
          onSwitchCapture={() => setOverlay("capture")}
          onOpenSearch={openSearch}
          onMutated={refresh}
          onToast={showToast}
          onToggleTerminal={isTauri && !mobile ? toggleTerminal : null}
          onTerminalRun={isTauri && !mobile ? terminalRun : null}
          terminalActions={terminalActions}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {shortcutsOpen && !mobile && (
        <ShortcutOverlay
          onClose={() => setShortcutsOpen(false)}
          customKeys={customKeys}
          pinCount={pinIds.length}
          onAssignKeys={() => setKeyAssignOpen(true)}
          labelCtx={keyLabelCtx}
        />
      )}
      {/* Session-only, desktop-only — assigning is a drag, and the
          mobile sidebar is a sheet that closes on the first touch */}
      {keyAssignOpen && !mobile && (
        <KeyAssignHud
          keys={customKeys}
          pinCount={pinIds.length}
          pins={pinIds}
          onUnassign={(token) => writeKeys((cur) => unassignKey(cur, token))}
          onClose={() => setKeyAssignOpen(false)}
          labelCtx={keyLabelCtx}
        />
      )}
      {!mobile && (
        <KeyHints
          view={view}
          selectedMeta={selectedMeta}
          dbNote={dbNote}
          daily={selectedMeta ? dailyDateOf(selectedMeta.path) : null}
          pins={pinIds}
          canGoBack={
            viewHistory.current.length > 0 ||
            ((view.kind === "db" || view.kind === "saved") && dbNote !== null)
          }
          sheetOpen={sheetOpen}
          onShowSheet={() => setShortcutsOpen(true)}
          canUndo={undoStack.peekUndo(undoState) !== null}
          canRedo={undoStack.peekRedo(undoState) !== null}
          hudEnabled={modHud}
          hudCtx={hudCtx}
        />
      )}
      {settingsOpen && (
        <SettingsPane
          onClose={() => setSettingsOpen(false)}
          onEditRaw={() => openNote(SETTINGS_PATH)}
          onSettingsChanged={refreshTerminalSettings}
          onToast={showToast}
          vaultSealed={sealScopes.some(
            (scope) => scope.path === "" && scope.confirmed && scope.state === "active"
          )}
          vaultSealPending={sealScopes.some(
            (scope) => scope.path === "" && scope.confirmed && scope.state === "pending"
          )}
          vaultSealUnconfirmed={sealScopes.some(
            (scope) => scope.path === "" && !scope.confirmed
          )}
          onSealVault={() => {
            setSettingsOpen(false);
            setSealScopeDialog({ path: "" });
          }}
          onConfirmVaultSeal={() => {
            setSettingsOpen(false);
            setSealScopeDialog({ path: "", mode: "confirm" });
          }}
          onRejectVaultSeal={() => removeSealScope("", true)}
          onRemoveVaultSeal={() => removeSealScope("")}
          onCheckUpdates={checkUpdates}
        />
      )}
      {sealScopeDialog && (
        <SealScopeDialog
          path={sealScopeDialog.path}
          mode={sealScopeDialog.mode}
          onClose={() => {
            setSealScopeDialog(null);
            // A refused seal is not a no-op: the files may already be
            // ciphertext with the marker left pending, so the
            // sidebar and the folder menu have to re-read the truth.
            reloadSealScopes();
            refresh();
          }}
          onDone={(result) => {
            setSealScopeDialog(null);
            reloadSealScopes();
            refresh();
            showToast(
              `${result.path ? "Folder" : "Vault"} sealed — ${result.sealed} note${result.sealed === 1 ? "" : "s"} converted`
            );
          }}
        />
      )}
      {isTauri && !mobile && (
        <Suspense fallback={null}>
          <TerminalHud
            open={termOpen}
            settings={termSettings}
            inject={termInject}
            onSized={setTerminalSize}
            onSettingsChanged={refreshTerminalSettings}
            onToast={showToast}
          />
        </Suspense>
      )}
      {dbDialog?.kind === "create" && (
        <NewDatabaseDialog
          dbTypes={dbTypes}
          onCreate={(name, props) =>
            createDatabase(name, props, dbDialog.fromSidebar, dbDialog.homeFolder)
          }
          onClose={() => setDbDialog(null)}
        />
      )}
      {csvImport && (
        <CsvImportDialog
          fileName={csvImport.fileName}
          rows={csvImport.rows}
          onImport={importCsv}
          onClose={() => setCsvImport(null)}
        />
      )}
      {share && (
        <ShareDialog meta={share} onClose={() => setShare(null)} onToast={showToast} />
      )}
      {/* Seal/unlock/unseal invoked from a surface that is not the open note:
          the row menu or the palette. Same dialog the pane uses. */}
      {sealDialog && (
        <SealedNoteDialog
          /* The unlock→unseal chain swaps the mode under one mount; without a
             fresh key React keeps the dialog's own busy/error state and the
             confirm button stays stuck reading "Removing seal…". */
          key={`${sealDialog.note.path}:${sealDialog.mode}`}
          meta={sealDialog.note}
          mode={sealDialog.mode}
          onClose={() => setSealDialog(null)}
          onDone={(result) => {
            const { note, mode, then } = sealDialog;
            if (mode === "unlock") {
              // the unlock leg of "Remove seal…": register the hold before the
              // confirm, so an abandoned confirm leaves honest state behind
              holdSealed(note.path);
              setSealDialog(then === "unseal" ? { note, mode: "unseal" } : null);
              return;
            }
            setSealDialog(null);
            if (mode === "seal") {
              const quick = (result as { device_unlock?: boolean } | undefined)?.device_unlock;
              if (quick === false) showToast("Sealed — use the vault password to unlock on this device");
            }
            // seal and unseal both leave the engine holding nothing for this
            // path: drop the bookkeeping without asking it to lock again
            forgetSealed(note.path);
            // unsealing drops every authorization in the engine; the pane
            // watching this note picks the change up through sealedsession
            refresh();
          }}
        />
      )}
      {tagFolderEdit && (
        <TagFolderDialog
          folder={tagFolderEdit.folder}
          universe={tagCounts}
          matchCount={(d) => notes.filter((n) => tagFolderMatches(d, n.tags ?? [])).length}
          onSave={saveTagFolder}
          onDelete={deleteTagFolder}
          onClose={() => setTagFolderEdit(null)}
        />
      )}
      {mountDialog && (
        <MountFolderDialog onMount={mountSubmit} onClose={() => setMountDialog(false)} />
      )}
      {/* The destructive half of unmounting — the notes go to Trash,
          so it asks first and snapshots before sweeping */}
      {unmountAsk && (
        <UnmountDialog
          mount={unmountAsk}
          onConfirm={() => unmountNow(unmountAsk, true)}
          onClose={() => setUnmountAsk(null)}
        />
      )}
      {dbDialog?.kind === "rename-db" && (
        <RenameDialog
          title={`Rename database “${dbDialog.dbType}”`}
          initial={dbDialog.dbType}
          submitLabel="Rename database"
          onSubmit={(name) => renameDatabase(dbDialog.dbType, name)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "delete-db" && (
        <DeleteDatabaseDialog
          dbType={dbDialog.dbType}
          noteCount={
            notes.filter(
              (n) => foldedPropStr(n.props, "type")?.toLowerCase() === dbDialog.dbType.toLowerCase()
            ).length
          }
          onChoice={(trash) => deleteDatabase(dbDialog.dbType, trash)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "rename-prop" && (
        <RenameDialog
          title={`Rename property “${dbDialog.prop}”`}
          initial={dbDialog.prop}
          submitLabel="Rename property"
          onSubmit={(name) => renameProperty(dbDialog.dbType, dbDialog.prop, name)}
          onClose={() => setDbDialog(null)}
        />
      )}
      {dbDialog?.kind === "strip-prop" && (
        <StripPropDialog
          dbType={dbDialog.dbType}
          prop={dbDialog.prop}
          count={dbDialog.count}
          onStrip={() =>
            stripPropValues(dbDialog.dbType, dbDialog.prop, dbDialog.wasNumber)
          }
          onClose={() => setDbDialog(null)}
        />
      )}
      {/* App chrome, so audio outlives every view switch below it.
          The component renders nothing until a folder row starts a queue. */}
      <MiniPlayer />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {/* the receipts peek (spec §6) — one at a time, anchored on whatever
          chip or cell asked for it */}
      {receipts && (
        <ReceiptsPeek
          path={receipts.path}
          factKey={receipts.key}
          anchor={receipts.anchor}
          vaultEpoch={vaultEpoch}
          onClose={() => setReceipts(null)}
          onScrub={(commit) => void scrubToCommit(commit)}
          onOpenHistory={() => {
            setReceipts(null);
            setSelected(receipts.path);
            historyNonce.current += 1;
            setHistoryFor({ path: receipts.path, nonce: historyNonce.current });
          }}
        />
      )}
      {/* The second stage of the row menu's key lane */}
      {keyPicker && (
        <ContextMenu
          x={keyPicker.x}
          y={keyPicker.y}
          items={keyPickerItems(keyPicker.target)}
          onClose={() => setKeyPicker(null)}
        />
      )}
      {homePicker && (
        <ContextMenu
          x={homePicker.x}
          y={homePicker.y}
          items={homePickerItems(homePicker.dbType)}
          onClose={() => setHomePicker(null)}
        />
      )}
      {dashMovePicker && (
        <ContextMenu
          x={dashMovePicker.x}
          y={dashMovePicker.y}
          items={dashMoveItems(dashMovePicker.path)}
          onClose={() => setDashMovePicker(null)}
        />
      )}
      {openAsPicker && (
        <ContextMenu
          x={openAsPicker.x}
          y={openAsPicker.y}
          items={openAsItems(openAsPicker.path)}
          onClose={() => setOpenAsPicker(null)}
        />
      )}
      {folderIconMenu && (
        <IconPicker
          anchor={folderIconMenu.anchor}
          type={folderIconMenu.path.split("/").pop() ?? folderIconMenu.path}
          icon={folderMeta[folderIconMenu.path]?.icon}
          onSave={(ic) => saveFolderIcon(folderIconMenu.path, ic)}
          onClose={() => setFolderIconMenu(null)}
        />
      )}
      {dbIconMenu && (
        <IconPicker
          anchor={dbIconMenu.anchor}
          type={dbIconMenu.type}
          icon={iconForType(dbIcons, dbIconMenu.type)}
          onSave={(ic) => saveSchemaIcon(dbIconMenu.type, ic)}
          onClose={() => setDbIconMenu(null)}
        />
      )}
      {/* One bubble for every `tooltip()` in the tree — mounted here
          so any pane can adopt it without mounting anything of its own */}
      <TooltipHost />
      {toast && (
        <div className="toast" key={toast.id}>
          {toast.msg}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                const run = toast.action?.run;
                setToast(null);
                run?.();
              }}
            >
              {toast.action.label}
            </button>
          )}
          {toast.sticky && (
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss"
              onClick={() => setToast(null)}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
    </NavContext.Provider>
    </UndoContext.Provider>
  );
}
