import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, FileIcon, ImageIcon, LockIcon, NotesIcon, PlusIcon } from "./Icons";
import type { DbIcon, FolderFile, NoteMeta, TagFolder, View } from "../lib/types";
import { propStr } from "../lib/types";
import type { DbBlock } from "../lib/views";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { isTyping, isTypingNow } from "../lib/dom";
import { displayTitle, JOURNAL_DIR } from "../lib/journal";
import { tagFolderSummary } from "../lib/tags";
import { fileExt, fileKind } from "../lib/folderfiles";
import { formatFileSize } from "../lib/display";
import InlineEdit from "./InlineEdit";
import TypeIcon from "./TypeIcon";
import { AudioPropButton } from "./AudioPropButton";

/** `now` is injectable so a memoized row can take the label as a prop and still
 *  age: pass the minute tick (see useNowMinute) and the string changes when the
 *  clock does, not only when the note does. */
export function relDate(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** stable identity for the memoized FileRow's optional callbacks — an inline
    arrow per render would defeat the memo */
const noop = () => {};

/** The pane header's name for a view. `tagFolders` is only needed by the
    tagfolder kind — its name lives in the folder definition, not the view, so
    a rename retitles the open pane without rewriting view state (SUB-818). */
export function viewLabel(view: View, tagFolders: TagFolder[] = []): string {
  switch (view.kind) {
    case "tagfolder":
      return tagFolders.find((f) => f.id === view.id)?.name ?? "Tag folder";
    case "tag":
      return `#${view.tag}`;
    case "today":
      return "Today";
    case "notes":
      return "Notes";
    case "all":
      return "All notes";
    case "calendar":
      return "Calendar";
    case "vaultsync":
      return "Vault sync";
    case "changelog":
      // renders ChangelogPane, never ListPane — generic labels only
      return "What's new";
    case "search":
      return "Search";
    case "db":
      return view.type.charAt(0).toUpperCase() + view.type.slice(1);
    case "saved":
      // pins render DatabasePane, never ListPane — this only feeds generic labels
      return "Saved view";
    case "mount":
      // a mount renders DatabasePane too, and its name lives in the registry
      // rather than in the view — generic label only (SUB-888)
      return "Mounted folder";
    case "dashboard":
      return "Dashboard";
    case "folder":
      return view.path.split("/").pop() ?? view.path;
    case "trash":
      return "Trash";
    case "assets":
      return "Assets";
    case "doctor":
      // the report renders DoctorPane, never ListPane — generic labels only
      return "Vault doctor";
    case "dbmanager":
      // the manager renders DbManagerPane, never ListPane — generic labels only
      return "All databases";
  }
}

function subtitle(n: NoteMeta): string {
  const parts: string[] = [];
  for (const key of ["status", "cat#", "artist", "category"]) {
    const v = propStr(n.props, key);
    if (v) parts.push(v);
  }
  if (parts.length === 0 && n.excerpt) return n.excerpt;
  return parts.join(" · ");
}

/** SUB-460: one row, memoized. Every prop is a primitive or a stable callback,
    so an unrelated App re-render (toast, another row's selection) reconciles
    nothing here.

    `date` arrives pre-rendered rather than computed from `note.updated_ms`
    here: relDate is a function of wall-clock time, and a memo that only ever
    sees updated_ms would freeze "now" forever. Passing the string means the
    minute tick re-renders exactly the rows whose label actually changed. */
const NoteRow = memo(function NoteRow({
  note: n,
  sub,
  date,
  selected,
  renaming,
  onSelect,
  onActivate,
  onRenameNote,
  onRenameCancel,
  onRowContextMenu,
}: {
  note: NoteMeta;
  sub: string;
  date: string;
  selected: boolean;
  renaming: boolean;
  onSelect: (path: string) => void;
  onActivate?: (path: string) => void;
  onRenameNote: (path: string, title: string) => void | Promise<unknown>;
  onRenameCancel: () => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
}) {
  const onCommit = useCallback((v: string) => onRenameNote(n.path, v), [onRenameNote, n.path]);
  return (
    <div
      data-path={n.path}
      className={`row${selected ? " selected" : ""}`}
      role={renaming ? undefined : "button"}
      tabIndex={renaming ? undefined : 0}
      aria-label={renaming ? undefined : displayTitle(n)}
      onClick={() => onSelect(n.path)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || renaming) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(n.path);
        // Enter goes on into the note (Space only selects) — same move as the
        // app-level enter-edit shortcut (SUB-392)
        if (e.key === "Enter") onActivate?.(n.path);
      }}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(NOTE_DRAG_MIME, n.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(n.path);
        onRowContextMenu(n.path, e.clientX, e.clientY);
      }}
    >
      <div className="row-top">
        {renaming ? (
          <InlineEdit initial={n.title} onCommit={onCommit} onCancel={onRenameCancel} />
        ) : (
          <span className="row-title">
            {n.sealed && <span className="row-sealed" title="Sealed"><LockIcon /></span>}
            {displayTitle(n)}
          </span>
        )}
        <span className="row-date">{date}</span>
      </div>
      {sub && <span className="row-sub">{sub}</span>}
    </div>
  );
});

