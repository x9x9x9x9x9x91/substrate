import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { listen } from "./lib/tauri";
import {
  agendaOpenCapture,
  agendaOpenNote,
  agendaResize,
  vaultList,
  vaultSchemaRead,
} from "./lib/ipc";
import { agendaPayload, type AgendaPayload } from "./lib/agenda";
import { humanDay, isoDay } from "./lib/calendar";
import { PlusIcon } from "./components/Icons";

// Tray mini-agenda popover (SUB-30): clicking the menu-bar icon shows today's
// calendar entries and due tasks, an overdue count, and a Capture… row.
// Read-only v1: clicking an item opens the note in the main window, Escape
// (or clicking away — the window hides on blur) dismisses the popover.
const isTauri = "__TAURI_INTERNALS__" in window;

/* SUB-746: the window is sized to the card rather than a fixed 440px, which
   left dead space under a short day. These bounds are the CSS half of the
   clamp; the Rust half (AGENDA_MIN_HEIGHT / AGENDA_MAX_HEIGHT in lib.rs) is
   authoritative for the window and must agree, or the card and its window
   disagree and the transparent frame shows a gap. Deliberately px, not vh:
   a card measured against the viewport would grow when the window grows. */
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 480;

async function hideWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .hide()
    .catch(() => undefined);
}

