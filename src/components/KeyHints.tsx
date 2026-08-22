import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardIcon } from "./Icons";
import { hintEntries, keyCaps, modEntries, type HeldMods, type ShortcutCtx } from "../lib/shortcuts";
import { getQueue } from "../lib/playqueue";
import { isTypingNow } from "../lib/dom";
import type { NoteMeta, View } from "../lib/types";

/** how long a modifier must be held before the hold panel appears */
const ARM_MS = 250;

/** the hold panel is a glance surface: past this it stops being glanceable,
    and the ⌘/ sheet is the right tool. Ordered context-first, so a truncated
    tail drops always-live globals the user meets constantly anyway. */
const MAX_ROWS = 12;

function readMods(e: KeyboardEvent): HeldMods {
  return { mod: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey };
}

/** ⌘ is the trigger — alone, or with ⇧ / ⌃. ⌃ alone also qualifies: it owns
    the workbook page chords. ⇧ alone does not (see the docstring). */
function isTrigger(m: HeldMods): boolean {
  return m.mod || m.ctrl;
}

function sameMods(a: HeldMods, b: HeldMods): boolean {
  return a.mod === b.mod && a.ctrl === b.ctrl && a.shift === b.shift;
}

/** the chord as the user is holding it, in the row glyphs' own language */
function chordLabel(m: HeldMods): string {
  return `${m.ctrl ? "⌃" : ""}${m.shift ? "⇧" : ""}${m.mod ? "⌘" : ""}`;
}

/** The hold panel answers `typing` itself: App builds its context from
    render state, but whether the caret sits in a text edit is only knowable at
    the moment the hold arms — so the prop deliberately omits it and this
    component reads the live focus. Leaving it in the prop invited the stale
    `typing: false` that advertised ⌘⌫ / ⌘[ mid-edit in the first place. */
export type HoldHudCtx = Omit<ShortcutCtx, "typing">;

/** The one keyboard affordance: a note-tool-weight button parked at
    the app's fixed chrome slot on every desktop view, with two ways in.

    CLICK folds out the keys live in the CURRENT view — pane-owned surfaces
    (calendar, database grid, sheet) included, straight from the registry's
    `hint` gates. The panel foot opens the full ⌘/ sheet, so NotePane no longer
    carries its own kbd button. Expanded state persists per window
    (localStorage, the sidebar-collapse idiom). Desktop only — App gates the
    mount on !mobile.

    HOLD ⌘ (alone or with ⇧, or ⌃) for a beat and a small panel unfolds under
    the same button listing exactly the chords that would fire right now.
    Release and it is gone. The two panels share the anchor but never the
    screen: an open click panel means the user is already reading the same
    rows, so the hold trigger stands down entirely while it is up.

    Held modifiers are a chord, not a filter — see `comboUnderMods`: holding ⌘
    advertises ⌘K but not ⌘⇧F, because pressing K right now fires and pressing
    F does not. The ⌘1–9 view jumps are omitted (`HUD_OMIT`); they are the
    shortcuts everyone already knows and nine numbered rows would swamp a panel
    whose whole job is staying small.

    Timing is the design. A typed chord's modifier→key gap is well under 250ms
    for anyone who knows the shortcut, so the reveal waits ARM_MS and any
    non-modifier keydown cancels it: ⌘S never flashes a panel. ARM_MS sits at
    that gap's edge rather than safely above it (400 read as lag —
    2026-07-29); a slow chord occasionally flashing the panel is the
    accepted cost. Release is a dismissal, not a transition — the panel goes
    instantly, because a fade-out after keyup reads as lag. Same reason a
    completed chord kills it mid-hold: its job is done.

    Bare ⇧ is deliberately not a trigger. It is the contaminated modifier —
    held through every capital letter — and the registry has no ⇧-only entry to
    show, so a ⇧ hold would open an empty box. ⇧ still matters *with* ⌘.

    Hold off switch: `mod-hud` in Settings.md, default on. The hold never fires
    while an overlay or the settings pane is up — those own the keyboard. */
