import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NoteMeta, PropSchema } from "../lib/types";
import { propStr } from "../lib/types";
import type { CalEntry } from "../lib/calendar";
import { parseTimeEntry, splitDateRange } from "../lib/calendar";
import { formatDateHuman } from "../lib/dates";
import { formatDateTimeHuman } from "../lib/display";
import DateMenu from "./DateMenu";
import SelectMenu, { anchorFrom, optionColor, OptionPill, type AnchorRect } from "./SelectMenu";

/** free-typed HH:MM — one or two hour digits, exactly two minute digits */
const TIME_RE = /^(\d{1,2}):([0-5]\d)$/;

const PEEK_MAX_H = 300;
const PEEK_W = 260; // must match styles.css .cal-peek width
const GAP = 8;

interface CalPeekProps {
  /** the live entry, re-derived by the pane on every refresh — the peek never
      renders stale values */
  entry: CalEntry;
  /** the entry's note (raw prop values); undefined only mid-refresh */
  note: NoteMeta | undefined;
  /** the chip's type badge, rendered by the pane */
  icon: React.ReactNode;
  /** the clicked chip's viewport rect */
  anchor: AnchorRect;
  /** a VIRTUAL series occurrence — a repeating entry on a day that isn't its
      anchor. Only those trade the date/time rows for the series actions:
      a non-repeating date range's continuation day is not one, and
      edits its span through the stored start like every other write path */
  isOccurrence: boolean;
  /** the `repeat` cadence for display ("Weekly", a raw custom value, "None") */
  repeatText: string;
  /** the type schema's `status` spec — the status row only exists with one */
  statusSchema: PropSchema | undefined;
  /** the pane's repeat picker is open — outside clicks must not dismiss yet */
  suppressDismiss: boolean;
  onClose: () => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  /** DateMenu commit — ISO day, optionally carrying " HH:MM" */
  onMoveDate: (iso: string) => void;
  onClearDate: () => void;
  /** null = all-day (the time part of the value is dropped) */
  onSetTime: (time: string | null) => void;
  /** the range's END time — null drops the end, leaving a plain
      start. The pane clamps an end at or before the start rather than flipping
      the pair, so it returns the time actually stored, which the field shows
      in place of the rejected one. */
  onSetEnd: (time: string | null) => string | null;
  /** the range's end DAY — the Ends row's day half, a picked ISO day
      (optionally carrying " HH:MM"). The pane clamps a day before the start
      onto the start's own day; null drops the end entirely. The way back to
      a single-day event when an over-drag left it spanning midnight. */
  onSetEndDay: (iso: string | null) => void;
  onSetStatus: (v: string | null) => void;
  onRepeatPick: (anchor: AnchorRect) => void;
  onSkip: () => void;
  onEndSeries: () => void;
  onTrash: () => void;
}

/** Entry peek popover (Notion-Calendar style): click a chip/card and edit the
    essentials in place — title (rename), date, time, status, repeat — with the
    note itself one "Open note ↗" away. Rides the same write paths as drag and
    the note chips; virtual series occurrences trade the date/time rows for the
    series actions. Dismisses on Esc (the pane's chain), outside press, scroll. */
