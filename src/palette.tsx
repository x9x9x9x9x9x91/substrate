import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { invoke, listen } from "./lib/tauri";
import { paletteOpenNote, paletteOpenView, paletteSeedQuery, vaultList, vaultSearch } from "./lib/ipc";
import { CAPTURE_ROW_ID, everywhereRows, type EverywhereRow } from "./lib/everywhere";
import { createLatestGuard } from "./lib/latest";
import { foldedPropStr, type NoteMeta, type SearchHit } from "./lib/types";
import { looksLikeUrl } from "./lib/url";
import { errText } from "./lib/errtext";

// The everywhere palette: a floating window a global chord summons over
// whatever app is frontmost. Type to search the vault, Enter to jump to a
// note or a destination in the main window, or file the line straight to the
// Inbox. Escape (or clicking away — the window hides on blur) dismisses it.
//
// A third window with its own bundle, like quick-capture and the tray agenda:
// no App state, no panes, and every exit is one IPC call. What ranks the rows
// lives in `lib/everywhere.ts`, where it is testable without a DOM.
const isTauri = "__TAURI_INTERNALS__" in window;

async function hideWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .hide()
    .catch(() => undefined);
}

function PaletteApp() {
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  // the query the hits answer, so a stale batch never renders under a newer
  // query — the ⌘K palette's `hitsQuery` rule
  const [hitsQuery, setHitsQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // selection follows the row's ID, not its slot: a search batch lands under
  // the cursor while the user is typing, and an index would silently move the
  // highlight onto a different note
  const [selId, setSelId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchGuard = useMemo(() => createLatestGuard(), []);

  const titles = useMemo(() => new Map(notes.map((n) => [n.path, n.title])), [notes]);
  const dashboards = useMemo(
    () =>
      notes
        .filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === "dashboard")
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((n) => ({ path: n.path, title: n.title })),
    [notes]
  );

  const reload = useCallback(() => {
    vaultList().then(setNotes).catch(console.error);
  }, []);

  // The window persists hidden between chords, so every re-show starts clean:
  // empty box, focused input, and a fresh note list (the vault moved on while
  // the window was hidden).
  //
  // …unless this summon came from ⌘K in quick capture, which hands over the
  // line already typed there. The seed is asked for after the clear, never
  // before: the clear is synchronous and the answer is not, so this order is
  // the one where repeated resets converge on the text instead of erasing it.
  const reset = useCallback(() => {
    setQ("");
    setHits([]);
    setHitsQuery("");
    setError(null);
    setSelId(null);
    searchGuard.issue();
    inputRef.current?.focus();
    reload();
    paletteSeedQuery()
      .then((seed) => {
        if (seed) setQ(seed);
      })
      .catch(console.error);
  }, [reload, searchGuard]);

  useEffect(() => {
    reset();
    let unFocus: (() => void) | undefined;
    let unVault: (() => void) | undefined;
    let cancelled = false;
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow()
          .listen("tauri://focus", reset)
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
  }, [reset, reload]);

  // Debounced search, guarded so a slow batch can't repopulate stale hits
  // behind a newer query — same 100ms and the same guard the ⌘K palette uses.
  useEffect(() => {
    const text = q.trim();
    if (!text) {
      searchGuard.issue();
      setHits([]);
      setHitsQuery("");
      return;
    }
    const t = window.setTimeout(() => {
      const id = searchGuard.issue();
      vaultSearch(text)
        .then((found) => {
          if (!searchGuard.isLatest(id)) return;
          setHits(found);
          setHitsQuery(text);
        })
        .catch((e) => {
          console.error(e);
          if (!searchGuard.isLatest(id)) return;
          // an unreadable search still leaves the destinations and the capture
          // row, which is the whole point of the window
          setHits([]);
          setHitsQuery(text);
        });
    }, 100);
    return () => window.clearTimeout(t);
  }, [q, searchGuard]);

  const rows = useMemo(
    () =>
      everywhereRows({
        q,
        hits: hitsQuery === q.trim() ? hits : [],
        titles,
        dashboards,
      }),
    [q, hits, hitsQuery, titles, dashboards]
  );

  /* Row 0 is selected whenever the user hasn't moved, and the capture row is
     always last (lib/everywhere.ts) — so Enter navigates as long as there is
     anywhere to navigate to, and only captures when the user walks down to
     the row or when nothing else matched. */
  const sel = useMemo(() => {
    const i = selId === null ? -1 : rows.findIndex((r) => r.id === selId);
    return i >= 0 ? i : 0;
  }, [rows, selId]);
  const selectIdx = (i: number) => setSelId(rows[i]?.id ?? null);

  // keep the selected row visible when arrow-keying past the fold
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const capture = async (text: string) => {
    setError(null);
    try {
      // a pasted link becomes a reference note, exactly as in quick capture
      if (looksLikeUrl(text)) await invoke("url_capture", { url: text });
      else await invoke("vault_create", { title: text, folder: "Inbox" });
    } catch (e) {
      // never discard what the user typed: it stays in the box so Enter
      // retries or the text can be copied out
      setError(errText(e));
      return;
    }
    setQ("");
    void hideWindow();
  };

  // One path for the mouse and the keyboard, so the two can't drift. The
  // navigating rows hide the window Rust-side, once the main window is up.
  const run = (row: EverywhereRow | undefined) => {
    if (!row) return;
    if (row.action.kind === "capture") return void capture(row.action.text);
    if (row.action.kind === "note") {
      paletteOpenNote(row.action.path).catch(console.error);
      return;
    }
    paletteOpenView(row.action.view).catch(console.error);
  };

  const selected = rows[sel];
  const foot =
    selected?.id === CAPTURE_ROW_ID
      ? looksLikeUrl(q.trim())
        ? "capture link"
        : "file in Inbox"
      : "open";

  return (
    <div
      className="palette"
      style={{
        width: "100%",
        maxWidth: "none",
        marginTop: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
    <input
        ref={inputRef}
        className="palette-input"
        // note titles and pasted links, not prose — no autocorrect bubble
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="Search, jump, or capture…"
        aria-label="Search, jump, or capture"
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls="everywhere-results"
        aria-activedescendant={rows.length > 0 ? `everywhere-row-${sel}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setError(null);
          // a new query is a new list; selection returns to its first row
          setSelId(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            void hideWindow();
          } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
            e.preventDefault();
            selectIdx(Math.min(sel + 1, rows.length - 1));
          } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
            e.preventDefault();
            selectIdx(Math.max(sel - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(selected);
          }
        }}
    />
      {error && <div className="capture-error">couldn’t save — {error}</div>}
      <div
        className="palette-results"
        id="everywhere-results"
        ref={listRef}
        role={rows.length > 0 ? "listbox" : undefined}
        aria-label={rows.length > 0 ? "Everywhere palette results" : undefined}
      >
        {rows.length === 0 && (
          <div className="palette-empty" role="status">Nothing to show yet</div>
        )}
        {rows.map((row, i) => (
          <React.Fragment key={row.id}>
            {/* a heading whenever the section changes, so the three kinds of
                row stay told apart in one flat list */}
            {row.section !== rows[i - 1]?.section && (
              <div className="palette-section">{row.section}</div>
            )}
            <div
              id={`everywhere-row-${i}`}
              className={`palette-item${i === sel ? " selected" : ""}`}
              data-idx={i}
              role="option"
              aria-selected={i === sel}
              // mousemove, not mouseenter: a search batch can land under a
              // resting cursor, and mouseenter would hand selection to
              // whatever slid beneath it
              onMouseMove={() => selectIdx(i)}
              onClick={() => run(row)}
            >
              <span className="palette-item-label">{row.label}</span>
              {row.snippet && <span className="palette-item-snippet">{row.snippet}</span>}
            </div>
          </React.Fragment>
        ))}
      </div>
      <div className="palette-foot">
        <span>
          <span className="key">↑↓</span> navigate
        </span>
        <span>
          <span className="key">↩</span> {foot}
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
    <PaletteApp />
  </React.StrictMode>,
);