function AgendaApp() {
  const [payload, setPayload] = useState<AgendaPayload | null>(null);
  const card = useRef<HTMLDivElement | null>(null);
  /* SUB-761: the listbox and its rows need stable ids so the focused card can
     point aria-activedescendant at the selected row. Same shape as the ⌘K
     palette (Palette.tsx `listId`/`rowId`). */
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;
  /* SUB-755: the ⌘K palette's selection model, minus the query box. Rows are
     the agenda items followed by the Capture row, so the Capture row's index
     is `payload.items.length`. -1 = nothing selected: the popover opens with
     no row lit (unlike the palette, which always has a first row selected —
     there is no query here for a selection to be "the answer" to), and the
     first ArrowDown lights row 1. Hover wins the same way it does there
     (Palette.tsx `onMouseMove` → selectIndex), so the pointer and the
     keyboard can never disagree about which row Enter would open. */
  const [sel, setSel] = useState(-1);

  /* Fit the window to the card (SUB-746). A ResizeObserver rather than an
     effect on `payload`: the card also settles after the webfont loads and
     after a `vault:changed` reload, and each of those is a real height change
     the window has to follow. Repeats are filtered here so an unchanged
     height doesn't cost an IPC round trip on every observation. */
  useEffect(() => {
    const el = card.current;
    if (!isTauri || !el || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const push = () => {
      const h = Math.min(Math.max(Math.ceil(el.offsetHeight), MIN_HEIGHT), MAX_HEIGHT);
      if (h === last) return;
      last = h;
      agendaResize(h).catch(console.error);
    };
    const ro = new ResizeObserver(push);
    ro.observe(el);
    push();
    return () => ro.disconnect();
  }, []);

  const reload = useCallback(() => {
    Promise.all([vaultList(), vaultSchemaRead()])
      .then(([notes, schema]) => setPayload(agendaPayload(notes, schema, isoDay(new Date()))))
      .catch(console.error);
  }, []);

  useEffect(() => {
    reload();
    // The window persists hidden between tray clicks: recompute on every
    // re-show (date rollover, edits while hidden) and live on vault changes.
    let unFocus: (() => void) | undefined;
    let unVault: (() => void) | undefined;
    let cancelled = false;
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow()
          .listen("tauri://focus", reload)
          .then((u) => {
            if (cancelled) u();
            else unFocus = u;
          });
      });
    }
    listen("vault:changed", reload).then((u) => {
      if (cancelled) u();
      else unVault = u;
    });
    return () => {
      cancelled = true;
      unFocus?.();
      unVault?.();
    };
  }, [reload]);

  // items + the Capture row, which always exists — so the last index is
  // `count - 1` and the Capture row is `count - 1` too when it is reached
  const rowCount = (payload?.items.length ?? 0) + 1;

  /* A reload (vault:changed, tray re-show) can shorten the list under a
     resting selection. Clamping to -1 rather than to the new last row: the
     row that was selected is gone, and silently moving the highlight onto a
     different note is exactly the class of bug the palette's select-by-id
     avoids (Palette.tsx SUB-493). Nothing selected is the honest state. */
  useEffect(() => {
    setSel((s) => (s >= rowCount ? -1 : s));
  }, [rowCount]);

  // keep the selected row visible when arrow-keying past the fold (SUB-235)
  useEffect(() => {
    if (sel < 0) return;
    // queried from the card, not the scroll list: the Capture row sits
    // outside `.agenda-list` (inside the `.agenda-rows` listbox, but pinned
    // below the scroller) and still has to be reachable by index
    card.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
    // SUB-1132: a reload can move the selected row to a different offset while
    // its index stays put, and the scroller keeps whatever the user scrolled to
  }, [sel, payload]);

  const openItem = (path: string) => {
    // Rust surfaces the main window with the note open and hides the popover
    agendaOpenNote(path).catch(console.error);
  };

  const openCapture = () => {
    agendaOpenCapture().catch(console.error);
  };

  // Enter routes through the same two calls the rows' onClick handlers use —
  // the keyboard has no path of its own to drift from the mouse's
  const openRow = (i: number) => {
    const item = payload?.items[i];
    if (item) openItem(item.path);
    else if (i === rowCount - 1) openCapture();
  };

  return (
    <div
      className="palette"
      style={{
        width: "100%",
        maxWidth: "none",
        marginTop: 0,
        // sized by content, not the viewport (SUB-746) — a 100vh card could
        // only ever report the window's own height back to the resize
        minHeight: MIN_HEIGHT,
        maxHeight: MAX_HEIGHT,
        display: "flex",
        flexDirection: "column",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          void hideWindow();
          return;
        }
        // ⌃n/⌃p ride along with the arrows, as they do in the palette
        if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
          e.preventDefault();
          setSel((s) => Math.min(s + 1, rowCount - 1));
        } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
          e.preventDefault();
          // stops at row 1 rather than walking back to "nothing selected" —
          // same floor the palette clamps to (Math.max(sel - 1, 0))
          setSel((s) => Math.max(s - 1, 0));
        } else if (e.key === "Enter" && sel >= 0) {
          e.preventDefault();
          openRow(sel);
        }
      }}
      tabIndex={-1}
      /* SUB-761: the card holds the key model and the focus, so it is the
         combobox-less equivalent of the palette's input — the element that
         points at the active option. The listbox itself is `.agenda-rows`
         below (the card also holds the head and the foot, so it can't be one
         itself). Same pairing as Palette.tsx: focused element owns
         aria-activedescendant, owned container owns the options. */
      aria-controls={listId}
      aria-activedescendant={sel >= 0 ? rowId(sel) : undefined}
      ref={(el) => {
        card.current = el;
        el?.focus();
      }}
    >
      <div className="agenda-head">
        {payload ? `Today — ${humanDay(payload.today)}` : "Today"}
      </div>
      {/* SUB-761: one container owning every row. The scroller and the pinned
          Capture row used to be siblings under the card, which left no element
          that held the options and nothing else — so no element could carry
          role="listbox" without also owning the head and the foot. This
          wrapper is layout-transparent (`.agenda-rows` forwards the card's
          free space straight to `.agenda-list`, styles.css), so the visual
          model is unchanged: same scroll behaviour, same pinned Capture row. */}
      <div className="agenda-rows" id={listId} role="listbox" aria-label="Today's agenda">
        {/* role="none" so the scroller itself doesn't sit between the listbox
            and its options — the rows promote to direct children of the list */}
        <div className="agenda-list" role="none">
          {payload && payload.items.length === 0 && (
            // same treatment as the palette's empty state (Palette.tsx): text
            // that isn't an option, announced rather than counted as a row
            <div className="agenda-empty" role="status">Nothing on today</div>
          )}
          {payload?.items.map((item, i) => (
            <div
              key={`${item.path}:${item.prop}`}
              id={rowId(i)}
              className={`agenda-row${i === sel ? " selected" : ""}`}
              data-idx={i}
              role="option"
              aria-selected={i === sel}
              // mousemove, not mouseenter (SUB-493): a reload can insert rows
              // under a resting cursor, and mouseenter would hand selection to
              // whatever slid beneath it
              onMouseMove={() => setSel(i)}
              onClick={() => openItem(item.path)}
            >
              <span className={`agenda-dot${item.deadline ? " due" : ""}`} />
              {item.type !== "" && item.type !== "event" && (
                <span className="cal-entry-type">{item.type}</span>
              )}
              {item.time && <span className="cal-entry-time">{item.time}</span>}
              <span className="agenda-title">{item.title}</span>
              <span className="palette-hint">{item.prop}</span>
            </div>
          ))}
          {payload !== null && payload.overdue > 0 && (
            // a summary line, not a row: it isn't selectable and Enter never
            // opens it, so it stays out of the option count the same way
            <div className="agenda-overdue" role="status">
              <span className="agenda-dot over" />
              {payload.overdue} overdue
            </div>
          )}
        </div>
        <div
          id={rowId(rowCount - 1)}
          className={`agenda-row agenda-capture${sel === rowCount - 1 ? " selected" : ""}`}
          data-idx={rowCount - 1}
          role="option"
          aria-selected={sel === rowCount - 1}
          onMouseMove={() => setSel(rowCount - 1)}
          onClick={openCapture}
        >
          <PlusIcon />
          <span className="agenda-title">Capture…</span>
          <span className="palette-hint">⌥Space</span>
        </div>
      </div>
      <div className="palette-foot">
        <span>
          <span className="key">↑↓</span> navigate
        </span>
        <span>
          <span className="key">↩</span> open
        </span>
        <span>
          <span className="key">esc</span> close
        </span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AgendaApp />
  </React.StrictMode>,
);
