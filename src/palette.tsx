import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIndexReveal } from "./hooks/useIndexReveal";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { invoke, listen } from "./lib/tauri";
import {
  paletteOpenNote,
  paletteOpenView,
  paletteSeedQuery,
  urlCaptureGated,
  vaultList,
  vaultSearch,
} from "./lib/ipc";
import { CAPTURE_ROW_ID, everywhereRows, type EverywhereRow } from "./lib/everywhere";
import { createLatestGuard } from "./lib/latest";
import { foldedPropStr, type NoteMeta, type SearchHit } from "./lib/types";
import { looksLikeUrl } from "./lib/url";
import { errText } from "./lib/errtext";
import { whenVaultReady } from "./lib/vaultReady";
import {
  contextChipIcon,
  contextChipLabel,
  contextProps,
  type CaptureContext,
} from "./lib/capturecontext";

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

export function PaletteApp() {
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  // the query the hits answer, so a stale batch never renders under a newer
  // query — the ⌘K palette's `hitsQuery` rule
  const [hitsQuery, setHitsQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  /* A capture is in flight. Filing waits for the vault index, a wait that can
     run to the gate's ceiling on a cold launch — and every Enter pressed
     meanwhile would queue its own capture and file them all together when the
     index lands: N identical Inbox notes from one typed line. */
  const [filing, setFiling] = useState(false);
  // selection follows the row's ID, not its slot: a search batch lands under
  // the cursor while the user is typing, and an index would silently move the
  // highlight onto a different note
  const [selId, setSelId] = useState<string | null>(null);
  /** The snapshot Rust armed for this summon, or null when the feature is off
      — the backend answers `context_pending` with null and nothing renders. */
  const [ctx, setCtx] = useState<CaptureContext | null>(null);
  /** Backspace on an empty box drops the chip, exactly as in quick capture:
      one keystroke, no click target, and it lasts until the next summon. */
  const [ctxDropped, setCtxDropped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchGuard = useMemo(() => createLatestGuard(), []);
  // The note list is refreshed from two places that can overlap — every
  // re-show of the window and every `vault:changed` — and the command is
  // async, so two lists in flight can come back in either order and the
  // older one would paint the vault as it was before the change.
  const listGuard = useMemo(() => createLatestGuard(), []);

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
    const id = listGuard.issue();
    vaultList()
      .then((n) => {
        if (listGuard.isLatest(id)) setNotes(n);
      })
      .catch(console.error);
  }, [listGuard]);

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
    // Same non-consuming pull quick capture does, for the same reason: this
    // reset runs more than once per summon. The slot is armed Rust-side just
    // before the window is shown and re-armed (or cleared) on the next summon.
    setCtxDropped(false);
    invoke<CaptureContext | null>("context_pending")
      .then((c) => setCtx(c && c.app ? c : null))
      .catch(() => setCtx(null));
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
      // cancel anything still in flight: a response landing after unmount
      // would otherwise call a setter on an unmounted component
      searchGuard.issue();
      listGuard.issue();
    };
  }, [reset, reload, searchGuard, listGuard]);

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

  useIndexReveal(listRef, sel, [sel, rows]);

  /* The chip shows for the capture this window can actually attach it to: a
     pasted link files through `url_capture`, which carries no props, so the
     chip steps aside there rather than promising context the note won't get. */
  const chip = ctx && !ctxDropped && !looksLikeUrl(q.trim()) ? ctx : null;

  const capture = async (text: string) => {
    if (filing) return;
    setError(null);
    // this window is created hidden at startup, so a summon during the launch
    // scan would park the main thread for the rest of it. Wait for the index
    // rather than freeze the app — the text stays in the box meanwhile.
    setFiling(true);
    try {
      await whenVaultReady();
      // a pasted link becomes a reference note, exactly as in quick capture
      if (looksLikeUrl(text)) await urlCaptureGated(text);
      else
        await invoke("vault_create", {
          title: text,
          folder: "Inbox",
          // attached unless it was dropped; flat `context-*` frontmatter, the
          // same keys however the note was captured
          props: chip ? contextProps(chip) : null,
        });
    } catch (e) {
      // never discard what the user typed: it stays in the box so Enter
      // retries or the text can be copied out
      setError(errText(e));
      return;
    } finally {
      setFiling(false);
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
      ? // the row is the only place a wait on the index shows: the text stays
        // in the box, so without this Enter reads as having done nothing
        filing
        ? "filing…"
        : looksLikeUrl(q.trim())
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
          // Backspace with nothing to delete can only mean the chip: there is
          // no text left for it to act on.
          else if (e.key === "Backspace" && q === "" && chip) {
            e.preventDefault();
            setCtxDropped(true);
          }
        }}
    />
      {chip && (
        <div className="capture-context" data-testid="palette-context-chip">
          <span aria-hidden="true" className="capture-context-mark">
            {contextChipIcon(chip)}
          </span>
          <span className="capture-context-label">{contextChipLabel(chip)}</span>
        </div>
      )}
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
        {chip && (
          <span>
            <span className="key">⌫</span> drop context
          </span>
        )}
        <span>
          <span className="key">esc</span> close
        </span>
      </div>
    </div>
  );
}

// Only when this bundle is the window’s entry point — the component test
// imports the same module to render `PaletteApp` into a root of its own.
const rootEl = document.getElementById("root");
if (rootEl)
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <PaletteApp />
    </React.StrictMode>,
  );
