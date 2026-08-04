import { memo, useEffect, useRef, useState } from "react";
import type { DbIcon, FolderMetaMap, NoteMeta, SavedView, TagFolder, View } from "../lib/types";
import { viewKey } from "../lib/types";
import { vaultRoot } from "../lib/ipc";
import {
  applyOrder,
  orderedRootNodes,
  orderedSiblingFolders,
  reorderIds,
  splitDashboards,
  splitPins,
  NOTE_DRAG_MIME,
  DB_DRAG_MIME,
  SIDE_DRAG_MIME,
  KEY_DRAG_MIME,
  FOLDER_DRAG_MIME,
  type FolderNode,
} from "../lib/sidebar";
import { keyForTarget, keyLabel } from "../lib/keyassign";
import { tagFolderSummary } from "../lib/tags";
import InlineEdit from "./InlineEdit";
import InfoView from "./InfoView";
import TypeIcon from "./TypeIcon";
import { dashboardIcon, folderDefaultIcon, iconForType } from "../lib/dbicons";
import {
  BookIcon,
  CalendarIcon,
  ChartIcon,
  ChevronIcon,
  ClockIcon,
  DbIcon as DbGlyphIcon,
  FolderIcon,
  FolderOpenIcon,
  GearIcon,
  MountIcon,
  NoteIcon,
  NotesIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SparkleIcon,
  SyncIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

function shortenHome(p: string): string {
  const m = p.match(/^\/Users\/[^/]+(.*)$/);
  return m ? `~${m[1]}` : p;
}

/** parent folder of a vault-relative path ("" for a root). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export type FolderEdit = { kind: "create"; parent: string } | { kind: "rename"; path: string };

export type MenuTarget =
  | { kind: "folder"; path: string }
  /** SUB-698: a Dashboards-section group header. Its folder gets the same menu
      a tree folder does — the kind exists so the Move up/down entries ride the
      "dashgroups" lane the header actually reorders in, not the folder tree's. */
  | { kind: "dashgroup"; path: string }
  | { kind: "dashboard"; path: string }
  | { kind: "db"; type: string }
  | { kind: "savedview"; id: string }
  /** a plain note pinned to the sidebar (SUB-410) */
  | { kind: "pin"; path: string }
  /** a tag-query folder (SUB-818) — Edit/Delete, and the key-assign lane */
  | { kind: "tagfolder"; id: string }
  /** SUB-492: a fixed destination row (Today/Notes/Calendar/Journal/…). It has
      no actions of its own — its menu exists purely so the key-assign lane is
      reachable without a drag; `token` is already the target token. */
  | { kind: "fixed"; token: string };

interface SidebarProps {
  view: View;
  setView: (v: View) => void;
  /** Runtime mobile capability (kept in lockstep with the layout query). */
  mobile: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** collapse the sidebar to the slim rail (SUB-394, desktop only) */
  onToggleHidden: () => void;
  /** untyped notes count — the Notes view's badge (SUB-70) */
  scratchCount: number;
  /** collapsed sidebar sections from `$sidebar.collapsed` (SUB-70):
      section ids ("dashboards" | "savedviews" | "folders") */
  collapsedIds: string[];
  onToggleCollapse: (id: string) => void;
  /** per-type database icons (SUB-27), keyed by type name */
  icons: Record<string, DbIcon>;
  /** folder path → database type for dbs with a home folder (SUB-85): the
      folder tree renders those rows as the database; every database (homed
      or not) is also reachable from the All databases manager (SUB-159) */
  homeDbByFolder: Record<string, string>;
  /** SUB-888: the folded names of databases that are mounted folders. A homed
      db row for one gets the mount glyph, and opens the mount view — which is
      why opening a db goes through `onOpenDb` rather than setView here. */
  mountDbs: ReadonlySet<string>;
  onOpenDb: (type: string) => void;
  dashboards: NoteMeta[];
  /** SUB-594: the paths in `dashboards`, computed by App so the pin split and
      App's pin menu math run off the identical set. A pinned dashboard already
      has a Dashboards-section row, so it must not nest in the folder tree too. */
  dashPaths: ReadonlySet<string>;
  /** plain notes pinned to the sidebar (SUB-410), in `$sidebar.pins` order */
  pinned: NoteMeta[];
  /** open a pinned note in its home context */
  onOpenNote: (path: string) => void;
  /** the open note's path — a pinned row for it renders active */
  selectedPath: string | null;
  /** a note dragged onto the Pinned section gets pinned (SUB-410) */
  onPinNote: (path: string) => void;
  /** pinned saved views (SUB-18), flat in their own sidebar section */
  savedViews: SavedView[];
  folders: string[];
  /** persisted ROOT-folder drag order (SUB-401) — `$sidebar.folders` */
  folderOrder: string[];
  /** persisted Dashboards group-header drag order (SUB-698) — `$sidebar.dashgroups` */
  dashGroupOrder: string[];
  /** move a Dashboards group's folder under `target` ("" = vault root), SUB-698 */
  onMoveFolder: (path: string, target: string) => void;
  /** per-folder icons (SUB-84), keyed by vault-relative folder path */
  folderMeta: FolderMetaMap;
  /** tag-query folders (SUB-818), rendered inline with the real folders and
      told apart by the tag glyph. They hold no notes on disk, so they never
      nest and never carry children. */
  tagFolders: TagFolder[];
  /** the tag-folder builder — App owns the sheet; the sidebar only asks for
      it, either blank (new) or seeded with an existing folder to edit */
  onTagFolderEdit: (folder: TagFolder | null) => void;
  /** a note dragged onto a tag folder is TAGGED, never moved (SUB-818) */
  onDropNoteTagFolder: (path: string, id: string) => void;
  /** path of the sidebar note (dashboard) currently being renamed inline */
  renaming: string | null;
  onRenameNote: (path: string, title: string) => void | Promise<unknown>;
  onRenameCancel: () => void;
  /** id of the saved view currently being renamed inline */
  renamingView: string | null;
  onRenameView: (id: string, name: string) => void | Promise<unknown>;
  folderEdit: FolderEdit | null;
  onFolderEditChange: (fe: FolderEdit | null) => void;
  onCreateFolder: (path: string) => void | Promise<unknown>;
  onRenameFolder: (path: string, name: string) => void | Promise<unknown>;
  /** `pinnable` says the drag was a PLAIN note drag (a list row — no
      SIDE_DRAG_MIME riding along): only those may pin on an own-folder drop
      (SUB-585). A sidebar row gesture (dashboard/pin reorder) landing on its
      own folder must stay a silent no-op, or the dashboard double-renders —
      SUB-466 finding 1's regression, reopened via group headers. */
  onDropNote: (path: string, folder: string, pinnable: boolean) => void;
  /** a database dragged in from the All-databases manager (SUB-403): the
      folder it lands on — plain row or another db's home row alike —
      becomes the database's home folder */
  onDropDb: (type: string, folder: string) => void;
  /** the Folders "+" anchored menu (New folder / New database…) — App owns
      the items, the dialog and folder-edit setters live there (SUB-403) */
  onAddMenu: (x: number, y: number) => void;
  onReorderSection: (section: Section, ids: string[]) => void;
  onContextMenu: (target: MenuTarget, x: number, y: number) => void;
  /** today's daily note is the one being looked at */
  journalActive: boolean;
  onJournal: () => void;
  onOpenSearch: () => void;
  onCapture: () => void;
  /** SUB-467: assignable keys. `keys` is `$sidebar.keys` (key token → target
      token); `active` says the key HUD is open, which only changes how the
      sidebar LOOKS — the drop targets stay live either way, because a chip
      already sitting on a row can always be dragged to another one. `onAssign`
      writes one binding. */
  keyAssign?: {
    active: boolean;
    keys: Record<string, string>;
    onAssign: (token: string, target: string) => void;
  };
  /** open the ⌘, settings sheet from the bottom-rail gear (SUB-476) */
  onOpenSettings: () => void;
  /** open the vault-wide history scrubber (SUB-822) */
  onOpenTimeTravel: () => void;
  /** SUB-822: already browsing the past — the clock's own call
      (history_snapshot) is a write and the guard rejects it, so the button
      goes quiet instead of erroring. */
  viewingPast?: boolean;
}

/** The reorderable sidebar lanes (SUB-585): the Dashboards section's rows, one
    folder sibling group per depth ("folders" = roots, "folders:<parent>" = the
    children of <parent>), one pin group per surface ("pins" = the flat Pinned
    section, "pins:<folder>" = the pins nested under a tree row), and — SUB-605
    — one group per folder whose tree row hosts dashboards
    ("dashes:<folder>"), plus — SUB-698 — the Dashboards section's subfolder
    GROUP HEADERS ("dashgroups"), which order against each other rather than
    against the dashboard rows inside them. A drag never crosses lanes: the
    token is part of the payload, so a tree dashboard reorders among its
    folder's dashboards only. */
export type Section =
  | "dashboards"
  | `dashes:${string}`
  | "dashgroups"
  | "folders"
  | `folders:${string}`
  | "pins"
  | `pins:${string}`;

function Sidebar({
  view,
  setView,
  mobile,
  mobileOpen,
  onMobileClose,
  onToggleHidden,
  scratchCount,
  collapsedIds,
  onToggleCollapse,
  icons,
  homeDbByFolder,
  mountDbs,
  onOpenDb,
  dashboards,
  dashPaths,
  pinned,
  onOpenNote,
  selectedPath,
  onPinNote,
  savedViews,
  folders,
  folderOrder,
  dashGroupOrder,
  onMoveFolder,
  folderMeta,
  tagFolders,
  onTagFolderEdit,
  onDropNoteTagFolder,
  renaming,
  onRenameNote,
  onRenameCancel,
  renamingView,
  onRenameView,
  folderEdit,
  onFolderEditChange,
  onCreateFolder,
  onRenameFolder,
  onDropNote,
  onDropDb,
  onAddMenu,
  onReorderSection,
  onContextMenu,
  journalActive,
  onJournal,
  onOpenSearch,
  onCapture,
  keyAssign,
  onOpenSettings,
  onOpenTimeTravel,
  viewingPast = false,
}: SidebarProps) {
  const key = viewKey(view);
  const [root, setRoot] = useState("~/Vault");
  useEffect(() => {
    vaultRoot()
      .then((r) => setRoot(shortenHome(r)))
      .catch(() => undefined);
  }, []);

  // SUB-627: geometry changes that fire no scroll event still flip the gate —
  // a resized window moves clientHeight, expanding/collapsing a folder moves
  // scrollHeight. ResizeObserver catches the first, MutationObserver the
  // second; both are mount-once, so nothing runs per render or per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      setScrolledY(el.scrollTop > 0);
      setMoreBelow(el.scrollTop < el.scrollHeight - el.clientHeight - 1);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const foldersOpen = !collapsedIds.includes("folders");
  const dashboardsOpen = !collapsedIds.includes("dashboards");
  const pinnedOpen = !collapsedIds.includes("pinned");
  // a note dragged over the Pinned section (SUB-410) highlights the section
  const [pinDrop, setPinDrop] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrolledY, setScrolledY] = useState(false);
  // SUB-627: the tree's last visible row was hard-clipped by .side-bottom's
  // divider when it overflowed — nothing said "more below". Same gate idiom
  // the table edges use (SUB-195): paint the fade only while the scroller can
  // still move, so at the stop the last row renders crisp.
  const [moreBelow, setMoreBelow] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  // the tag folder a dragged note is hovering (SUB-818) — its own state, not
  // dropFolder's, because the two lanes mean different things: one moves the
  // file, the other tags it in place
  const [dropTagFolder, setDropTagFolder] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ section: Section; id: string; after: boolean } | null>(
    null
  );
  // the section the live reorder drag started in — a dashboard hovering a
  // folder row (or vice versa) must not light the indicator for a drop that
  // would no-op (dragover can't read the payload, only its MIME)
  const [dragSection, setDragSection] = useState<Section | null>(null);

  // SUB-466: dashboards in a subfolder of their home folder render under a
  // collapsible group header; the home folder's own stay flat above the groups.
  // SUB-605: one filed in a CONTENT folder leaves the section entirely and
  // renders inside that folder's tree row instead (`dashesByFolder`) — one
  // split decides all three, so no path can render twice.
  const {
    home: dashHome,
    flat: flatDashboards,
    groups: rawDashGroups,
    byFolder: dashesByFolder,
    // SUB-1079: the folder list so an existing (even empty) `Dashboards/`
    // folder is the section's home outright, inference only without one
  } = splitDashboards(dashboards, folders);

  // SUB-698: the headers follow their own persisted drag order, groups the
  // user never dragged staying in the split's alphabetical order behind them.
  const dashGroups = applyOrder(rawDashGroups, dashGroupOrder, (g) => g.folder);

  // the tree follows the persisted drag order at EVERY depth (SUB-401 roots,
  // SUB-585 nested): one flat `$sidebar.folders` list, each sibling group
  // reading its own slice; hidden surfaces (Journal/Dashboards) never render
  const tree = orderedRootNodes(folders, folderOrder);
  const orderedChildren = (node: FolderNode) => applyOrder(node.children, folderOrder, (n) => n.path);

  // SUB-585: pinned notes render under their home folder's tree row; only
  // pins with no tree row keep the flat section — vault root, hidden surfaces,
  // and pinned dashboards, which already have a Dashboards-section row
  // (SUB-594; `dashPaths` comes from App so its pin menus split identically)
  const { flat: flatPins, byFolder: pinsByFolder } = splitPins(pinned, dashPaths);

  // a "new subfolder" edit starts visible: make sure the Folders section and
  // its parent folder are expanded
  useEffect(() => {
    if (folderEdit?.kind !== "create") return;
    if (collapsedIds.includes("folders")) onToggleCollapse("folders");
    if (!folderEdit.parent) return;
    setCollapsed((c) => {
      if (!c.has(folderEdit.parent)) return c;
      const next = new Set(c);
      next.delete(folderEdit.parent);
      return next;
    });
  }, [folderEdit, collapsedIds, onToggleCollapse]);

  const toggleCollapsed = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /* ----- key chips → destination rows (SUB-467) ----- */

  // the row a key chip is hovering, by target token — highlight only
  const [keyDrop, setKeyDrop] = useState<string | null>(null);

  const isKeyPayload = (e: React.DragEvent) => e.dataTransfer.types.includes(KEY_DRAG_MIME);

  // every DESTINATION row takes a key chip: the drop binds that key to this
  // target, stealing it from wherever it sat. Section headers and + buttons
  // are not destinations and stay inert.
  const keyDropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isKeyPayload(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (keyDrop !== target) setKeyDrop(target);
    },
    onDragLeave: () => {
      if (keyDrop === target) setKeyDrop(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isKeyPayload(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setKeyDrop(null);
      const token = e.dataTransfer.getData(KEY_DRAG_MIME);
      if (token) keyAssign?.onAssign(token, target);
    },
  });

  const keyDropClass = (target: string) => (keyDrop === target ? " drop-target" : "");

  // the chip a row wears, permanently — an assigned key is part of the row,
  // not a mode. Dragging it off is how it moves or comes back to the HUD.
  const keyChip = (target: string) => {
    const token = keyAssign ? keyForTarget(keyAssign.keys, target) : null;
    if (!token) return null;
    return (
      <span
        className="side-count side-shortcut side-key-chip"
        draggable
        title={`${keyLabel(token)} — drag to move or drop on the key panel to clear`}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(KEY_DRAG_MIME, token);
          e.dataTransfer.effectAllowed = "move";
        }}
        // the chip lives inside a <button>; a click on it would navigate
        onClick={(e) => e.stopPropagation()}
      >
        {keyLabel(token)}
      </span>
    );
  };

  const item = (
    k: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    count?: number,
    hint?: string,
    active?: boolean
  ) => (
    <button
      type="button"
      key={k}
      className={`side-item${(active ?? key === k) ? " active" : ""}${keyDropClass(k)}`}
      onClick={onClick}
      aria-label={label}
      aria-current={(active ?? key === k) ? "page" : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu({ kind: "fixed", token: k }, e.clientX, e.clientY);
      }}
      {...keyDropProps(k)}
    >
      <span className="side-chevron-spacer" />
      {icon}
      <span>{label}</span>
      {/* with a shortcut also on the row, the count tucks in after the label —
          two auto margins would strand it mid-gap; the hint owns the right edge */}
      {count !== undefined && count > 0 && (
        <span className={`side-count${hint ? " side-count-inline" : ""}`}>{count}</span>
      )}
      {hint && <span className="side-count side-shortcut">{hint}</span>}
      {keyChip(k)}
    </button>
  );

  // SUB-618: every row in the rail — fixed, dashboard, pin, folder — starts
  // with the chevron gutter, so one icon column runs top to bottom. A row's
  // indent is purely its tree depth; depth 0 matches `.side-item`'s own 8px
  // padding, so a root folder row sits in the same column as Today.
  const rowPad = (depth: number) => 8 + depth * 14;

  // one saved-view row — only pins of dbs WITHOUT a home folder render in
  // the sidebar (under All databases); homed dbs surface their pins as tabs
  // inside the database view, so the folder tree stays uncluttered (SUB-391)
  const savedViewRow = (v: SavedView, depth: number) =>
    renamingView === v.id ? (
      <div
        key={v.id}
        className={`side-item side-view${key === `sv:${v.id}` ? " active" : ""}`}
        style={{ paddingLeft: rowPad(depth) }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ kind: "savedview", id: v.id }, e.clientX, e.clientY);
        }}
      >
        <span className="side-chevron-spacer" />
        <PinIcon />
        <InlineEdit
          initial={v.name}
          onCommit={(name) => onRenameView(v.id, name)}
          onCancel={onRenameCancel}
        />
      </div>
    ) : (
      <button
        type="button"
        key={v.id}
        className={`side-item side-view${key === `sv:${v.id}` ? " active" : ""}${keyDropClass(
          `sv:${v.id}`
        )}`}
        style={{ paddingLeft: rowPad(depth) }}
        onClick={() => setView({ kind: "saved", id: v.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ kind: "savedview", id: v.id }, e.clientX, e.clientY);
        }}
        aria-label={v.name}
        aria-current={key === `sv:${v.id}` ? "page" : undefined}
        {...keyDropProps(`sv:${v.id}`)}
      >
        <span className="side-chevron-spacer" />
        <PinIcon />
        <span className="side-label-text">{v.name}</span>
        {keyChip(`sv:${v.id}`)}
      </button>
    );

  /* ----- note / database → folder drop targets ----- */

  const folderDragProps = (path: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (
        !e.dataTransfer.types.includes(NOTE_DRAG_MIME) &&
        !e.dataTransfer.types.includes(DB_DRAG_MIME) &&
        !e.dataTransfer.types.includes(FOLDER_DRAG_MIME)
      )
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropFolder !== path) setDropFolder(path);
    },
    onDragLeave: () => {
      if (dropFolder === path) setDropFolder(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropFolder(null);
      const notePath = e.dataTransfer.getData(NOTE_DRAG_MIME);
      if (notePath) {
        onDropNote(notePath, path, !e.dataTransfer.types.includes(SIDE_DRAG_MIME));
        return;
      }
      // SUB-698: a Dashboards group header dropped here moves the whole
      // subfolder under this row; the engine no-ops a move onto its own parent
      const folderPath = e.dataTransfer.getData(FOLDER_DRAG_MIME);
      if (folderPath) {
        if (folderPath !== path) onMoveFolder(folderPath, path);
        return;
      }
      const dbType = e.dataTransfer.getData(DB_DRAG_MIME);
      if (dbType) onDropDb(dbType, path);
    },
  });

  // the Dashboards header as a drop target (SUB-605): folderDragProps minus
  // the database lane — a db homed on the hidden Dashboards/ folder would have
  // no tree row to render on. Notes (a tree dashboard coming home, or a plain
  // list note) move into the dashboards home folder.
  const dashHomeDropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(NOTE_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropFolder !== dashHome) setDropFolder(dashHome);
    },
    onDragLeave: () => {
      if (dropFolder === dashHome) setDropFolder(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(NOTE_DRAG_MIME)) return;
      e.preventDefault();
      setDropFolder(null);
      const notePath = e.dataTransfer.getData(NOTE_DRAG_MIME);
      if (notePath) {
        onDropNote(notePath, dashHome, !e.dataTransfer.types.includes(SIDE_DRAG_MIME));
      }
    },
  };

  /* ----- section reorder drag (SUB-401 roots; SUB-585 every lane) ----- */

  // the lane's current display-order ids — the base a drop reorders. Folder
  // lanes hand back sibling paths at the lane's depth; pin lanes hand back
  // note paths inside that surface, in the split order rendered above.
  const sectionIds = (section: Section): string[] => {
    // SUB-605: the SECTION's lane is the rows the section RENDERS — its flat
    // rows then its group members, in render order — not every dashboard in
    // the vault. Feeding the whole list back made a move against a neighbour
    // that lives in the folder tree a silent no-op (reorderIds/moveId would
    // swap two ids the section never draws).
    if (section === "dashboards") {
      return [...flatDashboards, ...dashGroups.flatMap((g) => g.items)].map((d) => d.path);
    }
    if (section.startsWith("dashes:")) {
      return (dashesByFolder.get(section.slice("dashes:".length)) ?? []).map((d) => d.path);
    }
    // SUB-698: the group HEADERS are their own lane, keyed by folder path
    if (section === "dashgroups") return dashGroups.map((g) => g.folder);
    if (section === "pins") return flatPins.map((n) => n.path);
    if (section.startsWith("pins:")) {
      return (pinsByFolder.get(section.slice("pins:".length)) ?? []).map((n) => n.path);
    }
    if (section.startsWith("folders:")) {
      return orderedSiblingFolders(folders, folderOrder, section.slice("folders:".length));
    }
    return tree.map((n) => n.path);
  };

  const reorderDragProps = (section: Section, id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(SIDE_DRAG_MIME, JSON.stringify({ section, id }));
      e.dataTransfer.effectAllowed = "move";
      setDragSection(section);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(SIDE_DRAG_MIME) || dragSection !== section) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      if (dropAt?.section !== section || dropAt.id !== id || dropAt.after !== after) {
        setDropAt({ section, id, after });
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropAt(null);
      setDragSection(null);
      try {
        const { section: s, id: dragged } = JSON.parse(e.dataTransfer.getData(SIDE_DRAG_MIME));
        if (s !== section) return;
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        onReorderSection(section, reorderIds(sectionIds(section), dragged, id, after));
      } catch {
        /* foreign drag — ignore */
      }
    },
    onDragEnd: () => {
      setDropAt(null);
      setDragSection(null);
    },
  });

  // a folder row is a note/db drop target (NOTE_DRAG_MIME / DB_DRAG_MIME,
  // SUB-403) and a reorder drag source/target (SIDE_DRAG_MIME) within its own
  // sibling group (SUB-585 — roots ride "folders", nested rows
  // "folders:<parent>") — one handler set would override the other on spread,
  // so dispatch on the drag's MIME. A note drag from a LIST row carries only
  // NOTE_DRAG_MIME; a sidebar row being reordered carries SIDE_DRAG_MIME too,
  // and the reorder lane wins while the drag stays inside its group (dropping
  // a pin row on a foreign folder row still moves the file).
  // SUB-698 adds FOLDER_DRAG_MIME to the lane: a group header dragged out of
  // the Dashboards section lands on a tree row as "move this directory here".
  const isDropPayload = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(NOTE_DRAG_MIME) ||
    e.dataTransfer.types.includes(DB_DRAG_MIME) ||
    e.dataTransfer.types.includes(FOLDER_DRAG_MIME);
  const folderRowDragProps = (section: Section, path: string, target: string) => {
    const drop = folderDragProps(path);
    const reorder = reorderDragProps(section, path);
    const keys = keyDropProps(target);
    const reorderLive = (e: React.DragEvent) =>
      e.dataTransfer.types.includes(SIDE_DRAG_MIME) && dragSection === section;
    return {
      draggable: true,
      onDragStart: reorder.onDragStart,
      onDragOver: (e: React.DragEvent) => {
        if (isKeyPayload(e)) keys.onDragOver(e);
        else if (reorderLive(e)) reorder.onDragOver(e);
        else if (isDropPayload(e)) drop.onDragOver(e);
      },
      onDragLeave: (e: React.DragEvent) => {
        keys.onDragLeave();
        drop.onDragLeave();
        void e;
      },
      onDrop: (e: React.DragEvent) => {
        if (isKeyPayload(e)) keys.onDrop(e);
        else if (reorderLive(e)) reorder.onDrop(e);
        else if (isDropPayload(e)) drop.onDrop(e);
      },
      onDragEnd: reorder.onDragEnd,
    };
  };

  // SUB-698: a dash group header is three things at once — a note drop target
  // (a dashboard dragged onto it files into the group), a reorder row in the
  // "dashgroups" lane, and a drag SOURCE carrying its folder toward the tree.
  // Same MIME dispatch as folderRowDragProps, and the same rule: while the drag
  // stays inside the group lane the reorder wins, so dragging header A past
  // header B reorders instead of nesting A inside B.
  // A key chip dropped on the header assigns to `folder:<path>` — the same
  // token the group's menu assigns, and the same lane a tree folder row has.
  const dashGroupRowProps = (folder: string) => {
    const drop = folderDragProps(folder);
    const reorder = reorderDragProps("dashgroups", folder);
    const keys = keyDropProps(`folder:${folder}`);
    const reorderLive = (e: React.DragEvent) =>
      e.dataTransfer.types.includes(SIDE_DRAG_MIME) && dragSection === "dashgroups";
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        reorder.onDragStart(e);
        e.dataTransfer.setData(FOLDER_DRAG_MIME, folder);
      },
      onDragOver: (e: React.DragEvent) => {
        if (isKeyPayload(e)) keys.onDragOver(e);
        else if (reorderLive(e)) reorder.onDragOver(e);
        else if (isDropPayload(e)) drop.onDragOver(e);
      },
      onDragLeave: (e: React.DragEvent) => {
        keys.onDragLeave();
        drop.onDragLeave();
        void e;
      },
      onDrop: (e: React.DragEvent) => {
        if (isKeyPayload(e)) keys.onDrop(e);
        else if (reorderLive(e)) reorder.onDrop(e);
        else if (isDropPayload(e)) drop.onDrop(e);
      },
      onDragEnd: reorder.onDragEnd,
    };
  };

  // the Pinned section takes plain note drags only. A sidebar row dragged to be
  // reordered or moved carries SIDE_DRAG_MIME as well (SUB-466's dashboard rows
  // carry both payloads), and such a gesture is never "pin this" — accepting it
  // pinned the dashboard the user was only trying to move, rendering it twice
  const isPinPayload = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(NOTE_DRAG_MIME) &&
    !e.dataTransfer.types.includes(SIDE_DRAG_MIME);

  const dropClass = (section: Section, id: string) =>
    dropAt?.section === section && dropAt.id === id
      ? dropAt.after
        ? " drop-after"
        : " drop-before"
      : "";

  /* ----- dashboard rows (SUB-466: flat rows + subfolder groups) ----- */

  // a dashboard row drags for BOTH jobs: reorder inside the section
  // (SIDE_DRAG_MIME) and move-to-folder (NOTE_DRAG_MIME) when it lands on a
  // folder row or a group header — one dragstart carrying both payloads, each
  // target picking the MIME it understands. It also RECEIVES key chips
  // (SUB-467), so the incoming side dispatches on the drag's MIME the same way
  // rootFolderDragProps does.
  const dashDragProps = (path: string, section: Section) => {
    const reorder = reorderDragProps(section, path);
    const keys = keyDropProps(`dash:${path}`);
    return {
      ...reorder,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(NOTE_DRAG_MIME, path);
        reorder.onDragStart(e);
      },
      onDragOver: (e: React.DragEvent) =>
        isKeyPayload(e) ? keys.onDragOver(e) : reorder.onDragOver(e),
      onDragLeave: keys.onDragLeave,
      onDrop: (e: React.DragEvent) => (isKeyPayload(e) ? keys.onDrop(e) : reorder.onDrop(e)),
    };
  };

  /**
   * One dashboard row. `section` is its reorder lane — the Dashboards section's
   * own rows ride "dashboards", a SUB-605 tree row rides "dashes:<folder>".
   * `depth` is the row's tree depth on the rail's shared indent scale (SUB-618):
   * 0 for a section row, 1 for a SUB-466 group member, and the folder's own
   * depth + 1 for a tree-nested one, which lines it up with the sibling folder
   * and pin rows around it.
   */
  const dashRow = (
    d: NoteMeta,
    { section = "dashboards" as Section, depth = 0, nested = false } = {} as {
      section?: Section;
      depth?: number;
      nested?: boolean;
    }
  ) => {
    // every dashboard carries its own mark (SUB-391): frontmatter `icon:`
    // first, then the curated per-kind glyph, then the shared chart glyph
    const dIcon = dashboardIcon(d.props);
    const dashIcon = dIcon ? <TypeIcon type={d.title} icon={dIcon} /> : <ChartIcon />;
    // SUB-605: `side-dash-nested` marks a row the folder TREE owns rather than
    // the Dashboards section — the two surfaces are otherwise identical rows,
    // and telling them apart is exactly the no-dual-render invariant. It is a
    // structure/test hook only: no CSS rule targets it (the indent rides
    // rowPad(depth), SUB-618), so styling stays in styles.css
    const cls = `side-item${nested ? " side-dash-nested" : ""}${
      key === `dash:${d.path}` ? " active" : ""
    }${keyDropClass(`dash:${d.path}`)}${dropClass(section, d.path)}`;
    const menu = (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu({ kind: "dashboard", path: d.path }, e.clientX, e.clientY);
    };
    return renaming === d.path ? (
      <div
        key={d.path}
        className={cls}
        style={{ paddingLeft: rowPad(depth) }}
        onContextMenu={menu}
        {...dashDragProps(d.path, section)}
      >
        <span className="side-chevron-spacer" />
        {dashIcon}
        <InlineEdit
          initial={d.title}
          onCommit={(v) => onRenameNote(d.path, v)}
          onCancel={onRenameCancel}
        />
      </div>
    ) : (
      <button
        type="button"
        key={d.path}
        className={cls}
        style={{ paddingLeft: rowPad(depth) }}
        onClick={() => setView({ kind: "dashboard", path: d.path })}
        onContextMenu={menu}
        aria-label={d.title}
        aria-current={key === `dash:${d.path}` ? "page" : undefined}
        {...dashDragProps(d.path, section)}
      >
        <span className="side-chevron-spacer" />
        {dashIcon}
        <span className="side-label-text">{d.title}</span>
        {keyChip(`dash:${d.path}`)}
      </button>
    );
  };

  // one pinned-note row: the flat Pinned section (SUB-410) and, nested at a
  // depth, under its home folder's tree row (SUB-585). Drags like a dashboard
  // row — SIDE_DRAG_MIME reorders it inside its own pin group, and the
  // NOTE_DRAG_MIME payload riding along means dropping it on a folder row
  // MOVES the file (the engine retargets the pin to the new path).
  const pinRow = (n: NoteMeta, section: Section, depth = 0) => {
    // a pinned note wears its own `icon:` frontmatter mark when it has one
    // (same resolution dashboards use), else the note glyph
    const mark = dashboardIcon(n.props);
    const reorder = reorderDragProps(section, n.path);
    const keys = keyDropProps(`note:${n.path}`);
    return (
      <button
        type="button"
        key={n.path}
        className={`side-item${selectedPath === n.path ? " active" : ""}${keyDropClass(
          `note:${n.path}`
        )}${dropClass(section, n.path)}`}
        style={{ paddingLeft: rowPad(depth) }}
        onClick={() => onOpenNote(n.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ kind: "pin", path: n.path }, e.clientX, e.clientY);
        }}
        aria-label={n.title}
        {...reorder}
        onDragStart={(e) => {
          e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
          reorder.onDragStart(e);
        }}
        onDragOver={(e) => (isKeyPayload(e) ? keys.onDragOver(e) : reorder.onDragOver(e))}
        onDragLeave={keys.onDragLeave}
        onDrop={(e) => (isKeyPayload(e) ? keys.onDrop(e) : reorder.onDrop(e))}
      >
        {/* every row wears the tree's chevron gutter so its icon lines up with
            sibling folder rows at the same depth (SUB-618) */}
        <span className="side-chevron-spacer" />
        {mark ? <TypeIcon type={n.title} icon={mark} /> : <NoteIcon />}
        <span className="side-label-text">{n.title}</span>
        {keyChip(`note:${n.path}`)}
      </button>
    );
  };

  /* ----- tag folders (SUB-818) ----- */

  // Rendered inline with the real folders, above the tree: they are the same
  // KIND of destination, so they sit in the same list, and the tag glyph is
  // what says "this one gathers, it doesn't contain". A note dropped here is
  // tagged in place — hence the "copy" drop effect, not the tree's "move".
  const tagFolderRow = (f: TagFolder) => {
    const target = `tagfolder:${f.id}`;
    const active = key === target;
    return (
      <div
        key={f.id}
        className={`side-item side-folder${active ? " active" : ""}${
          dropTagFolder === f.id ? " drop-target" : ""
        }${keyDropClass(target)}`}
        style={{ paddingLeft: rowPad(0) }}
        data-tagfolder={f.id}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ kind: "tagfolder", id: f.id }, e.clientX, e.clientY);
        }}
        {...keyDropProps(target)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(NOTE_DRAG_MIME)) {
            e.preventDefault();
            // "move" to match what note drags allow (effectAllowed = "move" at
            // every source); a mismatched pair makes the browser swallow the
            // drop outright. The drop still only TAGS — nothing moves on disk.
            e.dataTransfer.dropEffect = "move";
            if (dropTagFolder !== f.id) setDropTagFolder(f.id);
            return;
          }
          keyDropProps(target).onDragOver(e);
        }}
        onDragLeave={() => {
          if (dropTagFolder === f.id) setDropTagFolder(null);
          keyDropProps(target).onDragLeave();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(NOTE_DRAG_MIME)) {
            e.preventDefault();
            e.stopPropagation();
            setDropTagFolder(null);
            const path = e.dataTransfer.getData(NOTE_DRAG_MIME);
            if (path) onDropNoteTagFolder(path, f.id);
            return;
          }
          keyDropProps(target).onDrop(e);
        }}
      >
        <span className="side-chevron-spacer" />
        <button
          type="button"
          className="side-destination"
          onClick={() => setView({ kind: "tagfolder", id: f.id })}
          onDoubleClick={() => onTagFolderEdit(f)}
          aria-label={f.name}
          aria-current={active ? "page" : undefined}
          title={tagFolderSummary(f)}
        >
          <TypeIcon type={f.name} icon={f.icon ?? { glyph: "tag" }} />
          <span className="side-label-text">{f.name}</span>
          {keyChip(target)}
        </button>
      </div>
    );
  };

  /* ----- folder tree ----- */

  const createRow = (parent: string, depth: number) => (
    <div className="side-item side-folder" style={{ paddingLeft: rowPad(depth) }}>
      <span className="side-chevron-spacer" />
      <FolderIcon />
      <InlineEdit
        initial=""
        placeholder="Folder name"
        onCommit={(v) => onCreateFolder(parent ? `${parent}/${v}` : v)}
        onCancel={() => onFolderEditChange(null)}
      />
    </div>
  );

  const renderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const open = !collapsed.has(node.path);
    const isRenaming = folderEdit?.kind === "rename" && folderEdit.path === node.path;
    // pinned notes nest under their folder's row (SUB-585) — subfolders
    // first, then the folder's own dashboards (SUB-605), then its pins; any of
    // them makes the row expandable
    const nodePins = pinsByFolder.get(node.path) ?? [];
    const nodeDashes = dashesByFolder.get(node.path) ?? [];
    const hasKids = node.children.length > 0 || nodeDashes.length > 0 || nodePins.length > 0;
    // SUB-605: dashboards filed in this folder, rendered here INSTEAD of in the
    // Dashboards section (splitDashboards routes each path to exactly one)
    const dashKids = (open: boolean, depth: number) =>
      open
        ? nodeDashes.map((d) =>
            dashRow(d, { section: `dashes:${node.path}`, depth, nested: true })
          )
        : null;
    // this row's sibling group: roots reorder in the classic "folders" lane,
    // nested rows in their parent's own lane
    const section: Section = depth === 0 ? "folders" : `folders:${parentOf(node.path)}`;
    const kids = orderedChildren(node);
    // a folder's SUB-84 icon replaces the plain glyph (the engine only stores
    // real marks, so meta present = a mark to render); with none set, a
    // curated name default steps in (SUB-391) before the plain folder glyph
    const icon = folderMeta[node.path]?.icon ?? folderDefaultIcon(node.name);
    // SUB-85: a database's home folder opens as the database — db icon,
    // click = db view, chevron expands its real subfolders.
    // SUB-611 legibility: the row KEEPS the folder's on-disk name and wears
    // a small DB chip instead of silently swapping identity to the type
    // label — the sidebar mirrors disk, the chip says what a click does.
    const homeDb = homeDbByFolder[node.path];
    if (homeDb) {
      const dbLabel = homeDb.charAt(0).toUpperCase() + homeDb.slice(1);
      // saved-view pins do NOT nest here (SUB-391) — the database view's tab
      // strip owns them; the chevron expands real subfolders and NOTE pins
      // (SUB-585), which nest under any folder row, db-dressed or plain
      const expandable = hasKids;
      return (
        <div key={node.path}>
          <div
            className={`side-item side-folder${key === `db:${homeDb}` ? " active" : ""}${
              dropFolder === node.path ? " drop-target" : ""
            }${keyDropClass(`db:${homeDb}`)}${dropClass(section, node.path)}`}
            style={{ paddingLeft: rowPad(depth) }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu({ kind: "db", type: homeDb }, e.clientX, e.clientY);
            }}
            {...folderRowDragProps(section, node.path, `db:${homeDb}`)}
          >
            {expandable ? (
              <button
                type="button"
                className={`side-chevron${open ? " open" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapsed(node.path);
                }}
                title={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
                aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
                aria-expanded={open}
              >
                <ChevronIcon />
              </button>
            ) : (
              <span className="side-chevron-spacer" />
            )}
            <button
              type="button"
              className="side-destination"
              onClick={() => onOpenDb(homeDb)}
              aria-label={node.name}
              title={`Opens the ${dbLabel} database`}
              aria-current={key === `db:${homeDb}` ? "page" : undefined}
            >
              <TypeIcon type={homeDb} icon={iconForType(icons, homeDb)} />
              <span className="side-label-text">{node.name}</span>
              {mountDbs.has(homeDb.toLowerCase()) && (
                <span className="side-mount" title="Mounted folder">
                  <MountIcon />
                </span>
              )}
              <span className="side-db-chip">DB</span>
              {keyChip(`db:${homeDb}`)}
            </button>
          </div>
          {open && kids.map((c) => renderNode(c, depth + 1))}
          {dashKids(open, depth + 1)}
          {open && nodePins.map((n) => pinRow(n, `pins:${node.path}`, depth + 1))}
          {open && folderEdit?.kind === "create" && folderEdit.parent === node.path
            ? createRow(node.path, depth + 1)
            : null}
        </div>
      );
    }
    return (
      <div key={node.path}>
        <div
          className={`side-item side-folder${key === `folder:${node.path}` ? " active" : ""}${
            dropFolder === node.path ? " drop-target" : ""
          }${keyDropClass(`folder:${node.path}`)}${dropClass(section, node.path)}`}
          style={{ paddingLeft: rowPad(depth) }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu({ kind: "folder", path: node.path }, e.clientX, e.clientY);
          }}
          {...folderRowDragProps(section, node.path, `folder:${node.path}`)}
        >
          {hasKids ? (
            <button
              type="button"
              className={`side-chevron${open ? " open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapsed(node.path);
              }}
              title={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
              aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
              aria-expanded={open}
            >
              <ChevronIcon />
            </button>
          ) : (
            <span className="side-chevron-spacer" />
          )}
          {isRenaming ? (
            <>
              {icon ? (
                <TypeIcon type={node.name} icon={icon} />
              ) : hasKids && open ? (
                <FolderOpenIcon />
              ) : (
                <FolderIcon />
              )}
              <InlineEdit
                initial={node.name}
                onCommit={(v) =>
                  v !== node.name ? onRenameFolder(node.path, v) : onFolderEditChange(null)
                }
                onCancel={() => onFolderEditChange(null)}
              />
            </>
          ) : (
            <button
              type="button"
              className="side-destination"
              onClick={() => setView({ kind: "folder", path: node.path })}
              aria-label={node.name}
              aria-current={key === `folder:${node.path}` ? "page" : undefined}
            >
              {icon ? (
                <TypeIcon type={node.name} icon={icon} />
              ) : hasKids && open ? (
                <FolderOpenIcon />
              ) : (
                <FolderIcon />
              )}
              <span className="side-label-text">{node.name}</span>
              {keyChip(`folder:${node.path}`)}
            </button>
          )}
        </div>
        {open && kids.map((c) => renderNode(c, depth + 1))}
        {dashKids(open, depth + 1)}
        {open && nodePins.map((n) => pinRow(n, `pins:${node.path}`, depth + 1))}
        {open && folderEdit?.kind === "create" && folderEdit.parent === node.path
          ? createRow(node.path, depth + 1)
          : null}
      </div>
    );
  };

  return (
    <div
      className={`sidebar${mobileOpen ? " mobile-open" : ""}${
        keyAssign?.active ? " key-assign-active" : ""
      }`}
      aria-hidden={mobile ? !mobileOpen : undefined}
    >
      <div className="sidebar-drag" data-tauri-drag-region />
      <div className={`sidebar-head${scrolledY ? " scrolled" : ""}`}>
        <span className="sidebar-title">Substrate</span>
        <div className="sidebar-head-actions">
          {!mobile && (
            <button
              className="sidebar-new"
              onClick={onToggleHidden}
              title="Hide sidebar (⌘\)"
              aria-label="Hide sidebar"
            >
              <SidebarIcon />
            </button>
          )}
          <button
            className="sidebar-new sidebar-capture"
            onClick={onCapture}
            title={mobile ? "New note" : "New note (⌘N)"}
          >
            <PlusIcon />
          </button>
          {mobile && (
            <button className="sidebar-mobile-close" onClick={onMobileClose} aria-label="Close navigation">
              <XIcon />
            </button>
          )}
        </div>
      </div>
      {/* SUB-259: an unchanged boolean bails out of re-render, so the rail
          only re-renders when the header hairline actually flips (SUB-194) */}
      <div
        className={`sidebar-scroll${scrolledY ? " side-scrolled-y" : ""}${
          moreBelow ? " side-more-y" : ""
        }`}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrolledY(el.scrollTop > 0);
          setMoreBelow(el.scrollTop < el.scrollHeight - el.clientHeight - 1);
        }}
      >
        {item("today", "Today", <SunIcon />, () => setView({ kind: "today" }), undefined, "⌘1")}
        {item("notes", "Notes", <NotesIcon />, () => setView({ kind: "notes" }), scratchCount, "⌘2")}
        {item("all", "All notes", <NoteIcon />, () => setView({ kind: "all" }), undefined, "⌘3")}
        {item("calendar", "Calendar", <CalendarIcon />, () => setView({ kind: "calendar" }), undefined, "⌘4")}
        {item("search", "Search", <SearchIcon />, onOpenSearch, undefined, "⌘⇧F")}
        <button
          type="button"
          className={`side-item${journalActive ? " active" : ""}${keyDropClass("journal")}`}
          onClick={onJournal}
          title="Today's journal (⌘D)"
          aria-label="Journal"
          aria-current={journalActive ? "page" : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu({ kind: "fixed", token: "journal" }, e.clientX, e.clientY);
          }}
          {...keyDropProps("journal")}
        >
          <span className="side-chevron-spacer" />
          <BookIcon />
          <span>Journal</span>
          <span className="side-count side-shortcut">⌘D</span>
          {keyChip("journal")}
        </button>
        {/* the Dashboards section also hosts the built-in Proxy status view
            (SUB-294) where the machine runs a proxy (SUB-441) — it belongs
            with the other dashboards, not the bottom rail */}
        {/* SUB-605: the header is the way BACK — a dashboard dragged out of the
            folder tree and dropped here moves the file into the dashboards home
            folder, the mirror of dropping a section row onto a folder row. It
            takes NOTE drags only: the shared folderDragProps would also accept
            a database dragged in from the All-databases manager, and homing a
            database on the hidden Dashboards/ folder gives it no visible row at
            all. A drop from inside the home subtree is a no-op App skips. */}
        <div
          className={`side-label side-label-row${
            dropFolder === dashHome ? " drop-target" : ""
          }`}
          {...dashHomeDropProps}
        >
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => onToggleCollapse("dashboards")}
            title={dashboardsOpen ? "Collapse" : "Expand"}
            aria-expanded={dashboardsOpen}
          >
            <span className={`side-chevron${dashboardsOpen ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <span>Dashboards</span>
          </button>
        </div>
        {dashboardsOpen && (
          <>
            {flatDashboards.map((d) => dashRow(d))}
            {/* SUB-466: one indent level of subfolder groups. The header is a
                folder row — collapse rides the persisted `collapsedIds`
                (`dashgroup:<folder>`), and a dashboard dropped on it moves
                the file into that subfolder */}
            {dashGroups.map((g) => {
              const gid = `dashgroup:${g.folder}`;
              const open = !collapsedIds.includes(gid);
              // SUB-698: the group's menu carries the folder lane's Rename…,
              // so the header needs the tree row's inline-edit branch too —
              // without it the rename state would arm with nothing to type in
              const renaming = folderEdit?.kind === "rename" && folderEdit.path === g.folder;
              return (
                <div key={g.folder}>
                  <div
                    className={`side-item side-folder side-dash-group${
                      dropFolder === g.folder ? " drop-target" : ""
                    }${keyDropClass(`folder:${g.folder}`)}${dropClass("dashgroups", g.folder)}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onContextMenu({ kind: "dashgroup", path: g.folder }, e.clientX, e.clientY);
                    }}
                    {...dashGroupRowProps(g.folder)}
                  >
                    <button
                      type="button"
                      className={`side-chevron${open ? " open" : ""}`}
                      onClick={() => onToggleCollapse(gid)}
                      title={open ? `Collapse ${g.name}` : `Expand ${g.name}`}
                      aria-label={open ? `Collapse ${g.name}` : `Expand ${g.name}`}
                      aria-expanded={open}
                    >
                      <ChevronIcon />
                    </button>
                    {renaming ? (
                      <>
                        {open ? <FolderOpenIcon /> : <FolderIcon />}
                        <InlineEdit
                          initial={g.name}
                          onCommit={(v) =>
                            v !== g.name ? onRenameFolder(g.folder, v) : onFolderEditChange(null)
                          }
                          onCancel={() => onFolderEditChange(null)}
                        />
                      </>
                    ) : (
                      <button
                        type="button"
                        className="side-destination"
                        onClick={() => setView({ kind: "folder", path: g.folder })}
                        aria-label={g.name}
                      >
                        {open ? <FolderOpenIcon /> : <FolderIcon />}
                        <span className="side-label-text">{g.name}</span>
                        {keyChip(`folder:${g.folder}`)}
                      </button>
                    )}
                  </div>
                  {open && g.items.map((d) => dashRow(d, { depth: 1 }))}
                  {/* a "New subfolder…" from the group's menu edits here, the
                      same inline row the tree gives a folder (SUB-698) */}
                  {open && folderEdit?.kind === "create" && folderEdit.parent === g.folder
                    ? createRow(g.folder, 1)
                    : null}
                </div>
              );
            })}
          </>
        )}

        {/* SUB-159: the flat Databases section (homeless dbs only) is gone —
            one persistent entry opens the manager listing EVERY database */}
        {item("dbmanager", "All databases", <DbGlyphIcon />, () =>
          setView({ kind: "dbmanager" })
        )}

        {/* saved views of dbs without a home folder (no tree row to nest
            under) still need a home — they hang off All databases */}
        {savedViews
          .filter((v) => !Object.values(homeDbByFolder).includes(v.db))
          .map((v) => savedViewRow(v, 1))}

        {/* SUB-410: plain notes pinned to the sidebar. The section only exists
            while something is pinned — an empty header would be chrome nobody
            asked for; the row menu's "Pin to sidebar" creates the first pin,
            and a note dragged onto the section adds more. Pins whose home
            folder has a tree row render THERE instead (SUB-585); this flat
            section keeps the rest (vault root, Journal/Dashboards notes). */}
        {flatPins.length > 0 && (
          <div
            onDragOver={(e) => {
              if (!isPinPayload(e)) return;
              e.preventDefault();
              // "move" to match what note drags allow (effectAllowed = "move"
              // at every source, SUB-1023): a dropEffect outside effectAllowed
              // is reset to "none" by the browser, and no drop event fires at
              // all — the section silently refused every real gesture while
              // the spec's dispatched events, which skip that negotiation,
              // kept passing. Nothing is copied or moved on disk either way;
              // the drop only adds a sidebar row (same note as the tag-folder
              // target above).
              e.dataTransfer.dropEffect = "move";
              if (!pinDrop) setPinDrop(true);
            }}
            onDragLeave={() => setPinDrop(false)}
            onDrop={(e) => {
              e.preventDefault();
              setPinDrop(false);
              if (!isPinPayload(e)) return;
              const notePath = e.dataTransfer.getData(NOTE_DRAG_MIME);
              if (notePath) onPinNote(notePath);
            }}
          >
            <div className={`side-label side-label-row${pinDrop ? " drop-target" : ""}`}>
              <button
                type="button"
                className="side-section-toggle"
                onClick={() => onToggleCollapse("pinned")}
                title={pinnedOpen ? "Collapse" : "Expand"}
                aria-expanded={pinnedOpen}
              >
                <span className={`side-chevron${pinnedOpen ? " open" : ""}`}>
                  <ChevronIcon />
                </span>
                <span>Pinned</span>
              </button>
            </div>
            {pinnedOpen && flatPins.map((n) => pinRow(n, "pins"))}
          </div>
        )}

        <div className="side-label side-label-row">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => onToggleCollapse("folders")}
            title={foldersOpen ? "Collapse" : "Expand"}
            aria-expanded={foldersOpen}
          >
            <span className={`side-chevron${foldersOpen ? " open" : ""}`}>
              <ChevronIcon />
            </span>
            <span>Folders</span>
          </button>
          <button
            type="button"
            className="side-add"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onAddMenu(r.left, r.bottom);
            }}
            title="New folder or database"
          >
            <PlusIcon />
          </button>
        </div>
        {foldersOpen && (
          <>
            {tree.map((n) => renderNode(n, 0))}
            {/* tag folders close the same section (SUB-818) — same row shape,
                same depth, told apart by the glyph. They sit after the real
                folders because the tree carries a persisted drag order and
                these follow their definition file instead. */}
            {tagFolders.map(tagFolderRow)}
            {folderEdit?.kind === "create" && folderEdit.parent === "" ? createRow("", 0) : null}
          </>
        )}
      </div>

      <div className="side-bottom">
        {item("vaultsync", "Vault sync", <SyncIcon />, () => setView({ kind: "vaultsync" }))}
        {item("trash", "Trash", <TrashIcon />, () => setView({ kind: "trash" }))}
        <div className="side-foot">{root}</div>
        {!mobile && (
          <div className="side-tools">
            <InfoView
              view={view}
              /* SUB-452: the release history sits beside the ? — same ghost
                 weight, because both are "about the app", not the vault */
              trailing={
                <>
                  <button
                    type="button"
                    className="side-tool-btn"
                    title={viewingPast ? "Already viewing the past" : "Browse the vault's past"}
                    aria-label="Browse the vault's past"
                    disabled={viewingPast}
                    onClick={onOpenTimeTravel}
                  >
                    <ClockIcon />
                  </button>
                  <button
                    type="button"
                    className="side-tool-btn"
                    title="What's new"
                    aria-label="What's new"
                    onClick={() => setView({ kind: "changelog" })}
                  >
                    <SparkleIcon />
                  </button>
                  {/* SUB-476: ⌘, had no visible affordance. The gear closes the
                      row (help, what's new, settings) — same ghost weight. */}
                  <button
                    type="button"
                    className="side-tool-btn"
                    title="Settings (⌘,)"
                    aria-label="Settings"
                    onClick={onOpenSettings}
                  >
                    <GearIcon />
                  </button>
                </>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* SUB-460: the sidebar is pure in its props — App-state churn that does not
   touch them (toast, overlays, palette, editor keystrokes) stops reconciling
   the whole tree. Callbacks it takes are stabilized at the App call site. */
export default memo(Sidebar);
