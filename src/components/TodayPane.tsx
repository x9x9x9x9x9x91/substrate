import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useIndexReveal } from "../hooks/useIndexReveal";
import type { DbIcon, NoteMeta, SchemaConfig } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import {
  FOCUS_PROP,
  isFocused,
  TODAY_PROP,
  todayData,
  type LeftoverItem,
  type PickedItem,
} from "../lib/today";
import { isComplete, type AgendaItem } from "../lib/agenda";
import { humanDay } from "../lib/calendar";
import { iconForType } from "../lib/dbicons";
import { setPropUndoable } from "../lib/undoprops";
import { recordCreate } from "../lib/undostruct";
import { useUndo } from "../lib/undoContext";
import { useMinuteOfDay, useTodayIso } from "./useTodayIso";
import { clockKey, nowNextCursor, untilLabel } from "../lib/todaynow";
import { appendWrapLine, wrapLine, wrapPlan, wrapWorthDoing } from "../lib/daywrap";
import type { WrapPlan } from "../lib/daywrap";
import { dailyPath, JOURNAL_DIR } from "../lib/journal";
import { setPropUndoableBulk } from "../lib/undoprops";
import { vaultCreate, vaultRead, vaultWriteBody } from "../lib/ipc";
import { useEdgeFade } from "../hooks/useEdgeFade";
import TypeIcon from "./TypeIcon";
import { NoteIcon, SunIcon } from "./Icons";
import EmptyState from "./EmptyState";
import { errText } from "../lib/errtext";

/* The Today surface: a day-agenda decision surface, not a dashboard.
   Sixty seconds every morning and the day is decided — three quiet lanes fed
   by the existing machinery (Scheduled: today's calendar entries; Due &
   overdue: deadline props; Picked for today: notes carrying the `today` date
   prop) and the one verb Pick. Picking writes `today: <YYYY-MM-DD>` on the
   note, unpicking clears it — persistence, query, and calendar visibility
   ride the date-prop machinery. A stale pick shows as a leftover with
   one-click keep-or-clear, never silently carried. Rows open their note
   through App's openNote, exactly like calendar entries do. */

interface TodayPaneProps {
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** per-type database icons, keyed by type name */
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onOpenJournal: () => void;
  onMutated: () => void;
  onToast?: (msg: string) => void;
  /** the app-level note context menu — same items as list rows */
  onRowContextMenu: (path: string, x: number, y: number) => void;
}

/** A dated entry's mark: the database's icon for typed notes, the quiet note
    glyph for untyped ones. */
function EntryIcon({ type, icons }: { type: string; icons: Record<string, DbIcon> }) {
  return type ? <TypeIcon type={type} icon={iconForType(icons, type)} /> : <NoteIcon />;
}

/** The capture line. A morning starts with "I need to do X", not with
    finding the note about X — so typing a title here creates the note with
    the pick already on it (the same `today` prop the verb writes), and the
    fresh row lands in the Picked lane with everything else. It sits OUTSIDE
    the listbox on purpose: this is a text field, and the rows' bare letter
    keys would eat what is typed into it. */
function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const title = text.trim();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || busy) return;
    setBusy(true);
    /* The typed text survives a refusal: an unwritable Inbox or a title the
       engine won't slug leaves the line exactly as it was, with the toast
       saying why — only a created note clears it. */
    onAdd(title).then(
      () => {
        setText("");
        setBusy(false);
      },
      () => setBusy(false)
    );
  };
  return (
    <form className="today-add" onSubmit={submit}>
      <input
        className="today-add-input"
        value={text}
        placeholder="Add to today…"
        aria-label="Add to today"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Esc drops a half-typed thought rather than leaving it parked in
          // the line; kept off the surface's own Esc while there is text
          if (e.key === "Escape" && text) {
            e.stopPropagation();
            setText("");
          }
        }}
      />
      <button type="submit" className="today-add-act" disabled={!title || busy}>
        Add
      </button>
    </form>
  );
}

