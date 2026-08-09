import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import type {
  CalendarFeedSnapshot,
  NoteMeta,
  SchemaConfig,
} from "../lib/types";
import { isTyping, isTypingNow } from "../lib/dom";
import {
  addDays,
  addMonths,
  calendarEntriesForWindows,
  calendarTypes,
  cellDayLabel,
  clampedRangeEnd,
  compareEntryTime,
  datePropFor,
  dateRangeValue,
  dayColumn,
  entryEndDay,
  folderFor,
  humanDay,
  isComplete,
  isDeadline,
  isoDay,
  monthGridDays,
  monthTitle,
  overdueEntries,
  parseDay,
  shiftedRangeEnd,
  splitDateRange,
  splitDayTime,
  statusSchemaFor,
  weekDays,
  type CalEntry,
} from "../lib/calendar";
import {
  DAY_MIN,
  blockSpan,
  layoutLanes,
  minutesToTime,
  snapMinutes,
  timeToMinutes,
} from "../lib/weekgrid";
import { formatDateHuman } from "../lib/dates";
import { calendarFeedsRead, vaultCreate, vaultTemplateRead } from "../lib/ipc";
import { listen } from "../lib/tauri";
import { setPropUndoable, setPropsUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { useEdgeFade } from "../hooks/useEdgeFade";
import { nextUndoId } from "../lib/undo";
import { foldedPropKey, foldedPropStr, typeHome } from "../lib/types";
import { typeSchemaFor } from "../lib/schemalookup";
import {
  buildEntryBody,
  buildEntryProps,
  mergeEntryProp,
} from "../lib/templates";
import { iconForType, iconsByType, tintVar, typeTint } from "../lib/dbicons";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  NoteIcon,
  RepeatIcon,
} from "./Icons";
import {
  compareExternalTime,
  externalEntries,
  type ExternalCalEntry,
} from "../lib/externalcalendar";
import SelectMenu, { anchorFrom, type AnchorRect } from "./SelectMenu";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import TypeIcon from "./TypeIcon";
import CalPeek from "./CalPeek";
import { cardSubtitle } from "./DatabasePane";
import { useNumberLocale } from "../hooks/useNumberLocale";
import { useTodayIso } from "./useTodayIso";
import CalendarFeedsMenu from "./CalendarFeedsMenu";
import SwitchGroup from "./SwitchGroup";
import { BackButton } from "./BackButton";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** month cells show this many entries before collapsing into "+N more" —
    the line chips are a row shorter than the old boxed chips, so a
    cell holds four without crowding */
const MONTH_CAP = 4;
/** the week surface's all-day strip keeps the tighter cap: its height is
    bounded (34%) and a strip pushed into internal scrolling turns Chromium's
    drag auto-scroll loose under every card drag */
const ALLDAY_CAP = 3;
/** week canvas scale: one hour of the day, in px — 24h ≈ 1150px */
const HOUR_PX = 48;
/** the canvas time cursor's step: ↑/↓ half-hours, Shift quarters —
    the same quarter-hour grid a canvas drop snaps to */
const SLOT_STEP = 30;
const SLOT_FINE = 15;
/** where the cursor lands on its first ↑/↓ — the working day's start, so the
    keyboard path opens on the same part of the day the canvas scrolls to */
const SLOT_SEED = 9 * 60;
const EMPTY_FEEDS: CalendarFeedSnapshot = {
  feeds: [],
  events: [],
  refreshing: false,
  configError: null,
};

type CalendarRenderEntry = CalEntry | ExternalCalEntry;
/** Shared empty day, so a dayless cell keeps a stable identity. */
const NO_ENTRIES: CalendarRenderEntry[] = [];

const isExternalEntry = (
  entry: CalendarRenderEntry,
): entry is ExternalCalEntry => "feedUrl" in entry;

/** The pane unmounts whenever an entry is opened (the note takes the
    view), so the two pieces of "where I was reading" have to live outside it.
    Split by kind: the layout is a stated preference and persists per window
    like the sidebar collapse, the cursor is session position — a
    scroll offset, not a setting — and only outlives the mount. */
const CAL_LAYOUT_KEY = "substrate.calLayout";

/** Month, and the timed canvas at seven columns or one. Day is not
    a third surface: it is the week canvas with a one-day column set. */
type CalLayout = "month" | "week" | "day";

/** the switcher's labels, in the order it shows them */
const LAYOUT_LABELS: Record<CalLayout, string> = {
  month: "Month",
  week: "Week",
  day: "Day",
};

function readCalLayout(): CalLayout {
  const stored = localStorage.getItem(CAL_LAYOUT_KEY);
  return stored === "week" || stored === "day" ? stored : "month";
}

function writeCalLayout(l: CalLayout): void {
  localStorage.setItem(CAL_LAYOUT_KEY, l);
}

/** epoch ms, so the round trip can't hand a mutated Date back out. null until
    the calendar has been visited, so a first open lands on today even in a
    window that has been running since before midnight (the rollover). */
const calSession: { cursor: number | null } = { cursor: null };