/** SUB-812: one loose file in a folder view. Audio rows lead with the play
    button and drive the same shared player as note embeds and database prop
    buttons — pressing it also seats the listening queue on this folder, which
    is what gives the mini-player its prev/next.

    The always-visible play button is the sanctioned exception to "no visible
    button per row" (design-principles §6, amended for task checkboxes in
    SUB-870): auditioning IS a folder-of-bounces' reason to exist, and the
    test the amendment names — is the control the row's reason, or a
    convenience hung off it — passes here. Every other verb (Reveal) stays
    quiet until hover or focus, and non-audio rows carry no visible button at
    all. Rendering is inert: the button peeks the player, never creates one,
    so opening a folder of masters stats and decodes nothing. */
const FileRow = memo(function FileRow({
  file,
  audio,
  onPlay,
  onOpen,
  onReveal,
}: {
  file: FolderFile;
  audio: boolean;
  onPlay: (rel: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const kind = fileKind(file);
  const ext = fileExt(file.name);
  // An audio row's keyboard surface is the play button it already carries, so
  // the row itself is NOT separately focusable: Tab lands on the button and
  // its native Enter/Space activation plays. Making the row a second tab stop
  // would mean a focus ring that answers Enter with nothing (seating the
  // queue is not playing) and two stops per row to walk past.
  // Non-audio rows have no button, so the row IS the control: it opens the
  // file in whatever the OS uses for it.
  const primary = audio ? undefined : () => onOpen(file.path);
  return (
    <div
      className={`row row-file${audio ? " row-file-audio" : ""}`}
      data-file={file.rel}
      role={primary ? "button" : undefined}
      tabIndex={primary ? 0 : undefined}
      aria-label={primary ? `Open ${file.name}` : undefined}
      onDoubleClick={() => onOpen(file.path)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || !primary) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        primary();
      }}
    >
      <div className="row-top">
        <span className="row-file-glyph">
          {audio ? (
            <AudioPropButton name={file.path} onToggle={() => onPlay(file.rel)} />
          ) : kind === "image" ? (
            <ImageIcon />
          ) : (
            <FileIcon size={14} />
          )}
        </span>
        <span className="row-title" title={file.name}>
          {file.name}
        </span>
        <button
          type="button"
          className="row-file-reveal"
          aria-label={`Reveal ${file.name} in Finder`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReveal(file.path);
          }}
        >
          Reveal
        </button>
        {/* one fact per row, right-aligned like every other list meta */}
        <span className="row-date row-file-meta">
          {ext && <span className="row-file-ext">{ext}</span>}
          {formatFileSize(file.size)}
        </span>
      </div>
    </div>
  );
});

