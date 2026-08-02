import { useEffect, useRef, useState } from "react";
import { comboLabel, modEntries, type HeldMods, type ShortcutCtx } from "../lib/shortcuts";
import { isTypingNow } from "../lib/dom";

/** Hold-modifier HUD (SUB-490): hold ⌘ (alone or with ⇧, or ⌃) for a beat and
    a small panel unfolds under the chrome's shortcut button listing exactly
    the chords that would fire right now. Release and it is gone.

    Held modifiers are a chord, not a filter — see `comboUnderMods`: holding ⌘
    advertises ⌘K but not ⌘⇧F, because pressing K right now fires and pressing
    F does not. The ⌘1–9 view jumps are omitted (`HUD_OMIT`); they are the
    shortcuts everyone already knows and nine numbered rows would swamp a panel
    whose whole job is staying small.

    Timing is the design. A typed chord's modifier→key gap is well under 250ms
    for anyone who knows the shortcut, so the reveal waits ARM_MS and any
    non-modifier keydown cancels it: ⌘S never flashes a panel. ARM_MS sits at
    that gap's edge rather than safely above it (400 read as lag —
    2026-07-29, SUB-582); a slow chord occasionally flashing the panel is the
    accepted cost. Release is a
    dismissal, not a transition — the panel unmounts instantly, because a
    fade-out after keyup reads as lag. Same reason a completed chord kills it
    mid-hold: its job is done.

    Bare ⇧ is deliberately not a trigger. It is the contaminated modifier —
    held through every capital letter — and the registry has no ⇧-only entry to
    show, so a ⇧ hold would open an empty box. ⇧ still matters *with* ⌘.

    Off switch: `mod-hud` in Settings.md, default on. Desktop only (App gates
    the mount on !mobile), and never while an overlay or the settings pane is
    up — those own the keyboard. */

/** how long a modifier must be held before the panel appears */
const ARM_MS = 250;

/** the panel is a glance surface: past this it stops being glanceable, and
    the ⌘/ sheet is the right tool. Ordered context-first, so a truncated
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

/** The HUD answers `typing` itself (SUB-498): App builds its context from
    render state, but whether the caret sits in a text edit is only knowable at
    the moment the hold arms — so the prop deliberately omits it and this
    component reads the live focus. Leaving it in the prop invited the stale
    `typing: false` that advertised ⌘⌫ / ⌘[ mid-edit in the first place. */
export type ModKeyHudCtx = Omit<ShortcutCtx, "typing">;

export default function ModKeyHud({ ctx, enabled }: { ctx: ModKeyHudCtx; enabled: boolean }) {
  /** the chord to render, or null for "no panel". Set only by the arm timer,
      so the panel's existence already means the hold outlasted ARM_MS. */
  const [held, setHeld] = useState<HeldMods | null>(null);
  /** focus as it stood when the hold armed. Read then rather than at render:
      the panel opens off a key event, and the modifier hold itself never moves
      focus, so the arm moment is exactly when the row list is decided. */
  const [typing, setTyping] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  /** modifiers seen down right now, whether or not the panel is up yet: a
      second modifier arriving mid-hold has to swap content without waiting
      for a fresh hold, and must not restart the timer */
  const pending = useRef<HeldMods | null>(null);

  useEffect(() => {
    const disarm = () => {
      window.clearTimeout(timer.current);
      pending.current = null;
      setHeld(null);
    };
    /** show the panel for this chord, sampling focus as we go (SUB-498) */
    const reveal = (mods: HeldMods | null) => {
      setTyping(isTypingNow());
      setHeld(mods);
    };

    if (!enabled) {
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
  }, [enabled, held]);

  // an overlay or the settings pane owns the keyboard; its own chords are not
  // what this panel lists, and it would render over the wrong surface
  const suppressed = ctx.overlay !== null || ctx.shortcutsOpen || ctx.settingsOpen;
  useEffect(() => {
    if (suppressed) setHeld(null);
  }, [suppressed]);

  if (!enabled || suppressed || !held) return null;
  const rows = modEntries({ ...ctx, typing }, held).slice(0, MAX_ROWS);
  // nothing live under this chord: show nothing rather than an empty frame
  if (rows.length === 0) return null;

  return (
    <div className="modkey-hud" role="presentation" aria-hidden="true">
      <div className="modkey-hud-head">{chordLabel(held)}</div>
      <div className="modkey-hud-rows">
        {rows.map((s) => (
          <div className="modkey-hud-row" key={s.id}>
            <span className="modkey-hud-row-label">{s.description}</span>
            <span className="modkey-hud-row-keys">
              {s.combos.map((c) => (
                <span className="key" key={comboLabel(c)}>
                  {comboLabel(c)}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
