import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { isTauri } from "./lib/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTyping, isTypingNow } from "./lib/dom";
import { MENU_SURFACES } from "./lib/menusurfaces";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DbIcon, DbLayout, FolderListing, MountInfo, MountRow, MountScanStats, NewTypeProp, NoteMeta, NumberFormat, PropKind, PropValue, RollupConfig, SavedView, SavedViewSort, SelectOption, SidebarOrder, TagFolder, VaultHistoryPoint, View, ViewPref } from "./lib/types";
import { foldedPropKey, foldedPropStr, FUNCTIONAL_TYPES, propStr, typeHome, viewKey } from "./lib/types";
import { tagFolderApplyTags, tagFolderMatches, tagUniverse } from "./lib/tags";
import { byFoldedKey, foldedObjectKey, isTypePropName, typeSchemaFor } from "./lib/schemalookup";
import { folderDefaultIcon, iconForType, iconsByType } from "./lib/dbicons";
import { looksLikeUrl } from "./lib/url";
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
import { addTagsUndoable, setPropUndoable, type PropWriter } from "./lib/undoprops";
import {
  isIntrinsic,
  MOUNT_SCHEME,
  mountStatus,
  rowMetas,
  scanStatLine,
} from "./lib/mounts";
import * as undoStack from "./lib/undo";
import { UndoContext } from "./lib/undoContext";
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
  numberFormatSetting,
  parseDbGrid,
  parseModHud,
  parseShowAppFiles,
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
  mountsList,
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
  vaultRenameProp,
  vaultRenameType,
  vaultResolve,
  vaultFolderFiles,
  vaultRoot,
  vaultSavedViewDelete,
  vaultSavedViewSet,
  vaultSavedViewsRead,
  vaultSchemaHomeSet,
  vaultSchemaRead,
  vaultSchemaSet,
  vaultSchemaSetIcon,
  vaultNoteAddTags,
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
  splitDashboards,
  splitPins,
} from "./lib/sidebar";
import { buildNoteActions, duplicateNote as duplicateNoteInVault } from "./lib/noteactions";
import { exportNoteMarkdown, exportNoteOneSheet, exportNotePdf } from "./lib/export";
import { embedQueryFor, type ViewSpecResult } from "./lib/embeds";
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
import SendLinkDialog from "./components/SendLinkDialog";
import TagFolderDialog from "./components/TagFolderDialog";
import TypeIcon from "./components/TypeIcon";
import Sidebar, { type FolderEdit, type MenuTarget, type Section } from "./components/Sidebar";
import ListPane from "./components/ListPane";
import MiniPlayer from "./components/MiniPlayer";
import { playableFiles } from "./lib/folderfiles";
import { getQueue, startQueue, subscribeQueue, syncQueue } from "./lib/playqueue";
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
import AssetsPane from "./components/AssetsPane";
import Palette, { type StartStage } from "./components/Palette";
import ShortcutOverlay from "./components/ShortcutOverlay";
import KeyHints from "./components/KeyHints";
import KeyAssignHud from "./components/KeyAssignHud";
import ModKeyHud, { type ModKeyHudCtx } from "./components/ModKeyHud";
import InfoView from "./components/InfoView";
import DonationNag from "./components/DonationNag";
import TimeTravelBar from "./components/TimeTravelBar";
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
import { DbIcon as DbGlyphIcon, ExportIcon, FolderIcon, KeyboardIcon, MenuIcon, MountIcon, NoteActionGlyph, NoteIcon, PenIcon, PinIcon, PlusIcon, RepeatIcon, SidebarIcon, TrashIcon, XIcon, ChevronLeftIcon, ChevronUpIcon, ChevronDownIcon } from "./components/Icons";
import { useSidebarHidden } from "./hooks/useSidebarHidden";
import { useZoom } from "./hooks/useZoom";
import { useTerminalHud } from "./hooks/useTerminalHud";
import { useMobileLayout } from "./hooks/useMobileLayout";
import { useUndoStack } from "./hooks/useUndoStack";
import { useViewHistory } from "./hooks/useViewHistory";
import { useVaultEvents } from "./hooks/useVaultEvents";
import { useShortcutRouter } from "./hooks/useShortcutRouter";
import { useToast } from "./hooks/useToast";
import { useUpdater } from "./hooks/useUpdater";
import { useSearch } from "./hooks/useSearch";
import { useVaultIndex } from "./hooks/useVaultIndex";
import { queueViewsWrite, useVaultConfigs } from "./hooks/useVaultConfigs";
import { useSidebarOrderModel } from "./hooks/useSidebarOrderModel";

