import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardIcon } from "./Icons";
import { hintEntries, keyCaps, type ShortcutCtx } from "../lib/shortcuts";
import { getQueue } from "../lib/playqueue";
import { isTypingNow } from "../lib/dom";
import type { NoteMeta, View } from "../lib/types";

/** The one keyboard affordance: a note-tool-weight button parked at
    the app's fixed chrome slot on every desktop view, folding out the keys
    live in the CURRENT view — pane-owned surfaces (calendar, database grid,
    sheet) included, straight from the registry's `hint` gates. The panel foot
    opens the full ⌘/ sheet, so NotePane no longer carries its own kbd button.
    Expanded state persists per window (localStorage, the sidebar-collapse
    idiom). Desktop only — App gates the mount on !mobile. */
export default function KeyHints({
  view,
  selectedMeta,
  dbNote,
  daily,
  pins,
  canGoBack,
  sheetOpen,
  onShowSheet,
  children,
  canUndo,
  canRedo,
}: {
  view: View;
  selectedMeta: NoteMeta | null;
  dbNote: string | null;
  daily: string | null;
  pins: string[];
  canGoBack: boolean;
  sheetOpen: boolean;
  onShowSheet: () => void;
  /** The hold-⌘ HUD, which hangs off this wrapper's anchor. It is
      passed in rather than imported so this component keeps owning only one
      thing — where the shortcut affordances sit in the chrome. */
  children?: ReactNode;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem("substrate.keyHints") === "1");
  const [closing, setClosing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const persist = (next: boolean) => localStorage.setItem("substrate.keyHints", next ? "1" : "0");

  const close = useCallback(() => {
    persist(false);
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 90);
  }, []);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // outside click and Esc close. The panel owns no keys, so Esc rides the
  // bubble phase — whatever else listens (a grid's focus-clear, the sheet)
  // still fires
  useEffect(() => {
    if (!open || closing) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closing, close]);

  // Whether the caret is in a text edit decides which surface rows are
  // honest, and focus moves under an open panel (⌘D opens the journal editor
  // without a click, which is what would have closed it) — so this is live
  // state, re-read on open and on every focus change while open, not a
  // snapshot. Clicking the chip itself focuses the button: not typing, and
  // truthfully so, since the chords then really do fire.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!open || closing) return;
    const sync = () => setTyping(isTypingNow());
    sync();
    // focusout fires before the new focus lands, so answer on the next tick
    let pending = 0;
    const later = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(sync, 0);
    };
    window.addEventListener("focusin", sync);
    window.addEventListener("focusout", later);
    return () => {
      window.clearTimeout(pending);
      window.removeEventListener("focusin", sync);
      window.removeEventListener("focusout", later);
    };
  }, [open, closing]);

  // the panel advertises the surface underneath it: no overlay, sheet closed
  const ctx: ShortcutCtx = {
    view,
    overlay: null,
    shortcutsOpen: false,
    settingsOpen: false,
    typing,
    selectedMeta,
    dbNote,
    daily,
    pins,
    // the panel lists registry entries, and custom keys are unlisted
    customKeys: {},
    searchReturn: false,
    canGoBack,
    sheetOpen,
    // the hint panel never renders over a dashboard pane, so the workbook
    // chord stays out of the baseline advertisement
    workbookOpen: false,
    dashCanUndo: false,
    dashCanRedo: false,
    canUndo,
    canRedo,
    // The transport chords are live whenever a folder is queued,
    // and the panel describes the surface underneath it — the bar is chrome
    // above every surface, so read the queue directly rather than threading
    // one more prop through App
    playing: getQueue() !== null,
  };
  // context rows first — the panel is about THIS surface; the always-live
  // globals fill what remains of the 12 rows
  const entries = hintEntries(ctx);
  const rows = [...entries.filter((s) => s.hint), ...entries.filter((s) => !s.hint)].slice(0, 12);

  return (
    <div className="keyhints" ref={wrapRef}>
      <button
        className={`keyhints-chip${open ? " active" : ""}`}
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        onClick={() => {
          window.clearTimeout(closeTimer.current);
          if (open) close();
          else {
            setClosing(false);
            setOpen(true);
            persist(true);
          }
        }}
      >
        <KeyboardIcon />
      </button>
      {open && (
        <div className={`keyhints-panel${closing ? " closing" : ""}`}>
          {rows.map((s) => (
            <div className="shortcut-row" key={s.id}>
              <span className="shortcut-row-label">{s.description}</span>
              <span className="shortcut-row-keys">
                {keyCaps(s.combos).map((cap) => (
                  <span className="key" key={cap}>
                    {cap}
                  </span>
                ))}
              </span>
            </div>
          ))}
          {/* the panel's one way out to the complete registry — closing first
              keeps the sheet's Esc from having to unwind two layers */}
          <button
            className="keyhints-foot"
            onClick={() => {
              close();
              onShowSheet();
            }}
          >
            <span>
              <span className="key">⌘/</span> all shortcuts
            </span>
          </button>
        </div>
      )}
      {/* the hold HUD shares this anchor, but never the screen: an open click
          panel means the user is already reading the same rows */}
      {!open && children}
    </div>
  );
}