/* SUB-461 windowing knobs, the ListPane cut of DatabasePane's SUB-310 pattern:
   lists longer than WIN_MIN paint only the scroll viewport ± WIN_OVERSCAN rows
   (WIN_INITIAL rows on the first frame, before the scroller reports its
   geometry), with spacer divs standing in for the rest so scroll height and
   scrollbar behave like a full render. Rows come in exactly two heights — with
   and without a subtitle line — so two measured heights derive every offset.
   WIN_ROW_H/WIN_SUB_H are pre-measurement fallbacks; the measure effect
   replaces them from the live DOM, so they only need to be close. */
const WIN_MIN = 60;
const WIN_OVERSCAN = 30;
const WIN_INITIAL = 64;
const WIN_ROW_H = 36;
const WIN_SUB_H = 53;

interface ListPaneProps {
  notes: NoteMeta[];
  view: View;
  selected: string | null;
  onSelect: (path: string) => void;
  /** path of the row currently being renamed inline */
  renaming: string | null;
  onRenameNote: (path: string, title: string) => void | Promise<unknown>;
  onRenameCancel: () => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
  /** SUB-590: right-click on the pane's empty space — the view-contextual
      create menu. Rows keep their own menu; they preventDefault first, which
      is how the background handler knows to stand down. */
  onBackgroundContextMenu?: (x: number, y: number) => void;
  /** Enter on a row: select is done, move on into the note (SUB-392) */
  onActivate?: (path: string) => void;
  /** the open folder's icon (SUB-84), when one is set */
  folderIcon?: DbIcon;
  /** collapsed database blocks above the loose rows (SUB-87) — only the
      folder and All notes views pass any; click-through opens the database */
  blocks?: DbBlock[];
  /** per-type database icons (SUB-27) for the blocks */
  icons?: Record<string, DbIcon>;
  onOpenDb?: (type: string) => void;
  /** SUB-584: folder header "+" — new note born in this folder (a typed entry
      when the folder is a database's home, today's daily in the Journal).
      Same fork ⌘N takes; the button is the only visible path on touch, where
      ⌘N doesn't exist. */
  onNewHere?: () => void;
  /** SUB-818: tag folder definitions — the header needs them to name a
      `tagfolder` view, which carries only an id. */
  tagFolders?: TagFolder[];
  /** Phone copy avoids advertising keyboard-only chrome. */
  mobile?: boolean;
  /** SUB-812: the folder's loose (non-note) files, below the notes. Only
      folder views pass any — "All notes" spans folders, so there is no one
      folder whose files it could list. */
  files?: FolderFile[];
  /** how many loose files the folder really has; larger than `files.length`
      when the engine's cap bit */
  fileTotal?: number;
  /** press play on a file row: seat the listening queue on this folder at
      that file. The shared player does the playing (AudioPropButton). */
  onPlayFile?: (rel: string) => void;
  /** open a loose file in whatever the OS uses for it */
  onOpenFile?: (path: string) => void;
  /** show a loose file in Finder */
  onRevealFile?: (path: string) => void;
}