interface CalendarPaneProps {
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** bumped by App when ⌘N fires inside the calendar view */
  newSignal: number;
  onOpenNote: (path: string) => void;
  onMutated: () => void;
  /** Move to Trash routes through App's shared handler — flush of
      the open note's pending save, then toast with Undo */
  onTrashNote: (path: string) => void;
  /** App's toast — failed writes surface here, not the console;
      the optional action carries Undo after a drag move */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** the entry peek's title field renames the note — App's renameNote
      (flush of the open note's pending save, then refresh) */
  onRenameNote: (path: string, title: string) => Promise<unknown>;
  /** The day menu's "Open daily note" — App's openJournal
      (get-or-create the day's note, ghost for non-today) */
  onOpenJournal: (date: string) => void;
}

export default function CalendarPane({
  notes,
  schema,
  newSignal,
  onOpenNote,
  onMutated,
  onTrashNote,
  onToast,
  onRenameNote,
  onOpenJournal,
}: CalendarPaneProps) {
  const undo = useUndo();
  // the entry cards' subtitles carry formatted numbers — the dial
  // is not threaded into this pane, so read it from the store
  const numberLocale = useNumberLocale();
  // The Upcoming rail is a fixed 168px against the viewport bottom,
  // so a full agenda cut its last row in half with nothing saying more was
  // below it.
  const agendaFade = useEdgeFade<HTMLDivElement>();
  // An expanded "+N more" cell scrolls its full list (`.cal-day.expanded`),
  // and a 9-entry day clips rows mid-glyph at the cell's bottom border with
  // nothing saying more is there — the same defect the shared gate exists
  // for. One instance is enough: expandedIso is single-valued, and the
  // callback ref re-attaches as expansion moves between cells.
  const expandedFade = useEdgeFade<HTMLDivElement>();
  // Opening an entry unmounts the pane (the note takes the view), so
  // both of these have to outlive the mount or coming back — ⌫, or the sidebar
  // — silently resets the calendar you were reading. `cursor` is session
  // position, like a scroll offset: it survives the round trip in a module ref
  // and starts fresh next launch. `layout` is a stated preference, so it
  // persists per window in localStorage, like the sidebar collapse.
  const [cursor, setCursor] = useState(
    () => new Date(calSession.cursor ?? Date.now()),
  );
  const [layout, setLayout] = useState<CalLayout>(() => readCalLayout());
  /** every gate that used to ask "is this the week?" asks "is this
      the timed canvas?" instead. Week and Day are the same surface — the only
      difference is how many columns `days` holds — so nothing below this line
      forks per layout, it reads the column set. */
  const onCanvas = layout !== "month";
  const [feedSnapshot, setFeedSnapshot] =
    useState<CalendarFeedSnapshot>(EMPTY_FEEDS);
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [feedReload, setFeedReload] = useState(0);
  useEffect(() => {
    calSession.cursor = cursor.getTime();
  }, [cursor]);
  useEffect(() => {
    writeCalLayout(layout);
  }, [layout]);
  const [focusIso, setFocusIso] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    day: string;
    type: string;
    time?: string;
  } | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [drag, setDrag] = useState<{
    path: string;
    prop: string;
    day: string;
    time?: string;
    /** the dragged entry's span end, so the drop rewrites the whole
        range rather than collapsing it to the new start day */
    endDay?: string;
    endTime?: string;
    /** a bottom-edge RESIZE, not a move: the same drag machinery,
        but the drop rewrites the range's END and holds the start where it is */
    resize?: boolean;
  } | null>(null);
  const [dropIso, setDropIso] = useState<string | null>(null);
  // canvas drag hover: the snapped drop minute, for the time-ghost line
  const [dropMin, setDropMin] = useState<number | null>(null);
  // the week canvas's keyboard time cursor: the minute-of-day ↑/↓
  // parks on inside the focused day's column, null when disarmed
  const [slotMin, setSlotMin] = useState<number | null>(null);
  // a day whose "+N more" was clicked renders its full entry list
  const [expandedIso, setExpandedIso] = useState<string | null>(null);
  // draft type picker: anchor rect while the SelectMenu is open
  const [typeMenu, setTypeMenu] = useState<AnchorRect | null>(null);
  // entry-chip context menu + its Repeat… picker
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: CalEntry;
    anchor: AnchorRect;
  } | null>(null);
  const [repeatMenu, setRepeatMenu] = useState<{
    entry: CalEntry;
    anchor: AnchorRect;
  } | null>(null);
  // the entry peek: click a chip/card to edit it in place (Notion-Calendar
  // style). Tracked by identity — the live entry is re-derived from `entries`,
  // so a mutation that removes it (moved, skipped, renamed, trashed) closes
  // the popover instead of leaving it stale
  const [peek, setPeek] = useState<{
    path: string;
    prop: string;
    day: string;
    anchor: AnchorRect;
  } | null>(null);
  // Right-click on a day cell (not a chip — chips preventDefault
  // first) — the day's own create/navigate menu. `time` is set on the week
  // canvas, where the pointer names a slot, not just a day.
  const [dayMenu, setDayMenu] = useState<{
    x: number;
    y: number;
    iso: string;
    time?: string;
  } | null>(null);
  const seenSignal = useRef(newSignal);
  const gridRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const weekScrollRef = useRef<HTMLDivElement>(null);
  // the timed canvas: gridRef only ever holds the all-day strip, so
  // the focus/scroll effects need their own handle on the canvas half
  const canvasRef = useRef<HTMLDivElement>(null);
  // Bumped when a keyboard gesture should pull REAL DOM focus onto
  // the focused day's canvas column. Not every focusIso change may steal
  // focus — composing (`n`, ⌘N, a canvas double-click) sets focusIso too, and
  // the composer's input owns focus there — so the move is requested
  // explicitly by the keyboard paths instead of riding on focusIso.
  const [colFocusReq, setColFocusReq] = useState(0);
  const requestColFocus = () => setColFocusReq((n) => n + 1);

  // day rollover lives in the hook — the today highlight and the
  // default focus follow midnight in a long-lived window
  const todayIso = useTodayIso();
  const today = parseDay(todayIso) ?? new Date();

  // the canvas now-line's minute-of-day, on a one-minute tick
  const [nowMin, setNowMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    if (!onCanvas) return;
    const tick = () => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [onCanvas]);

  // the one place a layout decides anything about the canvas: how many columns
  // it gets. Everything downstream reads `days`.
  const days = useMemo(
    () =>
      layout === "month"
        ? monthGridDays(cursor.getFullYear(), cursor.getMonth())
        : layout === "day"
          ? dayColumn(cursor)
          : weekDays(cursor),
    [cursor, layout],
  );
  const visible = useMemo(() => new Set(days.map(isoDay)), [days]);

  const feedGridStart = isoDay(days[0]);
  const feedGridEnd = isoDay(days[days.length - 1]);
  const feedUpcomingStart = todayIso;
  const feedUpcomingEnd = isoDay(addDays(parseDay(todayIso) ?? new Date(), 13));
  useEffect(() => {
    let live = true;
    Promise.all([
      calendarFeedsRead(feedGridStart, feedGridEnd),
      calendarFeedsRead(feedUpcomingStart, feedUpcomingEnd),
    ])
      .then(([grid, upcoming]) => {
        if (!live) return;
        const events = new Map(grid.events.map((event) => [event.id, event]));
        for (const event of upcoming.events) events.set(event.id, event);
        setFeedSnapshot({
          feeds: grid.feeds,
          events: [...events.values()],
          refreshing: grid.refreshing || upcoming.refreshing,
          configError: grid.configError ?? upcoming.configError,
        });
      })
      .catch((error) => {
        console.error(error);
        if (live) onToast?.("Couldn’t read external calendars.");
      });
    return () => {
      live = false;
    };
  }, [
    feedGridStart,
    feedGridEnd,
    feedUpcomingStart,
    feedUpcomingEnd,
    feedReload,
    onToast,
  ]);
  useEffect(() => {
    let dead = false;
    let unlisten: (() => void)[] = [];
    const reload = () => setFeedReload((n) => n + 1);
    Promise.all([
      listen("calendar:feeds-changed", reload),
      listen("vault:config-changed", reload),
    ]).then((callbacks) => {
      if (dead) callbacks.forEach((callback) => callback());
      else unlisten = callbacks;
    });
    return () => {
      dead = true;
      unlisten.forEach((callback) => callback());
    };
  }, []);

  // recurrence expands over the grid AND the 14-day upcoming list — both read
  // the same byDay map, so both windows feed it. Two windows, not
  // one spanning both: paging months back moves the grid away from today while
  // Upcoming stays put, and a single window stretched to cover the gap blew
  // past the expansion cap — the grid still rendered while Today and Upcoming
  // emptied out.
  const entries = useMemo(() => {
    const gridStart = isoDay(days[0]);
    const gridEnd = isoDay(days[days.length - 1]);
    const upcomingStart = todayIso;
    const upcomingEnd = isoDay(addDays(parseDay(todayIso) ?? new Date(), 13));
    return calendarEntriesForWindows(notes, schema, [
      { start: gridStart, end: gridEnd },
      { start: upcomingStart, end: upcomingEnd },
    ]);
  }, [notes, schema, days, todayIso]);
  // each database's icon, for the entry badges
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);
  /** an entry's mark: the same badge Today wears — the database's TypeIcon,
      the quiet note glyph for untyped notes */
  const entryIcon = (e: CalEntry) =>
    e.type ? (
      <TypeIcon type={e.type} icon={iconForType(dbIcons, e.type)} size={12} />
    ) : (
      <NoteIcon size={12} />
    );
  const noteByPath = useMemo(
    () => new Map(notes.map((n) => [n.path, n])),
    [notes],
  );
  const byDay = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    // keys stay day-only (e.day) — a timed entry's time never keys a bucket
    for (const e of entries) map.set(e.day, [...(map.get(e.day) ?? []), e]);
    for (const list of map.values())
      list.sort(
        (a, b) =>
          // all-day first, then timed ascending, then type/title
          compareEntryTime(a, b) ||
          a.type.localeCompare(b.type) ||
          a.title.localeCompare(b.title),
      );
    return map;
  }, [entries]);
  const external = useMemo(
    () => externalEntries(feedSnapshot.events),
    [feedSnapshot.events],
  );
  const externalByDay = useMemo(() => {
    const map = new Map<string, ExternalCalEntry[]>();
    for (const entry of external)
      map.set(entry.day, [...(map.get(entry.day) ?? []), entry]);
    for (const list of map.values()) list.sort(compareExternalTime);
    return map;
  }, [external]);
  // one merged day map per data change, instead of re-concatenating and
  // re-sorting on every cell of every render
  const mergedByDay = useMemo(() => {
    const map = new Map<string, CalendarRenderEntry[]>();
    for (const iso of new Set([...byDay.keys(), ...externalByDay.keys()]))
      map.set(
        iso,
        [...(byDay.get(iso) ?? []), ...(externalByDay.get(iso) ?? [])].sort(
          (a, b) => (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      );
    return map;
  }, [byDay, externalByDay]);
  const renderItems = (iso: string): CalendarRenderEntry[] =>
    mergedByDay.get(iso) ?? NO_ENTRIES;
  const types = useMemo(() => calendarTypes(schema), [schema]);

  // opening the canvas (or paging it) scrolls to the columns' action: an hour
  // above the earliest timed entry on screen, else 08:00. One-shot per column
  // set — keyed by its first day, so it re-anchors per week in Week and per
  // day in Day. A span whose entries hadn't loaded yet anchors
  // again when they land (byDay is in the deps), but once anchored with data,
  // later vault mutations never re-scroll under the user.
  const anchoredWeek = useRef<string | null>(null);
  useEffect(() => {
    if (!onCanvas) {
      anchoredWeek.current = null;
      return;
    }
    const el = weekScrollRef.current;
    if (!el) return;
    const weekKey = isoDay(days[0]);
    if (anchoredWeek.current === weekKey) return;
    let first = Infinity;
    for (const d of days) {
      for (const e of byDay.get(isoDay(d)) ?? []) {
        const m = e.time ? timeToMinutes(e.time) : null;
        if (m !== null && m < first) first = m;
      }
    }
    const target = first === Infinity ? 8 * 60 : Math.max(first - 60, 0);
    el.scrollTop = (target / 60) * HOUR_PX;
    if (byDay.size > 0) anchoredWeek.current = weekKey;
  }, [onCanvas, days, byDay]);

  // the peek's live entry, re-derived on every refresh — gone (moved day,
  // skipped occurrence, rename's new path, trash) means the popover closes
  const peekEntry = useMemo(
    () =>
      peek
        ? (entries.find(
            (e) =>
              e.path === peek.path &&
              e.prop === peek.prop &&
              e.day === peek.day,
          ) ?? null)
        : null,
    [peek, entries],
  );
  useEffect(() => {
    if (peek && !peekEntry) setPeek(null);
  }, [peek, peekEntry]);

  /** The entry the peek or the context menu is targeting keeps a
      selected tint (Notion-Calendar style), so the popover and the chip it
      edits read as one unit. A span lights whole — its segments are one
      event — while a repeating series stays day-matched: each virtual
      occurrence is its own row (expansion never carries spanPos, so the
      span branch can't cross-light a series). */
  const selTarget = peek ?? menu?.entry ?? null;
  const isSelected = (e: CalEntry): boolean => {
    if (!selTarget || selTarget.path !== e.path || selTarget.prop !== e.prop)
      return false;
    if (selTarget.day === e.day) return true;
    return e.spanPos !== undefined && !e.repeating;
  };

  /** move keyboard focus, paging the grid when the target leaves the view */
  const go = (d: Date) => {
    setFocusIso(isoDay(d));
    if (!visible.has(isoDay(d))) setCursor(d);
  };

  /** ⌘←/→ — pages by whatever unit is on screen: a month, a week, a day */
  const page = (n: number) => {
    const step = (d: Date) =>
      layout === "month"
        ? addMonths(d, n)
        : addDays(d, (layout === "day" ? 1 : 7) * n);
    setCursor(step(cursor));
    setExpandedIso(null);
    // paging mid-drag would strand the drop highlight/ghost on cells that
    // no longer exist
    setDropIso(null);
    setDropMin(null);
    const f = parseDay(focusIso ?? "");
    if (f) setFocusIso(isoDay(step(f)));
  };

  const focusDate = (): Date => {
    const f = parseDay(focusIso ?? "");
    if (f) return f;
    return visible.has(todayIso) ? today : days[0];
  };

  /** `time` — a canvas double-click composes a timed entry at that slot;
      day cells and the all-day strip keep composing day-only */
  const openDraft = (day: string, type?: string, time?: string) => {
    setFocusIso(day);
    setDraft({ day, type: type ?? draft?.type ?? "event", time });
    setDraftTitle("");
  };

  // ⌘N while the calendar is the active view composes on the focused day
  useEffect(() => {
    if (newSignal !== seenSignal.current) {
      seenSignal.current = newSignal;
      openDraft(isoDay(focusDate()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSignal]);

  // keep the focused day on screen — both halves of the week surface
  // gridRef is the all-day strip, canvasRef the timed canvas, and
  // a focused day that only exists on the canvas would otherwise never scroll
  useEffect(() => {
    if (!focusIso) return;
    gridRef.current
      ?.querySelector(`[data-iso="${focusIso}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    canvasRef.current
      ?.querySelector(`[data-iso="${focusIso}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusIso, layout]);

  // the time cursor leaves with its day — a cursor parked on a day
  // that scrolled out of the week would keep highlighting a stale column
  // The cursor disarms when the week canvas isn't the surface any more. It does
  // NOT clear on paging: `page()` carries `focusIso` along with the view, so the
  // focused day is always still visible afterwards and the cursor rides with it
  // ⌘→ must not silently disarm a cursor the user just placed.
  useEffect(() => {
    if (!onCanvas || !focusIso) setSlotMin(null);
  }, [onCanvas, focusIso]);

  // …and follows itself into view: moving the cursor scrolls the canvas so the
  // highlighted slot stays visible on a 1150px surface
  useEffect(() => {
    if (slotMin === null || !focusIso) return;
    canvasRef.current
      ?.querySelector(`[data-iso="${focusIso}"] .cal-wk-slot`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slotMin, focusIso]);

  // an expanded day collapses on any click outside its cell — the
  // peek is a body portal, but it belongs to the cell's entry: interacting
  // with it keeps the expansion. Its sub-pickers (status/date/repeat) are
  // separate `.selmenu` portals: a press in one must not collapse the cell —
  // the layout shift scrolls the grid and the peek's scroll-dismiss kills
  // the edit mid-flight
  useEffect(() => {
    if (!expandedIso) return;
    const onDown = (e: MouseEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(".cal-peek, .selmenu")
      )
        return;
      const cell = gridRef.current?.querySelector(
        `[data-iso="${expandedIso}"]`,
      );
      if (cell && !cell.contains(e.target as Node)) setExpandedIso(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [expandedIso]);

  /* ── A press that dismisses an open popup layer must not double
     as "compose here". The peek/select/date pickers close on window
     mousedown; the day cells create on click — so the SAME gesture that
     dismissed the popup used to land on a day cell and immediately open the
     new-entry composer. Re-evaluated at every press (capture, so it runs
     before any dismissal unmounts the popup): armed only when a popup layer
     was open AND the press was outside it. The day cells' click-to-create
     paths check it; explicit surfaces (header New, keyboard, the day
     context menu's items) don't — those presses are unambiguous. */
  const pressDismissed = useRef(false);
  useEffect(() => {
    // OPEN asks "is any popup layer up" — the context menu counts via its
    // full-viewport overlay. INSIDE asks "did the press land in the popup
    // itself" — there the overlay must NOT count, because a press on its
    // backdrop IS the dismissing press.
    const OPEN = ".cal-peek, .selmenu, .ctx-overlay";
    const INSIDE = ".cal-peek, .selmenu, .ctx-menu";
    const onDown = (e: MouseEvent) => {
      pressDismissed.current =
        document.querySelector(OPEN) !== null &&
        !(e.target instanceof Element && e.target.closest(INSIDE));
    };
    // a keyboard "click" (Enter on a focused day button) has no mousedown —
    // it must never inherit the previous pointer gesture's verdict
    const onKey = () => {
      pressDismissed.current = false;
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  /** the day cells' click-to-create, swallowed when this press's job was
      dismissing a popup. Chips, +N more, and the explicit create
      surfaces keep their plain handlers. */
  const openDraftFromCell = (iso: string) => {
    if (pressDismissed.current) return;
    openDraft(iso);
  };

  /* ── The composer's blur-commit vs the click that caused it ──
     Committing synchronously on blur tore the composer out of the DOM
     between mousedown and mouseup, so the cell's chips shifted mid-click
     and the click resolved against the day cell underneath — which REOPENED
     the composer instead of opening the chip the press was aimed at (same
     race for right-click → chip menu). So: a blur caused by a pointer press
     parks the draft's values and leaves the composer mounted — the DOM
     stays still, the gesture resolves against what was pressed — and the
     parked commit flushes right after the gesture's click has dispatched.
     Blurs with no button down (Tab away, programmatic focus) commit inline
     like before. */
  const pointerHeld = useRef(false);
  const pendingBlur = useRef<{
    d: { day: string; type: string; time?: string };
    title: string;
  } | null>(null);
  // state mirrors, so the window-level flush never reads a stale closure
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const flushNow = useRef<() => void>(() => {});

  /** the create half of a commit, decoupled from the state teardown:
      the deferred blur path creates from values captured at blur
      time, after the gesture that caused the blur has fully dispatched */
  const createFromDraft = (
    d: { day: string; type: string; time?: string },
    rawTitle: string,
  ) => {
    const title = rawTitle.trim();
    const { day, type, time } = d;
    if (!title) return;
    const typeSchema = typeSchemaFor(schema, type);
    const prop = datePropFor(type, notes, schema);
    const folder = folderFor(type, notes, typeHome(typeSchema));
    const foldedType = type.toLowerCase();
    const typeNotes = notes.filter(
      (n) => foldedPropStr(n.props, "type")?.toLowerCase() === foldedType,
    );
    // born complete: schema chips + template like the database
    // draft row; the picked day merges into the same create (no second
    // write) and is the date {{date}} instantiates to
    vaultTemplateRead(type)
      .then((tpl) =>
        vaultCreate(
          title,
          folder,
          type,
          mergeEntryProp(
            buildEntryProps({
              typeSchema,
              typeNotes,
              template: tpl,
              title,
              date: day,
            }),
            prop,
            // a canvas-slot draft is born timed; day cells stay day-only
            time ? `${day} ${time}` : day,
          ),
          buildEntryBody(tpl, title, day),
        ),
      )
      .then(onMutated)
      // A refused create (a title holding [ or ]) used to die on the
      // console with the draft already cleared — no entry, no message
      .catch((err) =>
        onToast?.(
          `couldn’t create “${title}” — ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  };

  const commitDraft = () => {
    if (!draft) return;
    const d = draft;
    const title = draftTitle;
    setDraft(null);
    setDraftTitle("");
    createFromDraft(d, title);
  };

  /** The input's blur handler. A blur mid-press only PARKS the
      draft — the composer stays mounted, so the pressed element keeps its
      geometry through mouseup and the click lands where the press did. The
      pointerup listener below flushes right after the click has dispatched.
      A blur with no button down (Tab away, programmatic focus moves)
      commits inline, exactly as before. */
  const onDraftBlur = () => {
    if (!draft) return;
    if (!pointerHeld.current) {
      commitDraft();
      return;
    }
    pendingBlur.current = { d: draft, title: draftTitle };
  };

  const flushPendingBlur = () => {
    const p = pendingBlur.current;
    if (!p) return;
    pendingBlur.current = null;
    // only tear down the exact draft that blurred — the gesture may have
    // already replaced or closed it
    if (draftNow.current === p.d) {
      setDraft(null);
      setDraftTitle("");
    }
    createFromDraft(p.d, p.title);
  };
  flushNow.current = flushPendingBlur;

  useEffect(() => {
    const down = () => {
      pointerHeld.current = true;
    };
    // the primary flush: window-CAPTURE click, flushed synchronously — it
    // runs before any React handler of the same click (those live on the
    // root), so the pressed chip's handler measures its anchor rect against
    // the post-teardown layout and the peek opens attached to the chip,
    // not to where the chip sat while the composer was mounted.
    const onClick = () => {
      if (pendingBlur.current) flushSync(() => flushNow.current());
    };
    // the fallback: gestures that never deliver a click (an HTML5 chip drag
    // swallows the stream, a cancelled press ends early) settle here; the
    // 0-timeout lands after any click of the same task, so when both fire
    // the capture flush has already emptied pendingBlur and this no-ops.
    const settle = () => {
      pointerHeld.current = false;
      if (pendingBlur.current) window.setTimeout(() => flushNow.current(), 0);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerup", settle, true);
    window.addEventListener("pointercancel", settle, true);
    window.addEventListener("dragend", settle, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerup", settle, true);
      window.removeEventListener("pointercancel", settle, true);
      window.removeEventListener("dragend", settle, true);
    };
  }, []);

  const cycleDraftType = (dir: 1 | -1 = 1) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const i = types.indexOf(cur.type);
      const next = types[(i + dir + types.length) % types.length] ?? "event";
      return { ...cur, type: next };
    });
  };

  // A failed date/repeat write used to die on the console — surface
  // it on App's toast and re-sync, so the grid never implies the write landed
  const reportWriteFailure = (err: unknown) => {
    onToast?.(
      `couldn’t save — ${err instanceof Error ? err.message : String(err)}`,
    );
    onMutated();
  };

  // A move used to commit silently — name the new day on App's toast
  // and offer an Undo that writes the captured prior value back. The drag
  // drop and the peek's date row share this one write path; only series
  // anchors reach either (virtual occurrences are inert), so the write and
  // its undo always shift the whole series — no special casing
  /** the value a date prop takes for a (possibly spanning) placement — the
      `day[ HH:MM]` form, with the `/end` half appended when
      the entry is a range. Every write path funnels through this, so a move,
      a time edit, or a peek reschedule can never silently drop a span's end. */
  const dateValue = (
    day: string,
    time?: string | null,
    end?: { day: string; time?: string } | null,
  ) => dateRangeValue(day, time, end);

  /** the end a spanning entry keeps when its start moves: the span holds its
      length — to the minute when both ends and the new start are timed,
      by whole days otherwise. Only a span's FIRST day is
      draggable (see `isAnchor`), so `span.day` is always the range's start
      and the delta is unambiguous. Pure math in calendar.ts. */
  const shiftedEnd = shiftedRangeEnd;

  const moveEntryTo = (
    path: string,
    prop: string,
    day: string,
    time?: string | null,
    end?: { day: string; time?: string } | null,
    /** what the toast and the undo entry are called — a resize names the new
        end, not the (unchanged) start day. Defaults to the move
        wording. */
    label?: string,
    /** skip the toast, still record the undo step: the peek's own rows show
        their result in place, so announcing it twice is noise
        (matching the time row) */
    quiet?: boolean,
  ) => {
    // The toast's Undo pops the entry cmd-Z would pop, by id, so the
    // two paths can't drift and undoing twice doesn't double-revert
    const id = nextUndoId();
    const title = noteByPath.get(path)?.title ?? path;
    const text = label ?? `“${title}” → ${formatDateHuman(day)}`;
    // a timed value keeps its time across a reschedule; a span
    // keeps its end, shifted by the same delta
    setPropUndoable({
      path,
      key: prop,
      value: dateValue(day, time, end),
      id,
      record: undo.record,
      label: text,
    })
      .then(() => {
        onMutated();
        if (quiet) return;
        onToast?.(text, {
          label: "Undo",
          run: () => undo.runById(id),
        });
      })
      .catch(reportWriteFailure);
  };

  /** The label a duration change wears: the interval itself when it stays
      inside one day, the closing day otherwise. */
  const resizeLabel = (
    title: string,
    start: { day: string; time?: string | null },
    end: { day: string; time?: string },
  ) =>
    end.day === start.day && start.time && end.time
      ? `“${title}” → ${start.time}–${end.time}`
      : `“${title}” → ends ${formatDateHuman(end.day)}${end.time ? ` ${end.time}` : ""}`;

  /** Set an entry's range END, holding its start. Both duration
      paths — the block's bottom-edge drag and the peek's end-time field —
      land here, so they share one write, one clamp and one undo shape.
      `time` null drops the end again (back to a plain single date).

      The start comes off the note's STORED value, never the rendered entry:
      the peek can open on any day a span covers, and the value is what the
      write has to rebuild. `clampedRangeEnd` runs first because
      `dateRangeValue` would otherwise SWAP a reversed pair — quietly moving
      the start instead of refusing, which is the one thing a resize must
      never do.

      Returns the end that was actually stored, so a caller with a text field
      can show the clamped value instead of the rejected one the user typed. */
  const setEntryEnd = (
    /** the peek passes its entry; the resize drag passes its own state, which
        carries the same path/prop/day/time — either identifies the value */
    e: { path: string; prop: string; day: string; time?: string | null },
    end: { day: string; time?: string } | null,
    quiet?: boolean,
  ): { day: string; time?: string } | null => {
    const stored = storedRange(e);
    const start = stored?.start ?? { day: e.day, time: e.time ?? null };
    const next = end ? clampedRangeEnd(start, end) : null;
    const cur = stored?.end;
    // no-op when nothing actually moves (a drag that lands back on its own
    // edge, an unchanged typed value) — no write, no toast, no undo entry
    if (
      (next?.day ?? null) === (cur?.day ?? null) &&
      (next?.time ?? null) === (cur?.time ?? null)
    )
      return next;
    const title = noteByPath.get(e.path)?.title ?? e.path;
    moveEntryTo(
      e.path,
      e.prop,
      start.day,
      start.time,
      next,
      next
        ? resizeLabel(title, start, next)
        : `“${title}” → ${formatDateHuman(start.day)}`,
      quiet,
    );
    return next;
  };

  /** the peek's Ends row: a typed end time, quiet like the time row beside it
      The DAY it lands on is the span's existing end day, so
      retiming the far end of a two-day event doesn't drag it back to day one;
      a single-day event's end stays on its own day.

      Hands the stored end time back to the field: a reversed value comes home
      clamped, and the row must never sit there showing what was refused. */
  const setPeekEnd = (e: CalEntry, time: string | null): string | null => {
    const stored = storedRange(e);
    const day = stored?.end?.day ?? stored?.start.day ?? e.day;
    return setEntryEnd(e, time ? { day, time } : null, true)?.time ?? null;
  };

  /** Drop targets differ in what they do to the value's time:
      month cells and the all-day strip's cells keep/clear it, the timed
      canvas sets it. `time` undefined = keep the dragged value's time
      (month), null = clear it (all-day strip), string = set it (canvas). */
  const dropOn = (day: string, time?: string | null) => {
    const d = drag;
    setDrag(null);
    setDropIso(null);
    if (!d) return;
    // a bottom-edge resize released anywhere but the timed canvas does
    // nothing — the all-day strip and month cells have no end to
    // aim at, and silently MOVING the event there would be a nasty surprise
    if (d.resize) return;
    const next = time === undefined ? d.time : (time ?? undefined);
    if (d.day === day && (d.time ?? null) === (next ?? null)) return;
    // a span moves whole: the end travels with the start, holding
    // the duration to the minute on a timed canvas drop
    moveEntryTo(d.path, d.prop, day, next, shiftedEnd(d, { day, time: next }));
  };

  /** A bottom-edge resize dropped on the timed canvas: the same
      drag state, the same snapped minute the move path uses, but the value's
      END follows the pointer while the start stays put. Returns false when
      the release wasn't a resize, so the canvas can fall through to a move. */
  const resizeDropOn = (day: string, time: string): boolean => {
    const d = drag;
    if (!d?.resize) return false;
    setDrag(null);
    setDropIso(null);
    setEntryEnd(d, { day, time });
    return true;
  };

  /* ----- entry peek writes — the same IPC the drag/chip paths use ----- */

  /** the peek's date row commits "day[ HH:MM][/day[ HH:MM]]" through the drag's
      write path. The peek can open on ANY day a span covers, so the write
      measures from the note's stored start, never from the day clicked. */
  const movePeekEntry = (e: CalEntry, iso: string) => {
    // the picker may hand back a range of its own — take it
    // wholesale; otherwise the entry's existing span slides with the new start
    const picked = splitDateRange(iso);
    if (!picked) return;
    const stored = storedRange(e);
    const end = picked.end
      ? { day: picked.end.day, time: picked.end.time ?? undefined }
      : stored?.end
        ? shiftedEnd(
            {
              day: stored.start.day,
              time: stored.start.time,
              endDay: stored.end.day,
              endTime: stored.end.time ?? undefined,
            },
            picked.start,
          )
        : null;
    moveEntryTo(e.path, e.prop, picked.start.day, picked.start.time, end);
  };

  /** the peek's time row rewrites the value's time part only — quiet (no
      toast): the row itself shows the result; a failure still toasts + resyncs */
  const setEntryTime = (e: CalEntry, time: string | null) => {
    // the START's time is what this row edits, and the span's end survives it
    // read both off the stored value, since the peek may have
    // opened on a continuation day
    const stored = storedRange(e);
    const start = stored?.start.day ?? e.day;
    const end = stored?.end
      ? { day: stored.end.day, time: stored.end.time ?? undefined }
      : null;
    setPropUndoable({
      path: e.path,
      key: e.prop,
      value: dateValue(start, time, end),
      record: undo.record,
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  /** status from the peek — "done from the calendar" */
  const setEntryStatus = (e: CalEntry, v: string | null) => {
    const props = noteByPath.get(e.path)?.props ?? {};
    setPropUndoable({
      path: e.path,
      key: foldedPropKey(props, "status"),
      value: v,
      record: undo.record,
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  /** the peek's title field renames — the new path then misses the peek's
      live-entry lookup and the popover closes itself */
  const commitPeekRename = (e: CalEntry, title: string) => {
    Promise.resolve(onRenameNote(e.path, title)).catch(reportWriteFailure);
  };

  /* ----- entry-chip menu actions ----- */

  const trashEntry = (e: CalEntry) => {
    onTrashNote(e.path);
  };

  /** the note's actual date DAY — the series anchor a chip belongs to.
      Day-only: a timed value ("2026-07-18 09:30") would never string-match
      e.day, wrongly reading every occurrence of a timed series as virtual */
  const anchorDayOf = (e: CalEntry): string | undefined =>
    splitDayTime(
      foldedPropStr(noteByPath.get(e.path)?.props ?? {}, e.prop) ?? "",
    )?.day;

  /** the note's stored value for this entry's prop, parsed. Write
      paths read the span from HERE rather than from the entry, because an
      entry is one covered day of a range and may not be its start. */
  const storedRange = (e: { path: string; prop: string }) =>
    splitDateRange(
      foldedPropStr(noteByPath.get(e.path)?.props ?? {}, e.prop) ?? "",
    );

  /** is this entry a CONTINUATION day of a span — a day the range
      covers that isn't its start? Those days are inert: the range moves by
      its start, so only the first day drags. */
  const isSpanTail = (e: CalEntry) =>
    e.spanPos !== undefined && e.spanPos !== "start";

  /** the overdue rule, shared by all three renderers: past
      day, deadline prop, non-repeating, not complete — and for a range, late
      only once its END has passed, so a span still running reads as current. */
  const entryOverdue = (e: CalEntry) =>
    !e.repeating &&
    entryEndDay(e) < todayIso &&
    !isComplete(e.status) &&
    isDeadline(schema, e.type, e.prop);

  const entryTip = (e: CalEntry) =>
    e.type && e.type.toLowerCase() !== "event"
      ? `${e.type} · ${e.title}`
      : e.title;

  /** span position as a class suffix: `cal-entry span start|mid|end`
      lets the CSS square the inner edges so consecutive days read as one bar
      across the row. A single date gets nothing and renders as it always did. */
  const spanClass = (e: CalEntry) => (e.spanPos ? ` span ${e.spanPos}` : "");

  /** An entry's identity color — the database's stable tint (the
      same `--opt-*` the type icon and select dots wear), quiet gray for
      untyped notes. Rides the chip as a CSS custom property so the styles
      decide what wears it (the leading bar, a span's fill) and overdue can
      override it with --danger without an inline-style fight. */
  const entryTintStyle = (e: CalEntry) =>
    ({
      "--entry-tint": e.type
        ? typeTint(e.type, iconForType(dbIcons, e.type))
        : "var(--opt-gray)",
    }) as CSSProperties;

  const externalTintStyle = (e: ExternalCalEntry) =>
    ({
      "--entry-tint": tintVar(e.tint) ?? "var(--opt-gray)",
    }) as CSSProperties;

  const externalTip = (e: ExternalCalEntry) =>
    [e.feedName, e.title, e.location].filter(Boolean).join(" · ");

  /** Done-from-the-calendar, visible but resolved — dim + strike.
      Non-repeating only: a series' status is the one note's, so a done
      weekly would wrongly strike every future occurrence. */
  const entryDone = (e: CalEntry) => !e.repeating && isComplete(e.status);

  const skipOccurrence = (e: CalEntry) => {
    // Repeat_skip only means anything to a series — writing it on a
    // plain entry (a date range's continuation day) does nothing visible but
    // leaves a key that would silently hole a series added later
    if (!e.repeating) return;
    const props = noteByPath.get(e.path)?.props ?? {};
    const repeatSkipKey = foldedPropKey(props, "repeat_skip");
    const cur = props[repeatSkipKey];
    const list = Array.isArray(cur)
      ? cur.filter((v): v is string => typeof v === "string")
      : typeof cur === "string"
        ? [cur]
        : [];
    setPropUndoable({
      path: e.path,
      key: repeatSkipKey,
      value: [...list, e.day],
      record: undo.record,
      label: `Skip ${formatDateHuman(e.day)}`,
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  const endSeriesBefore = (e: CalEntry) => {
    // Same guard as skipOccurrence — no series, no repeat_until
    if (!e.repeating) return;
    const anchor = anchorDayOf(e);
    const prev = parseDay(e.day);
    // ending on or before the anchor would erase the whole series — that is
    // delete-all, so do that instead; a broken anchor/unparsable day too
    if (!anchor || e.day <= anchor || !prev) {
      trashEntry(e);
      return;
    }
    const props = noteByPath.get(e.path)?.props ?? {};
    setPropUndoable({
      path: e.path,
      key: foldedPropKey(props, "repeat_until"),
      value: isoDay(addDays(prev, -1)),
      record: undo.record,
      label: "End series",
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  const commitRepeat = (e: CalEntry, v: string) => {
    setRepeatMenu(null);
    const props = noteByPath.get(e.path)?.props ?? {};
    if (v === "None") {
      // clearing the series also drops its end/skip bookkeeping
      // one user action, three keys — one undo entry, so cmd-Z restores the
      // whole series rather than just the last of the three writes
      setPropsUndoable({
        path: e.path,
        edits: [
          { key: foldedPropKey(props, "repeat"), value: null },
          { key: foldedPropKey(props, "repeat_until"), value: null },
          { key: foldedPropKey(props, "repeat_skip"), value: null },
        ],
        record: undo.record,
        label: "Clear repeat",
      })
        .then(onMutated)
        .catch(reportWriteFailure);
      return;
    }
    setPropUndoable({
      path: e.path,
      key: foldedPropKey(props, "repeat"),
      value: v.toLowerCase(),
      record: undo.record,
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  /** the type's done-like status option, if its schema carries one — the
      gate for "Mark done" in the entry menu: a plain event has no
      status to set, so the item simply doesn't exist there */
  const doneOption = (e: CalEntry): string | undefined => {
    if (!e.type) return undefined;
    const opts = statusSchemaFor(schema, e.type)?.options ?? [];
    return opts.find((o) => isComplete(o.value))?.value;
  };

  const entryMenuItems = (e: CalEntry, anchor: AnchorRect): MenuItem[] => {
    const done = doneOption(e);
    const items: MenuItem[] = [
      { label: "Open", onSelect: () => onOpenNote(e.path) },
      ...(done && !isComplete(e.status)
        ? [{ label: "Mark done", onSelect: () => setEntryStatus(e, done) }]
        : []),
      { label: "Repeat…", onSelect: () => setRepeatMenu({ entry: e, anchor }) },
    ];
    if (e.repeating) {
      items.push(
        { label: "Skip this occurrence", onSelect: () => skipOccurrence(e) },
        {
          label: "Delete this and following",
          onSelect: () => endSeriesBefore(e),
        },
        {
          label: "Delete all occurrences",
          danger: true,
          separatorAbove: true,
          onSelect: () => trashEntry(e),
        },
      );
    } else {
      items.push({
        label: "Move to Trash",
        danger: true,
        separatorAbove: true,
        onSelect: () => trashEntry(e),
      });
    }
    return items;
  };

  /** A day cell's own menu — create on that date, or jump. The
      handler lives on every day surface (month cell, all-day strip, canvas
      column); entry chips preventDefault first, so a prevented event means
      a chip's menu already owns the click. */
  const dayCellMenuProps = (iso: string, timed = false) => ({
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      // the draft composer's input keeps the native menu (paste, spellcheck);
      // while it is live anywhere (isTypingNow), the menu stands down — its
      // focus steal would blur-commit the half-typed entry
      if (e.defaultPrevented || isTyping(e.target) || isTypingNow()) return;
      e.preventDefault();
      e.stopPropagation();
      setFocusIso(iso);
      // on the canvas the pointer names a slot — the menu's draft opens at
      // that time, like the double-click compose on the same surface
      const time = timed
        ? minutesToTime(minuteAt(e.clientY, e.currentTarget))
        : undefined;
      setDayMenu({ x: e.clientX, y: e.clientY, iso, time });
    },
  });

  const dayMenuItems = (iso: string, time?: string): MenuItem[] => [
    {
      label: time
        ? `New entry at ${time}`
        : `New entry on ${humanDay(iso, today)}`,
      icon: <NoteIcon />,
      onSelect: () => openDraft(iso, undefined, time),
    },
    {
      label: "Open daily note",
      hint: iso === todayIso ? "⌘D" : undefined,
      onSelect: () => onOpenJournal(iso),
    },
    ...(iso !== todayIso
      ? [{ label: "Go to today", onSelect: () => go(today) }]
      : []),
  ];

  /** the Repeat… picker's current-value highlight: a bare cadence maps to its
      label, anything else ("every 2 weeks") matches no row */
  const repeatLabel = (e: CalEntry): string => {
    const raw = foldedPropStr(noteByPath.get(e.path)?.props ?? {}, "repeat")
      ?.trim()
      .toLowerCase();
    const labels: Record<string, string> = {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      yearly: "Yearly",
    };
    return labels[raw ?? ""] ?? "";
  };

  /** the peek's repeat row: the cadence label, a custom value verbatim
      ("every 2 weeks" matches no picker row), or "None" */
  const repeatText = (e: CalEntry): string => {
    const raw = foldedPropStr(
      noteByPath.get(e.path)?.props ?? {},
      "repeat",
    )?.trim();
    if (!raw) return "None";
    return repeatLabel(e) || raw;
  };

  /** the calendar's keyboard surface. Reached two ways:
      - primary: the focused day's canvas column, which now holds real DOM
        focus and takes the keys as a normal focused widget;
      - fallback: the window listener below, for when focus sits on inert
        chrome that owns no keys (the agenda header, the pane background) —
        the calendar's shortcuts have always worked from there and still do.
      Both routes run this one body, so the composer/peek/control guards
      below are enforced identically no matter where focus is. */
  const onCalKey = (e: KeyboardEvent | ReactKeyboardEvent<HTMLElement>) => {
    if (e.altKey) return;
    if (isTyping(e.target)) return; // the composer input handles its own keys
    // the peek (a body portal) owns its keys — its inputs revert on Esc,
    // its rows/buttons keep the grid's n/t/1-9 shortcuts from firing
    if (e.target instanceof HTMLElement && e.target.closest(".cal-peek"))
      return;
    // Focused controls own their platform activation. Otherwise Calendar's
    // bare-Enter shortcut cancels the button click and opens whichever item
    // happens to lead the visually focused day.
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === "Enter" || e.key === " ") &&
      target?.closest("button, a[href], [role='button'], summary")
    )
      return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        page(e.key === "ArrowLeft" ? -1 : 1);
        requestColFocus();
      }
      return;
    }
    const k = e.key;
    if (k === "ArrowLeft" || k === "h") {
      e.preventDefault();
      go(addDays(focusDate(), -1));
      requestColFocus();
    } else if (k === "ArrowRight" || k === "l") {
      e.preventDefault();
      go(addDays(focusDate(), 1));
      requestColFocus();
    } else if (onCanvas && (k === "ArrowUp" || k === "ArrowDown")) {
      // on the timed canvas ↑/↓ walk the focused day's canvas in
      // half-hours (Shift = quarters) instead of paging a week — vertical
      // IS time here. j/k keep the ±7-day step for anyone who wants it.
      e.preventDefault();
      const day = isoDay(focusDate());
      if (focusIso !== day) setFocusIso(day);
      requestColFocus();
      const size = e.shiftKey ? SLOT_FINE : SLOT_STEP;
      const step = size * (k === "ArrowUp" ? -1 : 1);
      setSlotMin((cur) => {
        if (cur === null) return SLOT_SEED;
        // Clamp to the last slot of the ACTIVE step, not a fixed quarter: a
        // plain ↓ that floored at 23:45 would put every later plain ↑ on a
        // :15/:45 phase the user can't leave, and that phase rides straight
        // into the composed note's time (review finding F1). The floor/ceiling
        // never drags the cursor backwards — arriving at 23:45 on a Shift step
        // and then pressing plain ↓ holds there rather than jumping up to
        // 23:30, since a Down press must never move the cursor up.
        const next = Math.min(Math.max(cur + step, 0), DAY_MIN - size);
        return step > 0 ? Math.max(next, cur) : Math.min(next, cur);
      });
    } else if (k === "ArrowUp" || k === "k") {
      e.preventDefault();
      go(addDays(focusDate(), -7));
      requestColFocus();
    } else if (k === "ArrowDown" || k === "j") {
      e.preventDefault();
      go(addDays(focusDate(), 7));
      requestColFocus();
    } else if (k === "Enter") {
      e.preventDefault();
      // an armed time cursor composes at its slot — the keyboard twin of
      // the canvas double-click
      if (slotMin !== null)
        openDraft(isoDay(focusDate()), undefined, minutesToTime(slotMin));
      else {
        // subscribed events are read-only chips with nothing to open, so
        // Enter reaches past them for the first note of the day
        const note = renderItems(isoDay(focusDate())).find(
          (i): i is CalEntry => !isExternalEntry(i),
        );
        if (note) onOpenNote(note.path);
        else openDraft(isoDay(focusDate()));
      }
    } else if (/^[1-9]$/.test(k)) {
      // count what the day actually shows: with a feed merged in, the nth
      // chip is not the nth vault note
      const item = renderItems(isoDay(focusDate()))[Number(k) - 1];
      if (item) {
        e.preventDefault();
        if (!isExternalEntry(item)) onOpenNote(item.path);
      }
    } else if (k === "n") {
      e.preventDefault();
      openDraft(isoDay(focusDate()));
    } else if (k === "t") {
      e.preventDefault();
      go(today);
      requestColFocus();
    } else if (k === "Escape") {
      if (draft) setDraft(null);
      else if (peek) setPeek(null);
      else if (expandedIso) setExpandedIso(null);
      // the time cursor unwinds before the day focus does — Esc
      // out of "compose at 09:30", then out of the day. The rover falls
      // back to today when no day is focused, so DOM focus must follow it —
      // otherwise the :focus-visible ring keeps burning on the old column
      // while the next ArrowDown arms today's (review)
      else if (slotMin !== null) setSlotMin(null);
      else if (focusIso) {
        setFocusIso(null);
        requestColFocus();
      }
    }
  };

  // the window-level fallback. It skips events that already reached a canvas
  // column, so a key pressed with the column focused runs the body exactly
  // once (the element handler is the primary route).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest(".cal-wk-col"))
        return;
      onCalKey(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    days,
    focusIso,
    draft,
    mergedByDay,
    layout,
    cursor,
    onOpenNote,
    peek,
    slotMin,
  ]);

  // roving tabindex: real DOM focus follows the focused day when a
  // keyboard gesture asks for it, so the ring is where focus actually is and a
  // screen reader announces the column it lands on.
  useEffect(() => {
    if (colFocusReq === 0 || !onCanvas) return;
    // focusDate()'s fallback (today, else the first visible day) keeps the
    // ring truthful when Esc just cleared focusIso (review)
    const iso = focusIso ?? isoDay(visible.has(todayIso) ? today : days[0]);
    const el = canvasRef.current?.querySelector<HTMLElement>(
      `.cal-wk-col[data-iso="${iso}"]`,
    );
    // never yank focus out of the composer — a draft owns its input
    if (
      el &&
      el !== document.activeElement &&
      !isTyping(document.activeElement)
    )
      el.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colFocusReq, focusIso, onCanvas]);

  // past non-repeating deadlines pin an Overdue group atop the agenda
  // the Today strip's "Show in Calendar" lands somewhere honest
  const overdue = useMemo(
    () => overdueEntries(notes, schema, todayIso),
    [notes, schema, todayIso],
  );

  const upcoming = (() => {
    const out: { iso: string; label: string; items: CalendarRenderEntry[] }[] =
      [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i);
      const iso = isoDay(d);
      const items = renderItems(iso);
      if (!items?.length) continue;
      const label =
        i === 0
          ? "Today"
          : i === 1
            ? "Tomorrow"
            : `${WEEKDAYS[(d.getDay() + 6) % 7]} ${humanDay(iso, today)}`;
      out.push({ iso, label, items });
    }
    return out;
  })();

  /** a day column's accessible name: the same thing the surface's
      own headings say — the weekday label over the column plus the day number
      in its cell ("Mon, Jul 20"), so a screen reader names the column the way
      a sighted user reads it. */
  const dayLabel = (iso: string): string => {
    const d = parseDay(iso);
    const wd = d ? WEEKDAYS[(d.getDay() + 6) % 7] : "";
    return `${wd}, ${humanDay(iso, today)}`;
  };

  const weekTitle = () => {
    const first = days[0];
    const last = days[days.length - 1];
    const y = last.getFullYear();
    const f = `${humanDay(isoDay(first), today)}`;
    const l =
      first.getMonth() === last.getMonth()
        ? String(last.getDate())
        : humanDay(isoDay(last), today);
    return `${f} – ${l}, ${y}`;
  };

  /** Day's title — the weekday the column header would carry, its date, and
      the year the week range also always spells out. humanDay
      already appends a foreign year, so only the current one is added. */
  const dayTitle = () => {
    const d = days[0];
    const label = dayLabel(isoDay(d));
    return d.getFullYear() === today.getFullYear()
      ? `${label}, ${d.getFullYear()}`
      : label;
  };

  const entryChip = (e: CalEntry) => {
    // only the anchor (the note's real date) is draggable — moving it rewrites
    // the date prop, shifting the whole series; virtual occurrences are inert.
    // A span's continuation days are inert for the same reason: the
    // range moves by its start
    const isAnchor =
      (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // an overdue deadline chip's one red mark is a --danger border-left
    // same rule as the agenda group: past day, deadline prop,
    // non-repeating, not complete. A range is late only once its
    // END has passed — a span still running is not overdue
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day
            ? " dragging"
            : ""
        }${isOverdue ? " overdue" : ""}${entryDone(e) ? " done" : ""}${spanClass(e)}${isSelected(e) ? " selected" : ""}`}
        style={entryTintStyle(e)}
        draggable={isAnchor}
        title={isOverdue ? `${tip} · overdue` : tip}
        aria-label={e.title}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.path);
          ev.dataTransfer.effectAllowed = "move";
          setDrag({
            path: e.path,
            prop: e.prop,
            day: e.day,
            time: e.time,
            endDay: e.endDay,
            endTime: e.endTime,
          });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({
            path: e.path,
            prop: e.prop,
            day: e.day,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({
            x: ev.clientX,
            y: ev.clientY,
            entry: e,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
      >
        {/* Month chips are Notion-style lines — the type's color
            bar carries identity (the boxed icon cost a row of height per
            entry); the icon language stays on the roomier week/agenda
            surfaces. A span needs no bar: its tinted fill IS the identity
            mark, and a bar would break the bar-runs-across-the-row read. */}
        {e.spanPos === undefined && (
          <span className="cal-entry-bar" aria-hidden="true" />
        )}
        {e.time && <span className="cal-entry-time">{e.time}</span>}
        <span className="cal-entry-title">{e.title}</span>
        {e.repeating && <RepeatIcon />}
      </button>
    );
  };

  const externalChip = (e: ExternalCalEntry) => (
    <button
      type="button"
      key={`external:${e.id}:${e.day}`}
      className={`cal-entry external${e.spanPos ? ` span ${e.spanPos}` : ""}`}
      style={externalTintStyle(e)}
      title={externalTip(e)}
      aria-label={`${e.title}, external calendar ${e.feedName}`}
      aria-disabled="true"
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {e.spanPos === undefined && (
        <span className="cal-entry-bar" aria-hidden="true" />
      )}
      {e.time && <span className="cal-entry-time">{e.time}</span>}
      <span className="cal-entry-title">{e.title}</span>
      <span className="cal-external-mark" aria-hidden="true" />
    </button>
  );

  const monthItem = (entry: CalendarRenderEntry) =>
    isExternalEntry(entry) ? externalChip(entry) : entryChip(entry);

  /* ── Week layout ── a real weekly surface, not a stretched month
     row: seven day columns of full entry cards (icon + title + time when
     timed + a compact prop subtitle, the database card language). byDay
     already orders all-day first, then timed ascending, and there
     is no "+N more" cap — the columns have the room. The month renderers
     above stay untouched; the fork happens at the grid. */
  const weekCard = (e: CalEntry) => {
    // same drag rule as the month chip: only the series anchor moves, and a
    // span moves by its first day only — pane-level drop handlers
    // key off the column's [data-iso] either way
    const isAnchor =
      (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // same overdue rule as the month chip
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    const note = noteByPath.get(e.path);
    const sub = note
      ? cardSubtitle(
          note,
          typeSchemaFor(schema, e.type) ?? {},
          undefined,
          undefined,
          undefined,
          undefined,
          numberLocale,
        )
      : null;
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day
            ? " dragging"
            : ""
        }${entryDone(e) ? " done" : ""}${spanClass(e)}${isSelected(e) ? " selected" : ""}`}
        style={entryTintStyle(e)}
        draggable={isAnchor}
        title={isOverdue ? `${tip} · overdue` : tip}
        aria-label={e.title}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.path);
          ev.dataTransfer.effectAllowed = "move";
          setDrag({
            path: e.path,
            prop: e.prop,
            day: e.day,
            time: e.time,
            endDay: e.endDay,
            endTime: e.endTime,
          });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({
            path: e.path,
            prop: e.prop,
            day: e.day,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({
            x: ev.clientX,
            y: ev.clientY,
            entry: e,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
      >
        <span className="cal-wk-head">
          {isOverdue && <span className="cal-dot" />}
          {entryIcon(e)}
          {e.time && <span className="cal-entry-time">{e.time}</span>}
          <span className="cal-entry-title">{e.title}</span>
          {e.repeating && <RepeatIcon />}
        </span>
        {sub && <span className="row-sub cal-wk-sub">{sub}</span>}
      </button>
    );
  };

  const externalWeekCard = (e: ExternalCalEntry) => (
    <button
      type="button"
      key={`external:${e.id}:${e.day}`}
      className={`cal-entry external${e.spanPos ? ` span ${e.spanPos}` : ""}`}
      style={externalTintStyle(e)}
      title={externalTip(e)}
      aria-label={`${e.title}, external calendar ${e.feedName}`}
      aria-disabled="true"
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="cal-wk-head">
        <CalendarIcon />
        {e.time && <span className="cal-entry-time">{e.time}</span>}
        <span className="cal-entry-title">{e.title}</span>
        <span className="cal-external-mark" aria-hidden="true" />
      </span>
      <span className="row-sub cal-wk-sub">{e.feedName}</span>
    </button>
  );

  const weekItem = (entry: CalendarRenderEntry) =>
    isExternalEntry(entry) ? externalWeekCard(entry) : weekCard(entry);

  /** the strip's day cell: day number + create affordance +
      all-day cards. Dropping here reschedules to the day AND clears the
      value's time — "make it all-day", the timed canvas's counterpart.
      Cards cap like a month cell ("+N more" expands in place): the canvas
      owns the vertical room, and a strip kept shorter than its max never
      scrolls — a scrolled strip turns Chromium's drag auto-scroll loose
      under every card drag. */
  const alldayCell = (d: Date) => {
    const iso = isoDay(d);
    // a time the canvas math can't place renders here instead of stacking
    // silently at 00:00 (defensive — splitDayTime and the canvas's HH_MM
    // agree today)
    const items = renderItems(iso).filter(
      (e) => !e.time || timeToMinutes(e.time) === null,
    );
    const expanded = expandedIso === iso;
    const cap = expanded ? items.length : ALLDAY_CAP;
    const overflow = items.length - cap;
    // week days are never adjacent-month cells — today/focus/drop only
    const cls = [
      "cal-day",
      "cal-wk-cell",
      iso === todayIso ? "today" : "",
      iso === focusIso ? "focused" : "",
      iso === dropIso && dropMin === null ? "drop" : "",
      expanded ? "expanded" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={iso}
        data-iso={iso}
        className={cls}
        // The strip cell is a labelled grouping of that day's all-day
        // entries, same shape as the canvas column below it. It stays
        // non-focusable — naming a region and making it a tab stop are separate
        // decisions, and the strip has no roving-tabindex widget behind it. The
        // "All-day" prefix keeps it distinct from the canvas column, which
        // carries the bare day name for the same date.
        role="group"
        aria-label={`All-day, ${dayLabel(iso)}`}
        onClick={() => openDraftFromCell(iso)}
        {...dayCellMenuProps(iso)}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dropIso !== iso) setDropIso(iso);
          setDropMin((cur) => (cur === null ? cur : null));
        }}
        onDragLeave={() => setDropIso((cur) => (cur === iso ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          dropOn(iso, null);
        }}
      >
        <button
          type="button"
          className="cal-daynum"
          onClick={(e) => {
            e.stopPropagation();
            openDraftFromCell(iso);
          }}
          aria-label={`New entry on ${humanDay(iso, today)}`}
          aria-current={iso === todayIso ? "date" : undefined}
        >
          {/* same month-seam label as the month grid */}
          <span
            className={
              iso === todayIso
                ? "cal-today"
                : d.getDate() === 1
                  ? "cal-seam"
                  : ""
            }
          >
            {iso === todayIso ? d.getDate() : cellDayLabel(d)}
          </span>
        </button>
        {draft?.day === iso && !draft.time && composer}
        {items.slice(0, cap).map(weekItem)}
        {overflow > 0 && (
          <button
            type="button"
            className="cal-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedIso(iso);
              go(d);
            }}
            aria-label={`Show ${overflow} more entries for ${humanDay(iso, today)}`}
            aria-expanded="false"
          >
            +{overflow} more
          </button>
        )}
        {expanded && (
          <button
            type="button"
            className="cal-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedIso(null);
            }}
            aria-label={`Show fewer entries for ${humanDay(iso, today)}`}
            aria-expanded="true"
          >
            Show less
          </button>
        )}
      </div>
    );
  };

  /** a timed entry's canvas block: positioned by its HH:MM, as
      tall as its same-day end time says or a default hour without
      one, lane-split when entries overlap. Same interactions as every other
      entry surface. */
  const canvasBlock = (
    e: CalEntry,
    box: { top: number; height: number; left: number; width: number },
  ) => {
    const isAnchor =
      (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // the bottom edge is grabbable only where it means something:
    // on the block that owns the value, and only while the event lives inside
    // one day. A multi-day span's start block paints a default hour, so its
    // bottom edge isn't the event's end — dragging it would be a lie; those
    // ends move through the peek's date row instead.
    const canResize = isAnchor && (e.endDay == null || e.endDay === e.day);
    // same overdue rule as every other entry surface
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry cal-wk-block${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day
            ? " dragging"
            : ""
        }${isOverdue ? " overdue" : ""}${entryDone(e) ? " done" : ""}${isSelected(e) ? " selected" : ""}`}
        style={{
          top: `${box.top}%`,
          height: `${box.height}%`,
          left: `${box.left}%`,
          width: `${box.width}%`,
          ...entryTintStyle(e),
        }}
        draggable={isAnchor}
        title={isOverdue ? `${tip} · overdue` : tip}
        aria-label={e.title}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.path);
          ev.dataTransfer.effectAllowed = "move";
          setDrag({
            path: e.path,
            prop: e.prop,
            day: e.day,
            time: e.time,
            endDay: e.endDay,
            endTime: e.endTime,
          });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
          setDropMin(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({
            path: e.path,
            prop: e.prop,
            day: e.day,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({
            x: ev.clientX,
            y: ev.clientY,
            entry: e,
            anchor: anchorFrom(ev.currentTarget),
          });
        }}
      >
        <span className="cal-wk-head">
          {entryIcon(e)}
          <span className="cal-entry-time">{e.time}</span>
          {e.repeating && <RepeatIcon />}
        </span>
        <span className="cal-entry-title">{e.title}</span>
        {/* the duration grip: a thin band on the block's bottom
            edge, dragged with the very machinery that moves an event — same
            drag state, same quarter-hour snap, same ghost line, same undoable
            write — only the drop rewrites the range's END. Pointer-only and
            hidden from assistive tech on purpose: the keyboard path to a
            duration is the peek's Ends field, which is a typed time rather
            than a pixel. `stopPropagation` on dragstart keeps the parent
            block's move-drag from firing too. */}
        {canResize && (
          <span
            className="cal-wk-grip"
            aria-hidden="true"
            title="Drag to set the end time"
            draggable
            onDragStart={(ev) => {
              ev.stopPropagation();
              ev.dataTransfer.setData("text/plain", e.path);
              ev.dataTransfer.effectAllowed = "move";
              setDrag({
                path: e.path,
                prop: e.prop,
                day: e.day,
                time: e.time,
                endDay: e.endDay,
                endTime: e.endTime,
                resize: true,
              });
            }}
            // a grab that never became a drag must not open the peek behind it
            onClick={(ev) => ev.stopPropagation()}
            onDoubleClick={(ev) => ev.stopPropagation()}
          />
        )}
      </button>
    );
  };

  const externalCanvasBlock = (
    e: ExternalCalEntry,
    box: { top: number; height: number; left: number; width: number },
  ) => (
    <button
      type="button"
      key={`external:${e.id}:${e.day}`}
      className="cal-entry cal-wk-block external"
      style={{
        top: `${box.top}%`,
        height: `${box.height}%`,
        left: `${box.left}%`,
        width: `${box.width}%`,
        ...externalTintStyle(e),
      }}
      title={externalTip(e)}
      aria-label={`${e.title}, external calendar ${e.feedName}`}
      aria-disabled="true"
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <span className="cal-wk-head">
        <CalendarIcon />
        <span className="cal-entry-time">{e.time}</span>
        <span className="cal-external-mark" aria-hidden="true" />
      </span>
      <span className="cal-entry-title">{e.title}</span>
    </button>
  );

  const canvasItem = (
    entry: CalendarRenderEntry,
    box: { top: number; height: number; left: number; width: number },
  ) =>
    isExternalEntry(entry)
      ? externalCanvasBlock(entry, box)
      : canvasBlock(entry, box);

  /** minute-of-day under the pointer, snapped to the drop grid — the column
      IS 24h tall, so offset scales linearly */
  const minuteAt = (clientY: number, col: HTMLElement) => {
    const r = col.getBoundingClientRect();
    return snapMinutes(((clientY - r.top) / r.height) * DAY_MIN);
  };

  /** one day's timed canvas column: hour lines from CSS, blocks by time,
      the now-line on today. Drops land on the snapped quarter-hour; a
      DOUBLE-click on empty canvas composes a timed draft at that slot — a
      single click is too eager on a 1150px surface (stray clicks, click
      residue after drags). The entry must also parse under the canvas's
      minute math — a time that doesn't goes to the strip, never to a
      silent 00:00 stack. */
  /** roving tabindex: exactly one tab stop for the whole week — the
      focused day, or (nothing focused yet) whichever day the shortcuts would
      already act on. Tab enters the canvas once; the arrows do the rest. */
  const roverIso = isoDay(focusDate());

  const canvasColumn = (d: Date) => {
    const iso = isoDay(d);
    const timed = renderItems(iso).filter(
      (e) => e.time && timeToMinutes(e.time) !== null,
    );
    // a same-day range shapes its own block — height AND the
    // overlap math, so a 14:00 entry inside a 09:00–17:00 one lanes beside it.
    // A multi-day span's endTime belongs to its LAST day, not this column, so
    // its start day keeps the default block rather than painting a lie.
    const boxes = layoutLanes(
      timed.map((e) =>
        blockSpan(
          e.time ?? "",
          e.endDay == null || e.endDay === e.day
            ? (e.endTime ?? undefined)
            : undefined,
        ),
      ),
    );
    const cls = [
      "cal-wk-col",
      iso === todayIso ? "today" : "",
      // the canvas half wears the same focus ring as its strip cell
      iso === focusIso ? "focused" : "",
      iso === dropIso && dropMin !== null ? "drop" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const isRover = iso === roverIso;
    return (
      <div
        key={iso}
        data-iso={iso}
        className={cls}
        // `group` + an aria-label: a column is a labelled grouping of that
        // day's timed entries, which is all it honestly is. It is NOT a
        // gridcell — there is no row/column grid semantics here (the strip
        // and the canvas are separate DOM subtrees and the vertical axis is
        // continuous time, not cells), and claiming grid would promise
        // navigation semantics the widget doesn't implement.
        role="group"
        aria-label={dayLabel(iso)}
        tabIndex={isRover ? 0 : -1}
        onFocus={(e) => {
          // tabbing into a column makes it the focused day, so the ring and
          // the keys agree with where focus actually is. Only the column
          // itself: React's onFocus bubbles, and focus landing on a child
          // (an entry block, the composer's input) must not re-target the day.
          if (e.target === e.currentTarget && focusIso !== iso)
            setFocusIso(iso);
        }}
        onKeyDown={onCalKey}
        onDoubleClick={(e) => {
          const min = minuteAt(e.clientY, e.currentTarget);
          openDraft(iso, undefined, minutesToTime(min));
        }}
        {...dayCellMenuProps(iso, true)}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const min = minuteAt(e.clientY, e.currentTarget);
          if (dropIso !== iso) setDropIso(iso);
          setDropMin((cur) => (cur === min ? cur : min));
        }}
        onDragLeave={() => setDropIso((cur) => (cur === iso ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          const min = minuteAt(e.clientY, e.currentTarget);
          // a bottom-edge drag rewrites the END here; anything
          // else is the ordinary move-to-this-slot drop
          if (resizeDropOn(iso, minutesToTime(min))) return;
          dropOn(iso, minutesToTime(min));
        }}
      >
        {/* the keyboard time cursor: a half-hour band on the focused
            day — the slot Enter composes into. Rendered under the blocks: it
            marks empty canvas, it doesn't veil what's already booked. */}
        {iso === focusIso && slotMin !== null && (
          <div
            className="cal-wk-slot"
            data-min={slotMin}
            style={{
              top: `${(slotMin / DAY_MIN) * 100}%`,
              // the last reachable slot is 23:45 — the band shortens rather
              // than painting past midnight
              height: `${(Math.min(SLOT_STEP, DAY_MIN - slotMin) / DAY_MIN) * 100}%`,
            }}
          >
            <span>{minutesToTime(slotMin)}</span>
          </div>
        )}
        {timed.map((e, i) =>
          canvasItem(e, {
            top: (boxes[i].start / DAY_MIN) * 100,
            height: ((boxes[i].end - boxes[i].start) / DAY_MIN) * 100,
            left: (boxes[i].lane / boxes[i].lanes) * 100,
            width: (1 / boxes[i].lanes) * 100,
          }),
        )}
        {/* a canvas-born draft composes at its slot, not in the strip —
            the input floats where the entry will land */}
        {draft?.day === iso && draft.time && (
          <div
            className="cal-wk-draft"
            style={{
              top: `${((timeToMinutes(draft.time) ?? 0) / DAY_MIN) * 100}%`,
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {composer}
          </div>
        )}
        {iso === todayIso && (
          <div
            className="cal-wk-now"
            style={{ top: `${(nowMin / DAY_MIN) * 100}%` }}
          />
        )}
        {iso === dropIso && dropMin !== null && drag && (
          <div
            className="cal-wk-ghost"
            style={{ top: `${(dropMin / DAY_MIN) * 100}%` }}
          >
            <span>{minutesToTime(dropMin)}</span>
          </div>
        )}
      </div>
    );
  };

  const composer = draft && (
    <div className="cal-draft" onClick={(e) => e.stopPropagation()}>
      {/* nothing to pick when only `event` is creatable — the badge
          and its picker stay home; Tab-cycling is already a 1-item no-op */}
      {types.length > 1 && (
        <button
          className="cal-draft-type"
          title="Database — click to pick, Tab cycles"
          onMouseDown={(e) => e.preventDefault() /* keep input focus */}
          onClick={(e) => setTypeMenu(anchorFrom(e.currentTarget))}
        >
          {draft.type}
        </button>
      )}
      <input
        className="cal-draft-input"
        ref={draftInputRef}
        autoFocus
        placeholder="Title…"
        value={draftTitle}
        onChange={(e) => setDraftTitle(e.target.value)}
        onBlur={() => {
          // the type picker's filter input steals focus — that's not click-away
          if (!typeMenu) onDraftBlur();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            setDraftTitle("");
          } else if (e.key === "Tab") {
            e.preventDefault();
            cycleDraftType(e.shiftKey ? -1 : 1);
          }
        }}
      />
    </div>
  );

  const dayCell = (d: Date) => {
    const iso = isoDay(d);
    const items = renderItems(iso);
    // "+N more" expands the cell in place — it renders (and scrolls)
    // its full entry list until a second click, Esc, or a click elsewhere
    const expanded = expandedIso === iso;
    const cap = layout === "month" && !expanded ? MONTH_CAP : items.length;
    const overflow = items.length - cap;
    const cls = [
      "cal-day",
      layout === "month" && d.getMonth() !== cursor.getMonth() ? "adj" : "",
      // Sat/Sun cells read a shade quieter than the workweek (week start Mon)
      d.getDay() === 0 || d.getDay() === 6 ? "wknd" : "",
      iso === todayIso ? "today" : "",
      iso === focusIso ? "focused" : "",
      iso === dropIso ? "drop" : "",
      expanded ? "expanded" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={iso}
        data-iso={iso}
        className={`${cls}${expanded ? expandedFade.className : ""}`}
        // the fade's ref/onScroll only ride the one expanded cell — a
        // collapsed cell hides overflow behind "+N more", not a scroll edge
        {...(expanded ? expandedFade.props : {})}
        // The month cell had the same anonymous-div shape as the week
        // strip — only its day-number button was named, which names the button,
        // not the day. Same `group` treatment, same reason it isn't `gridcell`
        // (no grid navigation semantics are implemented here), and likewise no
        // tab stop.
        role="group"
        aria-label={dayLabel(iso)}
        onClick={() => openDraftFromCell(iso)}
        {...dayCellMenuProps(iso)}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dropIso !== iso) setDropIso(iso);
        }}
        onDragLeave={() => setDropIso((cur) => (cur === iso ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          dropOn(iso);
        }}
      >
        <button
          type="button"
          className="cal-daynum"
          onClick={(e) => {
            e.stopPropagation();
            openDraftFromCell(iso);
          }}
          aria-label={`New entry on ${humanDay(iso, today)}`}
          aria-current={iso === todayIso ? "date" : undefined}
        >
          {/* The 1st names its month ("Aug 1") so the seam between
              months is visible in-grid; today's circle wins the collision —
              it already orients harder than a month label could */}
          <span
            className={
              iso === todayIso
                ? "cal-today"
                : d.getDate() === 1
                  ? "cal-seam"
                  : ""
            }
          >
            {iso === todayIso ? d.getDate() : cellDayLabel(d)}
          </span>
        </button>
        {draft?.day === iso && composer}
        {items.slice(0, cap).map(monthItem)}
        {overflow > 0 && (
          <button
            type="button"
            className="cal-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedIso(iso);
              go(d);
            }}
            aria-label={`Show ${overflow} more entries for ${humanDay(iso, today)}`}
            aria-expanded="false"
          >
            +{overflow} more
          </button>
        )}
        {expanded && (
          <button
            type="button"
            className="cal-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedIso(null);
            }}
            aria-label={`Show fewer entries for ${humanDay(iso, today)}`}
            aria-expanded="true"
          >
            Show less
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="cal">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">
          {layout === "month"
            ? monthTitle(cursor.getFullYear(), cursor.getMonth())
            : layout === "day"
              ? dayTitle()
              : weekTitle()}
        </span>
        <div className="db-tools">
          <button
            className={`db-new cal-feeds-button${feedSnapshot.feeds.some((feed) => feed.enabled) ? " active" : ""}`}
            onClick={() => setFeedsOpen(true)}
            title="External calendars"
          >
            Calendars
          </button>
          <button
            className="db-new"
            onClick={() => openDraft(isoDay(focusDate()))}
            title="New entry (N)"
          >
            New
          </button>
          <button
            className="db-new cal-today"
            onClick={() => go(today)}
            title="Jump to today (T)"
          >
            Today
          </button>
          <div className="cal-pager">
            <button
              onClick={() => page(-1)}
              title={`Previous ${layout} (⌘←)`}
            >
              <ChevronLeftIcon />
            </button>
            <button onClick={() => page(1)} title={`Next ${layout} (⌘→)`}>
              <ChevronRightIcon />
            </button>
          </div>
          <SwitchGroup className="cal-layouts" label="Calendar layout">
            {(["month", "week", "day"] as const).map((l) => (
              <button
                key={l}
                className={layout === l ? "active" : undefined}
                onClick={() => setLayout(l)}
              >
                {LAYOUT_LABELS[l]}
              </button>
            ))}
          </SwitchGroup>
        </div>
      </div>
      {feedsOpen && (
        <CalendarFeedsMenu
          snapshot={feedSnapshot}
          onClose={() => setFeedsOpen(false)}
          onChanged={() => setFeedReload((n) => n + 1)}
          onToast={onToast}
        />
      )}
      {/* one custom property carries the canvas's column count to
          all three of its rows (header, all-day strip, timed canvas), so Day
          is Week with `--cal-cols: 1` rather than a second surface. Month
          keeps the property unset and its own seven-column template. */}
      <div
        className="cal-grid-scroll"
        style={
          onCanvas
            ? ({ "--cal-cols": days.length } as CSSProperties)
            : undefined
        }
      >
        <div className={`cal-weekdays${onCanvas ? " week" : ""}`}>
          {onCanvas && <span className="cal-wk-spacer" aria-hidden="true" />}
          {/* today's column header sharpens when today is on the
              grid — the second orientation mark Notion Calendar leans on
              (the circled day number alone is easy to lose in six rows).
              Month names the seven weekdays once for six rows of cells; the
              canvas names its own columns, which is the same seven in Week
              and just the one in Day. */}
          {(layout === "month"
            ? WEEKDAYS.map((w, i) => ({ key: w, label: w, weekday: i }))
            : days.map((d) => ({
                key: isoDay(d),
                label: WEEKDAYS[(d.getDay() + 6) % 7],
                weekday: (d.getDay() + 6) % 7,
              }))
          ).map(({ key, label, weekday }) => (
            <span
              key={key}
              className={
                visible.has(todayIso) && (today.getDay() + 6) % 7 === weekday
                  ? "cal-wd-today"
                  : undefined
              }
            >
              {label}
            </span>
          ))}
        </div>
        {layout === "month" ? (
          <div className="cal-grid month" ref={gridRef}>
            {days.map(dayCell)}
          </div>
        ) : (
          <>
            {/* the week surface: a pinned all-day strip over a
                scrollable 24h canvas — the strip keeps the card
                language, the canvas places timed entries by their HH:MM */}
            <div className="cal-grid week" ref={gridRef}>
              <span className="cal-wk-spacer" aria-hidden="true" />
              {days.map(alldayCell)}
            </div>
            <div className="cal-wk-scroll" ref={weekScrollRef}>
              <div
                className="cal-wk-canvas"
                ref={canvasRef}
                style={{ height: 24 * HOUR_PX }}
              >
                <div className="cal-wk-gutter" aria-hidden="true">
                  {Array.from({ length: 23 }, (_, h) => (
                    <span
                      key={h + 1}
                      style={{ top: `${((h + 1) / 24) * 100}%` }}
                    >
                      {String(h + 1).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
                {days.map(canvasColumn)}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="cal-agenda">
        <div className="cal-agenda-head">Upcoming</div>
        <div
          className={`cal-agenda-body${agendaFade.className}`}
          {...agendaFade.props}
        >
          {/* Past non-repeating deadlines pin to the top, oldest
              first — no overdue, no group (and no empty header) */}
          {overdue.length > 0 && (
            <div className="cal-ag-row cal-ag-overdue">
              <span className="cal-ag-day overdue">Overdue</span>
              <div className="cal-ag-items">
                {overdue.map((e) => (
                  <button
                    type="button"
                    key={`${e.path}:${e.prop}:${e.day}`}
                    className={`cal-ag-item${isSelected(e) ? " selected" : ""}`}
                    onClick={() => onOpenNote(e.path)}
                    onContextMenu={(ev) => {
                      // same menu as the grid chips — overdue rows
                      // are exactly where "Mark done" / "Move to Trash" is
                      // needed most
                      ev.preventDefault();
                      ev.stopPropagation();
                      setMenu({
                        x: ev.clientX,
                        y: ev.clientY,
                        entry: e,
                        anchor: anchorFrom(ev.currentTarget),
                      });
                    }}
                    aria-label={e.title}
                  >
                    <span className="cal-dot" title="Overdue deadline" />
                    <span className="cal-entry-title">{e.title}</span>
                    <span className="cal-ag-when">
                      {humanDay(e.day, today)}
                      {e.time ? `, ${e.time}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {upcoming.length === 0 && overdue.length === 0 && (
            <div className="cal-hint">
              Any note with a date property shows up here.
            </div>
          )}
          {upcoming.map((g) => (
            <div key={g.iso} className="cal-ag-row">
              <button
                type="button"
                className={`cal-ag-day${g.iso === todayIso ? " today" : ""}`}
                onClick={() => go(parseDay(g.iso) ?? today)}
                aria-label={g.label}
                aria-current={g.iso === todayIso ? "date" : undefined}
              >
                {g.label}
              </button>
              <div className="cal-ag-items">
                {g.items.map((e) =>
                  isExternalEntry(e) ? (
                    <div
                      key={`external:${e.id}:${e.day}`}
                      className="cal-ag-item external"
                      style={externalTintStyle(e)}
                      title={externalTip(e)}
                      aria-label={`${e.title}, external calendar ${e.feedName}`}
                    >
                      <CalendarIcon />
                      {e.time && (
                        <span className="cal-entry-time">{e.time}</span>
                      )}
                      <span className="cal-entry-title">{e.title}</span>
                      <span className="cal-feed-badge">{e.feedName}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      key={`${e.path}:${e.prop}:${e.day}`}
                      className={`cal-ag-item${entryDone(e) ? " done" : ""}${isSelected(e) ? " selected" : ""}`}
                      onClick={() => onOpenNote(e.path)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setMenu({
                          x: ev.clientX,
                          y: ev.clientY,
                          entry: e,
                          anchor: anchorFrom(ev.currentTarget),
                        });
                      }}
                      aria-label={e.title}
                    >
                      {entryIcon(e)}
                      {e.time && (
                        <span className="cal-entry-time">{e.time}</span>
                      )}
                      <span className="cal-entry-title">{e.title}</span>
                    </button>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {typeMenu && draft && (
        <SelectMenu
          anchor={typeMenu}
          value={draft.type}
          options={[]}
          used={types}
          canEditSchema={false}
          label="Create as"
          listHeading="Create as"
          valueIcons={dbIcons}
          onCommit={(t) => {
            setDraft((cur) => (cur ? { ...cur, type: t } : cur));
            setTypeMenu(null);
            draftInputRef.current?.focus();
          }}
          onSaveSchema={() => {}}
          onClose={() => {
            setTypeMenu(null);
            draftInputRef.current?.focus();
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={entryMenuItems(menu.entry, menu.anchor)}
          onClose={() => setMenu(null)}
        />
      )}
      {dayMenu && (
        <ContextMenu
          x={dayMenu.x}
          y={dayMenu.y}
          items={dayMenuItems(dayMenu.iso, dayMenu.time)}
          onClose={() => setDayMenu(null)}
        />
      )}
      {repeatMenu && (
        <SelectMenu
          anchor={repeatMenu.anchor}
          value={repeatLabel(repeatMenu.entry)}
          options={[]}
          used={["None", "Daily", "Weekly", "Monthly", "Yearly"]}
          canEditSchema={false}
          label="Repeat"
          listHeading="Repeat"
          onCommit={(v) => commitRepeat(repeatMenu.entry, v)}
          onSaveSchema={() => {}}
          onClose={() => setRepeatMenu(null)}
        />
      )}
      {peek && peekEntry && (
        <CalPeek
          // remount per open: the scroll-dismiss arming delay is per-instance
          key={`${peek.path}:${peek.prop}:${peek.day}`}
          entry={peekEntry}
          note={noteByPath.get(peekEntry.path)}
          icon={entryIcon(peekEntry)}
          anchor={peek.anchor}
          isOccurrence={
            !!peekEntry.repeating && peekEntry.day !== anchorDayOf(peekEntry)
          }
          repeatText={repeatText(peekEntry)}
          statusSchema={
            peekEntry.type ? statusSchemaFor(schema, peekEntry.type) : undefined
          }
          suppressDismiss={repeatMenu !== null}
          onClose={() => setPeek(null)}
          onOpen={() => onOpenNote(peekEntry.path)}
          onRename={(t) => commitPeekRename(peekEntry, t)}
          onMoveDate={(iso) => movePeekEntry(peekEntry, iso)}
          onClearDate={() =>
            setPropUndoable({
              path: peekEntry.path,
              key: peekEntry.prop,
              value: null,
              record: undo.record,
            })
              .then(onMutated)
              .catch(reportWriteFailure)
          }
          onSetTime={(t) => setEntryTime(peekEntry, t)}
          onSetEnd={(t) => setPeekEnd(peekEntry, t)}
          onSetStatus={(v) => setEntryStatus(peekEntry, v)}
          onRepeatPick={(anchor) => setRepeatMenu({ entry: peekEntry, anchor })}
          onSkip={() => skipOccurrence(peekEntry)}
          onEndSeries={() => endSeriesBefore(peekEntry)}
          onTrash={() => trashEntry(peekEntry)}
        />
      )}
    </div>
  );
}
