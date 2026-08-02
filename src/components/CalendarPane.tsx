import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { isTyping, isTypingNow } from "../lib/dom";
import {
  addDays,
  addMonths,
  calendarEntriesForWindows,
  calendarTypes,
  cellDayLabel,
  compareEntryTime,
  datePropFor,
  dateRangeValue,
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
import { vaultCreate, vaultTemplateRead } from "../lib/ipc";
import { setPropUndoable, setPropsUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { nextUndoId } from "../lib/undo";
import { foldedPropKey, foldedPropStr, typeHome } from "../lib/types";
import { typeSchemaFor } from "../lib/schemalookup";
import { buildEntryBody, buildEntryProps, mergeEntryProp } from "../lib/templates";
import { iconForType, iconsByType, typeTint } from "../lib/dbicons";
import { ChevronLeftIcon, ChevronRightIcon, NoteIcon, RepeatIcon } from "./Icons";
import SelectMenu, { anchorFrom, type AnchorRect } from "./SelectMenu";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import TypeIcon from "./TypeIcon";
import CalPeek from "./CalPeek";
import { cardSubtitle } from "./DatabasePane";
import { useTodayIso } from "./useTodayIso";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** month cells show this many entries before collapsing into "+N more" —
    the SUB-701 line chips are a row shorter than the old boxed chips, so a
    cell holds four without crowding */
const MONTH_CAP = 4;
/** the week surface's all-day strip keeps the tighter cap: its height is
    bounded (34%) and a strip pushed into internal scrolling turns Chromium's
    drag auto-scroll loose under every card drag */
const ALLDAY_CAP = 3;
/** week canvas scale (SUB-448): one hour of the day, in px — 24h ≈ 1150px */
const HOUR_PX = 48;
/** the canvas time cursor's step (SUB-453): ↑/↓ half-hours, Shift quarters —
    the same quarter-hour grid a canvas drop snaps to */
const SLOT_STEP = 30;
const SLOT_FINE = 15;
/** where the cursor lands on its first ↑/↓ — the working day's start, so the
    keyboard path opens on the same part of the day the canvas scrolls to */
const SLOT_SEED = 9 * 60;

/** SUB-521: the pane unmounts whenever an entry is opened (the note takes the
    view), so the two pieces of "where I was reading" have to live outside it.
    Split by kind: the layout is a stated preference and persists per window
    like the sidebar collapse (SUB-394), the cursor is session position — a
    scroll offset, not a setting — and only outlives the mount. */
const CAL_LAYOUT_KEY = "substrate.calLayout";

function readCalLayout(): "month" | "week" {
  return localStorage.getItem(CAL_LAYOUT_KEY) === "week" ? "week" : "month";
}

function writeCalLayout(l: "month" | "week"): void {
  localStorage.setItem(CAL_LAYOUT_KEY, l);
}

/** epoch ms, so the round trip can't hand a mutated Date back out. null until
    the calendar has been visited, so a first open lands on today even in a
    window that has been running since before midnight (SUB-153's rollover). */
const calSession: { cursor: number | null } = { cursor: null };

interface CalendarPaneProps {
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** bumped by App when ⌘N fires inside the calendar view */
  newSignal: number;
  onOpenNote: (path: string) => void;
  onMutated: () => void;
  /** SUB-278: Move to Trash routes through App's shared handler — flush of
      the open note's pending save, then toast with Undo (SUB-263) */
  onTrashNote: (path: string) => void;
  /** SUB-240: App's toast — failed writes surface here, not the console;
      SUB-273: the optional action carries Undo after a drag move */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** the entry peek's title field renames the note — App's renameNote
      (flush of the open note's pending save, then refresh) */
  onRenameNote: (path: string, title: string) => Promise<unknown>;
  /** SUB-590: the day menu's "Open daily note" — App's openJournal
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
  // SUB-521: opening an entry unmounts the pane (the note takes the view), so
  // both of these have to outlive the mount or coming back — ⌫, or the sidebar
  // — silently resets the calendar you were reading. `cursor` is session
  // position, like a scroll offset: it survives the round trip in a module ref
  // and starts fresh next launch. `layout` is a stated preference, so it
  // persists per window in localStorage, like the sidebar collapse (SUB-394).
  const [cursor, setCursor] = useState(
    () => new Date(calSession.cursor ?? Date.now())
  );
  const [layout, setLayout] = useState<"month" | "week">(() => readCalLayout());
  useEffect(() => {
    calSession.cursor = cursor.getTime();
  }, [cursor]);
  useEffect(() => {
    writeCalLayout(layout);
  }, [layout]);
  const [focusIso, setFocusIso] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ day: string; type: string; time?: string } | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [drag, setDrag] = useState<{
    path: string;
    prop: string;
    day: string;
    time?: string;
    /** the dragged entry's span end (SUB-596), so the drop rewrites the whole
        range rather than collapsing it to the new start day */
    endDay?: string;
    endTime?: string;
  } | null>(null);
  const [dropIso, setDropIso] = useState<string | null>(null);
  // canvas drag hover: the snapped drop minute, for the time-ghost line (SUB-448)
  const [dropMin, setDropMin] = useState<number | null>(null);
  // the week canvas's keyboard time cursor (SUB-453): the minute-of-day ↑/↓
  // parks on inside the focused day's column, null when disarmed
  const [slotMin, setSlotMin] = useState<number | null>(null);
  // a day whose "+N more" was clicked renders its full entry list (SUB-107)
  const [expandedIso, setExpandedIso] = useState<string | null>(null);
  // draft type picker: anchor rect while the SelectMenu is open (SUB-91)
  const [typeMenu, setTypeMenu] = useState<AnchorRect | null>(null);
  // entry-chip context menu + its Repeat… picker (SUB-174)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: CalEntry; anchor: AnchorRect } | null>(null);
  const [repeatMenu, setRepeatMenu] = useState<{ entry: CalEntry; anchor: AnchorRect } | null>(null);
  // the entry peek: click a chip/card to edit it in place (Notion-Calendar
  // style). Tracked by identity — the live entry is re-derived from `entries`,
  // so a mutation that removes it (moved, skipped, renamed, trashed) closes
  // the popover instead of leaving it stale
  const [peek, setPeek] = useState<{ path: string; prop: string; day: string; anchor: AnchorRect } | null>(null);
  // SUB-590: right-click on a day cell (not a chip — chips preventDefault
  // first) — the day's own create/navigate menu. `time` is set on the week
  // canvas, where the pointer names a slot, not just a day.
  const [dayMenu, setDayMenu] = useState<{ x: number; y: number; iso: string; time?: string } | null>(null);
  const seenSignal = useRef(newSignal);
  const gridRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const weekScrollRef = useRef<HTMLDivElement>(null);
  // the timed canvas (SUB-453): gridRef only ever holds the all-day strip, so
  // the focus/scroll effects need their own handle on the canvas half
  const canvasRef = useRef<HTMLDivElement>(null);
  // SUB-512: bumped when a keyboard gesture should pull REAL DOM focus onto
  // the focused day's canvas column. Not every focusIso change may steal
  // focus — composing (`n`, ⌘N, a canvas double-click) sets focusIso too, and
  // the composer's input owns focus there — so the move is requested
  // explicitly by the keyboard paths instead of riding on focusIso.
  const [colFocusReq, setColFocusReq] = useState(0);
  const requestColFocus = () => setColFocusReq((n) => n + 1);

  // day rollover lives in the hook (SUB-153) — the today highlight and the
  // default focus follow midnight in a long-lived window
  const todayIso = useTodayIso();
  const today = parseDay(todayIso) ?? new Date();

  // the canvas now-line's minute-of-day, on a one-minute tick (SUB-448)
  const [nowMin, setNowMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    if (layout !== "week") return;
    const tick = () => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [layout]);

  const days = useMemo(
    () =>
      layout === "month"
        ? monthGridDays(cursor.getFullYear(), cursor.getMonth())
        : weekDays(cursor),
    [cursor, layout]
  );
  const visible = useMemo(() => new Set(days.map(isoDay)), [days]);

  // recurrence expands over the grid AND the 14-day upcoming list — both read
  // the same byDay map, so both windows feed it (SUB-174). Two windows, not
  // one spanning both: paging months back moves the grid away from today while
  // Upcoming stays put, and a single window stretched to cover the gap blew
  // past the expansion cap — the grid still rendered while Today and Upcoming
  // emptied out (SUB-570).
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
  // each database's icon, for the entry badges (SUB-249)
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);
  /** an entry's mark: the same badge Today wears — the database's TypeIcon,
      the quiet note glyph for untyped notes */
  const entryIcon = (e: CalEntry) =>
    e.type ? <TypeIcon type={e.type} icon={iconForType(dbIcons, e.type)} size={12} /> : <NoteIcon size={12} />;
  const noteByPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    // keys stay day-only (e.day) — a timed entry's time never keys a bucket
    for (const e of entries) map.set(e.day, [...(map.get(e.day) ?? []), e]);
    for (const list of map.values())
      list.sort(
        (a, b) =>
          // all-day first, then timed ascending (SUB-270), then type/title
          compareEntryTime(a, b) ||
          a.type.localeCompare(b.type) ||
          a.title.localeCompare(b.title)
      );
    return map;
  }, [entries]);
  const types = useMemo(() => calendarTypes(schema), [schema]);

  // opening the week (or paging into a new one) scrolls the canvas to the
  // day's action: an hour above the week's earliest timed entry, else
  // 08:00. One-shot per week: a week whose entries hadn't loaded yet
  // anchors again when they land (byDay is in the deps), but once anchored
  // with data, later vault mutations never re-scroll under the user.
  const anchoredWeek = useRef<string | null>(null);
  useEffect(() => {
    if (layout !== "week") {
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
  }, [layout, days, byDay]);

  // the peek's live entry, re-derived on every refresh — gone (moved day,
  // skipped occurrence, rename's new path, trash) means the popover closes
  const peekEntry = useMemo(
    () =>
      peek
        ? entries.find((e) => e.path === peek.path && e.prop === peek.prop && e.day === peek.day) ??
          null
        : null,
    [peek, entries]
  );
  useEffect(() => {
    if (peek && !peekEntry) setPeek(null);
  }, [peek, peekEntry]);

  /** SUB-609: the entry the peek or the context menu is targeting keeps a
      selected tint (Notion-Calendar style), so the popover and the chip it
      edits read as one unit. A span lights whole — its segments are one
      event — while a repeating series stays day-matched: each virtual
      occurrence is its own row (expansion never carries spanPos, so the
      span branch can't cross-light a series). */
  const selTarget = peek ?? menu?.entry ?? null;
  const isSelected = (e: CalEntry): boolean => {
    if (!selTarget || selTarget.path !== e.path || selTarget.prop !== e.prop) return false;
    if (selTarget.day === e.day) return true;
    return e.spanPos !== undefined && !e.repeating;
  };

  /** move keyboard focus, paging the grid when the target leaves the view */
  const go = (d: Date) => {
    setFocusIso(isoDay(d));
    if (!visible.has(isoDay(d))) setCursor(d);
  };

  /** ⌘←/→ — page months in month layout, weeks in week layout */
  const page = (n: number) => {
    const step = (d: Date) => (layout === "month" ? addMonths(d, n) : addDays(d, 7 * n));
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

  /** `time` — a canvas double-click composes a timed entry at that slot
      (SUB-448); day cells and the all-day strip keep composing day-only */
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
  // (SUB-453): gridRef is the all-day strip, canvasRef the timed canvas, and
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

  // the time cursor leaves with its day (SUB-453) — a cursor parked on a day
  // that scrolled out of the week would keep highlighting a stale column
  // The cursor disarms when the week canvas isn't the surface any more. It does
  // NOT clear on paging: `page()` carries `focusIso` along with the view, so the
  // focused day is always still visible afterwards and the cursor rides with it
  // — ⌘→ must not silently disarm a cursor the user just placed (SUB-453 F2).
  useEffect(() => {
    if (layout !== "week" || !focusIso) setSlotMin(null);
  }, [layout, focusIso]);

  // …and follows itself into view: moving the cursor scrolls the canvas so the
  // highlighted slot stays visible on a 1150px surface
  useEffect(() => {
    if (slotMin === null || !focusIso) return;
    canvasRef.current
      ?.querySelector(`[data-iso="${focusIso}"] .cal-wk-slot`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slotMin, focusIso]);

  // an expanded day collapses on any click outside its cell (SUB-107) — the
  // peek is a body portal, but it belongs to the cell's entry: interacting
  // with it keeps the expansion. Its sub-pickers (status/date/repeat) are
  // separate `.selmenu` portals: a press in one must not collapse the cell —
  // the layout shift scrolls the grid and the peek's scroll-dismiss kills
  // the edit mid-flight (SUB-321)
  useEffect(() => {
    if (!expandedIso) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest(".cal-peek, .selmenu")) return;
      const cell = gridRef.current?.querySelector(`[data-iso="${expandedIso}"]`);
      if (cell && !cell.contains(e.target as Node)) setExpandedIso(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [expandedIso]);

  /* ── SUB-792: a press that dismisses an open popup layer must not double
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
      dismissing a popup (SUB-792). Chips, +N more, and the explicit create
      surfaces keep their plain handlers. */
  const openDraftFromCell = (iso: string) => {
    if (pressDismissed.current) return;
    openDraft(iso);
  };

  /* ── SUB-608: the composer's blur-commit vs the click that caused it ──
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
  const pendingBlur = useRef<{ d: { day: string; type: string; time?: string }; title: string } | null>(null);
  // state mirrors, so the window-level flush never reads a stale closure
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const flushNow = useRef<() => void>(() => {});

  /** the create half of a commit, decoupled from the state teardown
      (SUB-608): the deferred blur path creates from values captured at blur
      time, after the gesture that caused the blur has fully dispatched */
  const createFromDraft = (d: { day: string; type: string; time?: string }, rawTitle: string) => {
    const title = rawTitle.trim();
    const { day, type, time } = d;
    if (!title) return;
    const typeSchema = typeSchemaFor(schema, type);
    const prop = datePropFor(type, notes, schema);
    const folder = folderFor(type, notes, typeHome(typeSchema));
    const foldedType = type.toLowerCase();
    const typeNotes = notes.filter(
      (n) => foldedPropStr(n.props, "type")?.toLowerCase() === foldedType
    );
    // born complete (SUB-60): schema chips + template like the database
    // draft row; the picked day merges into the same create (no second
    // write) and is the date {{date}} instantiates to
    vaultTemplateRead(type)
      .then((tpl) =>
        vaultCreate(
          title,
          folder,
          type,
          mergeEntryProp(
            buildEntryProps({ typeSchema, typeNotes, template: tpl, title, date: day }),
            prop,
            // a canvas-slot draft is born timed (SUB-448); day cells stay day-only
            time ? `${day} ${time}` : day
          ),
          buildEntryBody(tpl, title, day)
        )
      )
      .then(onMutated)
      // SUB-564: a refused create (a title holding [ or ]) used to die on the
      // console with the draft already cleared — no entry, no message
      .catch((err) =>
        onToast?.(`couldn’t create “${title}” — ${err instanceof Error ? err.message : String(err)}`)
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

  /** SUB-608: the input's blur handler. A blur mid-press only PARKS the
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

  // SUB-240: a failed date/repeat write used to die on the console — surface
  // it on App's toast and re-sync, so the grid never implies the write landed
  const reportWriteFailure = (err: unknown) => {
    onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
    onMutated();
  };

  // SUB-273: a move used to commit silently — name the new day on App's toast
  // and offer an Undo that writes the captured prior value back. The drag
  // drop and the peek's date row share this one write path; only series
  // anchors reach either (virtual occurrences are inert), so the write and
  // its undo always shift the whole series — no special casing
  /** the value a date prop takes for a (possibly spanning) placement — the
      SUB-270 `day[ HH:MM]` form, with the SUB-596 `/end` half appended when
      the entry is a range. Every write path funnels through this, so a move,
      a time edit, or a peek reschedule can never silently drop a span's end. */
  const dateValue = (
    day: string,
    time?: string | null,
    end?: { day: string; time?: string } | null
  ) => dateRangeValue(day, time, end);

  /** the end a spanning entry keeps when its start day moves to `to`: the
      span holds its length, so a dragged trip stays as long as it was. Only
      a span's FIRST day is draggable (see `isAnchor`), so `span.day` is
      always the range's start and the delta is unambiguous. */
  const shiftedEnd = (
    span: { day: string; endDay?: string; endTime?: string },
    to: string
  ): { day: string; time?: string } | null => {
    if (!span.endDay) return null;
    const from = parseDay(span.day);
    const target = parseDay(to);
    const end = parseDay(span.endDay);
    if (!from || !target || !end) return null;
    const deltaDays = Math.round((target.getTime() - from.getTime()) / 86400000);
    return { day: isoDay(addDays(end, deltaDays)), time: span.endTime };
  };

  const moveEntryTo = (
    path: string,
    prop: string,
    day: string,
    time?: string | null,
    end?: { day: string; time?: string } | null
  ) => {
    // SUB-477: the toast's Undo pops the entry cmd-Z would pop, by id, so the
    // two paths can't drift and undoing twice doesn't double-revert
    const id = nextUndoId();
    const title = noteByPath.get(path)?.title ?? path;
    // a timed value keeps its time across a reschedule (SUB-270); a span
    // keeps its end, shifted by the same delta (SUB-596)
    setPropUndoable({
      path,
      key: prop,
      value: dateValue(day, time, end),
      id,
      record: undo.record,
      label: `“${title}” → ${formatDateHuman(day)}`,
    })
      .then(() => {
        onMutated();
        onToast?.(`“${title}” → ${formatDateHuman(day)}`, {
          label: "Undo",
          run: () => undo.runById(id),
        });
      })
      .catch(reportWriteFailure);
  };

  /** Drop targets differ in what they do to the value's time (SUB-448):
      month cells and the all-day strip's cells keep/clear it, the timed
      canvas sets it. `time` undefined = keep the dragged value's time
      (month), null = clear it (all-day strip), string = set it (canvas). */
  const dropOn = (day: string, time?: string | null) => {
    const d = drag;
    setDrag(null);
    setDropIso(null);
    if (!d) return;
    const next = time === undefined ? d.time : (time ?? undefined);
    if (d.day === day && (d.time ?? null) === (next ?? null)) return;
    // a span moves whole (SUB-596): the end travels the same number of days
    moveEntryTo(d.path, d.prop, day, next, shiftedEnd(d, day));
  };

  /* ----- entry peek writes — the same IPC the drag/chip paths use ----- */

  /** the peek's date row commits "day[ HH:MM][/day[ HH:MM]]" through the drag's
      write path. The peek can open on ANY day a span covers, so the write
      measures from the note's stored start, never from the day clicked. */
  const movePeekEntry = (e: CalEntry, iso: string) => {
    // the picker may hand back a range of its own (SUB-596) — take it
    // wholesale; otherwise the entry's existing span slides with the new start
    const picked = splitDateRange(iso);
    if (!picked) return;
    const stored = storedRange(e);
    const end = picked.end
      ? { day: picked.end.day, time: picked.end.time ?? undefined }
      : stored?.end
        ? shiftedEnd(
            { day: stored.start.day, endDay: stored.end.day, endTime: stored.end.time ?? undefined },
            picked.start.day
          )
        : null;
    moveEntryTo(e.path, e.prop, picked.start.day, picked.start.time, end);
  };

  /** the peek's time row rewrites the value's time part only — quiet (no
      toast): the row itself shows the result; a failure still toasts + resyncs */
  const setEntryTime = (e: CalEntry, time: string | null) => {
    // the START's time is what this row edits, and the span's end survives it
    // (SUB-596) — read both off the stored value, since the peek may have
    // opened on a continuation day
    const stored = storedRange(e);
    const start = stored?.start.day ?? e.day;
    const end = stored?.end ? { day: stored.end.day, time: stored.end.time ?? undefined } : null;
    setPropUndoable({
      path: e.path,
      key: e.prop,
      value: dateValue(start, time, end),
      record: undo.record,
    })
      .then(onMutated)
      .catch(reportWriteFailure);
  };

  /** status from the peek — "done from the calendar" (SUB-205 semantics) */
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

  /* ----- entry-chip menu actions (SUB-174) ----- */

  const trashEntry = (e: CalEntry) => {
    onTrashNote(e.path);
  };

  /** the note's actual date DAY — the series anchor a chip belongs to.
      Day-only: a timed value ("2026-07-18 09:30") would never string-match
      e.day, wrongly reading every occurrence of a timed series as virtual */
  const anchorDayOf = (e: CalEntry): string | undefined =>
    splitDayTime(foldedPropStr(noteByPath.get(e.path)?.props ?? {}, e.prop) ?? "")?.day;

  /** the note's stored value for this entry's prop, parsed (SUB-596). Write
      paths read the span from HERE rather than from the entry, because an
      entry is one covered day of a range and may not be its start. */
  const storedRange = (e: CalEntry) =>
    splitDateRange(foldedPropStr(noteByPath.get(e.path)?.props ?? {}, e.prop) ?? "");

  /** is this entry a CONTINUATION day of a span (SUB-596) — a day the range
      covers that isn't its start? Those days are inert: the range moves by
      its start, so only the first day drags. */
  const isSpanTail = (e: CalEntry) => e.spanPos !== undefined && e.spanPos !== "start";

  /** the overdue rule, shared by all three renderers (SUB-206/SUB-596): past
      day, deadline prop, non-repeating, not complete — and for a range, late
      only once its END has passed, so a span still running reads as current. */
  const entryOverdue = (e: CalEntry) =>
    !e.repeating &&
    entryEndDay(e) < todayIso &&
    !isComplete(e.status) &&
    isDeadline(schema, e.type, e.prop);

  const entryTip = (e: CalEntry) =>
    e.type && e.type.toLowerCase() !== "event" ? `${e.type} · ${e.title}` : e.title;

  /** span position as a class suffix (SUB-596): `cal-entry span start|mid|end`
      lets the CSS square the inner edges so consecutive days read as one bar
      across the row. A single date gets nothing and renders as it always did. */
  const spanClass = (e: CalEntry) => (e.spanPos ? ` span ${e.spanPos}` : "");

  /** SUB-701: an entry's identity color — the database's stable tint (the
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

  /** SUB-701: done-from-the-calendar, visible but resolved — dim + strike.
      Non-repeating only: a series' status is the one note's, so a done
      weekly would wrongly strike every future occurrence. */
  const entryDone = (e: CalEntry) => !e.repeating && isComplete(e.status);

  const skipOccurrence = (e: CalEntry) => {
    // SUB-649: repeat_skip only means anything to a series — writing it on a
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
    // SUB-649: same guard as skipOccurrence — no series, no repeat_until
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
      gate for "Mark done" in the entry menu (SUB-376): a plain event has no
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
        { label: "Delete this and following", onSelect: () => endSeriesBefore(e) },
        {
          label: "Delete all occurrences",
          danger: true,
          separatorAbove: true,
          onSelect: () => trashEntry(e),
        }
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

  /** SUB-590: a day cell's own menu — create on that date, or jump. The
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
      const time = timed ? minutesToTime(minuteAt(e.clientY, e.currentTarget)) : undefined;
      setDayMenu({ x: e.clientX, y: e.clientY, iso, time });
    },
  });

  const dayMenuItems = (iso: string, time?: string): MenuItem[] => [
    {
      label: time ? `New entry at ${time}` : `New entry on ${humanDay(iso, today)}`,
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
    const raw = foldedPropStr(noteByPath.get(e.path)?.props ?? {}, "repeat")?.trim();
    if (!raw) return "None";
    return repeatLabel(e) || raw;
  };

  /** the calendar's keyboard surface. Reached two ways (SUB-512):
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
      if (e.target instanceof HTMLElement && e.target.closest(".cal-peek")) return;
      // Focused controls own their platform activation. Otherwise Calendar's
      // bare-Enter shortcut cancels the button click and opens whichever item
      // happens to lead the visually focused day (SUB-358).
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
      } else if (layout === "week" && (k === "ArrowUp" || k === "ArrowDown")) {
        // SUB-453: on the week surface ↑/↓ walk the focused day's canvas in
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
          // into the composed note's time (SUB-453 review F1). The floor/ceiling
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
        // the canvas double-click (SUB-453)
        if (slotMin !== null) openDraft(isoDay(focusDate()), undefined, minutesToTime(slotMin));
        else {
          const items = byDay.get(isoDay(focusDate())) ?? [];
          if (items.length > 0) onOpenNote(items[0].path);
          else openDraft(isoDay(focusDate()));
        }
      } else if (/^[1-9]$/.test(k)) {
        const item = (byDay.get(isoDay(focusDate())) ?? [])[Number(k) - 1];
        if (item) {
          e.preventDefault();
          onOpenNote(item.path);
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
        // the time cursor unwinds before the day focus does (SUB-453) — Esc
        // out of "compose at 09:30", then out of the day. The rover falls
        // back to today when no day is focused, so DOM focus must follow it —
        // otherwise the :focus-visible ring keeps burning on the old column
        // while the next ArrowDown arms today's (review, SUB-512)
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
      if (e.target instanceof HTMLElement && e.target.closest(".cal-wk-col")) return;
      onCalKey(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, focusIso, draft, byDay, layout, cursor, onOpenNote, peek, slotMin]);

  // roving tabindex (SUB-512): real DOM focus follows the focused day when a
  // keyboard gesture asks for it, so the ring is where focus actually is and a
  // screen reader announces the column it lands on.
  useEffect(() => {
    if (colFocusReq === 0 || layout !== "week") return;
    // focusDate()'s fallback (today, else the first visible day) keeps the
    // ring truthful when Esc just cleared focusIso (review, SUB-512)
    const iso = focusIso ?? isoDay(visible.has(todayIso) ? today : days[0]);
    const el = canvasRef.current?.querySelector<HTMLElement>(
      `.cal-wk-col[data-iso="${iso}"]`
    );
    // never yank focus out of the composer — a draft owns its input
    if (el && el !== document.activeElement && !isTyping(document.activeElement)) el.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colFocusReq, focusIso, layout]);

  // past non-repeating deadlines pin an Overdue group atop the agenda
  // (SUB-206) — the Today strip's "Show in Calendar" lands somewhere honest
  const overdue = useMemo(
    () => overdueEntries(notes, schema, todayIso),
    [notes, schema, todayIso]
  );

  const upcoming = (() => {
    const out: { iso: string; label: string; items: CalEntry[] }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i);
      const iso = isoDay(d);
      const items = byDay.get(iso);
      if (!items?.length) continue;
      const label =
        i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${WEEKDAYS[(d.getDay() + 6) % 7]} ${humanDay(iso, today)}`;
      out.push({ iso, label, items });
    }
    return out;
  })();

  /** a day column's accessible name (SUB-512): the same thing the surface's
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

  const entryChip = (e: CalEntry) => {
    // only the anchor (the note's real date) is draggable — moving it rewrites
    // the date prop, shifting the whole series; virtual occurrences are inert.
    // A span's continuation days are inert for the same reason (SUB-596): the
    // range moves by its start
    const isAnchor = (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // an overdue deadline chip's one red mark is a --danger border-left
    // (SUB-206) — same rule as the agenda group: past day, deadline prop,
    // non-repeating, not complete (SUB-205). A range is late only once its
    // END has passed (SUB-596) — a span still running is not overdue
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day ? " dragging" : ""
        }${isOverdue ? " overdue" : ""}${entryDone(e) ? " done" : ""}${spanClass(e)}${isSelected(e) ? " selected" : ""}`}
        style={entryTintStyle(e)}
        draggable={isAnchor}
        title={isOverdue ? `${tip} · overdue` : tip}
        aria-label={e.title}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.path);
          ev.dataTransfer.effectAllowed = "move";
          setDrag({ path: e.path, prop: e.prop, day: e.day, time: e.time, endDay: e.endDay, endTime: e.endTime });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({ path: e.path, prop: e.prop, day: e.day, anchor: anchorFrom(ev.currentTarget) });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: e, anchor: anchorFrom(ev.currentTarget) });
        }}
      >
        {/* SUB-701: month chips are Notion-style lines — the type's color
            bar carries identity (the boxed icon cost a row of height per
            entry); the icon language stays on the roomier week/agenda
            surfaces. A span needs no bar: its tinted fill IS the identity
            mark, and a bar would break the bar-runs-across-the-row read. */}
        {e.spanPos === undefined && <span className="cal-entry-bar" aria-hidden="true" />}
        {e.time && <span className="cal-entry-time">{e.time}</span>}
        <span className="cal-entry-title">{e.title}</span>
        {e.repeating && <RepeatIcon />}
      </button>
    );
  };

  /* ── Week layout (SUB-247) ── a real weekly surface, not a stretched month
     row: seven day columns of full entry cards (icon + title + time when
     timed + a compact prop subtitle, the database card language). byDay
     already orders all-day first, then timed ascending (SUB-270), and there
     is no "+N more" cap — the columns have the room. The month renderers
     above stay untouched; the fork happens at the grid. */
  const weekCard = (e: CalEntry) => {
    // same drag rule as the month chip: only the series anchor moves, and a
    // span moves by its first day only (SUB-596) — pane-level drop handlers
    // key off the column's [data-iso] either way
    const isAnchor = (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // same overdue rule as the month chip (SUB-206/SUB-596)
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    const note = noteByPath.get(e.path);
    const sub = note ? cardSubtitle(note, typeSchemaFor(schema, e.type) ?? {}) : null;
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day ? " dragging" : ""
        }${entryDone(e) ? " done" : ""}${spanClass(e)}${isSelected(e) ? " selected" : ""}`}
        style={entryTintStyle(e)}
        draggable={isAnchor}
        title={isOverdue ? `${tip} · overdue` : tip}
        aria-label={e.title}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.path);
          ev.dataTransfer.effectAllowed = "move";
          setDrag({ path: e.path, prop: e.prop, day: e.day, time: e.time, endDay: e.endDay, endTime: e.endTime });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({ path: e.path, prop: e.prop, day: e.day, anchor: anchorFrom(ev.currentTarget) });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: e, anchor: anchorFrom(ev.currentTarget) });
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

  /** the strip's day cell (SUB-448): day number + create affordance +
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
    const items = (byDay.get(iso) ?? []).filter(
      (e) => !e.time || timeToMinutes(e.time) === null
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
        // SUB-520: the strip cell is a labelled grouping of that day's all-day
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
          {/* same month-seam label as the month grid (SUB-701) */}
          <span
            className={
              iso === todayIso ? "cal-today" : d.getDate() === 1 ? "cal-seam" : ""
            }
          >
            {iso === todayIso ? d.getDate() : cellDayLabel(d)}
          </span>
        </button>
        {draft?.day === iso && !draft.time && composer}
        {items.slice(0, cap).map(weekCard)}
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

  /** a timed entry's canvas block (SUB-448): positioned by its HH:MM, as
      tall as its same-day end time says (SUB-646) or a default hour without
      one, lane-split when entries overlap. Same interactions as every other
      entry surface. */
  const canvasBlock = (e: CalEntry, box: { top: number; height: number; left: number; width: number }) => {
    const isAnchor = (!e.repeating || e.day === anchorDayOf(e)) && !isSpanTail(e);
    // same overdue rule as every other entry surface (SUB-206/SUB-596)
    const isOverdue = entryOverdue(e);
    const tip = entryTip(e);
    return (
      <button
        type="button"
        key={`${e.path}:${e.prop}:${e.day}`}
        className={`cal-entry cal-wk-block${
          drag?.path === e.path && drag.prop === e.prop && drag.day === e.day ? " dragging" : ""
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
          setDrag({ path: e.path, prop: e.prop, day: e.day, time: e.time, endDay: e.endDay, endTime: e.endTime });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropIso(null);
          setDropMin(null);
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setPeek({ path: e.path, prop: e.prop, day: e.day, anchor: anchorFrom(ev.currentTarget) });
        }}
        onDoubleClick={(ev) => {
          // power path: straight to the note, skipping the peek
          ev.stopPropagation();
          onOpenNote(e.path);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: e, anchor: anchorFrom(ev.currentTarget) });
        }}
      >
        <span className="cal-wk-head">
          {entryIcon(e)}
          <span className="cal-entry-time">{e.time}</span>
          {e.repeating && <RepeatIcon />}
        </span>
        <span className="cal-entry-title">{e.title}</span>
      </button>
    );
  };

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
  /** roving tabindex (SUB-512): exactly one tab stop for the whole week — the
      focused day, or (nothing focused yet) whichever day the shortcuts would
      already act on. Tab enters the canvas once; the arrows do the rest. */
  const roverIso = isoDay(focusDate());

  const canvasColumn = (d: Date) => {
    const iso = isoDay(d);
    const timed = (byDay.get(iso) ?? []).filter(
      (e) => e.time && timeToMinutes(e.time) !== null
    );
    // a same-day range shapes its own block (SUB-646) — height AND the
    // overlap math, so a 14:00 entry inside a 09:00–17:00 one lanes beside it.
    // A multi-day span's endTime belongs to its LAST day, not this column, so
    // its start day keeps the default block rather than painting a lie.
    const boxes = layoutLanes(
      timed.map((e) =>
        blockSpan(e.time ?? "", e.endDay === undefined || e.endDay === e.day ? e.endTime : undefined)
      )
    );
    const cls = [
      "cal-wk-col",
      iso === todayIso ? "today" : "",
      // the canvas half wears the same focus ring as its strip cell (SUB-453)
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
          if (e.target === e.currentTarget && focusIso !== iso) setFocusIso(iso);
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
          dropOn(iso, minutesToTime(min));
        }}
      >
        {/* the keyboard time cursor (SUB-453): a half-hour band on the focused
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
          canvasBlock(e, {
            top: (boxes[i].start / DAY_MIN) * 100,
            height: ((boxes[i].end - boxes[i].start) / DAY_MIN) * 100,
            left: (boxes[i].lane / boxes[i].lanes) * 100,
            width: (1 / boxes[i].lanes) * 100,
          })
        )}
        {/* a canvas-born draft composes at its slot, not in the strip —
            the input floats where the entry will land */}
        {draft?.day === iso && draft.time && (
          <div
            className="cal-wk-draft"
            style={{ top: `${((timeToMinutes(draft.time) ?? 0) / DAY_MIN) * 100}%` }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {composer}
          </div>
        )}
        {iso === todayIso && (
          <div className="cal-wk-now" style={{ top: `${(nowMin / DAY_MIN) * 100}%` }} />
        )}
        {iso === dropIso && dropMin !== null && drag && (
          <div className="cal-wk-ghost" style={{ top: `${(dropMin / DAY_MIN) * 100}%` }}>
            <span>{minutesToTime(dropMin)}</span>
          </div>
        )}
      </div>
    );
  };

  const composer = draft && (
    <div className="cal-draft" onClick={(e) => e.stopPropagation()}>
      {/* nothing to pick when only `event` is creatable (SUB-175) — the badge
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
    const items = byDay.get(iso) ?? [];
    // SUB-107: "+N more" expands the cell in place — it renders (and scrolls)
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
        className={cls}
        // SUB-520: the month cell had the same anonymous-div shape as the week
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
          {/* SUB-701: the 1st names its month ("Aug 1") so the seam between
              months is visible in-grid; today's circle wins the collision —
              it already orients harder than a month label could */}
          <span
            className={
              iso === todayIso ? "cal-today" : d.getDate() === 1 ? "cal-seam" : ""
            }
          >
            {iso === todayIso ? d.getDate() : cellDayLabel(d)}
          </span>
        </button>
        {draft?.day === iso && composer}
        {items.slice(0, cap).map(entryChip)}
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
        <span className="list-title">
          {layout === "month" ? monthTitle(cursor.getFullYear(), cursor.getMonth()) : weekTitle()}
        </span>
        <div className="db-tools">
          <button className="db-new" onClick={() => openDraft(isoDay(focusDate()))} title="New entry (N)">
            New
          </button>
          <button className="db-new cal-today" onClick={() => go(today)} title="Jump to today (T)">
            Today
          </button>
          <div className="cal-pager">
            <button onClick={() => page(-1)} title={layout === "month" ? "Previous month (⌘←)" : "Previous week (⌘←)"}>
              <ChevronLeftIcon />
            </button>
            <button onClick={() => page(1)} title={layout === "month" ? "Next month (⌘→)" : "Next week (⌘→)"}>
              <ChevronRightIcon />
            </button>
          </div>
          <div className="db-switch cal-layouts">
            {(["month", "week"] as const).map((l) => (
              <button
                key={l}
                className={layout === l ? "active" : undefined}
                onClick={() => setLayout(l)}
              >
                {l === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="cal-grid-scroll">
        <div className={`cal-weekdays${layout === "week" ? " week" : ""}`}>
          {layout === "week" && <span className="cal-wk-spacer" aria-hidden="true" />}
          {/* SUB-701: today's column header sharpens when today is on the
              grid — the second orientation mark Notion Calendar leans on
              (the circled day number alone is easy to lose in six rows) */}
          {WEEKDAYS.map((w, i) => (
            <span
              key={w}
              className={
                visible.has(todayIso) && (today.getDay() + 6) % 7 === i ? "cal-wd-today" : undefined
              }
            >
              {w}
            </span>
          ))}
        </div>
        {layout === "month" ? (
          <div className="cal-grid month" ref={gridRef}>
            {days.map(dayCell)}
          </div>
        ) : (
          <>
            {/* the week surface (SUB-448): a pinned all-day strip over a
                scrollable 24h canvas — the strip keeps the SUB-247 card
                language, the canvas places timed entries by their HH:MM */}
            <div className="cal-grid week" ref={gridRef}>
              <span className="cal-wk-spacer" aria-hidden="true" />
              {days.map(alldayCell)}
            </div>
            <div className="cal-wk-scroll" ref={weekScrollRef}>
              <div className="cal-wk-canvas" ref={canvasRef} style={{ height: 24 * HOUR_PX }}>
                <div className="cal-wk-gutter" aria-hidden="true">
                  {Array.from({ length: 23 }, (_, h) => (
                    <span key={h + 1} style={{ top: `${((h + 1) / 24) * 100}%` }}>
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
        <div className="cal-agenda-body">
          {/* SUB-206: past non-repeating deadlines pin to the top, oldest
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
                      // same menu as the grid chips (SUB-376) — overdue rows
                      // are exactly where "Mark done" / "Move to Trash" is
                      // needed most
                      ev.preventDefault();
                      ev.stopPropagation();
                      setMenu({ x: ev.clientX, y: ev.clientY, entry: e, anchor: anchorFrom(ev.currentTarget) });
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
            <div className="cal-hint">Any note with a date property shows up here.</div>
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
                {g.items.map((e) => (
                  <button
                    type="button"
                    key={`${e.path}:${e.prop}:${e.day}`}
                    className={`cal-ag-item${entryDone(e) ? " done" : ""}${isSelected(e) ? " selected" : ""}`}
                    onClick={() => onOpenNote(e.path)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setMenu({ x: ev.clientX, y: ev.clientY, entry: e, anchor: anchorFrom(ev.currentTarget) });
                    }}
                    aria-label={e.title}
                  >
                    {entryIcon(e)}
                    {e.time && <span className="cal-entry-time">{e.time}</span>}
                    <span className="cal-entry-title">{e.title}</span>
                  </button>
                ))}
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
          isOccurrence={!!peekEntry.repeating && peekEntry.day !== anchorDayOf(peekEntry)}
          repeatText={repeatText(peekEntry)}
          statusSchema={
            peekEntry.type
              ? statusSchemaFor(schema, peekEntry.type)
              : undefined
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