function ListPane({
  notes,
  view,
  selected,
  onSelect,
  renaming,
  onRenameNote,
  onRenameCancel,
  onRowContextMenu,
  onBackgroundContextMenu,
  onActivate,
  folderIcon,
  blocks = [],
  icons,
  onOpenDb,
  onNewHere,
  tagFolders = [],
  mobile = false,
  files = [],
  fileTotal = 0,
  onPlayFile,
  onOpenFile,
  onRevealFile,
}: ListPaneProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  /* SUB-818: the open tag folder, when one is. Its rule (not a path) is what
     the header's tooltip has to spell out — a tag folder has no location. */
  const openTagFolder = useMemo(
    () => (view.kind === "tagfolder" ? tagFolders.find((f) => f.id === view.id) : undefined),
    [view, tagFolders]
  );
  const headTitle =
    view.kind === "folder"
      ? view.path
      : openTagFolder
        ? tagFolderSummary(openTagFolder)
        : view.kind === "tag"
          ? `Every note tagged #${view.tag}`
          : undefined;

  /* SUB-461: long lists paint lazily. The subtitle line is what makes a row
     tall, so it is computed once per note here and reused by both the offset
     math and the render. */
  const subs = useMemo(() => notes.map(subtitle), [notes]);

  /* Rows are memoized (SUB-460), so nothing re-renders them as time passes and
     "2m" would sit there all afternoon. Before the memo an unrelated App render
     refreshed them incidentally; now the clock has to be an explicit input.
     Same minute tick CalendarPane uses. */
  const [nowMin, setNowMin] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const windowed = notes.length > WIN_MIN;
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const [winMetrics, setWinMetrics] = useState({
    rowH: WIN_ROW_H,
    subH: WIN_SUB_H,
    notesTop: 0,
  });

  // rowTops[i] = the row's offset inside the notes region (below the database
  // blocks and their seam, which `notesTop` measures); totalH is the
  // full-height region the spacers stand in for.
  const { rowTops, totalH } = useMemo(() => {
    const tops = new Array<number>(notes.length);
    let acc = 0;
    for (let i = 0; i < notes.length; i++) {
      tops[i] = acc;
      acc += subs[i] ? winMetrics.subH : winMetrics.rowH;
    }
    return { rowTops: tops, totalH: acc };
  }, [notes.length, subs, winMetrics]);

  // the window [start, end) covering the scroll viewport ± overscan. Binary
  // searches over rowTops; a no-change result bails out of re-render, so this
  // is safe to call from every scroll event.
  const winSync = () => {
    const body = bodyRef.current;
    if (!body || !windowed) return;
    const n = notes.length;
    const over = WIN_OVERSCAN * winMetrics.rowH;
    const v0 = body.scrollTop - winMetrics.notesTop - over;
    const v1 = body.scrollTop - winMetrics.notesTop + body.clientHeight + over;
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
  // same fresh-ref idiom DatabasePane uses: the scroll handler and the
  // selection effect always reach the latest closure without re-subscribing
  const winSyncRef = useRef(winSync);
  winSyncRef.current = winSync;

  // window state is only valid for the list that produced it: a stale
  // mid-list window paired with a clamped scrollTop mounts the wrong slice
  // for a frame. Reset on view switches and when windowing drops out.
  //
  // Deliberately does NOT reset scrollTop. Switching folders re-selects, and
  // the reveal effect below scrolls the window onto the new selection; when a
  // switch keeps the selection (folder -> All notes) the reveal has nothing to
  // do, so zeroing here would strand the selected row unpainted instead.
  useEffect(() => {
    setWin(null);
  }, [view, windowed]);

  const winStart = windowed ? Math.min(win?.start ?? 0, notes.length - 1) : 0;
  const winEnd = windowed
    ? Math.min(Math.max(win?.end ?? WIN_INITIAL, winStart + 1), notes.length)
    : notes.length;
  const winTopH = windowed ? rowTops[winStart] : 0;
  const winBottomH = windowed
    ? totalH - (rowTops[winEnd - 1] + (subs[winEnd - 1] ? winMetrics.subH : winMetrics.rowH))
    : 0;

  // measure the real row geometry once rows paint, then re-window. Passive on
  // purpose (as in DatabasePane): the fallback metrics make the first frame
  // close, and a layout effect's synchronous re-render chain delays paint.
  useEffect(() => {
    if (!windowed) return;
    const body = bodyRef.current;
    const anchor = body?.querySelector(".list-win-anchor");
    if (!body || !(anchor instanceof HTMLElement)) return;
    let rowH = 0;
    let subH = 0;
    // file rows (SUB-812) are excluded alongside the database blocks: the
    // window's offset math describes the NOTES region, and measuring a row of
    // a different height into rowH would slide every painted note
    for (const el of body.querySelectorAll(".row:not(.row-dbblock):not(.row-file)")) {
      const h = el.getBoundingClientRect().height;
      if (el.querySelector(".row-sub")) subH = subH || h;
      else rowH = rowH || h;
      if (rowH && subH) break;
    }
    const notesTop =
      anchor.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    setWinMetrics((cur) => {
      const next = {
        rowH: rowH || cur.rowH,
        subH: subH || cur.subH,
        notesTop,
      };
      return Math.abs(cur.rowH - next.rowH) < 0.5 &&
        Math.abs(cur.subH - next.subH) < 0.5 &&
        Math.abs(cur.notesTop - next.notesTop) < 0.5
        ? cur
        : next;
    });
    winSyncRef.current();
  }, [windowed, notes.length, winMetrics]);

  // geometry can change with no scroll event: full-screening the window,
  // dragging its edge, collapsing the sidebar. winSync reads clientHeight, so
  // a taller viewport keeps the shorter slice and paints a blank band below it
  // until the user scrolls. Same ResizeObserver DatabasePane uses (SUB-310).
  useEffect(() => {
    const body = bodyRef.current;
    if (!windowed || !body) return;
    const ro = new ResizeObserver(() => winSyncRef.current());
    ro.observe(body);
    return () => ro.disconnect();
  }, [windowed]);

  // Rename can be started from outside the list — the sidebar pin menu names a
  // note that may sit anywhere in a long list (App.tsx noteMenuItems). Without
  // this the edit field simply never mounts and the menu entry looks dead.
  useEffect(() => {
    if (!windowed || !renaming) return;
    const idx = notes.findIndex((n) => n.path === renaming);
    if (idx === -1 || (idx >= winStart && idx < winEnd)) return;
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = Math.max(0, winMetrics.notesTop + rowTops[idx] - body.clientHeight / 2);
    winSyncRef.current();
  }, [renaming, windowed, winStart, winEnd, notes, rowTops, winMetrics.notesTop]);

  // Selection follows the keyboard as well as the pointer, and a keyboard jump
  // can land on a row the window doesn't paint — so scroll the window onto it
  // first and finish the reveal on the next render (hence the window deps and
  // the already-handled guard, which keeps plain scrolling from yanking the
  // view back to the selected row).
  const revealedFor = useRef<string | null>(null);
  // A view switch that keeps the selection still MOVES it: the same note sits
  // at a different index in the new list, so the deliberately preserved
  // scrollTop now points at an unrelated stretch and the window paints around
  // the wrong rows. Clearing the guard lets the reveal below re-run for the
  // unchanged selection and scroll the window back onto it. Without this the
  // row only stays painted when the browser's scroll anchoring happens to
  // absorb the index shift — which it does for some list deltas and not for
  // others, so the guarantee was never actually the pane's (SUB-461).
  useEffect(() => {
    revealedFor.current = null;
  }, [view]);
  // Windowing unmounts rows the viewport has left, and unmounting the focused
  // row drops DOM focus to <body> with no event of its own. The reveal below
  // then can't tell "the list had focus a moment ago" from "focus was never
  // here", so it declines to move the ring and the keyboard is left orphaned.
  // Track ownership as focus moves instead of sampling it after the fact
  // (SUB-461).
  const hadRowFocus = useRef(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!windowed || !body) return;
    const onFocusIn = (e: FocusEvent) => {
      hadRowFocus.current =
        e.target instanceof HTMLElement && e.target.classList.contains("row");
    };
    // focusout fires before the new focus lands; anything outside this pane
    // (editor, sidebar, palette) legitimately takes the ring away from us.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next === null) return; // the row unmounted — ownership survives
      if (!(next instanceof Node) || !body.contains(next)) hadRowFocus.current = false;
    };
    body.addEventListener("focusin", onFocusIn);
    body.addEventListener("focusout", onFocusOut);
    return () => {
      body.removeEventListener("focusin", onFocusIn);
      body.removeEventListener("focusout", onFocusOut);
    };
  }, [windowed]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!selected || !body) {
      revealedFor.current = null;
      return;
    }
    if (revealedFor.current === selected) return;
    const rowFocused = (el: Element | null) =>
      el instanceof HTMLElement &&
      el.classList.contains("row") &&
      el.closest(".list-body") === bodyRef.current;
    if (windowed) {
      const idx = notes.findIndex((n) => n.path === selected);
      if (idx !== -1 && (idx < winStart || idx >= winEnd)) {
        body.scrollTop = Math.max(0, winMetrics.notesTop + rowTops[idx] - body.clientHeight / 2);
        winSyncRef.current();
        return;
      }
    }
    const el = body.querySelector(`[data-path="${CSS.escape(selected)}"]`);
    if (!el) return;
    revealedFor.current = selected;
    el.scrollIntoView({ block: "nearest" });
    // focus follows selection (SUB-392): after a click, DOM focus sits on the
    // clicked row — arrowing away without this leaves the focus ring (and
    // Enter's target) on the stale row. Only steal focus from a sibling row
    // (or the one this pane just unmounted), never from the editor.
    const active = document.activeElement;
    const restoring = hadRowFocus.current && (active === document.body || active === null);
    if (el instanceof HTMLElement && active !== el && (rowFocused(active) || restoring))
      el.focus({ preventScroll: true });
  }, [selected, windowed, winStart, winEnd, notes, rowTops, winMetrics.notesTop]);

  return (
    <div
      className="list"
      // SUB-590: empty space answers right-click with the create menu. A
      // row's own handler ran first (bubbling) and preventDefault()ed, so
      // a prevented event means "already handled" — stand down.
      onContextMenu={(e) => {
        // stand down while any text editor is live (the rename input, a
        // focused title) — the menu would steal focus and blur-commit a
        // half-typed value; the native menu leaves the edit undisturbed
        if (e.defaultPrevented || !onBackgroundContextMenu || isTyping(e.target) || isTypingNow()) return;
        e.preventDefault();
        onBackgroundContextMenu(e.clientX, e.clientY);
      }}
    >
      <div className="list-head" data-tauri-drag-region>
        {view.kind === "folder" && folderIcon && (
          <TypeIcon type={viewLabel(view)} icon={folderIcon} size={16} />
        )}
        {/* SUB-818: a tag folder and a bare tag collection both wear the tag
            glyph — the same mark the sidebar row carries, so the header
            confirms what was clicked */}
        {(view.kind === "tagfolder" || view.kind === "tag") && (
          <TypeIcon
            type={viewLabel(view, tagFolders)}
            icon={openTagFolder?.icon ?? { glyph: "tag" }}
            size={16}
          />
        )}
        <span className="list-title" title={headTitle}>
          {viewLabel(view, tagFolders)}
        </span>
        <span className="list-count">{notes.length + blocks.length + files.length}</span>
        {/* SUB-400: name the kind of thing that's open — a folder of 2 notes
            and a database of 1424 entries otherwise wear the same header */}
        {view.kind === "folder" && <span className="head-kind">Folder</span>}
        {view.kind === "tagfolder" && <span className="head-kind">Tag folder</span>}
        {view.kind === "tag" && <span className="head-kind">Tag</span>}
        {/* SUB-584: births in this folder — a typed entry when the folder is a
            database's home, today's daily in the Journal (SUB-593); the ⌘N
            fork made clickable, and the only path on touch */}
        {view.kind === "folder" && onNewHere && (
          <button
            className="list-new"
            onClick={onNewHere}
            title={`${view.path === JOURNAL_DIR ? "Today’s entry" : "New note"}${mobile ? "" : " (⌘N)"}`}
            aria-label={view.path === JOURNAL_DIR ? "Open today’s entry" : "New note in this folder"}
          >
            <PlusIcon />
          </button>
        )}
        {/* SUB-818: creating inside a tag folder tags the new note instead of
            moving it — same button, the acting-tags rule behind it */}
        {view.kind === "tagfolder" && onNewHere && openTagFolder && (
          <button
            className="list-new"
            onClick={onNewHere}
            title={`New note${mobile ? "" : " (⌘N)"} — tagged ${openTagFolder.tags
              .map((t) => `#${t}`)
              .join(" ")}`}
            aria-label="New note tagged for this folder"
          >
            <PlusIcon />
          </button>
        )}
      </div>
      <div
        className="list-body"
        ref={bodyRef}
        // scroll events aren't cancelable, so this can't block scrolling; an
        // unchanged window bails out of re-render, so the pane only re-renders
        // when the painted slice actually moves (SUB-461)
        onScroll={windowed ? () => winSyncRef.current() : undefined}
      >
        {notes.length === 0 && blocks.length === 0 && files.length === 0 ? (
          <div className="empty">
            <NotesIcon />
            <span>Nothing here</span>
            <span className="empty-hint">
              {mobile
                ? "Open navigation and tap + to capture"
                : view.kind === "notes"
                  ? "⌘N jots a new scratch note"
                  : "⌘N captures a note into the Inbox"}
            </span>
          </div>
        ) : (
          <>
            {blocks.map((b) => (
              <div
                key={b.type}
                className="row row-dbblock"
                role="button"
                tabIndex={0}
                aria-label={viewLabel({ kind: "db", type: b.type })}
                onClick={() => onOpenDb?.(b.type)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenDb?.(b.type);
                }}
              >
                <div className="row-top">
                  <TypeIcon type={b.type} icon={icons?.[b.type]} size={15} />
                  <span className="row-title">{viewLabel({ kind: "db", type: b.type })}</span>
                  <span className="row-dbblock-chevron">
                    <ChevronRightIcon />
                  </span>
                </div>
                <span className="row-sub">
                  {b.count} {b.count === 1 ? "entry" : "entries"}
                </span>
              </div>
            ))}
            {/* the pane speaks two list grammars — database blocks, then loose
                notes; a hairline names the seam when both are present */}
            {blocks.length > 0 && notes.length > 0 && <div className="list-seam" />}
            {/* zero-height marker the measure effect reads the notes region's
                offset from — the blocks above it are variable in number */}
            <div className="list-win-anchor" aria-hidden="true" />
            {winTopH > 0 && (
              <div className="list-win-spacer" aria-hidden="true" style={{ height: winTopH }} />
            )}
            {notes.slice(winStart, winEnd).map((n, winIdx) => (
              <NoteRow
                key={n.path}
                note={n}
                sub={subs[winStart + winIdx]}
                date={relDate(n.updated_ms, nowMin)}
                selected={selected === n.path}
                renaming={renaming === n.path}
                onSelect={onSelect}
                onActivate={onActivate}
                onRenameNote={onRenameNote}
                onRenameCancel={onRenameCancel}
                onRowContextMenu={onRowContextMenu}
              />
            ))}
            {winBottomH > 0 && (
              <div className="list-win-spacer" aria-hidden="true" style={{ height: winBottomH }} />
            )}
            {/* SUB-812: the pane's third list grammar — the folder's loose
                files, below the notes, behind their own seam. Deliberately
                unwindowed: the engine caps the listing, so this is a bounded
                render, and the notes above own the window offsets. */}
            {files.length > 0 && (notes.length > 0 || blocks.length > 0) && (
              <div className="list-seam list-seam-files" />
            )}
            {files.map((f) => (
              <FileRow
                key={f.rel}
                file={f}
                audio={fileKind(f) === "audio"}
                onPlay={onPlayFile ?? noop}
                onOpen={onOpenFile ?? noop}
                onReveal={onRevealFile ?? noop}
              />
            ))}
            {fileTotal > files.length && (
              <div className="list-files-more">
                {fileTotal - files.length} more files in this folder — open it in Finder to see
                them all
              </div>
            )}
            {/* a sparse journal (≤ 3 dailies) gets a quiet pointer under the
                list — the empty pane below the rows is a void otherwise */}
            {view.kind === "folder" && view.path === JOURNAL_DIR && notes.length + blocks.length <= 3 && (
              <div className="list-journal-hint">
                {mobile ? "One entry per day" : "One entry per day — ⌘D opens today"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* SUB-460: the pane is pure in its props — App-state churn that doesn't touch
   them (toast, overlays, palette) stops reconciling the whole list. */
export default memo(ListPane);
