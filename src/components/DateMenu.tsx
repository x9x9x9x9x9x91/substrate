import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatDateHuman,
  monthGrid,
  monthLabel,
  parseDateTimeLoose,
  todayIso,
} from "../lib/dates";
import { dateRangeValue, splitDateRange } from "../lib/calendar";
import { formatDateTimeHuman } from "../lib/display";
import type { AnchorRect } from "./SelectMenu";
import type { HopDir } from "../lib/cellhop";

interface DateMenuProps {
  anchor: AnchorRect;
  /** current value — ISO day with an optional ` HH:MM`, or any
      leftover free text */
  value: string;
  /** Type-to-replace: the keystroke that opened this picker, seeded
      into the date input — typing `2` over a date cell starts parsing there */
  seed?: string;
  /** Enter/Tab commit AND carry the editor onward (see SelectMenu) */
  onHop?: (dir: HopDir) => void;
  onCommit: (iso: string) => void;
  onClear?: () => void;
  /** open the shared schema editor (change this prop's kind/options) */
  onEditSchema?: () => void;
  /** opened from inside a z-100 overlay dialog: ride above it.
      Default stays 60 — below the palette overlay, as everywhere else. */
  aboveOverlay?: boolean;
  onClose: () => void;
}

const MENU_MAX_H = 340;
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** Compact Linear-style calendar for date-kind props. Arrows move the day,
    PgUp/PgDn the month, Enter commits, Esc closes; typing a date in the input
    always works and wins over the grid on Enter. */
