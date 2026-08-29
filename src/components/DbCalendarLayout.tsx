import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { DbIcon, NoteMeta, SchemaConfig } from "../lib/types";
import { NOTE_DRAG_MIME } from "../lib/sidebar";
import { dbLayoutEntries } from "../lib/dbcalendarlayout";
import { entriesByDay, monthWindow } from "../lib/calendarfence";
import { cellDayLabel, humanDay, isoDay, monthGridDays, monthTitle, parseDay } from "../lib/calendar";
import { typeTint } from "../lib/dbicons";
import { ChevronLeftIcon, ChevronRightIcon, RepeatIcon } from "./Icons";
import { useTodayIso } from "./useTodayIso";
import EmptyState from "./EmptyState";
import { HeroDatabase } from "./HeroIcons";

/** How many chips a day cell shows before "+N more" — the Calendar pane's own
    month cap, since a database pane is a full pane like it is. */
const CELL_CAP = 4;

// week starts Monday, exactly as monthGridDays lays the grid out
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The calendar layout (a sibling of the board, gallery and list layouts): the
    database's rows on a month grid, placed by one of its date properties.
    DatabasePane still owns the rows, the filter and the callbacks, and the
    month the reader is looking at: paging reports up, so a row made from the
    toolbar or ⌘N can be born on the day this grid is showing.

    The chips are ordinary buttons rather than cells in the pane's (column,
    row) focus walk: a month grid is not a row list, and a day's chips have no
    honest column. Tab reaches every chip, Enter opens it, and the pane's
    arrow-key walk stays with the layouts that have rows to walk.
 */