/** Membership. `tagFolders` is only consulted by the tagfolder kind — a view
    naming a folder that no longer exists matches nothing, which is what keeps
    a deleted tag folder from showing the whole vault (SUB-818). */
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
    // a mount's rows come from its index, not from the note list (SUB-888)
    case "mount":
    case "dashboard":
    case "trash":
    case "assets":
    case "doctor":
    case "calendar":
    case "today":
    case "vaultsync":
    case "changelog":
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
  // cold open lands on the Notes scratch list (SUB-299) — Today (SUB-300) is
  // a destination (sidebar, palette, ⌘1), never the front door
  const [view, setView] = useState<View>({ kind: "notes" });
  const [selected, setSelected] = useState<string | null>(null);
  const {
    mobile,
    mobilePane,
    setMobilePane,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSwipeStart,
    showMobileDetail,
  } = useMobileLayout();
  /** SUB-210: a daily surface being viewed with no file behind it — the note
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
  // SUB-490: `mod-hud` in Settings.md, default on until a read says otherwise
  const [modHud, setModHud] = useState(true);
  // SUB-831/SUB-878: `show-agent-files` in Settings.md — the seeded
  // AGENTS.md/CLAUDE.md and Settings.md itself stay ordinary files on disk
  // (and in the engine index), but the app's own note surfaces conceal them
  // unless this is explicitly true, so a vault reads as the user's content
  // rather than the tooling's
  const [showAppFiles, setShowAppFiles] = useState(false);
  // SUB-607: `db-grid` in Settings.md — the global default for table grid
  // lines; a database's ViewPref `grid` overrides it either way
  const [dbGrid, setDbGrid] = useState(true);
  // SUB-834: `net-link-titles` in Settings.md — gates the page-title fetch
  // behind a pasted link. The capture itself is local and always happens, so
  // this only decides whether the engine then asks that site anything.
  // `net-share-relay`, the other request this app makes, is enforced inside
  // SendLinkDialog, which reads Settings.md for the relay URL anyway.
  const [netLinkTitles, setNetLinkTitles] = useState(true);
  /** `number-format` (SUB-834): how calc lines and unit cells write numbers —
      de `1.234,56` (default) or intl `1,234.56`. Rides the same settings read
      below, so a toggle in the pane repaints on the next vaultEpoch bump. */
  const [numberStyle, setNumberStyle] = useState<"de" | "intl">("de");
  /** SUB-492: the key picker opened from a sidebar row's "Assign key…" — its
      own state, so the parent menu can close itself around it */
  const [keyPicker, setKeyPicker] = useState<{ target: string; x: number; y: number } | null>(null);
  /** the folder-icon picker set from a folder's context menu (SUB-84) */
  const [folderIconMenu, setFolderIconMenu] = useState<{ path: string; anchor: AnchorRect } | null>(
    null
  );
  /** the db-icon picker set from a database's context menu (SUB-260) */
  const [dbIconMenu, setDbIconMenu] = useState<{ type: string; anchor: AnchorRect } | null>(null);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  // session-local layout inside an open pin — persisted only by re-saving it
  const [svPref, setSvPref] = useState<ViewPref | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // second-stage folder picker for "Set home folder…" (SUB-159): the row
  // menu swaps to this so the pick lands on the same spot
  const [homePicker, setHomePicker] = useState<{ dbType: string; x: number; y: number } | null>(
    null
  );
  // SUB-466: the dashboard row's "Move to folder…" second stage — same
  // swap-in-place pattern, scoped to the dashboards' folders
  const [dashMovePicker, setDashMovePicker] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  // SUB-611: the folder row's "Open as database…" second stage — pick an
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
  useUpdater(showToast);
  // SUB-43 database management: which admin dialog is open (null = none);
  // create's fromSidebar marks the Folders "+" entry point — the new db is
  // homed into the tree on creation (SUB-403); homeFolder is the folder
  // menu's "Open as database…" birth (SUB-611) — the new db homes on that
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
  // SUB-274 CSV import: the picked, parsed file waiting on the import dialog
  const [csvImport, setCsvImport] = useState<{ fileName: string; rows: string[][] } | null>(null);
  // SUB-833: the note being sent as an encrypted expiring link
  const [sendLink, setSendLink] = useState<NoteMeta | null>(null);
  // SUB-888 "Mount a folder…": the dialog's open state
  const [mountDialog, setMountDialog] = useState(false);
  /** every mount in the vault, with this machine's binding resolved */
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  /** the open mount's rows — its last-known index merged with its sidecars */
  const [mountRowList, setMountRowList] = useState<MountRow[]>([]);
  /** the mount whose "unmount and trash its notes" is awaiting confirmation */
  const [unmountAsk, setUnmountAsk] = useState<MountInfo | null>(null);
  const editorFocusRef = useRef<(() => void) | null>(null);
  // focuses the note pane's title input with the text selected (⌘N in Notes)
  const titleFocusRef = useRef<(() => void) | null>(null);
  // the open note pane's debounced-save flush (SUB-271): actions that read or
  // destroy the file from outside the pane (Duplicate, trash) wait for any
  // pending text to land first — the pane's own SUB-229 rule, app-wide.
  // SUB-264's abandon lane awaits the same flush-and-settle before its
  // pristine check.
  const flushOpenRef = useRef<(() => Promise<void>) | null>(null);
  // SUB-264: paths created by THIS session's ⌘N — the only notes the abandon
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

  /* SUB-810: which pins already have a link folder on THIS machine, by view
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

  // window drag (SUB-81 round 2): `data-tauri-drag-region` only fires when the
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


  // palette quick actions come from Settings.md (SUB-441), so they must be
  // known before the palette first opens — not only when the HUD spawns. Read
  // once at boot; the HUD's own re-reads below keep it fresh after an edit.
  // SUB-490: the hold-⌘ HUD's off switch rides the same read, re-run on
  // vaultEpoch so toggling it in the settings pane takes effect immediately.
  useEffect(() => {
    // SUB-1122: a dial the user is still holding has not reached the note, so
    // this read would repaint the old value over it — see lib/appearance.ts
    const overtaken = () => appearancePreviewPending();
    vaultRead(SETTINGS_PATH)
      .then((c) => {
        setTerminalActions(parseTerminalActions(c.props));
        setModHud(parseModHud(c.props));
        setDbGrid(parseDbGrid(c.props));
        setShowAppFiles(parseShowAppFiles(c.props));
        // SUB-955: the appearance dials land on the document element rather
        // than in React state — they are CSS inputs, nothing renders off
        // them. This is also the write that CORRECTS the settings pane's
        // optimistic preview once the note has actually taken the value.
        if (!overtaken()) applyAppearance(document.documentElement, parseAppearance(c.props));
        applyWindowOpacity(parseWindowOpacity(c.props));
        setNetLinkTitles(netAllowed(c.props, "link-titles"));
        setNumberStyle(numberFormatSetting(c.props));
      })
      .catch(() => {
        setTerminalActions([]);
        // an unreadable Settings.md falls back to the shipped look rather than
        // leaving whatever happened to be applied last — unless a dial is
        // mid-drag, in which case the live preview outranks the fallback
        // (SUB-1122): the pane, not a failed read, is what the user is
        // holding, and the release repaints from the note either way.
        if (!overtaken()) applyAppearance(document.documentElement, DEFAULT_APPEARANCE);
      });
  }, [vaultEpoch]);

  // SUB-831: what the rest of the app calls `notes` — the index minus the
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
  // Only LEAVING clears (SUB-267): entering a db with a note already chosen —
  // a search hit opening in its home database — must not lose it to the swap.
  // A birth navigation (SUB-470) is a db→db switch that CARRIES its note into
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

  const { openNoteRef } = useVaultEvents({
    refresh,
    refreshConfigs,
    showToast,
    undoDispatch,
    setChangedPaths,
    setVaultEpoch,
    lastOwnRefreshRef,
  });

  // types with at least one note (dashboard excluded) — the single source of
  // truth for which types are databases (SUB-152): the sidebar unions
  // schema-registered types on top (SUB-43), the views partition takes this set
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

  // every note title — the body editor's [[ wikilink completion pool (SUB-269)
  const noteTitles = useMemo(() => notes.map((n) => n.title), [notes]);

  const databases = useMemo(() => {
    // schema-registered databases list even with zero notes (SUB-43)
    const counts = new Map(usedTypes);
    const casing = new Set([...counts.keys()].map((t) => t.toLowerCase()));
    for (const t of Object.keys(schema)) {
      const folded = t.toLowerCase();
      if (!FUNCTIONAL_TYPES.has(folded) && !casing.has(folded)) {
        counts.set(t, 0);
        casing.add(folded);
      }
    }
    // SUB-888: a mount IS a database — its name is a schema type, so it is
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

  /** Open a database by name, landing on the mount view when that name is a
      mounted folder (SUB-888). Every "open this database" path goes through
      here, so a mount is reachable from the manager, the sidebar and the
      palette without any of them knowing what a mount is. */
  const openDatabase = useCallback(
    (type: string) => {
      const mount = mountByType.get(type.toLowerCase());
      setView(mount ? { kind: "mount", id: mount.id } : { kind: "db", type });
    },
    [mountByType]
  );

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

  // SUB-460: `folders` is optional on the Rust struct and the loaders write it
  // straight through, so a `?? []` inline at the call site would mint a fresh
  // array on every render and make memo(Sidebar) a no-op for every vault whose
  // folder order was never dragged. Pin the empty case to one identity.
  const sidebarFolderOrder = useMemo(
    () => sidebarOrder.folders ?? EMPTY_ORDER,
    [sidebarOrder.folders]
  );

  /** SUB-698: the Dashboards section's group headers in drag order — same
      pinned-empty-identity trick as `sidebarFolderOrder` above. */
  const sidebarDashGroupOrder = useMemo(
    () => sidebarOrder.dashgroups ?? EMPTY_ORDER,
    [sidebarOrder.dashgroups]
  );

  // SUB-401: root folder paths in sidebar display order — the persisted drag
  // order with new folders appended; drives the Move up/down menu math
  const orderedRootFolders = useMemo(
    () => orderedRootNodes(folders, sidebarOrder.folders ?? []).map((n) => n.path),
    [folders, sidebarOrder.folders]
  );

  // SUB-85: folder path → database type for dbs whose home folder exists.
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

  // pin ids in sidebar order — the ⌘5…⌘9 targets (SUB-67)
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
    // the Journal folder lists its dailies newest-first (SUB-176)
    if (view.kind === "folder" && view.path === JOURNAL_DIR) return journalOrder(filtered);
    return filtered;
  }, [notes, view, tagFolders]);

  // SUB-87: in folder and All notes views the database entries collapse into
  // per-database blocks above the loose rows; every other view lists its
  // scope as-is. Blocks are click-through only — the loose rows are the
  // selectable list. Membership follows the used-types set (SUB-152), so a
  // type with notes collapses even without a schema entry.
  const viewRows = useMemo<{ loose: NoteMeta[]; blocks: DbBlock[] }>(() => {
    if (view.kind === "folder" || view.kind === "all")
      return partitionDbEntries(viewNotes, new Set(usedTypes.keys()));
    return { loose: viewNotes, blocks: [] };
  }, [viewNotes, view, usedTypes]);

  const scratchCount = useMemo(() => notes.filter(isScratchNote).length, [notes]);

  useEffect(() => {
    // an open template (SUB-59) lives outside the index — never snap away
    if (selected && templateTypeOf(selected)) return;
    // a ghost daily (SUB-210) has no file yet, so it's never in viewNotes
    if (selected && selected === ghostPath) return;
    // a concealed app file (SUB-831/SUB-878) — Settings.md via the ⌘, sheet's
    // "edit raw" (SUB-398), an agent file opened by wikilink — has no row in
    // any view, so membership can't decide for it
    if (selected && isAppFile(selected) && !notes.some((n) => n.path === selected)) return;
    if (viewNotes.length === 0) {
      setSelected(null);
      return;
    }
    // A phone opens on the list itself. Selecting the first row here would
    // immediately skip that navigation level and reproduce the squeezed
    // desktop shell's most confusing behavior (SUB-332).
    if (mobile) {
      if (selected && !viewNotes.some((n) => n.path === selected))
        setSelected((cur) => (cur === selected ? null : cur));
      return;
    }
    // membership is checked against the full scope, so a db entry opened
    // explicitly (palette, search hit, restore, embed click-through) keeps
    // its selection in views where it has no row of its own; auto-select
    // still lands on the first LOOSE note (SUB-87)
    if (!selected || !viewNotes.some((n) => n.path === selected)) {
      // SUB-436: this effect can flush a frame late — ⌘N seeds and selects its
      // fresh note between the render that saw no selection and this commit.
      // Resolving against the live value keeps the snap from overwriting a
      // newer selection (which sent the rename and the typing to the note that
      // happened to be open before).
      setSelected((cur) => (cur === selected ? viewRows.loose[0]?.path ?? null : cur));
    }
  }, [viewNotes, viewRows, selected, ghostPath, mobile]);

  const selectedMeta = useMemo(() => {
    // the full index, not the concealed view (SUB-831): a hidden agent file
    // followed by wikilink must still open in the editor
    const found = indexedNotes.find((n) => n.path === selected) ?? null;
    if (found) return found;
    // templates are unindexed: synthesize the meta NotePane needs — content
    // is read from disk by path anyway (SUB-59)
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
      };
    }
    // ghost daily (SUB-210): the dated surface exists on screen, not on disk
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
        };
      }
    }
    // Settings.md via ⌘, "edit raw" (SUB-398): concealed from `notes`, but
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
        setTimeError(error instanceof Error ? error.message : String(error));
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
      setTimeError(error instanceof Error ? error.message : String(error));
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
      setTimeError(error instanceof Error ? error.message : String(error));
      // Recovery must never dead-end: the guard is still on with no
      // projection behind it, so a failed re-entry would leave every write
      // blocked and no working control on screen (SUB-822). Re-show the past
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
        // the baseline is the version being restored (SUB-822): any live
        // file newer than it means this restore would bury someone else's
        // change, which is exactly what SUB-781's detection + rescue
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
        setTimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setTimeBusy(false);
      }
    },
    [reloadPresent, selectTimePoint, showToast, timePoint]
  );

  useEffect(() => () => historyLeave(), []);

  // leaving a ghost daily (SUB-210) discards it — nothing was ever written
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
      // full index (SUB-831): "Open" from search-by-path, a wikilink, or a
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
      // SUB-558: a daily note with no file behind it has to re-open as a ghost
      // (SUB-210) — selecting the bare path would synthesize no meta and render
      // an empty pane. This is the path SUB-549's "Reopen" toast takes when the
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

  const dbNoteMeta = useMemo(
    () =>
      (view.kind === "db" || (view.kind === "saved" && activeSaved)) && dbNote
        ? notes.find((n) => n.path === dbNote) ?? null
        : null,
    [notes, dbNote, view, activeSaved]
  );

  // SUB-396: the note on screen is a sheet — its grid owns a key surface the
  // hint panel advertises. Db views show their side note, everything else the
  // selection (same meta NotePane renders).
  const sheetOpen =
    foldedPropStr(
      (view.kind === "db" || view.kind === "saved" ? dbNoteMeta : selectedMeta)?.props ?? {},
      "type"
    )?.toLowerCase() === "sheet";

  // SUB-464: the open dashboard renders a workbook tab strip — ⌃⇥ / ⌃⇧⇥ steps
  // pages through the ref WorkbookPane registers while mounted
  const pageStepRef = useRef<((dir: 1 | -1) => void) | null>(null);
  // SUB-490/SUB-726: mounted boards publish actual ⌘Z / ⌘⇧Z availability here
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
        () => vaultViewsSet(storedDb, p.view, p.group_by, p.table_group_by, p.aggregations, p.sorts, p.col_order, p.hidden, p.widths, p.wrap, p.grid, p.hidden_per_layout),
        setViewsConfig,
        vaultViewsRead,
        "Couldn't save view settings"
      );
    },
    [persistViewsConfig, viewsDbKey]
  );

  /* ----- saved views (SUB-18): named pins over a database ----- */

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
        // SUB-199: `sort` always mirrors the first key so older readers still
        // work; the full list persists only when 2+ keys are active
        ...(capture.sorts.length > 0 ? { sort: capture.sorts[0] } : {}),
        ...(capture.sorts.length >= 2 ? { sorts: capture.sorts } : {}),
        view: capture.view,
        ...(capture.groupBy ? { group_by: capture.groupBy } : {}),
        ...(capture.tableGroupBy ? { table_group_by: capture.tableGroupBy } : {}),
        // SUB-212: the pane only sends columns that differ from the default
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
      // SUB-160: a fresh pin must be findable — re-expand the Saved views
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

  // SUB-212: column curation on an open pin persists straight into the view
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
      // SUB-810: the pin's remembered export target goes with it. The folder
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
    (dbType: string, prop: string, options: SelectOption[], kind: PropKind | null, notify?: boolean, notifyBefore?: number, target?: string, format?: NumberFormat, description?: string, rollup?: RollupConfig | null) => {
      const storedDb = schemaDbKey(dbType);
      const storedProp = schemaPropKey(dbType, prop);
      vaultSchemaSet(storedDb, storedProp, options, kind ?? undefined, notify, notifyBefore, target, format, description, rollup)
        .then(setSchema)
        .catch(console.error);
    },
    [schemaDbKey, schemaPropKey]
  );

  // per-type database icons (SUB-27) ride the same schema.json, under the
  // reserved `icon` key — derived here so every surface reads one source
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);

  const saveSchemaIcon = useCallback((dbType: string, icon: DbIcon | null) => {
    vaultSchemaSetIcon(schemaDbKey(dbType), icon).then(setSchema).catch(console.error);
  }, [schemaDbKey]);

  // a database's home folder (SUB-85), set/cleared from the All databases
  // manager (SUB-159), a folder's "Open as database…" (SUB-611), or the
  // tree row's "Stop opening as database" (SUB-411) — clearing is the exit
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
        .catch((e) => showToast(String(e)));
    },
    [showToast, schemaDbKey]
  );

  // per-folder icons (SUB-84) ride views.json under the reserved `$folders`
  // key — the setter returns the whole map, same discipline as the schema.
  // Queued like the other views.json writes so it can't interleave with a
  // pref/sidebar/pin write (SUB-241); not in that issue's toast list.
  const saveFolderIcon = useCallback((path: string, icon: DbIcon | null) => {
    queueViewsWrite(() => vaultFolderIconSet(path, icon)).then(setFolderMeta).catch(console.error);
  }, []);

  // the engine retargets/drops `$folders` keys behind folder renames and
  // deletes — re-read the map after one lands
  const reloadFolderMeta = useCallback(() => {
    vaultFolderMetaRead().then(setFolderMeta).catch(console.error);
  }, []);

  /* ----- reality mounts (SUB-888) ----- */

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

  /* ----- database management (SUB-43) ----- */

  // re-read the .vault JSONs the bulk engine ops move behind the scenes
  const reloadDbMeta = useCallback(() => {
    vaultSchemaRead().then(setSchema).catch(console.error);
    vaultViewsRead().then(setViewsConfig).catch(console.error);
    vaultSidebarOrder().then(setSidebarOrder).catch(console.error);
    vaultSavedViewsRead().then(setSavedViews).catch(console.error);
  }, []);

  // Safety rail: every bulk sweep starts with an explicit snapshot; history
  // being unavailable (no git) never blocks the op — but it must not pass in
  // silence either (SUB-481), or a sweep runs unprotected and nothing says so.
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
        // born from the Folders "+" (SUB-403): the db lands in the tree
        // immediately — a root folder named like its sidebar label becomes
        // its home (SUB-85), created now or REUSED when one already exists
        // (never "Name 2"); engine refusals surface as THE toast (the plain
        // "created" one would replace it unseen), the db itself still stands.
        // A folder's "Open as database…" (SUB-611) skips the eponymous-root
        // dance: homeFolder IS the home, it already exists.
        let homeErr: string | null = null;
        if (homeFolder) {
          try {
            setSchema(await vaultSchemaHomeSet(type, homeFolder));
            refresh();
          } catch (e) {
            homeErr = String(e);
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
            homeErr = String(e);
          }
        }
        setView({ kind: "db", type });
        showToast(homeErr ?? `Database “${type}” created`);
      }),
    [showToast, folders, refresh]
  );

  // SUB-274 CSV import: pick → parse → dialog. The dialog's confirm creates
  // the type through the same vault_create_type path as "New database", then
  // one vault_create per row — best-effort per row, so a title the engine
  // guards (SUB-223) skips that row instead of aborting the whole import
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
      .catch((e) => showToast(String(e)));
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

  // SUB-888 "Mount a folder…": register the mount, bind it here and scan it
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

  // SUB-888: unmounting is two different acts. Plain "Unmount" forgets the
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
      else unmountNow(mount, false).catch((e) => showToast(String(e)));
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

  /** SUB-888: a mount row's property write. Ordinary notes go through
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
        .catch((e) => showToast(String(e)));
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
      const items: MenuItem[] = [
        {
          label: "Open file",
          icon: <MountIcon />,
          disabled: !abs,
          onSelect: () => abs && fileOpen(abs).catch((e) => showToast(String(e))),
        },
        {
          label: "Reveal in Finder",
          icon: <FolderIcon />,
          disabled: !abs,
          onSelect: () => abs && fileReveal(abs).catch((e) => showToast(String(e))),
        },
      ];
      if (row.note) {
        items.push({
          label: "Open note",
          icon: <NoteIcon />,
          separatorAbove: true,
          onSelect: () => openNote(row.note!),
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
      if (activeMount.path && !activeMount.missing && !row.missing) {
        fileOpen(`${activeMount.path}/${row.rel}`).catch((e) => showToast(String(e)));
        return;
      }
      if (row.note) openNote(row.note);
      else showToast(mountStatus(activeMount) ?? `${row.name} isn’t on this machine`);
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
          // the engine retargets a key bound to this database (SUB-467)
          reloadSidebarOrder();
          if (sweep.failed) {
            // the rename did NOT land (the type keeps its old name) and notes
            // were partially retyped — that message must outlive a 4s toast,
            // so it rejects back into the dialog's persistent inline error
            // surface, which stays open exactly as it did pre-SUB-501
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
          // …and drops it when the database goes (SUB-467)
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
            // the pre-SUB-501 failure behavior)
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
              .catch((e) => showToast(String(e)));
        })
        .catch((e) => showToast(String(e)));
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
  // (SUB-79) contributes each of its values, not the joined display string.
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

  // relation pickers list the target database's entries
  const relCandidates = useCallback(
    (dbType: string) => relationCandidatesFor(notes, dbType),
    [notes]
  );

  const dbTypes = useMemo(() => databases.map((d) => d.type), [databases]);

  // create-new inline from a relation picker: lands in the target type's
  // home folder when one is set (SUB-85), else where most of it already
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

  // SUB-656: the palette closes before its create settles (Palette.tsx's
  // run() does `close(); item.run();`), so an engine refusal — a title
  // holding `[`/`]`, a dot-leading slug, an unwritable folder (vault.rs
  // create_full) — had no UI left to return to and died on
  // `.catch(console.error)`: nothing created, nothing said, typed text gone.
  // The shape createNote has had since SUB-113 and the db/calendar drafts
  // since SUB-564: name what failed, surface the engine's own reason, and
  // keep the user's text on the clipboard where there is text to keep.
  const reportCreateFailure = useCallback(
    (what: string, text?: string) =>
      (err: unknown) => {
        const head = `couldn’t ${what} — ${err instanceof Error ? err.message : String(err)}`;
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
          // seed the fresh meta synchronously (SUB-72): without it the
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
          // SUB-113: the palette is already closed by the time this rejects,
          // so the captured text has no UI to return to — preserve it on the
          // clipboard and say so; never fail silently
          const msg = err instanceof Error ? err.message : String(err);
          navigator.clipboard.writeText(title).then(
            () => showToast(`couldn’t create note (${msg}) — captured text copied to clipboard`),
            () => showToast(`couldn’t create note — ${msg}`)
          );
        });
    },
    [refresh, showToast, showMobileDetail, undoApi]
  );

  // ⌘N inside Notes (SUB-70): instant untyped scratch note — no dialog, lands
  // in Inbox/ like quick capture, sorts to the top of the recency list, and
  // the cursor drops into the title with "Untitled" selected. The fresh meta
  // is seeded synchronously so the selection effect doesn't snap back before
  // the async refresh lands (same trick as openJournal).
  const createScratch = useCallback(
    // SUB-818: `tags` is what "create inside a tag folder" means — the note is
    // born wherever loose notes are born and the folder's tags are written
    // onto it, because a tag folder is a rule, not a place.
    (folder = "Inbox", tags: string[] = []) => {
      vaultCreate("Untitled", folder)
        .then((meta) => (tags.length > 0 ? vaultNoteAddTags(meta.path, tags) : meta))
        .then((meta) => {
          scratchPaths.current.add(meta.path); // SUB-264: abandons if left pristine
          setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
          setSelected(meta.path);
          showMobileDetail();
          refresh();
          focusSoon(() => titleFocusRef.current?.());
        })
        // SUB-656: nothing typed to preserve here (the title is always
        // "Untitled"), but an unwritable folder still has to say so
        .catch(reportCreateFailure("create note"));
    },
    [refresh, showMobileDetail, reportCreateFailure]
  );

  // SUB-264: a ⌘N note that stayed pristine abandons itself — capture's Esc
  // never persists at all, this is the same discard one step later. Silent by
  // design (no trash toast). Flush-then-recheck (SUB-229): a debounced save
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

  // born-complete typed create (SUB-17): schema-default empty chips + the
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

  // SUB-796 — a cell edited inside an inline ```view fence. Deliberately the
  // same call the database pane's cells make (setPropUndoable), so one ⌘Z
  // reverts it whichever surface the edit came from; docs/undo.md §6.2.
  const embedSetProp = useCallback(
    (path: string, key: string, value: PropValue) => {
      // keyLabel matches the pane's (DatabasePane commitCell): the undo toast
      // must read the same whichever surface the edit came from
      setPropUndoable({ path, key, value, record: undoApi.record, keyLabel: displayColLabel(key) })
        .then(() => refresh())
        .catch((err) => {
          showToast(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
          refresh();
        });
    },
    [undoApi, refresh, showToast]
  );

  // SUB-796 — the fence's "+ New". A born-complete typed create like ⌘N's
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
          // Say so — otherwise the create looks dropped (SUB-234, the pane's rule)
          if (query.trim() && filterByQuery([meta], query, undefined, typeSchema).length === 0)
            showToast(`Created “${title}” — hidden by filter`);
        })
        .catch(reportCreateFailure(`create “${title}”`, title));
    },
    [notes, schema, templateTypes, refresh, undoApi, reportCreateFailure, showToast]
  );

  // SUB-796 — a relation cell's "create and link", inline. Same two steps the
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

  // "New sheet…" (SUB-393): sheets are surfaces, not database entries, so the
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

  // a `type` chip commit re-homed an existing note into a database (SUB-208):
  // without this the note leaves the current view's scope on refresh and the
  // selection-guard snaps to another note — the user files a capture and loses
  // it. Follow the note exactly like createTyped: seed the fresh meta
  // synchronously (app state is pre-refresh stale at this instant), then
  // stay on it wherever it now lives.
  //
  // SUB-470: when the commit MINTS the database — the type isn't in the
  // pre-refresh `databases` list — filing quietly would teleport the note to
  // a view that exists nowhere on screen yet ("appears from under your
  // grasp"). A birth is announced: follow the note INTO the new database and
  // offer the sidebar home right there — the same eponymous root folder the
  // Folders "+" create uses (SUB-403/SUB-85, reuse-never-"Name 2").
  const followTyped = useCallback(
    (meta: NoteMeta) => {
      setNotes((ns) => [...ns.filter((n) => n.path !== meta.path), meta]);
      const type = foldedPropStr(meta.props, "type");
      if (
        type &&
        !FUNCTIONAL_TYPES.has(type.toLowerCase()) &&
        !databases.some((d) => d.type.toLowerCase() === type.toLowerCase())
      ) {
        // db→db birth: keep the note across the SUB-267 leave-clears effect
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
              // setDbHome owns the success/refusal toast (SUB-407 taken
              // folder surfaces as the engine's own error text)
              .then((home) => setDbHome(type, home))
              .catch((e) => showToast(String(e)));
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

  // open a type's template as an ordinary note (SUB-59): the file lives
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
      // SUB-834: capture is local and always works; only the title fetch is
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
      // SUB-785: session fold memory is keyed by live path — move it with
      // the note so folds survive a rename done while the note is closed
      migrateSessionFolds(oldPath, m.path);
      scratchPaths.current.delete(oldPath); // a real title never abandons (SUB-264)
      setNotes((ns) => ns.map((n) => (n.path === oldPath ? m : n)));
      setSelected(m.path);
      setDbNote((cur) => (cur === oldPath ? m.path : cur));
      // SUB-624: a rename moves the FILE too (title → stem), so an open
      // dashboard view needs the same retarget the move path gets below
      setView((v) =>
        v.kind === "dashboard" && v.path === oldPath ? { ...v, path: m.path } : v
      );
      refresh();
      reloadSidebarOrder();
    },
    [refresh, reloadSidebarOrder]
  );

  // SUB-783: undo/redo of a rename repairs the same state the forward rename
  // does, but only FOLLOWS the note when it was the selected one — the
  // forward rename's unconditional setSelected would turn ⌘Z of a
  // background note's rename into a navigation. Announced first so an open
  // pane relabels in place (the SUB-772 no-remount lane) before the path
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

  // SUB-263: undo of Move to Trash — restore through the same IPC the Trash
  // pane uses, then re-select the note (seeded synchronously like TrashPane's
  // onRestored, so the selection effect finds it before the refresh lands).
  // SUB-478: by the trash id vault_delete returned, not a path scan — trash
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

  // SUB-515: the folder counterpart — undo of "Move folder to Trash" brings
  // the whole subtree back by the trash id and puts the user back in it
  const restoreTrashedFolder = useCallback(
    (id: string) => {
      vaultTrashRestoreFolder(id)
        .then((rel) => {
          setView({ kind: "folder", path: rel });
          reloadFolderMeta();
          refresh();
          reloadSidebarOrder();
        })
        .catch((e) => showToast(String(e instanceof Error ? e.message : e)));
    },
    [refresh, reloadFolderMeta, reloadSidebarOrder, showToast]
  );

  // SUB-263: feedback for the note pane's Move to Trash — a quiet toast with
  // Undo, and selection lands on the trashed note's neighbor in the current
  // list (next row, else previous) instead of snapping to the top
  // SUB-515: the toast's Undo runs the stack entry by id, so the button and
  // ⌘Z are one action rather than two lookalikes that could drift apart
  const onNoteTrashed = useCallback(
    (path: string, undoId: number) => {
      scratchPaths.current.delete(path); // explicit trash gets the toast (SUB-264)
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
  // landed (SUB-257 — Duplicate's SUB-271 rule, shared by trash + exports).
  // The action's promise passes through so callers that rely on rejection
  // (rename/move, SUB-286 — InlineEdit stays open on a failed rename) keep
  // their resolve/reject semantics
  const afterOpenFlush = useCallback(<T,>(fn: () => T | Promise<T>): Promise<T> => {
    const flush = flushOpenRef.current;
    return (flush ? flush() : Promise.resolve()).then(fn);
  }, []);

  // SUB-271: duplicate a note next to itself — the engine dedupes the
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

  // SUB-257: one trash path for every surface — pending text lands first
  // (SUB-229), then the SUB-263 toast with Undo + neighbor selection. The
  // note pane's own menu goes through here too (it flushes first itself)
  const trashNote = useCallback(
    (path: string) => {
      afterOpenFlush(() => {
        // the id is minted before the write so the toast and the stack entry
        // are the same action (SUB-515)
        const undoId = undoStack.nextUndoId();
        trashUndoable({ path, id: undoId, record: undoApi.record, restore: restoreTrashed })
          .then(() => {
            // a trashed db side note must not linger as state — the pane
            // already unmounts (meta lookup fails), and a stale dbNote would
            // eat one ⌫/Esc press for nothing (SUB-392)
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

  // SUB-272: bulk trash from the table's multi-select bar — one refresh, ONE
  // summary toast. Undo restores every trashed note through the same per-note
  // restore as SUB-263.
  // SUB-577: ONE vault_delete_many, not a vault_delete per note. The per-note
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

  const followLink = useCallback(
    (name: string) => {
      vaultResolve(name).then((meta) => {
        if (meta) {
          openNote(meta.path);
          return;
        }
        // unresolved: a database name opens that view (hub-page links,
        // SUB-203) — only a genuine miss creates the note
        const db = databases.find((d) => d.type.toLowerCase() === name.trim().toLowerCase());
        if (db) openDatabase(db.type);
        else createNote(name, "");
      });
    },
    [openNote, createNote, databases, openDatabase]
  );

  /* ----- inline view embeds in notes (SUB-86) ----- */

  // resolve a ```view fence against the current vault snapshot; the widget
  // re-asks on every render, so this closure must follow the latest state
  const embedQuery = useCallback(
    (spec: ViewSpecResult) => embedQueryFor(spec, notes, schema, savedViews),
    [notes, schema, savedViews]
  );

  // an embed's header click opens the database — or, when the embed came
  // from a saved: pin, that saved view itself (SUB-211)
  const openEmbedView = useCallback(
    (dbType: string, savedId?: string) =>
      setView(savedId ? { kind: "saved", id: savedId } : { kind: "db", type: dbType }),
    []
  );

  /* ----- sidebar flow: folders, moves, ordering ----- */

  // SUB-466: a moved dashboard keeps its manual sidebar position. The engine
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

  // SUB-698: a renamed or moved GROUP folder keeps its manual position and its
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

  // SUB-286: rename/move of the open note wait out its pending save too —
  // otherwise the pane's late flush writes to the OLD path after the mutation
  // and dies silently (SUB-94), losing the typed text
  const renameNote = useCallback(
    (path: string, title: string): Promise<void> =>
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
        })
      ),
    [afterOpenFlush, onRenamed, undoApi]
  );

  // SUB-1061: a move's undo runs long after the move recorded it, so the
  // follow decision can't ride the closure moveNote captured — it has to read
  // the view/selection as they are at ⌘Z time.
  const moveFollowRef = useRef({ view, selected, tagFolders });
  moveFollowRef.current = { view, selected, tagFolders };

  // SUB-1061: undo/redo apply the inverse move outside moveNote, so without
  // this the file returns and `selected` still names the dead destination —
  // the selection-guard snaps the editor to a neighbour and the next
  // keystroke lands in the wrong note (SUB-768's trap, at undo time). Same
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
      // seed the moved meta synchronously (SUB-72 trick), same reason the
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
        // SUB-768: whether the view has to FOLLOW is decided against the
        // pre-move meta — a note the current view never listed (a dashboard
        // or search scope, where the guard clears instead of snapping) must
        // not yank the view, and neither must moving a background note.
        const prev = notesRef.current.find((n) => n.path === path);
        const wasShown = selected === path && !!prev && inView(prev, view, tagFolders);
        // SUB-1061: onApplied is undo/redo only — the forward move's repair is
        // the `.then` right below, which knows this call's own `wasShown`
        return moveUndoable({ path, folder, record: undoApi.record, onApplied: onMoveApplied }).then((m) => {
          // the file's rel path changed — follow it everywhere it's referenced
          setSelected((sel) => (sel === path ? m.path : sel));
          setDbNote((cur) => (cur === path ? m.path : cur));
          setRenaming((r) => (r === path ? m.path : r));
          // SUB-624: an OPEN dashboard is addressed by its path too — since
          // SUB-605 dragging one between folders is a normal gesture, and a
          // view left on the old path finds no meta and falls back to the list
          setView((v) => (v.kind === "dashboard" && v.path === path ? { ...v, path: m.path } : v));
          // SUB-768: the OPEN note left this view's scope — left alone, the
          // selection-guard snaps the editor to a different note and the
          // next keystroke lands in it (the wrong-note editing trap). Follow
          // the note to where it now lives, exactly like followTyped does:
          // untyped Inbox/root captures belong to Notes (the createNote
          // idiom), anything else to its destination folder.
          if (wasShown && !inView(m, view, tagFolders)) {
            // seed the moved meta synchronously (SUB-72 trick): app state is
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

  /** SUB-698: a folder that changed rel (rename or move) drags every path the
      app is CURRENTLY pointing at with it — the SUB-624 rule one level up. The
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
        refresh();
        // re-reads the order the engine just rewrote; for a dash group (SUB-698)
        // it also carries the `dashgroup:<folder>` collapse id to the new path
        migrateSidebarGroupFolder(path, newRel);
      }),
    [refresh, reloadFolderMeta, migrateSidebarGroupFolder, followFolderRelocation, undoApi]
  );

  /** SUB-698: move a folder under `target` ("" = vault root) — the gesture
      behind dragging a Dashboards group header onto a folder tree row. The
      dashboards inside keep their filenames and re-render as that row's tree
      dashboards (SUB-605); a collision surfaces the engine's message. */
  const moveFolder = useCallback(
    (path: string, target: string) => {
      // SUB-286's rule for directories: a pending editor save inside the folder
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
      migrateSidebarGroupFolder,
      followFolderRelocation,
      showToast,
      undoApi,
    ]
  );

  // chevron-collapsible sidebar sections (SUB-70): the id is a section name
  // ("dashboards" | "databases" | "folders") or a pin group ("dbpins:<type>");
  // state persists in `.vault/views.json` under `$sidebar.collapsed`
  // SUB-466: the `dashgroup:<folder>` ids the sidebar can actually render right
  // now — a group exists only while some dashboard lives in that subfolder
  const dashGroupIds = useMemo(
    () =>
      new Set(splitDashboards(orderedDashboards, folders).groups.map((g) => `dashgroup:${g.folder}`)),
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

  // SUB-467: the key HUD is open. Session-only by design — assign mode is a
  // thing you do, not a setting you keep.
  const [keyAssignOpen, setKeyAssignOpen] = useState(false);

  // the ⌘-digit each pin owns (SUB-677) — derived from the same pinIds order
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

  // SUB-467: live rows behind the target tokens, so the sheet and the HUD name
  // a binding's destination instead of echoing its token
  const keyLabelCtx = useMemo(
    () => ({
      dashboards: orderedDashboards.map((d) => ({ path: d.path, title: d.title })),
      savedViews: savedViews.map((v) => ({ id: v.id, name: v.name })),
      pinned: pinnedNotes.map((n) => ({ path: n.path, title: n.title })),
    }),
    [orderedDashboards, savedViews, pinnedNotes]
  );

  // the dashboards the sidebar and palette actually list: mobile drops the
  // desk-bound ones (sync/music/mastering) — declared here because the pin
  // split below has to key off the very same list the sidebar renders
  const mobileDashboards = useMemo(
    () =>
      mobile
        ? orderedDashboards.filter(
            (d) => !["sync", "music", "mastering"].includes(propStr(d.props, "dashboard") ?? ""),
          )
        : orderedDashboards,
    [mobile, orderedDashboards]
  );

  // SUB-594: every dashboard already has a sidebar row of its own, so a pinned
  // one must not ALSO nest under a folder tree row as a pin. Exclusion is by
  // PATH and independent of WHICH surface owns the dashboard row — the
  // Dashboards section (home subtree) or, since SUB-605, its folder's tree row.
  // Computed once from the list that reaches the Sidebar's `dashboards` prop
  // and passed down, so menu math and render can't disagree (e.g. on mobile,
  // where the filtered list moves the dashboards home).
  const dashPaths = useMemo(
    () => new Set(mobileDashboards.map((d) => d.path)),
    [mobileDashboards]
  );

  // SUB-605: the same three-way dashboard split the sidebar renders — shared
  // here so the row menu's Move lane is the one the row actually reorders in
  const dashSplit = useMemo(
    () => splitDashboards(mobileDashboards, folders),
    [mobileDashboards, folders]
  );

  // SUB-698: the group headers in the order the sidebar draws them — the menu's
  // Move up/down has to index the same list the drag lane reorders
  const orderedDashGroups = useMemo(
    () => applyOrder(dashSplit.groups, sidebarDashGroupOrder, (g) => g.folder),
    [dashSplit, sidebarDashGroupOrder]
  );

  // SUB-585: the split the sidebar renders pins with — flat section rows vs
  // per-folder tree groups. Shared here so pin menus run the same lane math.
  const pinSplit = useMemo(() => splitPins(pinnedNotes, dashPaths), [pinnedNotes, dashPaths]);

  // the non-drag reorder path: every reorderable sidebar lane also moves by
  // menu — dashboards (SUB-58), folder sibling groups at any depth (SUB-401
  // roots, SUB-585 nested), and pin groups (SUB-585). The id list mirrors what
  // the sidebar renders for that lane, so menu math and drag math agree.
  const sectionMoveItems = useCallback(
    (section: Section, id: string): MenuItem[] => {
      const ids =
        section === "dashboards"
          ? // SUB-605: the section's own rows in render order (flat, then the
            // subfolder groups' members) — NOT every dashboard in the vault.
            // A tree-foldered one interleaved in the persisted order would
            // otherwise absorb the swap and Move up/down would do nothing.
            // SUB-698: groups in their persisted header order, same as render
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

  // SUB-257: the row menu renders the canonical note actions (lib/
  // noteactions) — same descriptors the note pane's ⋯ menu and the palette
  // actions stage show, with the row surface's full wiring (Open included)
  const noteMenuItems = useCallback(
    (n: NoteMeta): MenuItem[] =>
      buildNoteActions({
        open: () => openNote(n.path),
        moveToFolder: () => startMoveToFolder(n),
        rename: () => setRenaming(n.path),
        duplicate: () => duplicateNote(n),
        copyPath: () => copyAbsPath(n.path),
        reveal: () => revealRel(n.path),
        exportMarkdown: () => afterOpenFlush(() => exportNoteMarkdown(n).catch(console.error)),
        exportPdf: () => afterOpenFlush(() => exportNotePdf(n).catch(console.error)),
        exportOneSheet: () => afterOpenFlush(() => exportNoteOneSheet(n).catch(console.error)),
        sendAsLink: () => afterOpenFlush(() => setSendLink(n)),
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
      setPinned,
      pinnedPaths,
    ]
  );

  /** `lane` overrides which reorder lane the Move up/down entries act on.
      SUB-698: a Dashboards group header wears the folder menu but reorders
      against its sibling HEADERS, not against the folder tree. */
  const folderMenuItems = useCallback(
    (path: string, anchor: AnchorRect, lane?: Section): MenuItem[] => [
      { label: "Open", icon: <FolderIcon />, onSelect: () => setView({ kind: "folder", path }) },
      // SUB-451: the same instant scratch ⌘N makes in a folder view (2299),
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
      // SUB-611: the discoverable half of SUB-85 homing — this folder's row
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
      // SUB-401 roots, SUB-585 nested: every folder reorders by menu within
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
              refresh();
              // SUB-698: the engine drops the trashed folder's `dashgroups`
              // entry; its `dashgroup:` collapse id goes with it, so a restored
              // group comes back open rather than remembering a stale collapse
              if (lane === "dashgroups") migrateSidebarGroupFolder(path, null);
              else reloadSidebarOrder();
            })
            .catch((e) => showToast(String(e)));
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
      sectionMoveItems,
      createScratch,
      undoApi,
      restoreTrashedFolder,
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
        // SUB-85: a homed db opens as its folder's greeting view; the raw
        // file list of the home folder stays reachable here. SUB-611: the
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
        // same slot as the folder menu's (SUB-84): right below Rename…
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
        // SUB-411: the non-destructive exit — un-home straight from the tree
        // row, same lane as the manager picker's clear (setDbHome toasts).
        // SUB-611 label: the folder row stays in the sidebar after this, so
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

  // the All-databases manager's row menu (SUB-159): the database's standard
  // items with the home-folder lane inserted above the rename/icon/delete
  // tail; the lane swaps in the folder picker as a second-stage menu on the
  // spot. SUB-888: a mounted folder gets the unmount lanes there instead of
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
      // the tail is variable (Remove icon only shows when one is set, SUB-260)
      const tail = base.findIndex((it) => it.label === "Rename database…");
      setMenu({ x, y, items: [...base.slice(0, tail), ...lanes, ...base.slice(tail)] });
    },
    [dbMenuItems, schema, mountByType, unmount]
  );

  // SUB-466: the dashboard row's "Move to folder…" — a second-stage picker on
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
          onSelect: () => moveNote(path, f).catch((e) => showToast(String(e))),
        }));
    },
    [orderedDashboards, folders, orderedRootFolders, moveNote, showToast]
  );

  // the home picker's items: the vault's folders, plus the explicit clear
  // when the db has a home — the stray-exit (SUB-159)
  const homePickerItems = useCallback(
    (dbType: string): MenuItem[] => {
      const cur = typeHome(typeSchemaFor(schema, dbType));
      // one home folder, one database (SUB-407): a folder already homing
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

  // SUB-611: the folder row's "Open as database…" second stage. Databases
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

  // the Folders "+" menu (SUB-403): the plain inline-create folder flow, or
  // a database born straight into the tree — the create dialog flagged
  // fromSidebar so createDatabase homes it on an eponymous root folder.
  // SUB-888's "Mount a folder…" shows a real folder on disk as a database.
  /* ----- tag folders (SUB-818) ----- */

  // the builder sheet: null = closed, { folder: null } = building a new one
  const [tagFolderEdit, setTagFolderEdit] = useState<{ folder: TagFolder | null } | null>(null);

  // every tag in the vault with its note count — the completion source for
  // both the builder's chip fields and the editor's `#`. Derived from the
  // index rather than fetched: the notes are already here and already fresh,
  // and vault_tags exists for callers that aren't holding the index.
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
          showToast(String(e));
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
          showToast(String(e));
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
      // undoable like every other prop edit (SUB-1025): the inverse restores
      // the note's prior `tags:` list, not "remove what we just asked for" —
      // the add is a union, so a tag the note already had must survive undo
      addTagsUndoable({ path, tags, record: undoApi.record, onApplied: () => refresh() })
        .then(() => showToast(`Tagged ${tags.map((t) => `#${t}`).join(" ")}`))
        .catch((e) => showToast(String(e)));
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
            // SUB-818: born in the same menu as the real folders, because it
            // is the same kind of thing to the user — a place notes show up
            label: "New tag folder…",
            icon: <TypeIcon type="tag" icon={{ glyph: "tag" }} />,
            onSelect: () => setTagFolderEdit({ folder: null }),
          },
        ],
      }),
    []
  );


  /* SUB-810: a pin that has been exported once knows where it exports to, so
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

  const savedViewMenuItems = useCallback(
    (id: string): MenuItem[] => {
      const target = exportTargets[id];
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
          label: "Remove pin",
          icon: <TrashIcon />,
          danger: true,
          separatorAbove: true,
          onSelect: () => removeView(id),
        },
      ];
    },
    [removeView, exportView, exportTargets]
  );

  /* SUB-492: the non-drag lane for assignable keys (SUB-467). The HUD's drag
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
        // SUB-485's warning, in the menu's own idiom: still assignable, but
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
      // SUB-698: a dash group IS its folder, so it takes the folder token
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
        // SUB-698: the same folder menu, but its Move up/down rides the
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
        // db rows exist only in the Folders tree now (homed dbs, SUB-85) —
        // everything else goes through the All databases manager (SUB-159)
        setMenu({
          x,
          y,
          items: [...dbMenuItems(target.type, { left: x, top: y, bottom: y }), ...keyLane],
        });
      } else if (target.kind === "savedview") {
        setMenu({ x, y, items: [...savedViewMenuItems(target.id), ...keyLane] });
      } else if (target.kind === "tagfolder") {
        // SUB-818: no Rename lane of its own — the rule and the name are one
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
        // a pinned plain note (SUB-410) — the canonical note actions, whose
        // pin entry reads "Remove pin" here; unpinning never touches the file.
        // SUB-585: the row also moves by menu within its own pin lane (the
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
          // SUB-466: the dashboard row's move lane is the scoped folder picker
          // (opened on this spot), not the palette's all-folders stage
          const items = noteMenuItems(n).map((it) =>
            it.label === "Move to folder…"
              ? { ...it, onSelect: () => setDashMovePicker({ path: target.path, x, y }) }
              : it
          );
          // SUB-605: the Move lane is the row's OWN surface — the Dashboards
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

  const onRowMenu = useCallback(
    (path: string, x: number, y: number) => {
      const n = notes.find((n) => n.path === path);
      if (n) setMenu({ x, y, items: noteMenuItems(n) });
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
      // journal opens its own folder view (SUB-176), from anywhere. Select
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
      // SUB-210: only ⌘D-today creates a file up front. Any other missing day
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

  // born from context (SUB-125): a database's home folder births that
  // database's entries, any other folder a scratch note in place. ONE closure
  // shared by ⌘N's folder branch and the header "+" (SUB-584) — not two
  // lookalike forks that could drift apart. In the Journal, "new" means
  // today's daily (SUB-593, product call): one entry per day is the folder's
  // whole metaphor, so a loose Untitled beside the dailies is never the wish.
  const newInFolder = useCallback(() => {
    // SUB-818: inside a tag folder there is no folder to be born into — the
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

  // ⌘N's contextual dispatch, shared with the SUB-590 background menus:
  // inside a database, calendar, or folder view, "new" means a new entry
  // here, not Inbox capture; inside Notes it's an instant scratch.
  const createHere = useCallback(() => {
    if ((view.kind === "db" || view.kind === "saved") && !overlay) setDbNewSeq((s) => s + 1);
    else if (view.kind === "calendar" && !overlay) setCalNewSeq((s) => s + 1);
    else if (view.kind === "notes" && !overlay) createScratch();
    else if ((view.kind === "folder" || view.kind === "tagfolder") && !overlay) newInFolder();
    else setOverlay("capture");
  }, [view, overlay, createScratch, newInFolder]);

  // SUB-590: right-click on the list pane's empty space — create where you
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
            // (SUB-818) — newInFolder owns both forks
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

  // SUB-210: a ghost daily's first keystroke created the file — seed the meta
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
  });

  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      // walk the listed rows — db blocks are click-through only (SUB-87)
      const rows = viewRows.loose;
      if (rows.length === 0) return;
      const idx = rows.findIndex((n) => n.path === selected);
      const next = idx === -1 ? 0 : Math.min(Math.max(idx + dir, 0), rows.length - 1);
      setSelected(rows[next].path);
    },
    [viewRows, selected]
  );

  // SUB-392: linear view history — plain ⌫ (or ⌘[) walks back through visited
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
    runUndoEntry,
    showToast,
    zoom,
    applyZoom,
  });

  /* SUB-812: a folder is queued in the mini-player. Drives the bar's own
     mount, the shell's reserved height (the bar is chrome WITH height, like
     the time-travel banner — never a float over the panes), and the liveness
     of the transport chords. */
  const playing = useSyncExternalStore(subscribeQueue, getQueue) !== null;

  /* SUB-490: the hold HUD's context. The dispatcher above builds its ctx per
     keydown, which the HUD can't reuse — a held modifier is a state, not an
     event. `typing` is deliberately absent (SUB-498): it is knowable only at the
     moment the hold arms, so ModKeyHud samples the live focus itself rather than
     take a value this memo would serve stale. Overlays suppress the HUD
     outright, so anything they'd add is moot. */
  const hudCtx: ModKeyHudCtx = useMemo(
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

  /* SUB-460: Sidebar and ListPane are memoized, so every callback they take
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
      // SUB-585: a PLAIN note dropped on the folder it already lives in has
      // nowhere to move — the gesture means "give it a sidebar row here", so
      // it pins (a drop on a FOREIGN folder row still moves the file; the
      // engine retargets any existing pin to the new path). `pinnable` is
      // false for sidebar row gestures (dashboard/pin reorders carry
      // SIDE_DRAG_MIME): a dashboard dropped on its own group header must
      // stay a no-op, or it pins into the flat section and renders twice —
      // SUB-466 finding 1 (Opus review of this branch caught the reopening).
      const folder = p.slice(0, Math.max(0, p.lastIndexOf("/")));
      if (folder === f) {
        if (pinnable) setPinned(p, true);
        return;
      }
      moveNote(p, f).catch((e) => showToast(String(e)));
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
  // SUB-460: grouped into one memo rather than passed inline — a fresh object
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
  // the header mirrors the sidebar row (SUB-391): explicit SUB-84 icon first,
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

  /* ----- SUB-812: a folder's loose files, and the listening queue -----

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
        // which is exactly the pre-SUB-812 pane rather than an error state
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
  const onOpenFile = useCallback(
    (path: string) => {
      fileOpen(path).catch((e) => showToast(String(e)));
    },
    [showToast]
  );
  const onRevealFile = useCallback(
    (path: string) => {
      fileReveal(path).catch((e) => showToast(String(e)));
    },
    [showToast]
  );

  // SUB-460: NotePane is memoized too, so its inline prop needs stable identity.
  const clearReveal = useCallback(() => setReveal(null), []);

  // SUB-460: stable identity — Sidebar is memoized, and a fresh function here
  // would re-render it on every App state change.
  const navigateFromMobileChrome = useCallback((next: View) => {
    setView(next);
    setDbNote(null);
    setMobilePane("list");
    setMobileSidebarOpen(false);
  }, []);

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
      // SUB-590: bare chrome answers right-click with the minimal app menu
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
            excludeAppFiles={!showAppFiles}
            query={searchQuery}
            setQuery={setSearchQuery}
            onOpenMatch={openSearchHit}
            onClose={closeSearch}
            restoreSel={searchRestore}
            onRestoredSel={() => setSearchRestore(null)}
            onRowContextMenu={onRowMenu}
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
          <VaultSyncPane />
        </div>
      ) : view.kind === "changelog" ? (
        <div className="main">
          <ChangelogPane
          />
        </div>
      ) : view.kind === "assets" ? (
        <div className="main">
          <AssetsPane vaultEpoch={vaultEpoch} />
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
            // SUB-888: a mounted folder is a database whose rows are files.
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
                onSaveSchema={(prop, opts, kind, notify, target, format, description, rollup) => saveSchemaProp(activeMount.name, prop, opts, kind, notify, target, format, description, rollup)}
                relationCandidates={relCandidates}
                onCreateEntry={createEntry}
                dbTypes={dbTypes}
                openPath={null}
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
                onToast={showToast}
              />
            </div>
          ) : (
            <div className="db">
              <div className="empty">
                <span>Mounted folder not found</span>
                <span className="empty-hint">It may have been unmounted in another window</span>
              </div>
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
              onSaveSchema={(prop, opts, kind, notify, notifyBefore, target, format, description, rollup) => saveSchemaProp(view.type, prop, opts, kind, notify, notifyBefore, target, format, description, rollup)}
              relationCandidates={relCandidates}
              onCreateEntry={createEntry}
              dbTypes={dbTypes}
              openPath={dbNote}
              newSignal={dbNewSeq}
              exportRef={dbExportRef}
              gridDefault={dbGrid}
              numberStyle={numberStyle}
              onPrefChange={(p) => setDbPref(view.type, p)}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
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
              onToast={showToast}
            />
          ) : activeSaved ? (
            <DatabasePane
              key={`sv:${activeSaved.id}`}
              dbType={activeSaved.db}
              notes={savedNotes}
              allNotes={notes}
              pref={
                svPref ?? {
                  view: activeSaved.view ?? byFoldedKey(viewsConfig, activeSaved.db)?.view ?? "table",
                  group_by: activeSaved.group_by ?? byFoldedKey(viewsConfig, activeSaved.db)?.group_by,
                  table_group_by: activeSaved.table_group_by ?? byFoldedKey(viewsConfig, activeSaved.db)?.table_group_by,
                  aggregations: byFoldedKey(viewsConfig, activeSaved.db)?.aggregations,
                  // SUB-326: the pin's own sort seeds the pane (session-local
                  // via setSvPref until re-saved); it never falls back to the
                  // db's remembered sort — a pin is a capture, not a mirror
                  sorts: activeSaved.sorts ?? (activeSaved.sort ? [activeSaved.sort] : undefined),
                  // SUB-404: column widths/wrap aren't part of a pin's capture —
                  // they follow the db's remembered layout, like aggregations
                  widths: byFoldedKey(viewsConfig, activeSaved.db)?.widths,
                  wrap: byFoldedKey(viewsConfig, activeSaved.db)?.wrap,
                  // SUB-607: the grid override follows the db too
                  grid: byFoldedKey(viewsConfig, activeSaved.db)?.grid,
                }
              }
              schema={schema}
              typeSchema={typeSchemaFor(schema, activeSaved.db) ?? {}}
              icon={iconForType(dbIcons, activeSaved.db)}
              onSaveIcon={(ic) => saveSchemaIcon(activeSaved.db, ic)}
              usedValues={(key) => usedValues(activeSaved.db, key)}
              onSaveSchema={(prop, opts, kind, notify, notifyBefore, target, format, description, rollup) => saveSchemaProp(activeSaved.db, prop, opts, kind, notify, notifyBefore, target, format, description, rollup)}
              relationCandidates={relCandidates}
              onCreateEntry={createEntry}
              dbTypes={dbTypes}
              openPath={dbNote}
              newSignal={dbNewSeq}
              exportRef={dbExportRef}
              gridDefault={dbGrid}
              numberStyle={numberStyle}
              onPrefChange={setSvPref}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
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
              onToast={showToast}
            />
          ) : (
            <div className="db">
              <div className="empty">
                <span>Saved view not found</span>
                <span className="empty-hint">The pin may have been removed outside the app</span>
              </div>
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
                numberStyle={numberStyle}
                changedPaths={changedPaths}
                onSaveSchema={saveSchemaProp}
                relationCandidates={relCandidates}
                onCreateEntry={createEntry}
                dbTypes={dbTypes}
                onFollowLink={followLink}
                noteTitles={noteTitles}
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
                onSendAsLink={setSendLink}
                onTogglePin={setPinned}
                pinned={pinnedPaths.includes(dbNoteMeta.path)}
                flushRef={flushOpenRef}
                onTyped={followTyped}
                onJournalDay={openJournal}
                editorFocusRef={editorFocusRef}
                onEscape={onNoteEscape}
                reveal={reveal}
                onRevealed={clearReveal}
                onToast={showToast}
                readOnly={timePoint !== null}
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
          folderIcon={listFolderIcon}
          onNewHere={newInFolder}
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
            numberStyle={numberStyle}
            changedPaths={changedPaths}
            onSaveSchema={saveSchemaProp}
            relationCandidates={relCandidates}
            onCreateEntry={createEntry}
            dbTypes={dbTypes}
            onFollowLink={followLink}
            noteTitles={noteTitles}
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
            onSendAsLink={setSendLink}
            onTogglePin={setPinned}
            pinned={pinnedPaths.includes(selectedMeta.path)}
            flushRef={flushOpenRef}
            ghost={selectedMeta.path === ghostPath}
            onGhostCreated={adoptGhost}
            onTyped={followTyped}
            onJournalDay={openJournal}
            editorFocusRef={editorFocusRef}
            titleFocusRef={titleFocusRef}
            onEscape={onNoteEscape}
            reveal={reveal}
            onRevealed={clearReveal}
            onToast={showToast}
            readOnly={timePoint !== null}
          />
        ) : (
          <div className="note">
            <div className="empty">
              <span>No note selected</span>
              <span className="empty-hint">⌘K to find something, ⌘N to capture</span>
            </div>
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
          current={selectedMeta}
          startStage={paletteStart}
          templateTypes={templateTypes}
          onExportCsv={
            view.kind === "db" || view.kind === "saved" ? () => dbExportRef.current?.() : null
          }
          onClose={closePalette}
          onOpenNote={openNote}
          onSetView={navigateFromMobileChrome}
          onCreate={createOrCapture}
          onCreateFolder={(path) => createFolder(path).catch(console.error)}
          onMoveNote={(path, folder) => moveNote(path, folder).catch((e) => showToast(String(e)))}
          onRenameNote={(path, title) => renameNote(path, title).catch(console.error)}
          onRenameFolder={(path, name) => renameFolder(path, name).catch(console.error)}
          onDuplicate={duplicateNote}
          onSendAsLink={setSendLink}
          onTrashNote={trashNote}
          onTogglePin={setPinned}
          pinnedPaths={pinnedPaths}
          onRevealRel={revealRel}
          onCreateTyped={createTyped}
          onEditTemplate={openTemplate}
          onNewDatabase={() => setDbDialog({ kind: "create" })}
          onCreateSheet={createSheet}
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
      {/* SUB-467: session-only, desktop-only — assigning is a drag, and the
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
        >
          <ModKeyHud enabled={modHud} ctx={hudCtx} />
        </KeyHints>
      )}
      {settingsOpen && (
        <SettingsPane
          onClose={() => setSettingsOpen(false)}
          onEditRaw={() => openNote(SETTINGS_PATH)}
          onSettingsChanged={refreshTerminalSettings}
          onToast={showToast}
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
      {sendLink && <SendLinkDialog meta={sendLink} onClose={() => setSendLink(null)} />}
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
      {/* SUB-888: the destructive half of unmounting — the notes go to Trash,
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
      {/* SUB-812: app chrome, so audio outlives every view switch below it.
          The component renders nothing until a folder row starts a queue. */}
      <MiniPlayer />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {/* SUB-492: the second stage of the row menu's key lane */}
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
      {/* dormant unless NAG_ENABLED (src/lib/donate.ts) — renders nothing and
          touches no storage while the master switch is off */}
      <DonationNag />
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
    </UndoContext.Provider>
  );
}