export default function DateMenu({
  anchor,
  value,
  seed,
  onHop,
  onCommit,
  onClear,
  onEditSchema,
  aboveOverlay,
  onClose,
}: DateMenuProps) {
  // A type-to-replace keystroke lands in the parse input, so the
  // date reads as typed-over rather than picked from the grid
  const [text, setText] = useState(seed ?? "");
  // the current value, split: a timed value still opens on
  // its day, grid picks keep its time, and a range opens showing both ends
  const valueSplit = splitDateRange(value);
  const valueDay = valueSplit?.start.day ?? null;
  const valueTime = valueSplit?.start.time ?? null;
  const valueEnd = valueSplit?.end ?? null;
  /** range mode: off, the picker is exactly the single-date picker
      it always was. On, the first grid click arms a start and the second
      closes the range — until then `pending` holds the armed day so the grid
      can preview the span under the cursor. A value that already IS a range
      opens in range mode, so re-picking it doesn't silently drop its end. */
  const [ranging, setRanging] = useState(() => valueEnd !== null);
  const [pending, setPending] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => valueDay ?? todayIso());
  const boxRef = useRef<HTMLDivElement>(null);
  const [ym, setYm] = useState<[number, number]>(() => {
    const c = valueDay ?? todayIso();
    return [Number(c.slice(0, 4)), Number(c.slice(5, 7))];
  });
  const [y, m] = ym;

  const cells = useMemo(() => monthGrid(y, m), [y, m]);
  const today = todayIso();

  const showMonthOf = (iso: string) =>
    setYm([Number(iso.slice(0, 4)), Number(iso.slice(5, 7))]);

  const moveCursor = (days: number) => {
    const d = new Date(
      Number(cursor.slice(0, 4)),
      Number(cursor.slice(5, 7)) - 1,
      Number(cursor.slice(8, 10)) + days
    );
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setCursor(iso);
    showMonthOf(iso);
  };

  const shiftMonth = (delta: number) => {
    const nm = m + delta;
    const yy = nm < 1 ? y - 1 : nm > 12 ? y + 1 : y;
    const mm = nm < 1 ? 12 : nm > 12 ? 1 : nm;
    setYm([yy, mm]);
  };

  /** a grid-picked day keeps the current value's time when it carries one
 — the picker stays day-only, never inventing a time */
  const withTime = (day: string) => (valueTime ? `${day} ${valueTime}` : day);

  /** picking a day. Outside range mode this is the old behaviour
      verbatim: one click commits that day. Inside it, the first click arms a
      start and the second closes the span — clicking the two days in either
      order gives the same range, since a backwards pick reads as "I meant
      this end first". Each endpoint keeps the time the value already carried
      on its own side, so a timed range survives a re-pick. */
  const pick = (day: string) => {
    if (!ranging) {
      onCommit(withTime(day));
      return;
    }
    if (pending === null) {
      setPending(day);
      return;
    }
    const [a, b] = pending <= day ? [pending, day] : [day, pending];
    setPending(null);
    // dateRangeValue keeps the two endpoints in order — closing a
    // range on the SAME day the value is already timed would otherwise write
    // a timed start against an untimed end, which reads as reversed
    onCommit(dateRangeValue(a, valueTime, { day: b, time: valueEnd?.time }));
  };

  /** the range toggle. Turning it OFF drops the end and leaves the plain
      start behind — "clearing end reverts to single date". Turning it on with
      a value already set arms that value's day, so the next click closes a
      span against it rather than starting from nothing. */
  const toggleRange = () => {
    if (ranging) {
      setRanging(false);
      setPending(null);
      if (valueEnd && valueDay) onCommit(withTime(valueDay));
      return;
    }
    setRanging(true);
    setPending(valueDay);
  };

  const commitText = () => {
    const dt = parseDateTimeLoose(text);
    if (dt) onCommit(dt.time ? `${dt.day} ${dt.time}` : dt.day);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (text.trim()) commitText();
      else pick(cursor);
      // Same commit, then carry the editor down the column. A range
      // being drawn is mid-gesture — the second click closes it, so no hop.
      if (!ranging) onHop?.(e.shiftKey ? "up" : "down");
    } else if (e.key === "Tab" && onHop) {
      // Commit what's typed (an untouched picker just closes) and
      // land one cell over — the arrows belong to the calendar grid, so Tab
      // is the only horizontal hop a date cell offers
      e.preventDefault();
      if (text.trim()) commitText();
      else onClose();
      onHop(e.shiftKey ? "left" : "right");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveCursor(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveCursor(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(-7);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveCursor(7);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      shiftMonth(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      shiftMonth(1);
    }
    e.stopPropagation();
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const flipUp = anchor.bottom + MENU_MAX_H + 8 > window.innerHeight && anchor.top > MENU_MAX_H;
  const style: React.CSSProperties = {
    left: Math.min(anchor.left, window.innerWidth - 268),
    ...(flipUp
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
    // opened from an overlay dialog: ride above the z-100 dim
    ...(aboveOverlay ? { zIndex: 120 } : {}),
  };

  // portal children bubble through the React tree — keep clicks off the anchor
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const typed = parseDateTimeLoose(text);

  /* the span the grid shades: the armed start against the hovered
     day while a range is being drawn, otherwise the stored range's own two
     ends. Endpoints render as `current` — the shading is the interior. */
  const spanEnds: [string, string] | null =
    ranging && pending !== null
      ? pending <= cursor
        ? [pending, cursor]
        : [cursor, pending]
      : valueDay && valueEnd
        ? [valueDay, valueEnd.day]
        : null;
  const spanEndDay = spanEnds?.[1] ?? null;
  const inSpan = (iso: string) =>
    spanEnds !== null && iso >= spanEnds[0] && iso <= spanEnds[1];

  const menu = (
    <div
      className={`selmenu datemenu${flipUp ? " flip-up" : ""}`}
      style={style}
      ref={boxRef}
      onClick={stop}
      onKeyDown={stop}
    >
      <input
        className="selmenu-input"
        autoFocus
        placeholder={valueDay ? formatDateTimeHuman(value) : "Type a date…"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const dt = parseDateTimeLoose(e.target.value);
          if (dt) {
            setCursor(dt.day);
            showMonthOf(dt.day);
          }
        }}
        onKeyDown={onKey}
      />
      {text.trim() && (
        <div className="datemenu-parse">
          {typed
            ? `→ ${formatDateHuman(typed.day)}${typed.time ? `, ${typed.time}` : ""}`
            : "Keep typing…"}
        </div>
      )}
      {ranging && pending !== null && !text.trim() && (
        <div className="datemenu-parse">
          {`${formatDateHuman(pending)} → pick the end day`}
        </div>
      )}
      <div className="datemenu-head">
        <button className="datemenu-nav" onClick={() => shiftMonth(-1)} title="Previous month">
          ‹
        </button>
        <span className="datemenu-month">{monthLabel(y, m)}</span>
        <button className="datemenu-nav" onClick={() => shiftMonth(1)} title="Next month">
          ›
        </button>
      </div>
      <div className="datemenu-grid">
        {WEEKDAYS.map((d, i) => (
          <span key={`w${i}`} className="datemenu-wd">
            {d}
          </span>
        ))}
        {cells.map((c) => (
          <button
            key={c.iso}
            data-iso={c.iso}
            className={[
              "datemenu-day",
              c.inMonth ? "" : "out",
              c.iso === today ? "today" : "",
              c.iso === cursor ? "cursor" : "",
              c.iso === valueDay ? "current" : "",
              inSpan(c.iso) ? "inspan" : "",
              c.iso === spanEndDay ? "current" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={() => setCursor(c.iso)}
            onClick={() => pick(c.iso)}
          >
            {c.day}
          </button>
        ))}
      </div>
      <div className="datemenu-foot">
        <button className="selmenu-btn" onClick={() => pick(today)}>
          Today
        </button>
        <button
          className={`selmenu-btn${ranging ? " on" : ""}`}
          onClick={toggleRange}
          title={ranging ? "Back to a single date" : "Pick a start and an end day"}
        >
          Range
        </button>
        {value && onClear && (
          <button className="selmenu-btn" onClick={onClear}>
            Clear
          </button>
        )}
        {onEditSchema && (
          <button className="selmenu-btn datemenu-type" onClick={onEditSchema} title="Change property type">
            Type…
          </button>
        )}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