export default function DbCalendarLayout({
  rows,
  schema,
  dbType,
  icon,
  dateProp,
  dateProps,
  month,
  onMonth,
  openPath,
  bgMenuProps,
  head,
  tabRow,
  bar,
  noMatch,
  adminPop,
  draftRow,
  bodyRef,
  onOpenNote,
  onNoteMenu,
}: {
  rows: NoteMeta[];
  /** the whole vault schema — calendarEntries reads a note's own type's
      date rules from it, and a row's type is this database's */
  schema: SchemaConfig;
  dbType: string;
  icon?: DbIcon;
  /** the bound date prop; null = this database has no date property */
  dateProp: string | null;
  /** every date prop on offer — what the empty state can honestly promise */
  dateProps: string[];
  /** the month on screen, owned by the pane so a new row can be born on it */
  month: { year: number; month0: number };
  onMonth: (year: number, month0: number) => void;
  openPath: string | null;
  bgMenuProps: { onContextMenu: (e: React.MouseEvent) => void };
  head: React.ReactNode;
  tabRow: React.ReactNode;
  bar: React.ReactNode;
  noMatch: React.ReactNode;
  adminPop: React.ReactNode;
  draftRow: React.ReactNode;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onOpenNote: (path: string) => void;
  onNoteMenu: (path: string, x: number, y: number) => void;
}) {
  // day rollover lives in the hook, the same subscription the Calendar pane
  // and the dashboard fence take: a pane left open past midnight moves its
  // `.today` highlight without a remount
  const todayIso = useTodayIso();
  const today = parseDay(todayIso) ?? new Date();
  const [expandedIso, setExpandedIso] = useState<string | null>(null);
  const { year, month0 } = month;

  const entries = useMemo(
    () => dbLayoutEntries(rows, schema, dateProp, monthWindow(year, month0)),
    [rows, schema, dateProp, year, month0]
  );
  const byDay = useMemo(() => entriesByDay(entries), [entries]);
  const tint = useMemo(() => typeTint(dbType, icon), [dbType, icon]);

  const page = (delta: number) => {
    setExpandedIso(null);
    const next = new Date(year, month0 + delta, 1);
    onMonth(next.getFullYear(), next.getMonth());
  };
  const days = monthGridDays(year, month0);

  return (
    <div className="db" {...bgMenuProps}>
      {head}
      {tabRow}
      {bar}
      {dateProp === null ? (
        <EmptyState
          icon={<HeroDatabase />}
          title="No date to place these on"
          hint={
            dateProps.length === 0
              ? `A calendar needs a date property — “${dbType}” has none yet`
              : `Pick a date property for “${dbType}” to lay its entries out on`
          }
        />
      ) : (
        <>
          <div className="db-calhead">
            <span className="db-calbind">by {dateProp}</span>
            <div className="db-calnav">
              <span className="db-calmonth">{monthTitle(year, month0)}</span>
              <div className="cal-pager">
                <button
                  type="button"
                  onClick={() => page(-1)}
                  aria-label="Previous month"
                  title="Previous month"
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  onClick={() => page(1)}
                  aria-label="Next month"
                  title="Next month"
                >
                  <ChevronRightIcon />
                </button>
              </div>
            </div>
          </div>
          <div className="db-body db-calendar" ref={bodyRef}>
            {draftRow}
            {noMatch}
            <div className="cal-weekdays">
              {WEEKDAYS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="cal-grid month">
              {days.map((d) => {
                const iso = isoDay(d);
                const items = byDay.get(iso) ?? [];
                const expanded = expandedIso === iso;
                const cap = expanded ? items.length : CELL_CAP;
                const overflow = items.length - cap;
                const cls = [
                  "cal-day",
                  d.getMonth() !== month0 ? "adj" : "",
                  d.getDay() === 0 || d.getDay() === 6 ? "wknd" : "",
                  iso === todayIso ? "today" : "",
                  expanded ? "expanded" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  // a day cell is a labelled group, not a control: the pane
                  // edits its rows through the chips and the note itself
                  <div key={iso} data-iso={iso} className={cls} role="group" aria-label={humanDay(iso, today)}>
                    <span className="cal-daynum" aria-current={iso === todayIso ? "date" : undefined}>
                      <span className={iso === todayIso ? "cal-today" : d.getDate() === 1 ? "cal-seam" : ""}>
                        {iso === todayIso ? d.getDate() : cellDayLabel(d)}
                      </span>
                    </span>
                    {items.slice(0, cap).map((e) => (
                      <button
                        type="button"
                        key={`${e.path}:${e.prop}:${e.day}`}
                        // a multi-day row wears the shared span vocabulary, so
                        // a continuation day reads as the same event carried
                        // over rather than a second one starting
                        className={`cal-entry${e.spanPos ? ` span ${e.spanPos}` : ""}${openPath === e.path ? " open" : ""}`}
                        style={{ "--entry-tint": tint } as CSSProperties}
                        // a repeating instance is virtual — only the note on
                        // disk can be dragged anywhere
                        draggable={!e.repeating}
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData(NOTE_DRAG_MIME, e.path);
                          ev.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => onOpenNote(e.path)}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          onNoteMenu(e.path, ev.clientX, ev.clientY);
                        }}
                        title={`${e.title} · ${humanDay(e.day, today)}`}
                        aria-label={`${e.title}, ${humanDay(e.day, today)}`}
                      >
                        {/* a span needs no color bar: its tinted fill is the
                            identity mark, and a bar would break the read of
                            one run carrying across the row */}
                        {e.spanPos === undefined && (
                          <span className="cal-entry-bar" aria-hidden="true" />
                        )}
                        {e.time && <span className="cal-entry-time">{e.time}</span>}
                        <span className="cal-entry-title">{e.title}</span>
                        {e.repeating && <RepeatIcon />}
                      </button>
                    ))}
                    {overflow > 0 && (
                      <button type="button" className="cal-more" onClick={() => setExpandedIso(iso)}>
                        +{overflow} more
                      </button>
                    )}
                    {expanded && items.length > CELL_CAP && (
                      <button type="button" className="cal-more" onClick={() => setExpandedIso(null)}>
                        Show less
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {adminPop}
    </div>
  );
}