export default function KeyHints({
  view,
  selectedMeta,
  dbNote,
  daily,
  pins,
  canGoBack,
  sheetOpen,
  onShowSheet,
  hudEnabled,
  hudCtx,
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
  /** the `mod-hud` setting — it governs the hold trigger only */
  hudEnabled: boolean;
  /** what is live right now, for the hold panel's rows. The click panel builds
      its own context from the props above: it advertises the surface it sits
      over, which is not the same question. */
  hudCtx: HoldHudCtx;
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

  /** the chord the hold panel renders, or null for "no hold panel". Set only
      by the arm timer, so its existence already means the hold outlasted
      ARM_MS. */
  const [held, setHeld] = useState<HeldMods | null>(null);
  /** focus as it stood when the hold armed. Read then rather than at render:
      the panel opens off a key event, and the modifier hold itself never moves
      focus, so the arm moment is exactly when the row list is decided. */
  const [holdTyping, setHoldTyping] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  /** modifiers seen down right now, whether or not the panel is up yet: a
      second modifier arriving mid-hold has to swap content without waiting
      for a fresh hold, and must not restart the timer */
  const pending = useRef<HeldMods | null>(null);
  /** the click panel wins the anchor outright: while it is up (its closing
      animation included) the hold listeners are gone, not merely hidden */
  const holdLive = hudEnabled && !open;

  useEffect(() => {
    const disarm = () => {
      window.clearTimeout(timer.current);
      pending.current = null;
      setHeld(null);
    };
    /** show the panel for this chord, sampling focus as we go */
    const reveal = (mods: HeldMods | null) => {
      setHoldTyping(isTypingNow());
      setHeld(mods);
    };

    if (!holdLive) {
      disarm();
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const mods = readMods(e);
      const modifierKey =
        e.key === "Meta" || e.key === "Shift" || e.key === "Control" || e.key === "Alt";
      // a real key under the modifiers means a chord is being TYPED, not read.
      // Cancel whether or not the panel is up — mid-hold completion included,
      // since the panel has served its purpose the moment the key lands.
      if (!modifierKey) {
        disarm();
        return;
      }
      // ⌥ is not in any registry combo, so holding it has nothing to say
      if (e.altKey || !isTrigger(mods)) {
        disarm();
        return;
      }
      if (pending.current && sameMods(pending.current, mods)) return; // key repeat
      pending.current = mods;
      // already open: swap content instantly. The hold began at the first
      // modifier, so ⌘-then-⇧ must not buy itself another ARM_MS.
      if (held) {
        reveal(mods);
        return;
      }
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => reveal(pending.current), ARM_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const mods = readMods(e);
      if (!isTrigger(mods) || e.altKey) {
        disarm();
        return;
      }
      // dropped ⇧ but kept ⌘: narrow, don't dismiss
      pending.current = mods;
      if (held) reveal(mods);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // a click means the user is working with the pointer, and ⌘-drag /
    // ⌘-click gestures hold a modifier the whole time. Blur matters most:
    // ⌘⇥ away leaves no keyup behind, so without this the panel would strand.
    window.addEventListener("pointerdown", disarm);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", disarm);
      window.removeEventListener("blur", disarm);
      window.clearTimeout(timer.current);
    };
  }, [holdLive, held]);

  // an overlay or the settings pane owns the keyboard; its own chords are not
  // what the hold panel lists, and it would render over the wrong surface
  const suppressed = hudCtx.overlay !== null || hudCtx.shortcutsOpen || hudCtx.settingsOpen;
  useEffect(() => {
    if (suppressed) setHeld(null);
  }, [suppressed]);

  // the click panel advertises the surface underneath it: no overlay, sheet closed
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

  const holdRows =
    holdLive && !suppressed && held
      ? modEntries({ ...hudCtx, typing: holdTyping }, held).slice(0, MAX_ROWS)
      : [];

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
      {/* nothing live under this chord: show nothing rather than an empty frame */}
      {held !== null && holdRows.length > 0 && (
        <div className="modkey-hud" role="presentation" aria-hidden="true">
          <div className="modkey-hud-head">{chordLabel(held)}</div>
          <div className="modkey-hud-rows">
            {holdRows.map((s) => (
              <div className="modkey-hud-row" key={s.id}>
                <span className="modkey-hud-row-label">{s.description}</span>
                <span className="modkey-hud-row-keys">
                  {keyCaps(s.combos).map((cap) => (
                    <span className="key" key={cap}>
                      {cap}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