export default function CalPeek({
  entry,
  note,
  icon,
  anchor,
  isOccurrence,
  repeatText,
  statusSchema,
  suppressDismiss,
  onClose,
  onOpen,
  onRename,
  onMoveDate,
  onClearDate,
  onSetTime,
  onSetEnd,
  onSetEndDay,
  onSetStatus,
  onRepeatPick,
  onSkip,
  onEndSeries,
  onTrash,
}: CalPeekProps) {
  // the note's actual value on the anchor occurrence — day + optional time
  const rawValue = propStr(note?.props ?? {}, entry.prop) ?? entry.day;

  // the STORED value, read off the note rather than the entry: the peek can
  // open on any day a span covers, and the value is the truth every row and
  // write path here works from. A drag on the block's edge grips commits
  // through the same pane handlers, so a resize shows up here on the next
  // refresh.
  const stored = splitDateRange(rawValue);
  // the START's clock, wherever the peek opened: a timed span's continuation
  // chip renders all-day and carries no time of its own, but the time row
  // edits the stored start — so show that start, instead of an empty field
  // implying an all-day event
  const startTime = entry.time ?? stored?.start.time ?? null;
  const endDay = stored?.end?.day ?? null;
  const endTime = stored?.end?.time ?? null;
  // does the value cross days? A span that does has a closing hour worth
  // giving even when it starts all-day ("the festival runs Fri–Sun, ends 5pm")
  const spanning = !!stored?.end && stored.end.day !== stored.start.day;

  const [titleDraft, setTitleDraft] = useState(entry.title);
  const [timeDraft, setTimeDraft] = useState(startTime ?? "");
  const [endDraft, setEndDraft] = useState("");
  const [dateMenu, setDateMenu] = useState<AnchorRect | null>(null);
  const [endDayMenu, setEndDayMenu] = useState<AnchorRect | null>(null);
  const [statusMenu, setStatusMenu] = useState<AnchorRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // A committed time lands on the next refresh — pick it up, but never fight
  // an in-progress edit (the input shows the normalized value once committed).
  //
  // Adjusted DURING render against the value each field last synced from,
  // rather than from an effect keyed on the value itself. A write made from
  // one of these rows lands as two updates at once — the vault refresh
  // carrying the new value, and the field's own commit — and React renders
  // the first pass, throws it away, and re-renders. A discarded pass still
  // leaves its values in the effect's comparison, so on the surviving pass
  // the row that changed in the discarded one reads as unchanged, its effect
  // never runs, and the field sits on the old time until the peek is
  // reopened: type a start past the block's own end and the Ends row keeps
  // showing the end that was just moved. A state adjustment made during
  // render is thrown away together with the render that made it, so the
  // surviving pass always compares against what was actually shown.
  const [syncedStart, setSyncedStart] = useState(startTime);
  const [syncedEnd, setSyncedEnd] = useState<string | null>(null);
  if (startTime !== syncedStart) {
    setSyncedStart(startTime);
    setTimeDraft(startTime ?? "");
  }
  if (endTime !== syncedEnd) {
    setSyncedEnd(endTime);
    setEndDraft(endTime ?? "");
  }

  // outside press closes — except while a sub-picker (date/status, or the
  // pane's repeat menu) owns the layer; those portals sit outside this box.
  // Registered ONCE, reading the latest props through a ref: with the props
  // in the dep list, any same-mousedown state update elsewhere (the pane's
  // expanded-day collapse listens on the same window mousedown) re-renders
  // us between listeners, the effect re-subscribes mid-dispatch, and the
  // re-added listener misses the very event that should have dismissed us.
  const dismissRef = useRef({ dateMenu, endDayMenu, statusMenu, suppressDismiss, onClose });
  dismissRef.current = { dateMenu, endDayMenu, statusMenu, suppressDismiss, onClose };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const cur = dismissRef.current;
      if (boxRef.current?.contains(e.target as Node)) return;
      if (cur.dateMenu || cur.endDayMenu || cur.statusMenu || cur.suppressDismiss) return;
      cur.onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  // the anchor rect goes stale the moment the grid moves — close, like the
  // context menu does, rather than float detached. Armed a beat after mount:
  // the click that opened the peek may itself have scrolled the chip into
  // view (an expanded cell's overflow), and that scroll event is delivered
  // asynchronously — after this listener exists. The anchor was measured
  // after that scroll, so it isn't stale; only later scrolls are.
  const armedRef = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      armedRef.current = true;
    }, 150);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const close = () => {
      if (armedRef.current) onClose();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const commitTitle = () => {
    const t = titleDraft.trim();
    if (t && t !== entry.title) onRename(t);
    else setTitleDraft(entry.title);
  };

  const commitTime = () => {
    // an empty field and a typed "all day" are the same request: back to an
    // all-day event, which also drops a timed span's end (the pane's write)
    const parsed = parseTimeEntry(timeDraft);
    if (parsed.kind === "clear") {
      setTimeDraft("");
      if (startTime) onSetTime(null);
      return;
    }
    if (parsed.kind === "invalid") {
      setTimeDraft(startTime ?? "");
      return;
    }
    setTimeDraft(parsed.time);
    if (parsed.time !== startTime) onSetTime(parsed.time);
  };

  const commitEnd = () => {
    const raw = endDraft.trim();
    // empty = no end: the value loses its range and is a plain start again
    if (!raw) {
      if (endTime) onSetEnd(null);
      setEndDraft("");
      return;
    }
    const m = TIME_RE.exec(raw);
    if (!m || Number(m[1]) > 23) {
      setEndDraft(endTime ?? "");
      return;
    }
    const t = `${m[1].padStart(2, "0")}:${m[2]}`;
    // the field shows what was STORED, not what was typed: an end at or
    // before the start comes back clamped to the first slot after it, and a
    // row still reading "00:15" under a 06:15 date would be a plain lie
    setEndDraft((t !== endTime ? onSetEnd(t) : endTime) ?? "");
  };

  // Beside the entry, Notion-Calendar style: to the RIGHT of the
  // clicked chip, top-aligned with it, so the popover never covers the day
  // it edits. Near the window's right edge it flips to the chip's left; only
  // when neither side has room (a very narrow window) does it fall back to
  // the old below/above placement.
  const anchorRight = anchor.left + (anchor.width ?? 0);
  const fitsRight = anchorRight + GAP + PEEK_W <= window.innerWidth - GAP;
  const fitsLeft = anchor.left - GAP - PEEK_W >= GAP;
  // top-aligned with the chip, nudged up just enough to stay on screen
  const sideTop = Math.max(GAP, Math.min(anchor.top, window.innerHeight - PEEK_MAX_H - GAP));
  const flipUp = anchor.bottom + PEEK_MAX_H + GAP > window.innerHeight && anchor.top > PEEK_MAX_H;
  const style: React.CSSProperties =
    fitsRight || fitsLeft
      ? {
          left: fitsRight ? anchorRight + GAP : anchor.left - GAP - PEEK_W,
          top: sideTop,
        }
      : {
          left: Math.min(anchor.left, window.innerWidth - PEEK_W - GAP),
          ...(flipUp ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
        };

  // portal children bubble through the React tree — keep clicks off the anchor
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const menu = (
    <div className="cal-peek" style={style} ref={boxRef} onClick={stop} onKeyDown={stop}>
      <div className="cal-peek-head">
        {icon}
        <input
          className="cal-peek-title"
          value={titleDraft}
          placeholder="Untitled"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
            } else if (e.key === "Escape") {
              // revert, then hand focus back so a second Esc closes the peek
              e.preventDefault();
              setTitleDraft(entry.title);
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
        />
      </div>
      <div className="cal-peek-rows">
        {!isOccurrence ? (
          <>
            <button
              className="cal-peek-row"
              onClick={(e) => setDateMenu(anchorFrom(e.currentTarget))}
            >
              <span className="cal-peek-key">Date</span>
              <span className="cal-peek-val">{formatDateTimeHuman(rawValue)}</span>
            </button>
            <div className="cal-peek-row">
              <span className="cal-peek-key">Time</span>
              <input
                className="cal-peek-time"
                value={timeDraft}
                placeholder="All day"
                onChange={(e) => setTimeDraft(e.target.value)}
                onBlur={commitTime}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTime();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setTimeDraft(startTime ?? "");
                    e.currentTarget.blur();
                  }
                  e.stopPropagation();
                }}
              />
            </div>
            {/* how long it runs — the typed twin of the week
                canvas's bottom-edge drag. Offered for a timed start OR any
                span that crosses days: an all-day one-day entry has no
                closing hour to describe, but a multi-day one does, and the
                row is the only way to type it (the date picker stays
                day-only). Typing an hour on an all-day span leaves the start
                all-day and closes the span at that clock time; emptying the
                field again drops only the hour, never the closing day. When
                the end falls on a later day the day is shown beside the
                field — so "09:00" can't read as this morning — and is a
                button: picking an earlier day pulls the end back (clamped to
                the start), the way home when an over-drag stranded the event
                across midnight; the picker's Clear drops the end whole. */}
            {(entry.time || spanning) && (
              <div className="cal-peek-row">
                <span className="cal-peek-key">Ends</span>
                <input
                  className="cal-peek-end"
                  value={endDraft}
                  placeholder="—"
                  onChange={(e) => setEndDraft(e.target.value)}
                  onBlur={commitEnd}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEnd();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEndDraft(endTime ?? "");
                      e.currentTarget.blur();
                    }
                    e.stopPropagation();
                  }}
                />
                {endDay && endDay !== (stored?.start.day ?? entry.day) && (
                  <button
                    type="button"
                    className="cal-peek-endday"
                    title="Change the day the event ends"
                    onClick={(e) => setEndDayMenu(anchorFrom(e.currentTarget))}
                  >
                    {formatDateHuman(endDay)}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <button className="cal-peek-row cal-peek-act" onClick={onSkip}>
              Skip this occurrence
            </button>
            <button className="cal-peek-row cal-peek-act" onClick={onEndSeries}>
              Delete this and following
            </button>
          </>
        )}
        {statusSchema && (
          <button
            className="cal-peek-row"
            onClick={(e) => setStatusMenu(anchorFrom(e.currentTarget))}
          >
            <span className="cal-peek-key">Status</span>
            <span className="cal-peek-val">
              {entry.status ? (
                <OptionPill color={optionColor(statusSchema.options, entry.status)}>
                  {entry.status}
                </OptionPill>
              ) : (
                <span className="cal-peek-none">—</span>
              )}
            </span>
          </button>
        )}
        <button className="cal-peek-row" onClick={(e) => onRepeatPick(anchorFrom(e.currentTarget))}>
          <span className="cal-peek-key">Repeat</span>
          <span className="cal-peek-val">{repeatText}</span>
        </button>
      </div>
      <div className="cal-peek-foot">
        <button className="cal-peek-open" onClick={onOpen}>
          Open note ↗
        </button>
        <button className="cal-peek-del" onClick={onTrash}>
          {entry.repeating ? "Delete all occurrences" : "Delete"}
        </button>
      </div>
      {dateMenu && (
        <DateMenu
          anchor={dateMenu}
          value={rawValue}
          onCommit={(iso) => {
            setDateMenu(null);
            onMoveDate(iso);
          }}
          onClear={() => {
            setDateMenu(null);
            onClearDate();
          }}
          onClose={() => setDateMenu(null)}
        />
      )}
      {/* no `&& endDay` here: the dismiss guard above holds while this menu
          is open, so a mid-refresh render that blanks the note must not
          unmount the picker and strand the peek undismissable */}
      {endDayMenu && (
        <DateMenu
          anchor={endDayMenu}
          value={endDay ?? entry.day}
          onCommit={(iso) => {
            setEndDayMenu(null);
            onSetEndDay(iso);
          }}
          onClear={() => {
            setEndDayMenu(null);
            onSetEndDay(null);
          }}
          onClose={() => setEndDayMenu(null)}
        />
      )}
      {statusMenu && statusSchema && (
        <SelectMenu
          anchor={statusMenu}
          value={entry.status ?? ""}
          label="Pick status"
          options={statusSchema.options}
          used={[]}
          canEditSchema={false}
          onCommit={(v) => {
            setStatusMenu(null);
            onSetStatus(v);
          }}
          onClear={() => {
            setStatusMenu(null);
            onSetStatus(null);
          }}
          onSaveSchema={() => {}}
          onClose={() => setStatusMenu(null)}
        />
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
