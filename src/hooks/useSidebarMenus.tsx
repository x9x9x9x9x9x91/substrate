import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  DbIcon,
  FolderMetaMap,
  MountInfo,
  NoteMeta,
  SavedView,
  SchemaConfig,
  SealScopeInfo,
  TagFolder,
  View,
} from "../lib/types";
import { foldedPropKey, foldedPropStr, FUNCTIONAL_TYPES, typeHome } from "../lib/types";
import { tagFolderApplyTags, tagUniverse } from "../lib/tags";
import { byFoldedKey, typeSchemaFor } from "../lib/schemalookup";
import { iconForType } from "../lib/dbicons";
import { exportSavedView, exportSummary, savedViewRows } from "../lib/viewexport";
import { todayIso } from "../lib/dates";
import { isPickedToday } from "../lib/today";
import { assignKey, keyForTarget, keyLabel, splitFreeKeys, unassignKey } from "../lib/keyassign";
import { addTagsUndoable, setPropUndoable } from "../lib/undoprops";
import { trashFolderUndoable } from "../lib/undostruct";
import { vaultRoot, vaultTagFoldersRead, vaultTagFoldersWrite } from "../lib/ipc";
import { dashLaneFolder, isDbHidden, pinLaneFolder, splitDashboards } from "../lib/sidebar";
import { buildNoteActions } from "../lib/noteactions";
import type { SealedNoteMode } from "../components/SealedNoteDialog";
import { buildNoteExtras, type NoteExtras } from "../lib/noteextras";
import { relockSealed, subscribeSealed, unlockedSealedPaths } from "../lib/sealedsession";
import { exportNoteMarkdown, exportNoteOneSheet, exportNotePdf } from "../lib/export";
import { savedViewFence } from "../lib/embeds";
import { errText } from "../lib/errtext";
import type { UndoApi } from "../lib/undoContext";
import TypeIcon from "../components/TypeIcon";
import type { FolderEdit, MenuTarget, Section } from "../components/Sidebar";
import type { MenuItem } from "../components/ContextMenu";
import type { AnchorRect } from "../components/SelectMenu";
import type { ToastAction } from "./useToast";
import {
  CopyIcon,
  DbIcon as DbGlyphIcon,
  ExportIcon,
  EyeOffIcon,
  FolderIcon,
  KeyboardIcon,
  MountIcon,
  NoteActionGlyph,
  NoteIcon,
  PenIcon,
  PinIcon,
  PlusIcon,
  RepeatIcon,
  SidebarIcon,
  TableIcon,
  TrashIcon,
  XIcon,
} from "../components/Icons";

/** The db-dialog shapes this belt opens — a subset of the admin hook's union. */
type DbDialogRequest =
  | { kind: "create"; fromSidebar?: boolean; homeFolder?: string }
  | { kind: "rename-db"; dbType: string }
  | { kind: "delete-db"; dbType: string };

/** What the menu belt needs from the rest of App to build its entries. */
type SidebarMenusDeps = {
  /* the vault as the menus read it */
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  notes: NoteMeta[];
  /** the live index, read at menu-open time rather than closed over */
  notesRef: { current: NoteMeta[] };
  folders: string[];
  schema: SchemaConfig;
  savedViews: SavedView[];
  folderMeta: FolderMetaMap;
  tagFolders: TagFolder[];
  setTagFolders: Dispatch<SetStateAction<TagFolder[]>>;
  databases: { type: string }[];
  dbIcons: Readonly<Record<string, DbIcon>>;
  homeByDb: Record<string, string>;
  orderedDashboards: NoteMeta[];
  orderedRootFolders: string[];
  dashPaths: ReadonlySet<string>;
  dashSplit: { home: string };

  /* sidebar order model */
  pinIds: string[];
  pinnedPaths: string[];
  setPinned: (path: string, pinned: boolean) => void;
  /** type names of the databases removed from the sidebar — `$sidebar.hidden_dbs` */
  hiddenDbs: string[];
  /** their home folders: the subtrees the tree doesn't draw, so a row's Move
      lane is the one it actually renders in */
  hiddenDbFolders: string[];
  setDbHidden: (type: string, hidden: boolean) => void;
  customKeys: Record<string, string>;
  writeKeys: (edit: (cur: Record<string, string>) => Record<string, string>) => void;
  sectionMoveItems: (section: Section, id: string) => MenuItem[];
  reloadSidebarOrder: () => void;
  migrateSidebarGroupFolder: (oldRel: string, newRel: string | null) => void;

  /* link-folder exports, device-local */
  exportTargets: Record<string, string>;
  setExportTargets: Dispatch<SetStateAction<Record<string, string>>>;

  /* the surfaces a menu entry can open */
  setMenu: (menu: { x: number; y: number; items: MenuItem[] }) => void;
  setFolderEdit: (edit: FolderEdit) => void;
  setOpenAsPicker: (p: { path: string; x: number; y: number }) => void;
  setFolderIconMenu: (p: { path: string; anchor: AnchorRect }) => void;
  setDbIconMenu: (p: { type: string; anchor: AnchorRect }) => void;
  setKeyPicker: (p: { target: string; x: number; y: number }) => void;
  setHomePicker: (p: { dbType: string; x: number; y: number }) => void;
  setDashMovePicker: (p: { path: string; x: number; y: number }) => void;
  setDbDialog: (d: DbDialogRequest) => void;
  setDbNewSeq: Dispatch<SetStateAction<number>>;
  setDbNote: (path: string | null) => void;
  setRenaming: (path: string | null) => void;
  setRenamingViewId: (id: string | null) => void;
  setMountDialog: (open: boolean) => void;
  setShare: (n: NoteMeta | null) => void;
  noteInsertRef: { current: ((text: string) => boolean) | null };

  /* mounts */
  mountByType: Map<string, MountInfo>;
  unmount: (mount: MountInfo, cleanup: boolean) => void;

  /* seals */
  sealScopes: SealScopeInfo[];
  setSealScopeDialog: (d: { path: string; mode?: "seal" | "confirm" }) => void;
  reloadSealScopes: () => void;
  scopeInheritedAt: (path: string) => boolean;
  removeSealScope: (path: string, rejecting?: boolean) => void;

  /* the acts the entries run */
  showToast: (msg: string, action?: ToastAction) => void;
  refresh: () => void;
  undoApi: UndoApi;
  afterOpenFlush: <T>(fn: () => T | Promise<T>) => Promise<T>;
  saveFolderIcon: (path: string, icon: DbIcon | null) => void;
  saveSchemaIcon: (dbType: string, icon: DbIcon | null) => void;
  setDbHome: (dbType: string, home: string | null) => void;
  reloadFolderMeta: () => void;
  restoreTrashedFolder: (id: string) => void;
  removeView: (id: string) => void;
  moveNote: (path: string, folder: string) => Promise<void>;
  openNote: (path: string) => void;
  createScratch: (folder?: string, tags?: string[]) => void;
  duplicateNote: (n: NoteMeta) => void;
  trashNote: (path: string) => void;
  startMoveToFolder: (n: NoteMeta) => void;
  togglePickToday: (path: string, pick: boolean) => void;
};