/* The keyboard model, ported from the tray popover (agenda.tsx) —
   the better-built of the two. Every row in every lane is one option in a
   single flat list running top to bottom, so j/k walks the day in the order
   it reads. Rows carry the chrome an option needs (id, index, selected) and
   the pane holds the selection, exactly as the popover's card does. */
interface RowChrome {
  id: string;
  idx: number;
  selected: boolean;
  onSelect: (idx: number) => void;
}

/** The shared option wiring for a row — mousemove, not mouseenter:
    a vault re-scan can insert rows under a resting cursor, and mouseenter
    would hand the selection to whatever slid beneath it. */
function optionProps({ id, idx, selected, onSelect }: RowChrome, base: string) {
  return {
    id,
    "data-idx": idx,
    role: "option",
    "aria-selected": selected,
    className: selected ? `${base} selected` : base,
    onMouseMove: () => onSelect(idx),
  };
}

/** The day's ending. Two steps on purpose: the first click only shows what
    the second one will do — the exact line that lands in the journal and the
    exact number of stale picks that get cleared. Nothing here ever fires on
    its own; a day that is not wrapped stays exactly as it was. */
function DayWrap({
  plan,
  line,
  busy,
  onWrap,
}: {
  plan: WrapPlan;
  line: string;
  busy: boolean;
  /** resolves true when the wrap actually landed */
  onWrap: () => Promise<boolean>;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <div className="today-wrap">
        <button type="button" className="today-wrap-act" onClick={() => setArmed(true)}>
          Wrap the day
        </button>
      </div>
    );
  }
  const clears = plan.clearing.length;
  return (
    <div className="today-wrap armed">
      <div className="today-wrap-what">Writes to today’s journal:</div>
      <div className="today-wrap-line">{line}</div>
      <div className="today-wrap-what">
        {clears === 0
          ? "Clears nothing — there are no leftovers."
          : `Clears the pick on ${clears} leftover${clears === 1 ? "" : "s"}: ${plan.clearing
              .map((c) => c.title)
              .join(", ")}`}
      </div>
      <div className="today-wrap-row">
        <button
          type="button"
          className="today-wrap-act go"
          // a finished wrap folds the confirmation back up — leaving it open
          // would offer to write a line that is already written. A FAILED one
          // stays armed: the toast says what went wrong and the retry is the
          // same click, not four of them
          onClick={() => void onWrap().then((ok) => ok && setArmed(false))}
          disabled={busy}
        >
          {busy ? "Wrapping…" : clears ? "Write and clear" : "Write"}
        </button>
        <button type="button" className="today-wrap-act" onClick={() => setArmed(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One candidate row (Scheduled / Due lanes): opens on click, picks on the
    quiet verb. An overdue row's one red signal is its day chip in --danger,
    showing the day it was due; done rows dim. */
function CandidateRow({
  item,
  overdue,
  cursor,
  icons,
  onOpenNote,
  onPick,
  onRowContextMenu,
  chrome,
}: {
  item: AgendaItem;
  overdue: boolean;
  /** "now" on the entry happening, "in 25m" on the one starting next */
  cursor?: { at: "now" | "next"; label: string };
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onPick: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
  chrome: RowChrome;
}) {
  const done = isComplete(item.status);
  return (
    <div
      {...optionProps(chrome, done ? "today-row done" : "today-row")}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(item.path, e.clientX, e.clientY);
      }}
    >
      <button type="button" className="today-open" onClick={() => onOpenNote(item.path)}>
        <EntryIcon type={item.type} icons={icons} />
        {item.time && <span className="cal-entry-time">{item.time}</span>}
        <span className="today-row-title">{item.title}</span>
        {cursor && (
          <span className={cursor.at === "now" ? "today-cursor now" : "today-cursor"}>
            {cursor.label}
          </span>
        )}
        {overdue && <span className="today-row-day overdue">{humanDay(item.day)}</span>}
      </button>
      <button
        type="button"
        className="today-act"
        onClick={(e) => {
          e.stopPropagation();
          onPick(item.path);
        }}
      >
        Pick
      </button>
    </div>
  );
}

/** One committed row (Picked lane): the day's agenda. Unpick sends the note
    back to the candidate lanes. */
function PickedRow({
  item,
  icons,
  onOpenNote,
  onUnpick,
  onFocus,
  onRowContextMenu,
  chrome,
}: {
  item: PickedItem;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onUnpick: (path: string) => void;
  onFocus: (path: string, on: boolean) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
  chrome: RowChrome;
}) {
  const n = item.note;
  const done = isComplete(foldedPropStr(n.props, "status"));
  const base = item.focused ? "today-row headline" : "today-row";
  return (
    <div
      {...optionProps(chrome, done ? `${base} done` : base)}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(n.path, e.clientX, e.clientY);
      }}
    >
      <button type="button" className="today-open" onClick={() => onOpenNote(n.path)}>
        <EntryIcon type={foldedPropStr(n.props, "type") ?? ""} icons={icons} />
        {item.time && <span className="cal-entry-time">{item.time}</span>}
        <span className="today-row-title">{n.title}</span>
        {item.focused && <span className="today-cursor now">focus</span>}
      </button>
      <button
        type="button"
        className="today-act"
        onClick={(e) => {
          e.stopPropagation();
          onFocus(n.path, !item.focused);
        }}
      >
        {item.focused ? "Unfocus" : "Focus"}
      </button>
      <button
        type="button"
        className="today-act"
        onClick={(e) => {
          e.stopPropagation();
          onUnpick(n.path);
        }}
      >
        Unpick
      </button>
    </div>
  );
}

