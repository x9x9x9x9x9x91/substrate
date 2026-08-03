import { useMemo } from "react";
import type { DbIcon, NoteMeta, SchemaConfig } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { TODAY_PROP, todayData, type LeftoverItem, type PickedItem } from "../lib/today";
import { isComplete, type AgendaItem } from "../lib/agenda";
import { humanDay } from "../lib/calendar";
import { iconForType } from "../lib/dbicons";
import { setPropUndoable } from "../lib/undoprops";
import { useUndo } from "../lib/undoContext";
import { useTodayIso } from "./useTodayIso";
import TypeIcon from "./TypeIcon";
import { NoteIcon } from "./Icons";

/* The Today surface (SUB-300): a day-agenda decision surface, not a dashboard.
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
  /** per-type database icons (SUB-27), keyed by type name */
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onOpenJournal: () => void;
  onMutated: () => void;
  onToast?: (msg: string) => void;
  /** the app-level note context menu (SUB-378) — same items as list rows */
  onRowContextMenu: (path: string, x: number, y: number) => void;
}

/** A dated entry's mark: the database's icon for typed notes, the quiet note
    glyph for untyped ones. */
function EntryIcon({ type, icons }: { type: string; icons: Record<string, DbIcon> }) {
  return type ? <TypeIcon type={type} icon={iconForType(icons, type)} /> : <NoteIcon />;
}

/** One candidate row (Scheduled / Due lanes): opens on click, picks on the
    quiet verb. An overdue row's one red signal is its day chip in --danger
    (SUB-306), showing the day it was due; done rows dim (SUB-205). */
function CandidateRow({
  item,
  overdue,
  icons,
  onOpenNote,
  onPick,
  onRowContextMenu,
}: {
  item: AgendaItem;
  overdue: boolean;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onPick: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
}) {
  const done = isComplete(item.status);
  return (
    <div
      className={done ? "today-row done" : "today-row"}
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
}: {
  item: PickedItem;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onUnpick: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
}) {
  const n = item.note;
  const done = isComplete(foldedPropStr(n.props, "status"));
  return (
    <div
      className={done ? "today-row done" : "today-row"}
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
}: {
  item: LeftoverItem;
  icons: Record<string, DbIcon>;
  onOpenNote: (path: string) => void;
  onKeep: (path: string) => void;
  onClear: (path: string) => void;
  onRowContextMenu: (path: string, x: number, y: number) => void;
}) {
  const n = item.note;
  return (
    <div
      className="today-row"
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
  // focus, so a long-lived window never shows yesterday (SUB-153)
  const iso = useTodayIso();
  const data = useMemo(() => todayData(notes, schema, iso), [notes, schema, iso]);

  // the one verb, both directions — the write mirrors CalendarPane's
  // reschedule: the pane owns its mutation, failures land on App's toast and
  // re-sync so nothing implies the write landed (SUB-240)
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

  return (
    <div className="today-pane">
      <div className="today-scroll">
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

          {data.leftovers.length > 0 && (
            <section className="today-section today-leftovers">
              <div className="today-eyebrow">Leftovers</div>
              {data.leftovers.map((l) => (
                <LeftoverRow
                  key={l.note.path}
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

          <section className="today-section">
            <div className="today-eyebrow">Scheduled</div>
            {data.scheduled.length === 0 ? (
              <div className="today-quiet">Nothing scheduled.</div>
            ) : (
              data.scheduled.map((it) => (
                <CandidateRow
                  key={`${it.path}:${it.prop}`}
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

          <section className="today-section">
            <div className="today-eyebrow">Due &amp; overdue</div>
            {data.due.length === 0 ? (
              <div className="today-quiet">Nothing due.</div>
            ) : (
              data.due.map((it) => (
                <CandidateRow
                  key={`${it.path}:${it.prop}`}
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

          <section className="today-section">
            <div className="today-eyebrow">Picked for today</div>
            {data.picked.length === 0 ? (
              <div className="today-quiet">Nothing picked yet.</div>
            ) : (
              data.picked.map((p) => (
                <PickedRow
                  key={p.note.path}
                  item={p}
                  icons={icons}
                  onOpenNote={onOpenNote}
                  onUnpick={unpick}
                  onRowContextMenu={onRowContextMenu}
                />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