/**
 * Every context menu the sidebar and the row surfaces open: the note actions a
 * row, a cell and the note pane all share, the folder / database / saved-view /
 * tag-folder menus, the second-stage pickers they swap themselves for, and the
 * `onSidebarMenu` router that picks between them by row kind.
 *
 * It builds descriptors and holds the two states that are the menus' own (the
 * seal dialog a note action opens, the tag-folder builder sheet) — no effects,
 * so it is ordering-free against App's effect chain.
 */
export function useSidebarMenus(deps: SidebarMenusDeps) {
  const {
    view,
    setView,
    notes,
    notesRef,
    folders,
    schema,
    savedViews,
    folderMeta,
    tagFolders,
    setTagFolders,
    databases,
    dbIcons,
    homeByDb,
    orderedDashboards,
    orderedRootFolders,
    dashPaths,
    dashSplit,
    pinIds,
    pinnedPaths,
    setPinned,
    hiddenDbs,
    hiddenDbFolders,
    setDbHidden,
    customKeys,
    writeKeys,
    sectionMoveItems,
    reloadSidebarOrder,
    migrateSidebarGroupFolder,
    exportTargets,
    setExportTargets,
    setMenu,
    setFolderEdit,
    setOpenAsPicker,
    setFolderIconMenu,
    setDbIconMenu,
    setKeyPicker,
    setHomePicker,
    setDashMovePicker,
    setDbDialog,
    setDbNewSeq,
    setDbNote,
    setRenaming,
    setRenamingViewId,
    setMountDialog,
    setShare,
    noteInsertRef,
    mountByType,
    unmount,
    sealScopes,
    setSealScopeDialog,
    reloadSealScopes,
    scopeInheritedAt,
    removeSealScope,
    showToast,
    refresh,
    undoApi,
    afterOpenFlush,
    saveFolderIcon,
    saveSchemaIcon,
    setDbHome,
    reloadFolderMeta,
    restoreTrashedFolder,
    removeView,
    moveNote,
    openNote,
    createScratch,
    duplicateNote,
    trashNote,
    startMoveToFolder,
    togglePickToday,
  } = deps;

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
      // a hidden database only ever meets this menu in the All databases
      // manager — the tree row it would otherwise open from is gone
      const hidden = isDbHidden(hiddenDbs, type);
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
        // The two exits, side by side because they read alike and are
        // not: hiding takes the whole row out of the tree and KEEPS the home,
        // so showing the database again restores the row where it was;
        // un-homing keeps the row and gives back a plain folder.
        ...(home
          ? [
              hidden
                ? {
                    label: "Show in sidebar",
                    icon: <SidebarIcon />,
                    separatorAbove: true,
                    onSelect: () => setDbHidden(type, false),
                  }
                : {
                    label: "Remove from sidebar",
                    icon: <EyeOffIcon />,
                    separatorAbove: true,
                    // says what it does NOT do: no file moves, and the
                    // database keeps its place in the manager
                    hint: "stays under All databases",
                    onSelect: () => setDbHidden(type, true),
                  },
              {
                label: "Stop opening as database",
                icon: <XIcon />,
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
    [homeByDb, dbIcons, saveSchemaIcon, setDbHome, hiddenDbs, setDbHidden]
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
    /* The dep list is bracketed OUTSIDE the markers on purpose: a strip that
       took the brackets with it would leave `useCallback(fn)` behind. */
    [
    ]
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
          const home = pinLaneFolder(n.folder, n.path, dashPaths, hiddenDbFolders);
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
          const treeFolder = dashLaneFolder(target.path, dashSplit.home, hiddenDbFolders);
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
      hiddenDbFolders,
      sectionMoveItems,
      keyMenuItems,
      dashPaths,
      dashSplit,
      tagFolders,
      deleteTagFolder,
    ]
  );

  return {
    revealRel,
    sealDialog,
    setSealDialog,
    noteActionExtras,
    noteMenuItems,
    dbManagerMenu,
    dashMoveItems,
    homePickerItems,
    openAsItems,
    tagFolderEdit,
    setTagFolderEdit,
    tagCounts,
    onTagFolderEdit,
    openTag,
    saveTagFolder,
    deleteTagFolder,
    onDropNoteTagFolder,
    folderAddMenu,
    linkFolderCommand,
    savedViewMenuItems,
    keyPickerItems,
    onSidebarMenu,
  };
}