/** One stale pick: keep rolls the pick forward to today, clear drops it. */
function LeftoverRow({
  item,
  icons,
  onOpenNote,
  onKeep,
  onClear,
  onRowContextMenu,
  chrome,
}: {
  item: LeftoverItem;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onKeep: (path: string) => void;
  onClear: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
  chrome: RowChrome;
}) {
  const n = item.note;
  return (
    <div
      {...optionProps(chrome, "today-row")}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(n.path, e.clientX, e.clientY);
      }}
    >
      <button type="button" className="today-open" onClick={() => onOpenNote(n.path)}>
        <EntryIcon type={foldedPropStr(n.props, "type") ?? ""} icons={icons} />
        <span className="today-row-title">{n.title}</span>
        <span className="today-row-day">{humanDay(item.day)}</span>
      </button>
      <button
        type="button"
        className="today-act"
        onClick={(e) => {
          e.stopPropagation();
          onKeep(n.path);
        }}
      >
        Keep
      </button>
      <button
        type="button"
        className="today-act"
        onClick={(e) => {
          e.stopPropagation();
          onClear(n.path);
        }}
      >
        Clear
      </button>
    </div>
  );
}

export default function TodayPane({
  notes,
  schema,
  icons,
  onOpenNote,
  onOpenJournal,
  onMutated,
  onToast,
  onRowContextMenu,
}: TodayPaneProps) {
  const undo = useUndo();
  // day rollover lives in the hook — re-renders at midnight and on window
  // focus, so a long-lived window never shows yesterday
  const iso = useTodayIso();
  const data = useMemo(() => todayData(notes, schema, iso), [notes, schema, iso]);
  // the lane's clock: which scheduled entry is running, which is up next, and
  // how long until it. Re-read on the minute so a row stops saying "in 1m"
  // forever; the marker is text in the row, not a badge or a colour.
  const nowMin = useMinuteOfDay();
  const cursor = useMemo(
    () => nowNextCursor(data.scheduled, nowMin),
    [data.scheduled, nowMin]
  );
  const cursorFor = (it: AgendaItem): { at: "now" | "next"; label: string } | undefined => {
    const key = clockKey(it);
    if (key === cursor.now) return { at: "now", label: "now" };
    if (key === cursor.next && cursor.untilMin !== null)
      return { at: "next", label: untilLabel(cursor.untilMin) };
    return undefined;
  };
  // A short window overflows the day and hard-clipped rows at both scroll
  // stops with nothing saying more was there — the same defect the shared
  // gate exists for; Today was the last row-list surface off it.
  const fade = useEdgeFade<HTMLDivElement>();

  // the one verb, both directions — the write mirrors CalendarPane's
  // reschedule: the pane owns its mutation, failures land on App's toast and
  // re-sync so nothing implies the write landed
  const writeToday = (path: string, day: string | null) => {
    setPropUndoable({ path, key: TODAY_PROP, value: day, record: undo.record })
      .then(onMutated)
      .catch((err) => {
        onToast?.(`couldn’t save — ${errText(err)}`);
        onMutated();
      });
  };
  const pick = (path: string) => writeToday(path, iso);
  const unpick = (path: string) => writeToday(path, null);

  /* The day's headline. Exclusive by construction: taking focus clears the
     mark from whoever held it first, so the lane can never show two. The
     clear and the take are separate undo steps — one write per note is what
     the prop helpers record, and a switch is genuinely two decisions. */
  const focusing = useRef(false);
  const setFocus = (path: string, on: boolean) => {
    // one at a time: both clicks of a fast double-take would read the same
    // snapshot, each clear the mark the other is about to write, and strand
    // two marks on the day
    if (focusing.current) return;
    focusing.current = true;
    // the RAW mark, never the rendered one: todayData demotes every mark but
    // the first, so a second `focus: true` left by a stale write is invisible
    // in `p.focused` — a clear pass reading that flag can never reach it, and
    // Unfocus then looks broken as the hidden mark pops up in its place
    const held = data.picked.filter((p) => isFocused(p.note) && p.note.path !== path);
    const clear = held.length
      ? setPropUndoableBulk({
          paths: held.map((p) => p.note.path),
          key: FOCUS_PROP,
          value: null,
          record: undo.record,
          label: "Cleared the day’s focus",
        }).then(({ failed }) => {
          // a refused clear is the whole exclusivity story failing — say so
          // rather than letting the take land on top of a mark still there
          if (failed.length)
            onToast?.(`couldn’t clear the old focus — ${failed[0].error}`);
          return failed.length === 0;
        })
      : Promise.resolve(true);
    clear
      .then((cleared) =>
        cleared
          ? setPropUndoable({
              path,
              key: FOCUS_PROP,
              value: on ? "true" : null,
              record: undo.record,
              label: on ? "Focused for today" : "Unfocused",
            })
          : undefined
      )
      .then(onMutated)
      .catch((err) => {
        onToast?.(`couldn’t save — ${errText(err)}`);
        onMutated();
      })
      .finally(() => {
        focusing.current = false;
      });
  };

  /* Capture: a new note born already picked. Inbox is where loose notes are
     born everywhere else (⌘N, quick capture), and the pick rides along as an
     ordinary prop on the create rather than a second write, so a half-made
     note can never exist. The create is undoable like any other. */
  const quickAdd = (title: string) =>
    vaultCreate(title, "Inbox", undefined, [[TODAY_PROP, iso]]).then(
      (meta) => {
        recordCreate({ meta, record: undo.record });
        onMutated();
      },
      (err: unknown) => {
        onToast?.(`couldn’t add — ${errText(err)}`);
        throw err;
      }
    );

  /* Day wrap. Clear the stale picks as a single undoable step — the clear is
     the half that changes the vault's state, so it is the half undo has to
     hold — and only then get-or-create today's journal note and append the
     line, which can now name what actually cleared rather than what was
     going to. The journal write is append-only and guarded by the body it
     read, so a note being edited in the other pane refuses rather than losing
     a keystroke. */
  const [wrapping, setWrapping] = useState(false);
  const plan = wrapPlan(data.picked, data.leftovers);
  const line = wrapLine(plan);
  const runWrap = async (): Promise<boolean> => {
    setWrapping(true);
    try {
      // clear FIRST, then write what actually happened. The bulk helper never
      // rejects — it collects `failed` — so a line written up front would
      // claim leftovers were cleared that are still sitting on the day, and
      // the journal keeps that claim forever
      let cleared = plan.clearing;
      let clearFailed = false;
      if (plan.clearing.length) {
        const { failed } = await setPropUndoableBulk({
          paths: plan.clearing.map((c) => c.path),
          key: TODAY_PROP,
          value: null,
          record: undo.record,
          label: `Cleared ${plan.clearing.length} leftover${plan.clearing.length === 1 ? "" : "s"}`,
        });
        if (failed.length) {
          clearFailed = true;
          onToast?.(`couldn’t clear ${failed.length} — ${failed[0].error}`);
          const refused = new Set(failed.map((f) => f.path));
          cleared = plan.clearing.filter((c) => !refused.has(c.path));
        }
      }

      /* Today's journal note, get-or-create. Existence is decided by the READ,
         not by the snapshot: a daily created a moment ago in the other pane is
         on disk before it is in `notes`, and creating over it dedupes into a
         stray "<date> 2" beside the real day. When a create does happen, its
         own returned path is what gets written — never the guessed one. */
      let path = dailyPath(iso);
      let body: string;
      try {
        ({ body } = await vaultRead(path));
      } catch (err) {
        // the snapshot says it exists, so the read failing is a real failure
        // and not a missing file — never answer it by creating a second day
        if (notes.some((n) => n.path === path)) throw err;
        const meta = await vaultCreate(iso, JOURNAL_DIR);
        path = meta.path;
        ({ body } = await vaultRead(path));
      }
      await vaultWriteBody(path, appendWrapLine(body, wrapLine({ ...plan, clearing: cleared })), body);

      if (clearFailed) return false;
      onToast?.("Day wrapped — the line is in today’s journal.");
      return true;
    } catch (err) {
      onToast?.(`couldn’t wrap the day — ${errText(err)}`);
      return false;
    } finally {
      setWrapping(false);
      onMutated();
    }
  };

  /* A day with nothing in any lane. Three grey one-liners stacked
     under three eyebrows read as three failures; the day is one thing, so it
     gets one empty state. The per-lane quiet lines stay for a PARTIALLY full
     day — there they say which lane is clear, which is information. */
  const emptyDay =
    data.leftovers.length === 0 &&
    data.scheduled.length === 0 &&
    data.due.length === 0 &&
    data.picked.length === 0;

  /* One flat option list over the lanes, in the order they render —
     leftovers, scheduled, due, picked. Each row knows its own verb, so Enter
     and the pick key route through the same two writes the buttons call and
     the keyboard can never drift from the mouse.

     `key` is the row's identity, not its slot: a note can hold two date props
     and so occupy two candidate rows, which is why the path alone can't name
     one. `clearable` is "this note carries a pick prop" — the only rows where
     clearing it writes anything. */
  const rows = useMemo(() => {
    const out: {
      key: string;
      path: string;
      verb: "pick" | "unpick";
      clearable: boolean;
      /** the headline state of a picked row; absent on candidates */
      focused?: boolean;
    }[] = [];
    for (const l of data.leftovers)
      out.push({ key: `lo:${l.note.path}`, path: l.note.path, verb: "pick", clearable: true });
    for (const it of data.scheduled)
      out.push({ key: `sc:${it.path}:${it.prop}`, path: it.path, verb: "pick", clearable: false });
    for (const it of data.due)
      out.push({ key: `du:${it.path}:${it.prop}`, path: it.path, verb: "pick", clearable: false });
    for (const p of data.picked)
      out.push({
        key: `pk:${p.note.path}`,
        path: p.note.path,
        verb: "unpick",
        clearable: true,
        focused: p.focused ?? false,
      });
    return out;
  }, [data]);

  /* The selection is a NOTE, not a slot. A pick moves its
     row out of a candidate lane and into Picked at CONSTANT total length, so
     a clamp on `rows.length` never fires and the highlight silently lands on
     whichever note shifted into the old index. Hold the selected row's
     identity and re-derive the index from the current rows instead: the exact
     row when it is still there, the same note's new row when a pick moved it
     across lanes, and nothing at all when the note left the day. */
  const [selRow, setSelRow] = useState<{ key: string; path: string } | null>(null);
  const sel = useMemo(() => {
    if (!selRow) return -1;
    const exact = rows.findIndex((r) => r.key === selRow.key);
    return exact >= 0 ? exact : rows.findIndex((r) => r.path === selRow.path);
  }, [rows, selRow]);
  const selectIdx = (i: number) => {
    const r = i >= 0 ? rows[i] : undefined;
    setSelRow(r ? { key: r.key, path: r.path } : null);
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowIdBase = useId();
  const rowId = (i: number) => `${rowIdBase}-row-${i}`;
  // an empty day has no options, so it has no listbox and takes no focus —
  // the empty state's own copy sits outside this container
  const empty = rows.length === 0;

  /* The pane holds the key model, so it has to hold the focus — but only if
     nothing else already does: opening Today under a palette, a dialog or a
     focused editor must not yank the caret out of them. Waits for the first
     row: the vault snapshot can arrive after mount, and focusing an empty
     listbox parks the caret somewhere with nothing to key. */
  const tookFocus = useRef(false);
  useEffect(() => {
    if (tookFocus.current || empty) return;
    tookFocus.current = true;
    const active = document.activeElement;
    if (!active || active === document.body) listRef.current?.focus();
  }, [empty]);

  useIndexReveal(listRef, sel, [sel]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = sel >= 0 ? rows[sel] : undefined;
    /* A letter is only this pane's key when it arrives bare: ⌘K is the
       palette and ⌘J the sidebar, and swallowing them here would take the
       app's own chords away from the one view that has focus. ⌃n/⌃p are the
       deliberate exception — they ride along with the arrows, as they do in
       the palette and the tray. */
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey && !e.metaKey) || (e.key === "j" && bare)) {
      e.preventDefault();
      selectIdx(Math.min(sel + 1, rows.length - 1));
    } else if (
      e.key === "ArrowUp" ||
      (e.key === "p" && e.ctrlKey && !e.metaKey) ||
      (e.key === "k" && bare)
    ) {
      e.preventDefault();
      // stops at the first row rather than walking back to "nothing selected"
      selectIdx(Math.max(sel - 1, 0));
    } else if (e.key === "Enter" && bare && row) {
      e.preventDefault();
      onOpenNote(row.path);
    } else if ((e.key === "p" || e.key === " ") && bare && row) {
      // the one verb on the selected row: a candidate or a leftover picks for
      // today, a picked row unpicks — the same toggle the row's button runs
      e.preventDefault();
      if (row.verb === "pick") pick(row.path);
      else unpick(row.path);
    } else if (e.key === "f" && bare && row && row.verb === "unpick") {
      // the day's headline, from the keyboard: only a picked row can be it —
      // a candidate has not been decided on yet, and focus is a decision
      // about the day, not a way to make one
      e.preventDefault();
      setFocus(row.path, !row.focused);
    } else if ((e.key === "Backspace" || e.key === "Delete") && bare && row) {
      /* off today, never out of the vault — clears the pick prop, nothing
         else. Only rows that carry one actually write: a candidate has never
         been picked, so clearing it wrote null over null and put an undo step
         on the stack that undoes nothing. A leftover does
         write: its stale pick is exactly what Clear removes.

         The key stays swallowed either way. Bare ⌫ is nav-back at the surface
         (shortcuts.ts `nav-back`), and a row that has nothing to clear must
         not answer "nothing to do here" by leaving the surface. */
      e.preventDefault();
      if (row.clearable) unpick(row.path);
    }
  };

  // each lane's first index in the flat list, so a row's option index is its
  // own position plus its lane's offset — no render-order bookkeeping
  const offScheduled = data.leftovers.length;
  const offDue = offScheduled + data.scheduled.length;
  const offPicked = offDue + data.due.length;
  const chromeAt = (i: number): RowChrome => ({
    id: rowId(i),
    idx: i,
    selected: i === sel,
    onSelect: selectIdx,
  });

  return (
    <div className="today-pane">
      <div className={`today-scroll${fade.className}`} {...fade.props}>
        <div className="today-col">
          <div className="today-head" data-tauri-drag-region>
            <div className="today-head-main">
              <span className="today-eyebrow">Today</span>
              <span className="today-date">{data.title}</span>
            </div>
            <button className="today-journal" onClick={onOpenJournal} title="Today's journal (⌘D)">
              Journal <span className="today-kbd">⌘D</span>
            </button>
          </div>

          <QuickAdd onAdd={quickAdd} />

          {emptyDay && (
            <EmptyState className="today-empty" icon={<SunIcon />} title="Nothing on today" />
          )}

          {/* One container owning every option across the lanes, so
              the listbox holds the rows and nothing else — the head and its
              Journal button stay outside it. Layout-transparent: the sections
              were already direct children of `.today-col`, a plain block.
              On a day with no rows it is a plain block again: an empty listbox
              is not a control, so it neither announces as one nor takes the
              focus and the keys that come with it. On that day the three lanes
              also stand down together — the one designed empty state above
              replaces them, not three quiet lines under three eyebrows. */}
          <div
            className="today-rows"
            ref={listRef}
            {...(empty
              ? {}
              : {
                  role: "listbox",
                  "aria-label": "Today's rows",
                  tabIndex: -1,
                  "aria-activedescendant": sel >= 0 ? rowId(sel) : undefined,
                  onKeyDown,
                })}
          >
            {data.leftovers.length > 0 && (
              <section className="today-section today-leftovers" role="group" aria-label="Leftovers">
                <div className="today-eyebrow">Leftovers</div>
                {data.leftovers.map((l, i) => (
                  <LeftoverRow
                    key={l.note.path}
                    chrome={chromeAt(i)}
                    item={l}
                    icons={icons}
                    onOpenNote={onOpenNote}
                    onKeep={pick}
                    onClear={unpick}
                    onRowContextMenu={onRowContextMenu}
                  />
                ))}
              </section>
            )}

            {!emptyDay && (
              <section className="today-section" role="group" aria-label="Scheduled">
                <div className="today-eyebrow">Scheduled</div>
                {data.scheduled.length === 0 ? (
                  <div className="today-quiet">Nothing scheduled.</div>
                ) : (
                  data.scheduled.map((it, i) => (
                    <CandidateRow
                      key={`${it.path}:${it.prop}`}
                      chrome={chromeAt(offScheduled + i)}
                      item={it}
                      overdue={false}
                      cursor={cursorFor(it)}
                      icons={icons}
                      onOpenNote={onOpenNote}
                      onPick={pick}
                      onRowContextMenu={onRowContextMenu}
                    />
                  ))
                )}
              </section>
            )}

            {!emptyDay && (
              <section className="today-section" role="group" aria-label="Due and overdue">
                <div className="today-eyebrow">Due &amp; overdue</div>
                {data.due.length === 0 ? (
                  <div className="today-quiet">Nothing due.</div>
                ) : (
                  data.due.map((it, i) => (
                    <CandidateRow
                      key={`${it.path}:${it.prop}`}
                      chrome={chromeAt(offDue + i)}
                      item={it}
                      overdue={it.day < iso}
                      icons={icons}
                      onOpenNote={onOpenNote}
                      onPick={pick}
                      onRowContextMenu={onRowContextMenu}
                    />
                  ))
                )}
              </section>
            )}

            {!emptyDay && (
              <section className="today-section" role="group" aria-label="Picked for today">
                <div className="today-eyebrow">Picked for today</div>
                {data.picked.length === 0 ? (
                  <div className="today-quiet">Nothing picked yet.</div>
                ) : (
                  data.picked.map((p, i) => (
                    <PickedRow
                      key={p.note.path}
                      chrome={chromeAt(offPicked + i)}
                      item={p}
                      icons={icons}
                      onOpenNote={onOpenNote}
                      onUnpick={unpick}
                      onFocus={setFocus}
                      onRowContextMenu={onRowContextMenu}
                    />
                  ))
                )}
              </section>
            )}
          </div>

          {wrapWorthDoing(plan) && (
            <DayWrap plan={plan} line={line} busy={wrapping} onWrap={runWrap} />
          )}
        </div>
      </div>
    </div>
  );
}
