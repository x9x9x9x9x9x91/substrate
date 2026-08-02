import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NoteMeta, PropSchema } from "../lib/types";
import { propStr } from "../lib/types";
import type { CalEntry } from "../lib/calendar";
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
      anchor. Only those trade the date/time rows for the series actions
      (SUB-649): a non-repeating date range's continuation day is not one, and
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
  onSetStatus,
  onRepeatPick,
  onSkip,
  onEndSeries,
  onTrash,
}: CalPeekProps) {
  const [titleDraft, setTitleDraft] = useState(entry.title);
  const [timeDraft, setTimeDraft] = useState(entry.time ?? "");
  const [dateMenu, setDateMenu] = useState<AnchorRect | null>(null);
  const [statusMenu, setStatusMenu] = useState<AnchorRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // the note's actual value on the anchor occurrence — day + optional time
  const rawValue = propStr(note?.props ?? {}, entry.prop) ?? entry.day;

  // a committed time lands on the next refresh — pick it up, but never fight
  // an in-progress edit (the input shows the normalized value once committed)
  useEffect(() => setTimeDraft(entry.time ?? ""), [entry.time]);

  // outside press closes — except while a sub-picker (date/status, or the
  // pane's repeat menu) owns the layer; those portals sit outside this box.
  // Registered ONCE, reading the latest props through a ref: with the props
  // in the dep list, any same-mousedown state update elsewhere (the pane's
  // expanded-day collapse listens on the same window mousedown) re-renders
  // us between listeners, the effect re-subscribes mid-dispatch, and the
  // re-added listener misses the very event that should have dismissed us.
  const dismissRef = useRef({ dateMenu, statusMenu, suppressDismiss, onClose });
  dismissRef.current = { dateMenu, statusMenu, suppressDismiss, onClose };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const cur = dismissRef.current;
      if (boxRef.current?.contains(e.target as Node)) return;
      if (cur.dateMenu || cur.statusMenu || cur.suppressDismiss) return;
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
    const raw = timeDraft.trim();
    // empty = all-day: the value drops its time part
    if (!raw) {
      if (entry.time) onSetTime(null);
      return;
    }
    const m = TIME_RE.exec(raw);
    if (!m || Number(m[1]) > 23) {
      setTimeDraft(entry.time ?? "");
      return;
    }
    const t = `${m[1].padStart(2, "0")}:${m[2]}`;
    setTimeDraft(t);
    if (t !== entry.time) onSetTime(t);
  };

  // Beside the entry, Notion-Calendar style (SUB-792): to the RIGHT of the
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
                    setTimeDraft(entry.time ?? "");
                    e.currentTarget.blur();
                  }
                  e.stopPropagation();
                }}
              />
            </div>
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
