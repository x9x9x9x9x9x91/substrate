import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DbIcon, NoteMeta, SavedView, SearchHit, SnippetPart, TagCount, TagFolder, View } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRoot, vaultSearch, mountRescan } from "../lib/ipc";
import { setPropUndoable } from "../lib/undoprops";
import { isPickedToday } from "../lib/today";
import { useTodayIso } from "./useTodayIso";
import { useUndo } from "../lib/undoContext";
import { createLatestGuard } from "../lib/latest";
import { exportNoteMarkdown, exportNoteOneSheet, exportNotePdf } from "../lib/export";
import { useEdgeFade } from "../hooks/useEdgeFade";
import { buildNoteActions } from "../lib/noteactions";
import { scanSummary } from "../lib/mounts";
import { NO_MATCH, fuzzyScore } from "../lib/fuzzy";
import { noteHint } from "../lib/display";
import { displayTitle } from "../lib/journal";
import {
  FIXED_VIEW_COMMANDS,
  hoistAboveContent,
  markLabel,
  markSnippet,
  onlyFallbacks,
  rankCommands,
  synFuzzyScore,
} from "../lib/palette";
import { shortcutKeyLabel } from "../lib/shortcuts";
import { looksLikeUrl, urlDisplayTitle } from "../lib/url";
import { templateTypeOptions } from "../lib/templates";
import { iconForType } from "../lib/dbicons";
import type { TerminalAction } from "../lib/settings";
import {
  completeFilter,
  filterCompletions,
  filterLabel,
  matchesFilters,
  parseQuery,
} from "../lib/query";
import TypeIcon from "./TypeIcon";
import {
  BookIcon,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  CookbookIcon,
  DbIcon as DbGlyphIcon,
  ExportIcon,
  FilterIcon,
  FolderIcon,
  GearIcon,
  ImageIcon,
  KeyboardIcon,
  PulseIcon,
  LinkIcon,
  NoteActionGlyph,
  NoteIcon,
  NotesIcon,
  PenIcon,
  PinIcon,
  PlusIcon,
  PrintIcon,
  RedoIcon,
  SearchIcon,
  SparkleIcon,
  SunIcon,
  SyncIcon,
  TableIcon,
  TagIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
} from "./Icons";
import EmptyState from "./EmptyState";

type Item = {
  id: string;
  label: string;
  icon: React.ReactNode;
  section: string;
  hint?: string;
  snippet?: string;
  /** note behind this row — Tab/→ opens its actions */
  note?: NoteMeta;
  /** folder behind this row — Tab/→ opens its actions */
  folder?: string;
  /** bare destination name for nav rows ("Release" for "Go to Release") —
      ranking matches the query against it and hoists exact/prefix hits
      above the Content section */
  dest?: string;
  /** run() navigates within the palette instead of finishing */
  keepOpen?: boolean;
  /** row that renders for any query (echoes it in its label) rather than
      matching one — so a list of only these means zero real hits */
  fallback?: true;
  run: () => void;
};

/** Alternating plain/hit runs as text + <mark> — the search pane's match
    language, worn by palette rows too. */
