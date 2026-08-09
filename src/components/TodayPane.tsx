import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DbIcon, NoteMeta, SchemaConfig } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { TODAY_PROP, todayData, type LeftoverItem, type PickedItem } from "../lib/today";
import { isComplete, type AgendaItem } from "../lib/agenda";
import { humanDay } from "../lib/calendar";
import { iconForType } from "../lib/dbicons";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { useTodayIso } from "./useTodayIso";
import { useEdgeFade } from "../hooks/useEdgeFade";
import TypeIcon from "./TypeIcon";
import { NoteIcon, SunIcon } from "./Icons";
import EmptyState from "./EmptyState";

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

/** One candidate row (Scheduled / Due lanes): opens on click, picks on the
    quiet verb. An overdue row's one red signal is its day chip in --danger,
    showing the day it was due; done rows dim. */
function CandidateRow({
  item,
  overdue,
  icons,
  onOpenNote,
  onPick,
  onRowContextMenu,
  chrome,
}: {
  item: AgendaItem;
  overdue: boolean;
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
  onRowContextMenu,
  chrome,
}: {
  item: PickedItem;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onUnpick: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
  chrome: RowChrome;
}) {
  const n = item.note;
  const done = isComplete(foldedPropStr(n.props, "status"));
  return (
    <div
      {...optionProps(chrome, done ? "today-row done" : "today-row")}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(n.path, e.clientX, e.clientY);
      }}
    >
      <button type="button" className="today-open" onClick={() => onOpenNote(n.path)}>
        <EntryIcon type={foldedPropStr(n.props, "type") ?? ""} icons={icons} />
        {item.time && <span className="cal-entry-time">{item.time}</span>}
        <span className="today-row-title">{n.title}</span>
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
        onToast?.(`couldn’t save — ${err instanceof Error ? err.message : String(err)}`);
        onMutated();
      });
  };
  const pick = (path: string) => writeToday(path, iso);
  const unpick = (path: string) => writeToday(path, null);

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
    const out: { key: string; path: string; verb: "pick" | "unpick"; clearable: boolean }[] = [];
    for (const l of data.leftovers)
      out.push({ key: `lo:${l.note.path}`, path: l.note.path, verb: "pick", clearable: true });
    for (const it of data.scheduled)
      out.push({ key: `sc:${it.path}:${it.prop}`, path: it.path, verb: "pick", clearable: false });
    for (const it of data.due)
      out.push({ key: `du:${it.path}:${it.prop}`, path: it.path, verb: "pick", clearable: false });
    for (const p of data.picked)
      out.push({ key: `pk:${p.note.path}`, path: p.note.path, verb: "unpick", clearable: true });
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

  // keep the selected row visible when arrow-keying past the fold
  useEffect(() => {
    if (sel < 0) return;
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

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

          {/* No verb here yet: the day's lines name none to make clickable —
              the head's Journal ⌘D is the day's one action and stays above. */}
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
                      onRowContextMenu={onRowContextMenu}
                    />
                  ))
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
