/* The backend refuses a changed `capture-hotkey` setting in two
   ways that used to be silent outside the log file — the chord won't parse,
   or the OS says another app owns it — and in both the OLD chord stays
   registered while the settings form shows the new one. `apply_settings`
   (src-tauri/src/lib.rs) reports both arms as `capture:hotkey-rejected`;
   useVaultEvents turns that event into a one-slot toast via the mapper here.
   The payload shape is pinned by the `hotkey_rejected_payload_shape` test in
   lib.rs — rename keys in lockstep. */

export interface HotkeyRejection {
  /** "invalid" = won't parse; "unavailable" = another app owns the chord */
  kind: string;
  /** the chord Settings.md now names (does nothing) */
  typed: string;
  /** the chord that actually stayed registered ("" when none ever did) */
  active: string;
  /** which global chord this was — absent on payloads from older builds,
      which only ever had the one */
  which?: string;
}

/* global-hotkey's modifier spellings → macOS glyphs, emitted in comboLabel's
   canonical order (shortcuts.ts). Aliases cover what the parser accepts; an
   unknown token anywhere fails the whole format so the caller shows the raw
   chord instead of a mangled half-translation. */
const MOD_GLYPHS: Record<string, string> = {
  meta: "⌘",
  super: "⌘",
  cmd: "⌘",
  command: "⌘",
  win: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};
const MOD_ORDER = ["⌘", "⌃", "⌥", "⇧"];

const KEY_LABELS: Record<string, string> = {
  space: "Space",
  tab: "⇥",
  enter: "↩",
  return: "↩",
  escape: "esc",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Display label for a stored global-hotkey chord ("cmd+shift+j" → "⌘⇧J").
    Anything outside the modifier vocabulary falls back to the raw string —
    a chord the user typed wrong is shown exactly as typed. */
export function hotkeyLabel(chord: string): string {
  const parts = chord.trim().toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (key === "" || mods.some((m) => !(m in MOD_GLYPHS))) return chord;
  const glyphs = MOD_ORDER.filter((g) => mods.some((m) => MOD_GLYPHS[m] === g)).join("");
  const keyLabel =
    KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return glyphs + keyLabel;
}

/** Toast text for a refused capture-hotkey change. The typed chord
    shows as typed when it won't parse, as a label when it reached the OS; the
    chord that actually still fires is always named — the form and the engine
    disagree until the user fixes it, and this is the only place that says so. */
/* One event carries every global chord, so the toast has to name the one it
   is about: a refused voice chord that says "quick capture has no working
   hotkey" points the user at the wrong setting.

   A table rather than a chain of ifs, so a chord held back from the public
   mirror is one strippable row: the lookup itself stays in the shared path and
   reads `which` in every build, which a stripped `if` branch would not
   (TS6133). */
const REJECTED_WORDS: Record<string, { lead: string; none: string }> = {
  capture: { lead: "Hotkey", none: "quick capture has no working hotkey" },
  voice: { lead: "Voice hotkey", none: "voice notes have no working hotkey" },
};

/** An older backend sends no `which` at all, and a chord this build doesn't
    know is not worth a wrong name — both read as quick capture's. */
function rejectedWords(which: string | undefined): { lead: string; none: string } {
  return REJECTED_WORDS[which ?? "capture"] ?? REJECTED_WORDS.capture;
}

export function hotkeyRejectedMessage(p: HotkeyRejection): string {
  const words = rejectedWords(p.which);
  const still =
    p.active.trim() === "" ? words.none : `still using “${hotkeyLabel(p.active)}”`;
  return p.kind === "invalid"
    ? `${words.lead} “${p.typed}” isn’t valid — ${still}.`
    : `${words.lead} “${hotkeyLabel(p.typed)}” is taken by another app — ${still}.`;
}