function MarkedText({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

type Stage =
  | { kind: "root" }
  | { kind: "actions"; note: NoteMeta }
  | { kind: "setprop"; note: NoteMeta }
  | { kind: "moveto"; note: NoteMeta }
  | { kind: "rename"; note: NoteMeta }
  | { kind: "folderactions"; folder: string }
  | { kind: "newfolder"; parent: string }
  | { kind: "renamefolder"; folder: string }
  | { kind: "newtpl" }
  | { kind: "newtyped"; dbType: string };

/** Stage the palette can be opened straight into (e.g. from a context menu). */
export type StartStage = { kind: "moveto"; note: NoteMeta };

interface PaletteProps {
  mode: "palette" | "capture";
  notes: NoteMeta[];
  /** true while the app conceals AGENTS.md/CLAUDE.md/Settings.md —
      forwarded to the engine so its 30-hit page skips them */
  excludeAppFiles: boolean;
  databases: { type: string; count: number }[];
  /** per-type database icons, keyed by type name */
  icons: Record<string, DbIcon>;
  dashboards: NoteMeta[];
  folders: string[];
  /** saved views in sidebar order — every one a destination, including the
      sixth onward, which the ⌘5…⌘9 pin keys never reach */
  savedViews: SavedView[];
  /** tag folders, the saved-query siblings of real folders */
  tagFolders: TagFolder[];
  /** every tag in the vault, most-used first — a tag is a destination whether
      or not anyone ever saved a folder for it */
  tags: TagCount[];
  /** A local proxy answered the boot probe — gates the destination row for
      it. OPTIONAL on purpose, and the one thing on this component that must
      not be tightened: the surface it gates is machine-private, so the pass
      from App sits inside share-mirror fences and is not there at all in the
      shared tree. Optional plus a `false` default keeps THIS file identical
      on both sides — a required prop would need its own fences here, in the
      destructure, in the deps and at the read, and any one of those drifting
      out of step breaks the shared tree's build in a way the mirror's own
      --check does not look for. */
  proxyAvailable?: boolean;
  current: NoteMeta | null;
  startStage?: StartStage | null;
  /** types with a `.vault/templates/<type>.md` note */
  templateTypes: string[];
  /** set while a database view is active — runs its CSV export */
  onExportCsv: (() => void) | null;
  /** set while the surface on screen can print itself (the dashboards that
      carry the Print button) — null everywhere else. ⌘P opens the palette
      everywhere and always will; this is the row that press lands next to. */
  onPrint: (() => void) | null;
  /** The session undo/redo stack's next move, named in the user's
      words ("Role → booking"), or null when there is nothing to undo/redo.
      The palette is the mouse path to ⌘Z: the toast that used to carry Undo
      dies after 4s, and the keystroke was the only way back after that. */
  undoCommand: { label: string; run: () => void } | null;
  redoCommand: { label: string; run: () => void } | null;
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onSetView: (v: View) => void;
  /** open a database by name — a mounted folder lands on its mount view, so
      the palette reaches a mount without knowing what one is */
  onOpenDb: (type: string) => void;
  /** open today's journal note — the ⌘D surface, which is not the picked-notes
      Today view "Go to Today" opens */
  onOpenJournal: () => void;
  /** summon the vault's history bar; null while a past state is already on
      screen, where the sidebar glyph is disabled for the same reason */
  onOpenTimeTravel: (() => void) | null;
  /** the ⌘/ cheat sheet; null on mobile, which doesn't render it */
  onOpenShortcuts: (() => void) | null;
  /** the key-assign HUD, whose only other door is a button inside the
      cheat sheet; null on mobile, which doesn't render it */
  onAssignKeys: (() => void) | null;
  onCreate: (title: string) => void;
  onCreateFolder: (path: string) => void;
  onMoveNote: (path: string, folder: string) => void;
  onRenameNote: (path: string, title: string) => void;
  onRenameFolder: (path: string, name: string) => void;
  /** Duplicate the note in place — App creates, opens and toasts */
  onDuplicate: (note: NoteMeta) => void;
  /** Open the Send-as-link dialog for the note */
  onSendAsLink: (note: NoteMeta) => void;
  /** Trash the note via App's single path (flush + toast w/ Undo) */
  onTrashNote: (path: string) => void;
  /** Pick the note for today (or unpick it) — the Today surface's
      verb, reachable from the palette so a note with no dates at all, which
      never surfaces as a candidate in the pane, can still be picked */
  onTogglePick: (path: string, pick: boolean) => void;
  /** Pin/unpin a note in the sidebar's Pinned section */
  onTogglePin: (path: string, pinned: boolean) => void;
  /** the currently pinned note paths — flips the action's label */
  pinnedPaths: string[];
  onRevealRel: (rel: string) => void;
  /** create a typed entry born complete: schema props + template */
  onCreateTyped: (title: string, type: string) => void;
  /** open the type's `.vault/templates/<type>.md` as a note */
  onEditTemplate: (type: string) => void;
  /** open the New database dialog */
  onNewDatabase: () => void;
  /** create a `type: sheet` surface note */
  onCreateSheet: (title: string) => void;
  /** pick a CSV and open the import dialog */
  onImportCsv: () => void;
  onSwitchCapture: () => void;
  /** open the search pane — with a seed query, or with no argument to leave
      whatever was last searched in place, which is what the ⌘⇧F chord does */
  onOpenSearch: (seed?: string) => void;
  onMutated: () => void;
  /** transient result feedback (folder rescan and friends) */
  onToast: (msg: string) => void;
  /** terminal HUD, desktop only — null hides the terminal rows */
  onToggleTerminal: (() => void) | null;
  /** summon the HUD and type a command into its PTY */
  onTerminalRun: ((text: string) => void) | null;
  /** the user's own quick actions from Settings.md `terminal-actions`
 — empty on a machine that listed none, which is the default */
  terminalActions: TerminalAction[];
  /** open the ⌘, settings sheet */
  onOpenSettings: () => void;
}

async function absPath(rel: string): Promise<string> {
  const root = await vaultRoot();
  return `${root}/${rel}`;
}

/** How many tags the empty palette lists before a query narrows them. */
const TAG_BROWSE_MAX = 20;

/** The glyph a fixed destination wears, keyed by row id — the one part of the
    catalogue that has to stay here, since `src/lib` holds no JSX. Each is the
    mark that destination already carries in the sidebar. */
function viewCommandIcon(id: string): React.ReactNode {
  switch (id) {
    case "cmd:today":
      return <SunIcon />;
    case "cmd:notes":
      return <NotesIcon />;
    case "cmd:all":
      return <NoteIcon />;
    case "cmd:calendar":
      return <CalendarIcon />;
    case "cmd:search":
      return <SearchIcon />;
    case "cmd:dbmanager":
      return <DbGlyphIcon />;
    case "cmd:trash":
      return <TrashIcon />;
    case "cmd:assets":
      return <ImageIcon />;
    case "cmd:doctor":
      return <PulseIcon />;
    case "cmd:vaultsync":
      return <SyncIcon />;
    case "cmd:changelog":
      return <SparkleIcon />;
    case "cmd:cookbook":
      return <CookbookIcon />;
    // a destination added to the catalogue and not to this switch still gets
    // a row — it just wears the generic database mark until someone picks one
    default:
      return <DbGlyphIcon />;
  }
}

export default function Palette({
  mode,
  notes,
  excludeAppFiles,
  databases,
  icons,
  dashboards,
  folders,
  savedViews,
  tagFolders,
  tags,
  // absent wherever the surface it gates is — see the prop's own note
  proxyAvailable = false,
  current,
  startStage,
  templateTypes,
  onExportCsv,
  onPrint,
  undoCommand,
  redoCommand,
  onClose,
  onOpenNote,
  onSetView,
  onOpenDb,
  onOpenJournal,
  onOpenTimeTravel,
  onOpenShortcuts,
  onAssignKeys,
  onCreate,
  onCreateFolder,
  onMoveNote,
  onRenameNote,
  onRenameFolder,
  onDuplicate,
  onSendAsLink,
  onTrashNote,
  onTogglePick,
  onTogglePin,
  pinnedPaths,
  onRevealRel,
  onCreateTyped,
  onEditTemplate,
  onNewDatabase,
  onCreateSheet,
  onImportCsv,
  onSwitchCapture,
  onOpenSearch,
  onMutated,
  onToast,
  onToggleTerminal,
  onTerminalRun,
  terminalActions,
  onOpenSettings,
}: PaletteProps) {
  const undo = useUndo();
  const todayIso = useTodayIso();
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "root" });
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitsQuery, setHitsQuery] = useState("");
  const [closing, setClosing] = useState(false);
  const [searchGuard] = useState(createLatestGuard);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listFade = useEdgeFade<HTMLDivElement>();
  const closeTimer = useRef<number | undefined>(undefined);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  const close = useCallback(() => {
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 90);
  }, [onClose]);

  useEffect(() => {
    // mode switched (palette → capture): abort any pending close
    setClosing(false);
    window.clearTimeout(closeTimer.current);
  }, [mode]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode, stage]);

  const parsed = useMemo(() => parseQuery(q), [q]);
  // quoted phrases leave `text` but still search. The engine does
  // NOT phrase-adjoin them: `fts_match_expr` (vault.rs) makes every
  // whitespace token a quoted prefix and ANDs them, so `"night drive"`
  // matches a note holding both words anywhere. Real phrase search is
  // unimplemented; joining them back in keeps quoted queries searching.
  const searchText = useMemo(() => [parsed.text, ...parsed.phrases].filter(Boolean).join(" "), [parsed]);

  // The engine's LIMIT 30 page is drawn before the caller's filters
  // run, so a filtered query could page in 30 notes none of which survive.
  // Hand the filters' verdict down as a path allow-list so the cap applies
  // to the notes actually in scope. `null` = unfiltered.
  const searchScope = useMemo(() => {
    const { filters, trailing } = parsed;
    const eff =
      trailing && (trailing.partial || trailing.values.length > 0)
        ? [
            ...filters,
            {
              key: trailing.key,
              values: trailing.partial ? [...trailing.values, trailing.partial] : trailing.values,
              op: trailing.op,
              neg: trailing.neg,
            },
          ]
        : filters;
    return eff.length === 0
      ? null
      : notes.filter((n) => matchesFilters(n, eff)).map((n) => n.path);
  }, [parsed, notes]);

  useEffect(() => {
    if (mode !== "palette" || stage.kind !== "root" || !searchText) {
      // invalidate a still-in-flight search so it can't repopulate stale hits
      searchGuard.issue();
      setHits([]);
      setHitsQuery("");
      return;
    }
    const t = window.setTimeout(() => {
      const id = searchGuard.issue();
      vaultSearch(searchText, searchScope ?? undefined, excludeAppFiles)
        .then((hits) => {
          if (searchGuard.isLatest(id)) {
            setHits(hits);
            setHitsQuery(searchText);
          }
        })
        .catch((e) => {
          console.error(e);
          if (searchGuard.isLatest(id)) {
            setHits([]);
            setHitsQuery(searchText);
          }
        });
    }, 100);
    return () => window.clearTimeout(t);
  }, [searchText, searchScope, mode, stage.kind, searchGuard, excludeAppFiles]);

  const visibleHits = useMemo(
    () => (hitsQuery === searchText ? hits : []),
    [hits, hitsQuery, searchText]
  );

  const enterStage = useCallback((s: Stage, initialQ = "") => {
    setStage(s);
    setQ(initialQ);
    setSelectedId(null);
  }, []);

  // opened straight into a stage (context menu "Move to folder…")
  useEffect(() => {
    if (startStage) enterStage(startStage);
  }, [startStage, enterStage]);

  const setProp = useCallback(
    (note: NoteMeta, key: string, value: string | null) => {
      // Undoable like every other property edit
      // The palette closes on apply, so a failed write has nowhere
      // to show itself — report it on the app toast like every sibling surface
      setPropUndoable({ path: note.path, key, value, record: undo.record })
        .then(onMutated)
        .catch((e) => onToast(`couldn't set ${key} (${e})`));
    },
    [onMutated, onToast, undo]
  );

  const rescanFolders = useCallback(() => {
    mountRescan()
      .then((stats) => {
        onToast(scanSummary(stats));
        onMutated();
      })
      .catch((e) => onToast(e instanceof Error ? e.message : String(e)));
  }, [onMutated, onToast]);

  // a copy or an export that fails says so: these used to reject into the
  // console, so the palette closed on a path that was never on the clipboard
  // and a file that was never written looked exactly like a success
  const toastError = useCallback(
    (e: unknown) => onToast(e instanceof Error ? e.message : String(e)),
    [onToast]
  );

  const copyPath = useCallback(
    (note: NoteMeta) => {
      absPath(note.path)
        .then((p) => navigator.clipboard.writeText(p))
        .catch(toastError);
    },
    [toastError]
  );

  const revealNote = useCallback(
    (note: NoteMeta) => {
      onRevealRel(note.path);
    },
    [onRevealRel]
  );

  // dashboard notes open their rendered surface — the same route the sidebar
  // and the "Dashboard: …" command take — never the raw editor
  const dashboardPaths = useMemo(() => new Set(dashboards.map((d) => d.path)), [dashboards]);
  const openNote = useCallback(
    (n: NoteMeta) => {
      if (dashboardPaths.has(n.path)) onSetView({ kind: "dashboard", path: n.path });
      else onOpenNote(n.path);
    },
    [dashboardPaths, onOpenNote, onSetView]
  );

  const items: Item[] = useMemo(() => {
    if (mode === "capture") return [];

    if (stage.kind === "actions") {
      const note = stage.note;
      const section = `“${displayTitle(note)}”`;
      // The canonical note actions — same descriptors as the row
      // menu and the note pane's ⋯ menu. Set property stays palette-only
      // (its sub-stage machinery has no menu counterpart); keepOpen marks
      // the rows that navigate into a sub-stage instead of finishing
      const acts = buildNoteActions({
        open: () => openNote(note),
        moveToFolder: () => enterStage({ kind: "moveto", note }),
        rename: () => enterStage({ kind: "rename", note }, note.title),
        duplicate: () => onDuplicate(note),
        setProperty: () => enterStage({ kind: "setprop", note }),
        copyPath: () => copyPath(note),
        reveal: () => revealNote(note),
        exportMarkdown: () => exportNoteMarkdown(note).catch(toastError),
        exportPdf: () => exportNotePdf(note).catch(toastError),
        exportOneSheet: () => exportNoteOneSheet(note).catch(toastError),
        sendAsLink: () => onSendAsLink(note),
        sealed: note.sealed,
        togglePick: () => onTogglePick(note.path, !isPickedToday(note, todayIso)),
        picked: isPickedToday(note, todayIso),
        togglePin: () => onTogglePin(note.path, !pinnedPaths.includes(note.path)),
        pinned: pinnedPaths.includes(note.path),
        trash: () => onTrashNote(note.path),
      }).map((a): Item => {
        return {
          id: `act:${a.id}`,
          label: a.label,
          icon: <NoteActionGlyph name={a.icon} />,
          section,
          hint: a.hint,
          keepOpen: a.id === "move" || a.id === "rename" || a.id === "prop",
          run: a.run,
        };
      });
      return q.trim() ? acts.filter((a) => synFuzzyScore(q, a.label) > NO_MATCH) : acts;
    }

    if (stage.kind === "moveto") {
      const note = stage.note;
      const section = `Move “${displayTitle(note)}” to…`;
      const out: Item[] = [];
      if (note.folder) {
        out.push({
          id: "move:root",
          label: "Vault root",
          icon: <FolderIcon />,
          section,
          run: () => onMoveNote(note.path, ""),
        });
      }
      for (const f of folders) {
        if (f === note.folder) continue;
        out.push({
          id: `move:${f}`,
          label: f,
          icon: <FolderIcon />,
          section,
          run: () => onMoveNote(note.path, f),
        });
      }
      return q.trim() ? out.filter((i) => fuzzyScore(q, i.label) > NO_MATCH) : out;
    }

    if (stage.kind === "rename") {
      const note = stage.note;
      const name = q.trim();
      if (!name || name === note.title) {
        return [
          {
            id: "rename:hint",
            label: "Type the new title",
            icon: <PenIcon />,
            section: `Rename “${note.title}”`,
            keepOpen: true,
            run: () => undefined,
          },
        ];
      }
      return [
        {
          id: "rename:apply",
          label: `Rename to “${name}”`,
          icon: <PenIcon />,
          section: `Rename “${note.title}”`,
          run: () => onRenameNote(note.path, name),
        },
      ];
    }

    if (stage.kind === "folderactions") {
      const folder = stage.folder;
      const acts: Item[] = [
        {
          id: "fa:open",
          label: "Open",
          icon: <FolderIcon />,
          section: `“${folder}”`,
          run: () => onSetView({ kind: "folder", path: folder }),
        },
        {
          id: "fa:newsub",
          label: "New subfolder…",
          icon: <PlusIcon />,
          section: `“${folder}”`,
          keepOpen: true,
          run: () => enterStage({ kind: "newfolder", parent: folder }),
        },
        {
          id: "fa:rename",
          label: "Rename…",
          icon: <PenIcon />,
          section: `“${folder}”`,
          keepOpen: true,
          run: () =>
            enterStage({ kind: "renamefolder", folder }, folder.split("/").pop() ?? ""),
        },
        {
          id: "fa:reveal",
          label: "Reveal in Finder",
          icon: <FolderIcon />,
          section: `“${folder}”`,
          run: () => onRevealRel(folder),
        },
      ];
      return q.trim() ? acts.filter((a) => synFuzzyScore(q, a.label) > NO_MATCH) : acts;
    }

    if (stage.kind === "newfolder") {
      const { parent } = stage;
      const section = parent ? `New folder inside ${parent}` : "New folder";
      const name = q.trim();
      if (!name) {
        return [
          {
            id: "nf:hint",
            label: "Type a folder name — nest with /",
            icon: <PlusIcon />,
            section,
            keepOpen: true,
            run: () => undefined,
          },
        ];
      }
      const path = parent ? `${parent}/${name}` : name;
      if (folders.includes(path)) {
        return [
          {
            id: "nf:exists",
            label: `“${path}” already exists`,
            icon: <FolderIcon />,
            section,
            keepOpen: true,
            run: () => undefined,
          },
        ];
      }
      return [
        {
          id: "nf:create",
          label: `New folder “${path}”`,
          icon: <PlusIcon />,
          section,
          run: () => onCreateFolder(path),
        },
      ];
    }

    if (stage.kind === "renamefolder") {
      const folder = stage.folder;
      const name = q.trim();
      const currentName = folder.split("/").pop() ?? "";
      if (!name || name === currentName) {
        return [
          {
            id: "rf:hint",
            label: "Type the new folder name",
            icon: <PenIcon />,
            section: `Rename ${folder}`,
            keepOpen: true,
            run: () => undefined,
          },
        ];
      }
      return [
        {
          id: "rf:apply",
          label: `Rename to “${name}”`,
          icon: <PenIcon />,
          section: `Rename ${folder}`,
          run: () => onRenameFolder(folder, name),
        },
      ];
    }

    if (stage.kind === "setprop") {
      const note = stage.note;
      const out: Item[] = [];
      const m = q.match(/^\s*(\p{L}[\p{L}\p{N}_#-]*)\s*[:=]?\s*(.*)$/u);
      const key = m?.[1];
      const value = m?.[2].trim() ?? "";
      if (key) {
        out.push({
          id: "prop:apply",
          label: value ? `Set ${key}: ${value}` : `Clear ${key}`,
          icon: <TagIcon />,
          section: `“${displayTitle(note)}”`,
          run: () => setProp(note, key, value || null),
        });
      }
      for (const k of Object.keys(note.props)) {
        if (key && !k.toLowerCase().startsWith(key.toLowerCase())) continue;
        const vs = propStr(note.props, k) ?? "";
        out.push({
          id: `prop:${k}`,
          label: `${k}: ${vs}`,
          icon: <TagIcon />,
          section: `“${displayTitle(note)}”`,
          hint: "edit",
          keepOpen: true,
          run: () => setQ(`${k}: ${vs}`),
        });
      }
      return out;
    }

    // "New from template…" — pick a type, then give the entry a title
    if (stage.kind === "newtpl") {
      return templateTypeOptions(databases, templateTypes)
        .filter((o) => !q.trim() || fuzzyScore(q, o.type) > NO_MATCH)
        .map((o) => ({
          id: `tpl:${o.type}`,
          label: `New ${o.type}…`,
          icon: <TypeIcon type={o.type} icon={iconForType(icons, o.type)} />,
          section: "New from template",
          hint: o.hasTemplate ? "template" : undefined,
          keepOpen: true,
          run: () => enterStage({ kind: "newtyped", dbType: o.type }),
        }));
    }

    if (stage.kind === "newtyped") {
      const t = q.trim();
      const hasT = templateTypes.some((x) => x.toLowerCase() === stage.dbType.toLowerCase());
      const rows: Item[] = [
        {
          id: "newtyped:create",
          label: t ? `New ${stage.dbType} “${t}”` : `New ${stage.dbType}…`,
          icon: <PlusIcon />,
          section: "New from template",
          hint: t ? undefined : "type a title",
          keepOpen: !t,
          run: () => {
            if (t) onCreateTyped(t, stage.dbType);
          },
        },
        // the type's `.vault/templates/<type>.md` as an editable note
        {
          id: "newtyped:template",
          label: hasT ? `Edit ${stage.dbType} template` : `Create ${stage.dbType} template`,
          icon: <PenIcon />,
          section: "New from template",
          run: () => onEditTemplate(stage.dbType),
        },
      ];
      return q.trim() ? rows.filter((r) => synFuzzyScore(q, r.label) > NO_MATCH) : rows;
    }

    // root stage
    const out: Item[] = [];
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const { filters, trailing } = parsed;
    // A quoted phrase is a typed query like any other — leaving it
    // out here made `"spectral"` render the Recent list, as if nothing had
    // been typed, while its search was already in flight.
    const hasOps = filters.length > 0 || trailing !== null || parsed.phrases.length > 0;

    // a partially typed value already narrows (prefix match) — feels live;
    // multi-value stubs narrow on their committed segments too
    const effFilters =
      trailing && (trailing.partial || trailing.values.length > 0)
        ? [
            ...filters,
            {
              key: trailing.key,
              values: trailing.partial ? [...trailing.values, trailing.partial] : trailing.values,
              op: trailing.op,
              neg: trailing.neg,
            },
          ]
        : filters;
    const filtered = effFilters.length
      ? notes.filter((n) => matchesFilters(n, effFilters))
      : notes;

    if (trailing) {
      const source = filters.length
        ? notes.filter((n) => matchesFilters(n, filters))
        : notes;
      for (const v of filterCompletions(source, trailing.key, trailing.partial)) {
        out.push({
          id: `filter:${trailing.key}:${v}`,
          label: filterLabel(trailing.key, trailing.op, [...trailing.values, v], trailing.neg),
          icon: <FilterIcon />,
          section: "Filter",
          hint: "↩ apply",
          keepOpen: true,
          run: () => setQ(completeFilter(q, trailing.key, v, trailing.op)),
        });
      }
    }

    // Gate on what was actually SEARCHED, not on `parsed.text` — a
    // quoted-only query ("spectral") has empty `text`, so this branch never
    // ran and the fetched hits had nowhere to render.
    if (searchText) {
      const scored = filtered
        // dailies match by either face: the stem ("2026-07-18") or the human
        // date shown in lists ("Sat, 18 Jul 2026")
        .map((n) => ({
          n,
          s: Math.max(fuzzyScore(searchText, n.title), fuzzyScore(searchText, displayTitle(n))),
        }))
        .filter((x) => x.s > NO_MATCH)
        .sort((a, b) => b.s - a.s)
        .slice(0, 9);
      for (const { n } of scored) {
        out.push({
          id: `note:${n.path}`,
          label: displayTitle(n),
          icon: <NoteIcon />,
          section: "Notes",
          hint: noteHint(n),
          note: n,
          run: () => openNote(n),
        });
      }
      const seen = new Set(scored.map((x) => x.n.path));
      const inScope = new Set(filtered.map((n) => n.path));
      for (const h of visibleHits) {
        if (out.filter((i) => i.section === "Content").length >= 6) break;
        if (seen.has(h.path) || !inScope.has(h.path)) continue;
        const n = byPath.get(h.path);
        if (!n) continue;
        out.push({
          id: `hit:${h.path}`,
          label: displayTitle(n),
          icon: <SearchIcon />,
          section: "Content",
          // a hit that landed only in a property value marks nothing in the
          // body — the opening prose would sit there explaining nothing. Show
          // the value that answered the query, and say where it came from.
          snippet: h.prop_snippet ?? h.snippet,
          hint: h.prop_snippet ? "in properties" : undefined,
          note: n,
          run: () => openNote(n),
        });
      }
    } else if (effFilters.length) {
      // operators only — every match, freshest first (notes arrive recency-sorted)
      for (const n of filtered.slice(0, 12)) {
        out.push({
          id: `note:${n.path}`,
          label: displayTitle(n),
          icon: <NoteIcon />,
          section: "Notes",
          hint: noteHint(n),
          note: n,
          run: () => openNote(n),
        });
      }
    } else {
      for (const n of notes.slice(0, 6)) {
        out.push({
          id: `recent:${n.path}`,
          label: displayTitle(n),
          icon: <ClockIcon />,
          section: "Recent",
          hint: noteHint(n),
          note: n,
          run: () => openNote(n),
        });
      }
    }

    if (searchText || hasOps) {
      out.push({
        id: "cmd:searchall",
        label: `See all results${searchText ? ` for “${searchText}”` : ""}…`,
        icon: <SearchIcon />,
        section: "Search",
        hint: shortcutKeyLabel("search"),
        fallback: true,
        run: () => onOpenSearch(q),
      });
    }

    if (!hasOps) {
      // a pasted link is an intent to capture, not to search — top slot, so
      // plain Enter files the reference note (onCreate routes URLs there)
      const urlQ = looksLikeUrl(q) ? q.trim() : null;
      if (urlQ) {
        out.unshift({
          id: "cmd:capture-url",
          label: `Capture URL “${urlDisplayTitle(urlQ)}”`,
          icon: <LinkIcon />,
          section: "Capture",
          hint: "reference",
          run: () => onCreate(urlQ),
        });
      }
      const commands: Item[] = [
        {
          id: "cmd:new",
          label: q.trim() ? `New note “${q.trim()}”` : "New note…",
          icon: <PlusIcon />,
          section: "Commands",
          hint: shortcutKeyLabel("new-note"),
          fallback: true,
          run: () => (q.trim() ? onCreate(q.trim()) : onSwitchCapture()),
        },
        {
          id: "cmd:newfolder",
          label: "New folder…",
          icon: <FolderIcon />,
          section: "Commands",
          keepOpen: true,
          run: () => enterStage({ kind: "newfolder", parent: "" }),
        },
        {
          id: "cmd:newdb",
          label: "New database…",
          icon: <DbGlyphIcon />,
          section: "Commands",
          run: onNewDatabase,
        },
        {
          id: "cmd:newsheet",
          label: q.trim() ? `New sheet “${q.trim()}”` : "New sheet",
          icon: <TableIcon />,
          section: "Commands",
          hint: "formulas",
          fallback: true,
          run: () => onCreateSheet(q.trim() || "Untitled sheet"),
        },
        {
          id: "cmd:import-csv",
          label: "Import CSV as database…",
          icon: <DbGlyphIcon />,
          section: "Commands",
          run: onImportCsv,
        },
        ...(databases.length > 0
          ? [
              {
                id: "cmd:newtpl",
                label: "New from template…",
                icon: <DbGlyphIcon />,
                section: "Commands",
                keepOpen: true,
                run: () => enterStage({ kind: "newtpl" }),
              },
            ]
          : []),
        ...(current
          ? [
              {
                id: "cmd:actions",
                label: `Actions: “${current.title}”`,
                icon: <TagIcon />,
                section: "Commands",
                keepOpen: true,
                run: () => enterStage({ kind: "actions", note: current }),
              },
            ]
          : []),
        // Undo/redo where the mouse can reach them. The row names
        // the move it would make, so it stays unambiguous even while a board
        // owns ⌘Z for its own local history.
        ...(undoCommand
          ? [
              {
                id: "cmd:undo",
                label: `Undo ${undoCommand.label}`,
                icon: <UndoIcon />,
                section: "Commands",
                hint: shortcutKeyLabel("undo"),
                run: undoCommand.run,
              },
            ]
          : []),
        ...(redoCommand
          ? [
              {
                id: "cmd:redo",
                label: `Redo ${redoCommand.label}`,
                icon: <RedoIcon />,
                section: "Commands",
                hint: shortcutKeyLabel("redo"),
                run: redoCommand.run,
              },
            ]
          : []),
        ...(onExportCsv
          ? [
              {
                id: "cmd:export-csv",
                label: "Export CSV…",
                icon: <ExportIcon />,
                section: "Commands",
                run: onExportCsv,
              },
            ]
          : []),
        // Print, for the surface that can print itself. ⌘P is the palette's
        // own chord here and stays that way; anyone pressing it out of habit
        // from every other app finds printing one row away instead of a
        // dialog the webview never opens.
        ...(onPrint
          ? [
              {
                id: "cmd:print",
                label: "Print…",
                icon: <PrintIcon />,
                section: "Commands",
                run: onPrint,
              },
            ]
          : []),
        {
          id: "cmd:rescan-mounts",
          label: "Rescan mounted folders",
          icon: <FolderIcon />,
          section: "Commands",
          run: rescanFolders,
        },
        // terminal HUD: desktop-only rows; the quick actions are
        // keystrokes into the configured agent CLI, not an API — any CLI
        // that knows the slash command works
        ...(onToggleTerminal
          ? [
              {
                id: "cmd:terminal",
                label: "Toggle terminal",
                icon: <TerminalIcon />,
                section: "Commands",
                hint: shortcutKeyLabel("terminal-toggle"),
                run: onToggleTerminal,
              },
            ]
          : []),
        // quick actions are the user's own: whatever Settings.md's
        // `terminal-actions` lists, nothing when it lists nothing. They used
        // to be two rows naming the author's personal agent skills, which on
        // any other machine typed a command no CLI knew.
        ...(onTerminalRun
          ? terminalActions.map((a, i) => ({
              id: `cmd:term-action-${i}`,
              label: a.label,
              icon: <TerminalIcon />,
              section: "Commands",
              hint: a.command,
              run: () => onTerminalRun(`${a.command}\r`),
            }))
          : []),
        {
          id: "cmd:settings",
          label: "Settings…",
          icon: <GearIcon />,
          section: "Commands",
          hint: shortcutKeyLabel("settings-open"),
          run: onOpenSettings,
        },
        // Every fixed destination, from the one catalogue a drift test can
        // read. Rows that need a door of their own rather than a plain
        // navigation are named below.
        ...FIXED_VIEW_COMMANDS.filter(
          (c) =>
            (c.when?.({ proxyAvailable }) ?? true) &&
            // Once something is typed, "See all results…" IS the search row and
            // it carries the query across. Two rows printing one keycap and
            // doing different things with the query is worse than one, so the
            // generic row stands down and browse mode keeps it.
            !(c.view.kind === "search" && searchText)
        ).map((c) => ({
          id: c.id,
          label: c.label,
          icon: viewCommandIcon(c.id),
          section: "Commands",
          ...(c.dest ? { dest: c.dest } : {}),
          ...(c.shortcut ? { hint: shortcutKeyLabel(c.shortcut) } : {}),
          // No seed, so the pane opens on whatever was last searched — what
          // the chord this row prints does. And through the pane's own door,
          // which stashes the view Esc comes back to; setting the view
          // directly lands there with no way back.
          run: c.view.kind === "search" ? () => onOpenSearch() : () => onSetView(c.view),
        })),
        // Today's journal — the ⌘D surface, and deliberately NOT where "Go to
        // Today" lands: that one opens the picked-notes view. The pair being
        // two different places is exactly why the journal needed a row rather
        // than being read into the one above it.
        {
          id: "cmd:journal",
          label: "Open today's journal",
          icon: <BookIcon />,
          section: "Commands",
          hint: shortcutKeyLabel("journal-today"),
          dest: "Journal",
          run: onOpenJournal,
        },
        // The vault's own history, which until now was an unlabelled clock
        // glyph in the sidebar footer — nothing about it was searchable, and
        // no key reached it. Absent while a past state is already on screen.
        ...(onOpenTimeTravel
          ? [
              {
                id: "cmd:timetravel",
                label: "Browse the vault's past",
                icon: <ClockIcon />,
                section: "Commands",
                dest: "Time travel",
                run: onOpenTimeTravel,
              },
            ]
          : []),
        ...(onOpenShortcuts
          ? [
              {
                id: "cmd:shortcuts",
                label: "Keyboard shortcuts",
                icon: <KeyboardIcon />,
                section: "Commands",
                hint: shortcutKeyLabel("shortcuts-cmd"),
                dest: "Keyboard shortcuts",
                run: onOpenShortcuts,
              },
            ]
          : []),
        // the key HUD's only other door is a button inside the sheet above —
        // so someone who never opens the sheet never learns keys are assignable
        ...(onAssignKeys
          ? [
              {
                id: "cmd:assignkeys",
                label: "Assign keys to sidebar rows…",
                icon: <KeyboardIcon />,
                section: "Commands",
                run: onAssignKeys,
              },
            ]
          : []),
        // with a query, a dashboard that already surfaced as a note row
        // would list twice — both rows open the rendered surface —
        // so the command copy is dropped. The empty-query browse
        // list stays complete: Recent is recency, Commands is the catalog.
        ...dashboards
          .filter((d) => !searchText || !out.some((i) => i.note?.path === d.path))
          .map((d) => ({
            id: `cmd:dash:${d.path}`,
            label: `Dashboard: ${d.title}`,
            icon: <ChartIcon />,
            section: "Commands",
            dest: d.title,
            run: () => onSetView({ kind: "dashboard", path: d.path }),
          })),
        ...databases.map((db) => {
          const name = db.type.charAt(0).toUpperCase() + db.type.slice(1);
          return {
            id: `cmd:db:${db.type}`,
            label: `Go to ${name}`,
            icon: <TypeIcon type={db.type} icon={iconForType(icons, db.type)} />,
            section: "Commands",
            dest: name,
            // through the app's one open-a-database door rather than straight
            // to the database view: a mounted folder's name IS a database
            // type, and only that door knows to land on the mount instead
            run: () => onOpenDb(db.type),
          };
        }),
        // Saved views, which had no palette route at all and no key past the
        // fifth pin. Same destination a click on the sidebar row reaches.
        ...savedViews.map((v) => ({
          id: `cmd:saved:${v.id}`,
          label: `Go to ${v.name}`,
          icon: <PinIcon />,
          section: "Commands",
          dest: v.name,
          run: () => onSetView({ kind: "saved", id: v.id }),
        })),
        ...tagFolders.map((f) => ({
          id: `cmd:tagfolder:${f.id}`,
          label: `Go to ${f.name}`,
          icon: <TypeIcon type={f.name} icon={f.icon ?? { glyph: "tag" }} />,
          section: "Commands",
          dest: f.name,
          run: () => onSetView({ kind: "tagfolder", id: f.id }),
        })),
        // Pick the open note for today from anywhere. The pane can
        // only offer Pick on notes that already carry a date, so this is the
        // one route a dateless note has onto Today. Rides ahead of the
        // Folders spread: itemSections groups by contiguity, so a Commands
        // row after Folders painted a second "Commands" header on cold open.
        ...(current
          ? [
              {
                id: "cmd:pick",
                label: isPickedToday(current, todayIso)
                  ? "Unpick from today"
                  : "Pick for today",
                icon: <SunIcon />,
                section: "Commands",
                run: () => onTogglePick(current.path, !isPickedToday(current, todayIso)),
              },
            ]
          : []),
        ...folders.map((f) => ({
          id: `cmd:folder:${f}`,
          label: f,
          icon: <FolderIcon />,
          section: "Folders",
          folder: f,
          dest: f.split("/").pop() ?? f,
          run: () => onSetView({ kind: "folder", path: f }),
        })),
        // Every tag is a collection whether or not anyone saved a folder for
        // it, and clicking one inside a note was the only way to open it.
        // Their own section, after Folders: the same KIND of destination.
        //
        // Capped in browse mode only. A mature vault carries hundreds of
        // tags and the cold-open list is meant to be readable, so it shows
        // the most-used ones (the list arrives count-ordered); type anything
        // and every tag is back in play, because ranking is what finds the
        // rare one and a cap there would hide it for good.
        ...(searchText ? tags : tags.slice(0, TAG_BROWSE_MAX)).map((t) => ({
          id: `cmd:tag:${t.tag}`,
          label: `#${t.tag}`,
          icon: <TagIcon />,
          section: "Tags",
          dest: t.tag,
          run: () => onSetView({ kind: "tag", tag: t.tag }),
        })),
      ];
      // rank by fuzzy score (declaration order breaks ties); destinations in
      // the exact/prefix band render directly under Notes, above Content
      const { ranked, hoisted } = rankCommands(q, commands);
      out.push(...ranked);
      return hoistAboveContent(out, hoisted);
    }
    return out;
  }, [
    mode,
    stage,
    q,
    parsed,
    searchText,
    notes,
    visibleHits,
    databases,
    icons,
    dashboards,
    folders,
    savedViews,
    tagFolders,
    tags,
    proxyAvailable,
    current,
    templateTypes,
    onExportCsv,
    onPrint,
    openNote,
    onSetView,
    onOpenDb,
    onOpenJournal,
    onOpenTimeTravel,
    onOpenShortcuts,
    onAssignKeys,
    onCreate,
    onCreateFolder,
    onMoveNote,
    onRenameNote,
    onRenameFolder,
    onRevealRel,
    onCreateTyped,
    onEditTemplate,
    onImportCsv,
    onSwitchCapture,
    onOpenSearch,
    enterStage,
    setProp,
    onTrashNote,
    onSendAsLink,
    onTogglePick,
    todayIso,
    onTogglePin,
    pinnedPaths,
    copyPath,
    revealNote,
    toastError,
    rescanFolders,
    onToggleTerminal,
    onTerminalRun,
    terminalActions,
    onOpenSettings,
  ]);

  const itemSections = useMemo(() => {
    const out: { section: string; start: number; items: Item[] }[] = [];
    for (const [index, item] of items.entries()) {
      const current = out[out.length - 1];
      if (!current || current.section !== item.section) {
        out.push({ section: item.section, start: index, items: [item] });
      } else {
        current.items.push(item);
      }
    }
    return out;
  }, [items]);

  // Result batches can arrive after the synchronous command/note rows. Keep
  // the user's active item by identity so an inserted Content section cannot
  // silently move selection to a different action at the same index.
  const selectedIndex = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
  const sel = selectedIndex >= 0 ? selectedIndex : 0;
  const selectIndex = useCallback(
    (index: number) => setSelectedId(items[index]?.id ?? null),
    [items]
  );

  useEffect(() => {
    if (selectedId && selectedIndex < 0) setSelectedId(null);
  }, [selectedId, selectedIndex]);

  useEffect(() => {
    if (!selectedId && items[0]) setSelectedId(items[0].id);
  }, [selectedId, items]);

  useEffect(() => {
    setSelectedId(null);
  }, [q, mode, stage]);

  // the "See all results…"/"New note…" fallbacks render unconditionally, so
  // zero hits used to look identical to results still loading
  // `searchText`, not `parsed.text` — a quoted-only query is a real query
  // and deserves a real "no matches" too
  // fallback rows carry a flag rather than being listed by id here: the old
  // whitelist went stale when "New sheet" landed and killed the banner for
  // every plain-text query
  const noMatches = stage.kind === "root" && searchText !== "" && onlyFallbacks(items);

  // keep the selected row visible when arrow-keying past the fold
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (item: Item) => {
    if (item.keepOpen) {
      item.run();
      inputRef.current?.focus();
      return;
    }
    close();
    item.run();
  };

  const pop = () => {
    setQ("");
    setSelectedId(null);
    setStage((s) => {
      switch (s.kind) {
        case "setprop":
        case "moveto":
        case "rename":
          return { kind: "actions", note: s.note };
        case "renamefolder":
          return { kind: "folderactions", folder: s.folder };
        case "newfolder":
          return s.parent ? { kind: "folderactions", folder: s.parent } : { kind: "root" };
        case "newtyped":
          return { kind: "newtpl" };
        default:
          return { kind: "root" };
      }
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (stage.kind === "root") close();
      else pop();
      return;
    }
    if (mode === "capture") {
      if (e.key === "Enter" && q.trim()) {
        e.preventDefault();
        close();
        onCreate(q.trim());
      }
      return;
    }
    if (e.key === "Backspace" && q === "" && stage.kind !== "root") {
      e.preventDefault();
      pop();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      selectIndex(Math.min(sel + 1, Math.max(0, items.length - 1)));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      selectIndex(Math.max(sel - 1, 0));
    } else if (e.key === "Tab" || e.key === "ArrowRight") {
      const cursorAtEnd = inputRef.current?.selectionStart === q.length;
      const it = items[sel];
      if (it?.note && (e.key === "Tab" || cursorAtEnd)) {
        e.preventDefault();
        enterStage({ kind: "actions", note: it.note });
      } else if (it?.folder && (e.key === "Tab" || cursorAtEnd)) {
        e.preventDefault();
        enterStage({ kind: "folderactions", folder: it.folder });
      } else if (e.key === "Tab") {
        e.preventDefault(); // never tab focus out of the palette
      }
    } else if (e.key === "Enter" && items[sel]) {
      e.preventDefault();
      run(items[sel]);
    }
  };

  const placeholder =
    stage.kind === "actions" || stage.kind === "folderactions"
      ? "Filter actions…"
      : stage.kind === "setprop"
        ? "key: value — empty value clears"
        : stage.kind === "moveto"
          ? "Filter folders…"
          : stage.kind === "rename"
            ? "New title…"
            : stage.kind === "renamefolder"
              ? "New folder name…"
              : stage.kind === "newfolder"
                ? "Folder name — nest with /…"
                : stage.kind === "newtpl"
                  ? "New from template — pick a database…"
                  : stage.kind === "newtyped"
                    ? `Title for the new ${stage.dbType}…`
                    : mode === "capture"
                      ? "Note title…"
                      : "Type a command or search…";

  return (
    <div className={`overlay${closing ? " closing" : ""}`} onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          // macOS autocorrect draws a candidate bubble under the input and
          // captures ↑↓ while visible — queries aren't prose
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          role={mode === "palette" ? "combobox" : undefined}
          aria-label={mode === "palette" ? "Command palette" : "Capture note title"}
          aria-expanded={mode === "palette" ? items.length > 0 : undefined}
          aria-autocomplete={mode === "palette" ? "list" : undefined}
          aria-controls={mode === "palette" && items.length > 0 ? listId : undefined}
          aria-activedescendant={mode === "palette" && items[sel] ? rowId(sel) : undefined}
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        {mode === "capture" ? (
          <div className="palette-foot">
            <span>
              <span className="key">↩</span>{" "}
              {looksLikeUrl(q) ? "capture link to Inbox" : "create in Inbox"}
            </span>
            <span>
              <span className="key">esc</span> cancel
            </span>
          </div>
        ) : (
          <>
            <div
              className={`palette-results${listFade.className}`}
              id={listId}
              role={items.length > 0 ? "listbox" : undefined}
              aria-label={items.length > 0 ? "Command palette results" : undefined}
              ref={(node) => {
                listRef.current = node;
                listFade.props.ref(node);
              }}
              onScroll={listFade.props.onScroll}
            >
              {noMatches && (
                <div className="palette-empty" role="status">No results for “{searchText}”</div>
              )}
              {itemSections.map((group) => {
                // Key groups by identity, not position. The
                // debounced Content batch inserts a section above Search, so
                // a positional key shifted every group below it and React
                // remounted them — throwing away live DOM nodes on a purely
                // additive update. That destroys node identity for anything
                // holding a reference: focus, the aria-activedescendant
                // target, the accessibility tree, and any in-flight hit test.
                // Section names repeat across stages, so the pair with the
                // group's first item id is what makes this unique.
                const key = `${group.section}:${group.items[0].id}`;
                // aria-labelledby is a space-separated ID list, and item ids
                // carry note paths that can contain spaces — sanitize, or the
                // reference shatters and the group loses its accessible name.
                const sectionId = `${listId}-section-${key.replace(/[^\w-]/g, "_")}`;
                return (
                  <div key={key} role="group" aria-labelledby={sectionId}>
                    <div className="palette-section" id={sectionId}>{group.section}</div>
                    {group.items.map((item, localIndex) => {
                      const i = group.start + localIndex;
                      // mark WHY the row matched, in the search pane's own
                      // <mark> language. Root stage only — that is
                      // the retrieval surface; fallback rows echo the query
                      // rather than match it, so they stay plain. A snippet
                      // row matched by its BODY: mark the snippet, leave the
                      // title alone (title letters that happen to thread are
                      // noise, not the reason). Note rows ranked against
                      // searchText (filters stripped), command rows against
                      // the raw query — mark with what ranked.
                      const snippetParts = item.snippet
                        ? markSnippet(searchText, item.snippet)
                        : null;
                      const labelParts =
                        stage.kind === "root" && !item.fallback && !item.snippet
                          ? markLabel(item.note ? searchText : q, item.label)
                          : null;
                      return (
                        <div
                          key={item.id}
                          id={rowId(i)}
                          className={`palette-item${i === sel ? " selected" : ""}`}
                          data-idx={i}
                          role="option"
                          aria-selected={i === sel}
                          aria-label={[item.label, item.snippet, item.hint].filter(Boolean).join(", ")}
                          // mousemove, not mouseenter: a debounced
                          // Content batch inserts rows above a resting cursor,
                          // and the browser fires mouseenter for whatever slid
                          // under it — silently moving selection to a row the
                          // user never pointed at. mousemove needs real pointer
                          // motion, so an insert alone can't steal selection.
                          onMouseMove={() => selectIndex(i)}
                          onClick={() => run(item)}
                        >
                          {item.icon}
                          <span className="palette-item-label">
                            {labelParts ? <MarkedText parts={labelParts} /> : item.label}
                          </span>
                          {item.snippet && (
                            <span className="palette-item-snippet">
                              {snippetParts ? <MarkedText parts={snippetParts} /> : item.snippet}
                            </span>
                          )}
                          {item.hint && <span className="palette-hint">{item.hint}</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {items.length === 0 && (
                <EmptyState icon={<SearchIcon />} title="No matches" role="status" style={{ height: 80 }} />
              )}
            </div>
            <div className="palette-foot">
              {stage.kind === "root" ? (
                <>
                  <span>
                    <span className="key">↑↓</span> navigate
                  </span>
                  <span>
                    <span className="key">↩</span> open
                  </span>
                  <span>
                    <span className="key">⇥</span> actions
                  </span>
                  <span>
                    <span className="key">esc</span> close
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <span className="key">↑↓</span> navigate
                  </span>
                  <span>
                    <span className="key">↩</span>{" "}
                    {stage.kind === "setprop" ? "apply" : "run"}
                  </span>
                  <span>
                    <span className="key">esc</span> back
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
