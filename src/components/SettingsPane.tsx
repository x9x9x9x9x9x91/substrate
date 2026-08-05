/* Settings overlay (⌘, — SUB-398): a small form over the vault's Settings.md.
   The note stays the source of truth (plain markdown, hot-reloaded by the
   backend watcher within a second of any save), this pane is just a typed
   front door: read props on open, write each field back on commit via the
   same vault_set_prop IPC every prop editor uses. "Edit raw" opens the note
   in the normal editor for anything beyond the known keys. */

import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { onboardingStatus, vaultRead } from "../lib/ipc";
import { normalizeNumberInput } from "../lib/aggregate";
import { setPropUndoable } from "../lib/undoprops";
import { useEdgeFade } from "../hooks/useEdgeFade";
import { useUndo } from "../lib/undoContext";
import {
  missingTerminalFonts,
  SETTINGS_PATH,
  terminalActionsToText,
  textToTerminalActions,
  WINDOW_OPACITY_DEFAULT,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
} from "../lib/settings";
import { applyWindowOpacity, vibrancyCapable } from "../lib/vibrancy";
import type { TerminalFontProblems } from "../lib/settings";
import { foldedPropKey } from "../lib/types";
import { isTauri } from "../lib/tauri";
import {
  TERMINAL_HEIGHT_MAX,
  TERMINAL_HEIGHT_MIN,
  TERMINAL_WIDTH_MAX,
  TERMINAL_WIDTH_MIN,
} from "../lib/termdock";
import {
  appearancePreviewSeq,
  previewAppearance,
  reconcileAppearance,
  DEFAULT_GLOW,
  DEFAULT_NUDGE,
  DEFAULT_TONE,
  GLOW_MAX,
  GLOW_MIN,
  NUDGE_MAX,
  TONES,
  type ToneId,
} from "../lib/appearance";
import type { OnboardingStatus } from "../lib/onboarding";
import { HOSTED_HANDOFF_RELAY_URL } from "../lib/handoff";

const Onboarding = lazy(() => import("./Onboarding"));

interface SettingsPaneProps {
  onClose: () => void;
  onEditRaw: () => void;
  /** Re-read render settings after a write or inverse so an open terminal
      follows this sheet instead of waiting for its next summon. */
  onSettingsChanged: () => void | Promise<void>;
  onToast: (msg: string) => void;
}

interface Field {
  key: string;
  label: string;
  hint: string;
  placeholder?: string;
  kind: "text" | "bool" | "multiline" | "select" | "slider" | "chips" | "choice";
  /** fields that only exist on one platform; hidden elsewhere rather than
      shown inert, so the sheet never offers a control that does nothing */
  only?: "macos";
  /** bool fields only: an unset key reads as ON (e.g. `drop-hint`) */
  defaultOn?: boolean;
  /** select and chips fields: the choices. For a select the FIRST option is
      what an unset key means; chips name their default explicitly. */
  options?: { value: string; label: string }[];
  /** chips fields only: the option an unset key reads as, and the one that
      clears the key rather than writing it back */
  defaultChip?: string;
  /** text fields only: an inclusive numeric range the value must fall in */
  range?: { min: number; max: number };
  /** slider fields only (SUB-955): the dial's bounds and the value that
      means "unset" — landing on it clears the key instead of writing it */
  slider?: { min: number; max: number; step: number; default: number };
  /** slider fields only: how the live number reads next to the track */
  format?: (n: number) => string;
  /** text fields only: render as a password input (shoulder-surfing guard —
      the value still lives in Settings.md as plain frontmatter) */
  masked?: boolean;
  /** choice fields only: the two options, first one the default an unset key
      reads as (SUB-834) */
  choices?: { value: string; label: string }[];
  /** heading this field opens (rendered above its row) — the list is flat and
      ordered, so a section runs until the next field that starts one */
  section?: string;
}

/* SUB-873: a `terminal-font` the machine can't resolve looks like the setting
   simply doesn't work — xterm falls back to the app's mono with no sign.

   NOT `document.fonts.check`: that answers "can this text be rendered", and
   fallback means it can, so it returns true for every family name including
   nonsense ones (measured in this app's own webview). The one thing the
   platform will tell us is metrics — render a probe string in `family, base`
   and in `base` alone, and if the family is installed the width moves. Three
   bases, because a real font can happen to match one of them; installed means
   differing from ANY of them.

   False "not found" envelope, both quiet: a font metrically identical to mono
   AND sans AND serif, and a font with no Latin coverage at all (CJK, symbol
   and icon families render the probe string from the fallback, so the widths
   never move). Which is why this line is a hint and not an error state.

   The measurement is also platform-dependent — CoreText drops an unknown
   family from the list, fontconfig substitutes one — so the e2e can't assert
   a nonsense name here. `__mockFontAvailable` is the seam it stubs; the
   shipped app never has it and measures exactly as before. */
const FONT_PROBE = "mmmmmwwwwwiiiii0123456789";
const FONT_BASES = ["monospace", "sans-serif", "serif"];

/** measured families, keyed by name — the debounce re-runs the whole chain on
    every settled keystroke and each miss costs 3 canvases × 6 measureText */
const fontSeen = new Map<string, boolean>();

function fontAvailable(family: string): boolean {
  const stub = isTauri ? undefined : window.__mockFontAvailable;
  if (stub) return stub(family);
  const hit = fontSeen.get(family);
  if (hit !== undefined) return hit;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true; // no canvas → can't tell; never cry wolf
  const ok = FONT_BASES.some((base) => {
    ctx.font = `72px ${base}`;
    const plain = ctx.measureText(FONT_PROBE).width;
    ctx.font = `72px "${family}", ${base}`;
    return ctx.measureText(FONT_PROBE).width !== plain;
  });
  fontSeen.set(family, ok);
  return ok;
}

/** current state of a bool field, honoring its default when unset */
function boolOn(f: Field, raw: string): boolean {
  return raw === "" ? !!f.defaultOn : raw === "true";
}

function fieldText(f: Field, raw: unknown): string {
  if (f.key === "share-relay-url") {
    if (raw === undefined || raw === null) return HOSTED_HANDOFF_RELAY_URL;
    if (String(raw).trim().toLowerCase() === "off") return "";
  }
  if (f.kind === "multiline") return terminalActionsToText(raw);
  if (raw === undefined || raw === null) return "";
  return typeof raw === "boolean" ? String(raw) : String(raw).trim();
}

/** where a slider sits: an unset, blank or unparseable value reads as the
    field's default, and anything outside the bounds is clamped into them —
    the same "a typo degrades to the default" posture the parsers take */
function sliderValue(f: Field, raw: string): number {
  const s = f.slider!;
  const n = Number.parseFloat((raw ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n)) return s.default;
  return Math.min(s.max, Math.max(s.min, Math.round(n / s.step) * s.step));
}

/** which chip a chips field is on, folding an unknown value to the default */
function chipValue(f: Field, raw: string): string {
  const want = (raw ?? "").trim().toLowerCase();
  return f.options?.find((o) => o.value === want)?.value ?? f.defaultChip ?? "";
}

/** which option a select field is on: an unset key — or a value the note
    carries that isn't one of the choices — reads as the first option, which
    is the same fallback the parser applies (`parseTerminalDock`) */
function selectValue(f: Field, raw: string): string {
  const opts = f.options ?? [];
  const hit = opts.find((o) => o.value === raw.trim().toLowerCase());
  return hit?.value ?? opts[0]?.value ?? "";
}

/** current option of a choice field: an unset or unrecognized value reads as
    the first choice, matching how the parsers in `lib/settings.ts` default */
function choiceValue(f: Field, raw: string): string {
  const choices = f.choices ?? [];
  return choices.some((c) => c.value === raw) ? raw : (choices[0]?.value ?? "");
}

const FIELDS: Field[] = [
  {
    key: "capture-hotkey",
    label: "Quick-capture hotkey",
    hint: "global shortcut for the floating capture window, works from any app",
    placeholder: "alt+space",
    kind: "text",
  },
  {
    key: "close-to-tray",
    label: "Close to menu bar",
    hint: "closing the window keeps Substrate running in the tray",
    kind: "bool",
  },
  {
    key: "drop-hint",
    label: "Drag-and-drop hint",
    hint: "while dragging a file over a note, show the copy-vs-⇧-link hint",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "mod-hud",
    label: "Hold-⌘ shortcut HUD",
    hint: "holding ⌘ (alone or with ⇧) folds out the shortcuts it can fire right now",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "db-grid",
    label: "Table grid lines",
    hint: "vertical lines between database table columns; each database can override this in its ⋯ menu",
    kind: "bool",
    defaultOn: true,
  },
  /* Appearance (SUB-955) — the two dials that move the look without moving
     the layout. Both default to the shipped picture: glow 0, tone sky. */
  {
    key: "glow",
    label: "Glow",
    hint: "bloom on dashboard chart strokes, dots and emphasised values; bars join above 70. 0 is the shipped look",
    kind: "slider",
    slider: { min: GLOW_MIN, max: GLOW_MAX, step: 1, default: DEFAULT_GLOW },
    format: (n) => (n === 0 ? "off" : String(n)),
  },
  {
    key: "accent-tone",
    label: "Accent tone",
    hint: "the hue every dashboard mark wears; state colours never move with it",
    kind: "chips",
    defaultChip: DEFAULT_TONE,
    options: TONES.map((t) => ({ value: t.id, label: t.label })),
  },
  {
    key: "accent-tone-nudge",
    label: "Tone fine-tune",
    hint: "shifts the chosen tone a few degrees; bounded so every mark stays legible on screen and on paper",
    kind: "slider",
    slider: { min: -NUDGE_MAX, max: NUDGE_MAX, step: 1, default: DEFAULT_NUDGE },
    format: (n) => (n === 0 ? "0°" : `${n > 0 ? "+" : ""}${n}°`),
  },
  /* SUB-951: the third look dial, and the only one that reaches outside the
     window — so it rides the same slider chrome but is hidden where the OS
     can't do it, rather than shown inert. */
  {
    key: "window-opacity",
    label: "Window opacity",
    hint: "how solid the window is over your desktop — the wallpaper shows through, blurred by macOS; 100% is fully solid",
    kind: "slider",
    slider: {
      min: WINDOW_OPACITY_MIN,
      max: WINDOW_OPACITY_MAX,
      step: 1,
      default: WINDOW_OPACITY_DEFAULT,
    },
    format: (n) => `${n}%`,
    only: "macos",
  },
  {
    key: "show-agent-files",
    label: "Show app files",
    hint: "list AGENTS.md, CLAUDE.md and Settings.md — the notes the app itself seeds and reads — in notes and search; they stay on disk either way, and “edit raw” below always opens Settings.md",
    kind: "bool",
  },
  {
    key: "terminal-command",
    label: "Terminal command",
    hint: "what the ⌘⇧T terminal runs on start — your agent CLI (claude, codex, pi…); empty = plain shell",
    placeholder: "claude",
    kind: "text",
  },
  {
    key: "terminal-cwd",
    label: "Terminal folder",
    hint: "working directory the terminal starts in; empty = the vault folder",
    placeholder: "~/Notes/side-vault",
    kind: "text",
  },
  {
    key: "terminal-font",
    label: "Terminal font",
    hint: "font family for the ⌘⇧T terminal — set your nerd font here so powerline and prompt glyphs render; empty = the app's mono",
    placeholder: "JetBrainsMono Nerd Font",
    kind: "text",
  },
  {
    key: "terminal-dock",
    label: "Terminal position",
    hint: "which edge the ⌘⇧T terminal slides in from; drag its inner edge to resize either way",
    kind: "select",
    options: [
      { value: "bottom", label: "Bottom" },
      { value: "right", label: "Right" },
    ],
  },
  {
    key: "terminal-height",
    label: "Terminal height",
    hint: "fraction of the window the terminal covers when docked to the bottom (0.2–0.9)",
    placeholder: "0.45",
    kind: "text",
    range: { min: TERMINAL_HEIGHT_MIN, max: TERMINAL_HEIGHT_MAX },
  },
  {
    key: "terminal-width",
    label: "Terminal width",
    hint: "fraction of the window the terminal covers when docked to the right (0.2–0.7)",
    placeholder: "0.38",
    kind: "text",
    range: { min: TERMINAL_WIDTH_MIN, max: TERMINAL_WIDTH_MAX },
  },
  {
    key: "terminal-actions",
    label: "Terminal quick actions",
    hint: "one `Label: command` per line — each becomes a ⌘K palette action that types its command into the terminal",
    placeholder: "Sweep inbox: /inbox-sweep",
    kind: "multiline",
  },
  {
    key: "number-format",
    label: "Number format",
    hint: "how numbers are written in tables, calc lines and totals",
    kind: "choice",
    choices: [
      { value: "de", label: "1.234,56" },
      { value: "intl", label: "1,234.56" },
    ],
  },
  /* SUB-834: the three requests that leave this machine, each with its own
     switch. Grouped under one heading so the answer to "what does this app
     talk to?" is a single place in the UI, not three settings apart. */
  {
    key: "net-link-titles",
    label: "Fetch link titles",
    hint: "pasting a URL asks that site for its page title",
    kind: "bool",
    defaultOn: true,
    section: "Outbound requests",
  },
  {
    key: "net-fx-rates",
    label: "Currency rates",
    hint: "fetches exchange rates from frankfurter.dev; off = conversions use the last saved rates and show their date",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "net-share-relay",
    label: "Send as link",
    hint: "uploads the encrypted note to your share relay; off hides the Send-as-link action",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "share-relay-url",
    label: "Share relay URL",
    hint: "where “Send as link” parks the encrypted copy — the relay only ever sees ciphertext; self-host one with scripts/handoff-relay",
    placeholder: "https://drop.example.org",
    kind: "text",
  },
  {
    key: "share-relay-token",
    label: "Share relay token",
    hint: "only if your relay requires a token for uploads (HANDOFF_TOKEN); recipients never need it — stored as plain text in Settings.md",
    kind: "text",
    masked: true,
  },
];

const field = (key: string): Field => FIELDS.find((f) => f.key === key)!;
const GLOW_FIELD = field("glow");
const TONE_FIELD = field("accent-tone");
const NUDGE_FIELD = field("accent-tone-nudge");
const WINDOW_OPACITY_FIELD = field("window-opacity");

/** What the three appearance keys currently in the form add up to. The pane
    previews through this rather than through the saved note, so dragging a
    dial repaints the app under the sheet before anything is written
    (SUB-955); App re-applies the committed truth on the next vault epoch. */
function appearanceOf(v: Record<string, string>) {
  return {
    glow: sliderValue(GLOW_FIELD, v[GLOW_FIELD.key] ?? ""),
    tone: chipValue(TONE_FIELD, v[TONE_FIELD.key] ?? "") as ToneId,
    nudge: sliderValue(NUDGE_FIELD, v[NUDGE_FIELD.key] ?? ""),
  };
}

export default function SettingsPane({
  onClose,
  onEditRaw,
  onSettingsChanged,
  onToast,
}: SettingsPaneProps) {
  const undo = useUndo();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  /** what `values` holds right now, readable from a handler that must not be
      re-created on every drag step. The appearance dials repaint OUTSIDE their
      state updater (SUB-1122) — see `slide` — and still need the current
      sheet, including fields the user edited while a write was in flight. */
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState(false);
  const [missing, setMissing] = useState(false);
  const mountedRef = useRef(true);
  /** which vault is open + where the choice lives; null while it loads or on
      a backend too old to answer, in which case the row simply stays hidden */
  const [vault, setVault] = useState<OnboardingStatus | null>(null);
  const [switching, setSwitching] = useState(false);
  /** families in the current `terminal-font` that won't take effect (SUB-873),
      settled a beat after the last keystroke so half-typed names don't flash a
      warning at someone who is still spelling one correctly */
  const [badFonts, setBadFonts] = useState<TerminalFontProblems>({
    missing: [],
    unusable: [],
  });

  const fontValue = values?.["terminal-font"] ?? "";
  useEffect(() => {
    const t = window.setTimeout(
      () => setBadFonts(missingTerminalFonts(fontValue, fontAvailable)),
      350
    );
    return () => window.clearTimeout(t);
  }, [fontValue]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // SUB-1122: with the sheet gone there is nobody to hold an uncommitted
      // preview, so hand the appearance back to Settings.md — the next read
      // repaints from the note, as an abandoned drag already did.
      reconcileAppearance(appearancePreviewSeq());
    };
  }, []);

  useEffect(() => {
    onboardingStatus()
      .then(setVault)
      .catch(() => setVault(null));
  }, []);

  const loadValues = useCallback(async () => {
    try {
      const c = await vaultRead(SETTINGS_PATH);
      if (!mountedRef.current) return;
      const v: Record<string, string> = {};
      for (const f of FIELDS) {
        // fold the read (SUB-924) — a hand-cased key still shows its value
        const raw = c.props[foldedPropKey(c.props, f.key)];
        v[f.key] = fieldText(f, raw);
      }
      setValues(v);
      setSaved(v);
      setMissing(false);
    } catch {
      if (mountedRef.current) setMissing(true);
    }
  }, []);

  useEffect(() => {
    void loadValues();
  }, [loadValues]);

  const reconcileSettings = useCallback(async () => {
    await Promise.all([mountedRef.current ? loadValues() : undefined, onSettingsChanged()]);
  }, [loadValues, onSettingsChanged]);

  const close = useCallback(() => {
    // fields commit on blur, and both exits from here (Esc, backdrop click)
    // unmount before the browser would blur on its own — so blur first, or the
    // edit in the focused box is thrown away (SUB-476).
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setClosing(true);
    window.setTimeout(onClose, 90);
  }, [onClose]);

  // pane-owned Esc (capture phase, like the menus): the registry's esc-close
  // entry is surface-scoped and stays inert while this sheet is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the switch-vault sheet sits on top and owns esc while it's up
      if (switching) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, switching]);

  const commit = useCallback(
    (key: string) => {
      if (!values) return;
      const field = FIELDS.find((f) => f.key === key);
      if (field?.kind === "multiline") {
        // normalize to the stored shape first, so the round trip through the
        // list is what the comparison (and the box) settles on
        const list = textToTerminalActions(values[key]);
        const next = list.join("\n");
        setValues((v) => (v ? { ...v, [key]: next } : v));
        if (next === (saved[key] ?? "")) return;
        // a list of commands joined into one toast phrase reads as noise, so
        // this one names the field instead of its value
        setPropUndoable({
          path: SETTINGS_PATH,
          key,
          value: list.length === 0 ? null : list,
          label: list.length === 0 ? `Clear ${key}` : `Edit ${key}`,
          record: undo.record,
          onApplied: reconcileSettings,
        })
          .then(() => {
            setSaved((s) => ({ ...s, [key]: next }));
            void onSettingsChanged();
          })
          .catch((e) => onToast(`couldn't save ${key} (${e})`));
        return;
      }
      const next = values[key].trim();
      if (next === (saved[key] ?? "")) return;
      // the HUD sizes get validated here so a typo can't silently collapse it
      if (field?.range && next !== "") {
        // accept de-DE typed fractions like the reader does (SUB-926)
        const n = Number.parseFloat(normalizeNumberInput(next));
        if (!Number.isFinite(n) || n < field.range.min || n > field.range.max) {
          onToast(
            `${field.label.toLowerCase()} must be between ${field.range.min} and ${field.range.max}`
          );
          setValues((v) => (v ? { ...v, [key]: saved[key] ?? "" } : v));
          return;
        }
      }
      // same guard for the relay: a non-URL would silently disable Send as
      // link (its parser treats junk as unconfigured)
      if (key === "share-relay-url" && next !== "" && !/^https?:\/\/.+/i.test(next)) {
        onToast("share relay must be an http(s) URL");
        setValues((v) => (v ? { ...v, [key]: saved[key] ?? "" } : v));
        return;
      }
      setPropUndoable({
        path: SETTINGS_PATH,
        key,
        // Missing means "use the hosted default". Persist an explicit
        // sentinel when the user clears this one field so opt-out survives
        // reloads and sync. `disabled` stays a string even in YAML 1.1 tools;
        // legacy `off` remains accepted by the reader.
        value: key === "share-relay-url" && next === "" ? "disabled" : next === "" ? null : next,
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => {
          setSaved((s) => ({ ...s, [key]: next }));
          void onSettingsChanged();
        })
        .catch((e) => onToast(`couldn't save ${key} (${e})`));
    },
    [values, saved, onSettingsChanged, onToast, reconcileSettings, undo]
  );

  const toggle = useCallback(
    (f: Field) => {
      if (!values) return;
      const key = f.key;
      const next = boolOn(f, values[key]) ? "false" : "true";
      setValues((v) => (v ? { ...v, [key]: next } : v));
      setPropUndoable({
        path: SETTINGS_PATH,
        key,
        value: next,
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => {
          setSaved((s) => ({ ...s, [key]: next }));
          void onSettingsChanged();
        })
        .catch((e) => onToast(`couldn't save ${key} (${e})`));
    },
    [values, onSettingsChanged, onToast, reconcileSettings, undo]
  );

  /** choices write on the click — there is no blur to wait for. Select fields
      clear their first option because that is what an unset key already means;
      choice fields retain their explicit value, matching the existing setting. */
  const choose = useCallback(
    (f: Field, value: string) => {
      if (!values) return;
      const key = f.key;
      const current =
        f.kind === "choice"
          ? choiceValue(f, saved[key] ?? "")
          : selectValue(f, saved[key] ?? "");
      if (value === current) return;
      setValues((v) => (v ? { ...v, [key]: value } : v));
      const isDefaultSelect = f.kind === "select" && value === f.options?.[0]?.value;
      setPropUndoable({
        path: SETTINGS_PATH,
        key,
        value: isDefaultSelect ? null : value,
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => {
          setSaved((s) => ({ ...s, [key]: value }));
          void onSettingsChanged();
        })
        .catch((e) => onToast(`couldn't save ${key} (${e})`));
    },
    [values, saved, onSettingsChanged, onToast, reconcileSettings, undo]
  );

  const fade = useEdgeFade<HTMLDivElement>();

  /** dragging: repaint immediately, write nothing. A range input fires
      onChange for every step of a drag, and each write is an IPC round trip
      plus its own undo entry — so the note learns about it on release. */
  const slide = useCallback((f: Field, n: number) => {
    const v = valuesRef.current;
    if (!v) return;
    const next = { ...v, [f.key]: String(n) };
    setValues(next);
    // the claim is taken HERE and not inside a setValues updater: React may
    // run an updater more than once per user action (StrictMode double-invoke,
    // render replay), and a counter bumped from a render-phase function is a
    // shape that stops being harmless the day reconcile learns to subtract.
    previewAppearance(document.documentElement, appearanceOf(next));
    // SUB-951: opacity is the one dial you judge by looking THROUGH the
    // window at your desktop, so it has to preview on the drag too — and
    // it is only a class plus a custom property, so an abandoned drag
    // needs no undo: the next settings read repaints from the note.
    if (f.key === WINDOW_OPACITY_FIELD.key) applyWindowOpacity(n);
  }, []);

  /** A live appearance preview is only optimistic. If Settings.md rejects
      the write, restore that field from the last persisted snapshot and
      repaint immediately; leaving an unsaved look active would make the
      sheet and the next launch disagree. */
  const rollbackAppearance = useCallback(
    (key: string) => {
      const current = valuesRef.current;
      if (!current) return;
      const next = { ...current, [key]: saved[key] ?? "" };
      // back on the persisted snapshot, so this field is no longer ahead of
      // the note — stop holding the appearance for it (SUB-1122). Only up to
      // the seq claimed BEFORE this rollback's own repaint, though: a monotone
      // counter cannot say "release mine, keep the older one", and releasing
      // the current seq would hand back a preview another dial made while
      // this write was in flight — the interleaving the counter pair exists to
      // prevent, in the failure path. What stays claimed is this rollback's
      // own repaint, which is harmless: it already matches the note, and the
      // next commit or the unmount releases it.
      const previewed = appearancePreviewSeq();
      setValues(next);
      previewAppearance(document.documentElement, appearanceOf(next));
      reconcileAppearance(previewed);
      if (key === WINDOW_OPACITY_FIELD.key) {
        applyWindowOpacity(sliderValue(WINDOW_OPACITY_FIELD, next[key]));
      }
    },
    [saved]
  );

  /** release (pointer up, key up, or losing focus): persist if it moved */
  const commitSlider = useCallback(
    (f: Field) => {
      // a release that writes NOTHING must still hand the appearance back
      // (SUB-1122). Dragging glow 30 → 80 → 30 and letting go bumps the claim
      // on every step and then issues no write, so returning early here used
      // to leave the claim standing for the life of the open sheet: every
      // later Settings.md read dropped its appearance apply, and nothing
      // replays a suppressed read — an external edit to the look (other
      // window, editor, sync) was silently lost. Same bound as the unmount
      // release: everything previewed so far goes back, since the sheet is
      // now level with the note.
      if (!values) {
        reconcileAppearance(appearancePreviewSeq());
        return;
      }
      const n = sliderValue(f, values[f.key]);
      if (n === sliderValue(f, saved[f.key] ?? "")) {
        reconcileAppearance(appearancePreviewSeq());
        return;
      }
      const isDefault = n === f.slider!.default;
      setValues((v) => (v ? { ...v, [f.key]: String(n) } : v));
      // everything previewed up to here is what this write puts in the note
      // (SUB-1122); a preview made while it is in flight stays claimed
      const previewed = appearancePreviewSeq();
      setPropUndoable({
        path: SETTINGS_PATH,
        key: f.key,
        // the default is what an unset key already means, so landing on it
        // clears the key rather than writing the default into the note
        value: isDefault ? null : String(n),
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => {
          reconcileAppearance(previewed);
          setSaved((s) => ({ ...s, [f.key]: String(n) }));
          void onSettingsChanged();
        })
        .catch((e) => {
          rollbackAppearance(f.key);
          onToast(`couldn't save ${f.key} (${e})`);
        });
    },
    [
      values,
      saved,
      onSettingsChanged,
      onToast,
      reconcileSettings,
      rollbackAppearance,
      undo,
    ]
  );

  /** a tone chip writes on the click, like the segmented control */
  const chooseChip = useCallback(
    (f: Field, value: string) => {
      if (!values) return;
      if (value === chipValue(f, saved[f.key] ?? "")) return;
      const next = { ...values, [f.key]: value };
      setValues(next);
      previewAppearance(document.documentElement, appearanceOf(next));
      const previewed = appearancePreviewSeq();
      setPropUndoable({
        path: SETTINGS_PATH,
        key: f.key,
        value: value === f.defaultChip ? null : value,
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => {
          reconcileAppearance(previewed);
          setSaved((s) => ({ ...s, [f.key]: value }));
          void onSettingsChanged();
        })
        .catch((e) => {
          rollbackAppearance(f.key);
          onToast(`couldn't save ${f.key} (${e})`);
        });
    },
    [
      values,
      saved,
      onSettingsChanged,
      onToast,
      reconcileSettings,
      rollbackAppearance,
      undo,
    ]
  );

  return (
    <div className={`overlay${closing ? " closing" : ""}`} onMouseDown={close}>
      <div className="shortcut-sheet settings-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcut-sheet-title settings-title">
          Settings
          <button
            className="settings-raw"
            onClick={() => {
              onEditRaw();
              onClose();
            }}
          >
            edit raw
          </button>
        </div>
        <div className={`shortcut-sheet-body${fade.className}`} {...fade.props}>
          {vault && (
            <div className="settings-row">
              <div className="settings-row-text">
                {/* not a <label>: the row's control is the switch button, and a
                    label pointing at nothing announces a phantom field */}
                <div className="settings-label">Vault</div>
                <div className="settings-hint settings-vault-path">{vault.root}</div>
              </div>
              <button
                className="settings-raw"
                data-testid="switch-vault"
                onClick={() => setSwitching(true)}
              >
                switch…
              </button>
            </div>
          )}
          {missing && (
            <div className="settings-missing">
              No Settings.md in the vault — create it via “edit raw”.
            </div>
          )}
          {values &&
            FIELDS.filter((f) => f.only !== "macos" || vibrancyCapable).map((f) => (
              <Fragment key={f.key}>
                {f.section && <div className="palette-section">{f.section}</div>}
                <div className="settings-row">
                  <div className="settings-row-text">
                    {/* radiogroups are not labelable elements, so those rows
                        use a plain heading and name the group with aria-label */}
                    {f.kind === "choice" || f.kind === "select" || f.kind === "chips" ? (
                      <div className="settings-label">{f.label}</div>
                    ) : (
                      <label className="settings-label" htmlFor={`set-${f.key}`}>
                        {f.label}
                      </label>
                    )}
                    <div className="settings-hint">{f.hint}</div>
                    {f.key === "terminal-font" && badFonts.missing.length > 0 && (
                      <div className="settings-hint settings-hint-warn" data-testid="font-missing">
                        font not found: {badFonts.missing.join(", ")} — check the exact family name
                        in Font Book
                      </div>
                    )}
                    {/* a dropped entry isn't a family the machine could have —
                        sending someone to Font Book to look up "0.45" is the
                        wrong hint, so this one just says what it is */}
                    {f.key === "terminal-font" && badFonts.unusable.length > 0 && (
                      <div className="settings-hint settings-hint-warn" data-testid="font-unusable">
                        not a usable font name: {badFonts.unusable.join(", ")}
                      </div>
                    )}
                  </div>
                  {f.kind === "choice" ? (
                    /* the expiry picker's idiom (SendLinkDialog): a radiogroup
                       of latched buttons, not a <select> — two options fit
                       inline and both stay readable without opening anything */
                    <div className="settings-choice" role="radiogroup" aria-label={f.label}>
                      {(f.choices ?? []).map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          role="radio"
                          aria-checked={choiceValue(f, values[f.key]) === c.value}
                          className={`selmenu-btn${choiceValue(f, values[f.key]) === c.value ? " on" : ""}`}
                          onClick={() => choose(f, c.value)}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  ) : f.kind === "bool" ? (
                    <button
                      id={`set-${f.key}`}
                      role="switch"
                      aria-checked={boolOn(f, values[f.key])}
                      className={`settings-switch${boolOn(f, values[f.key]) ? " on" : ""}`}
                      onClick={() => toggle(f)}
                    >
                      <span className="settings-knob" />
                    </button>
                  ) : f.kind === "select" ? (
                    /* two choices, so a segmented control rather than a menu:
                       both options stay readable and one click switches */
                    <div
                      className="settings-seg"
                      id={`set-${f.key}`}
                      role="radiogroup"
                      aria-label={f.label}
                    >
                      {(f.options ?? []).map((o, index, options) => {
                        const selected = selectValue(f, values[f.key]) === o.value;
                        return (
                          <button
                            key={o.value}
                            role="radio"
                            aria-checked={selected}
                            tabIndex={selected ? 0 : -1}
                            className={`settings-seg-btn${selected ? " on" : ""}`}
                            onClick={() => choose(f, o.value)}
                            onKeyDown={(e) => {
                              let next = index;
                              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                                next = (index + 1) % options.length;
                              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                                next = (index - 1 + options.length) % options.length;
                              } else if (e.key === "Home") {
                                next = 0;
                              } else if (e.key === "End") {
                                next = options.length - 1;
                              } else {
                                return;
                              }
                              e.preventDefault();
                              e.stopPropagation();
                              choose(f, options[next].value);
                              const buttons = e.currentTarget.parentElement?.querySelectorAll("button");
                              (buttons?.[next] as HTMLButtonElement | undefined)?.focus();
                            }}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                    ) : f.kind === "slider" ? (
                    /* SUB-955: the appearance dials. The live number sits next
                       to the track because "glow 46" is a value the user wants
                       to be able to come back to, and a bare handle isn't one. */
                    <div className="settings-slider">
                      <input
                        id={`set-${f.key}`}
                        className="settings-range"
                        type="range"
                        min={f.slider!.min}
                        max={f.slider!.max}
                        step={f.slider!.step}
                        value={sliderValue(f, values[f.key])}
                        onChange={(e) => slide(f, Number(e.target.value))}
                        onPointerUp={() => commitSlider(f)}
                        onKeyUp={() => commitSlider(f)}
                        onBlur={() => commitSlider(f)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") close();
                          e.stopPropagation();
                        }}
                      />
                      <span className="settings-slider-val">
                        {(f.format ?? String)(sliderValue(f, values[f.key]))}
                      </span>
                    </div>
                  ) : f.kind === "chips" ? (
                    /* more than two choices and each one is a COLOUR, so the
                       segmented control's text-only rows won't do: every chip
                       carries a dot in the tone it names. The dots are painted
                       from the same table the app is (styles.css), so a chip
                       can never disagree with what picking it does. */
                    <div
                      className="settings-chips"
                      id={`set-${f.key}`}
                      role="radiogroup"
                      aria-label={f.label}
                    >
                      {(f.options ?? []).map((o, index, options) => {
                        const selected = chipValue(f, values[f.key]) === o.value;
                        return (
                          <button
                            key={o.value}
                            role="radio"
                            aria-checked={selected}
                            tabIndex={selected ? 0 : -1}
                            data-tone-swatch={o.value}
                            className={`settings-chip${selected ? " on" : ""}`}
                            onClick={() => chooseChip(f, o.value)}
                            onKeyDown={(e) => {
                              let next = index;
                              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                                next = (index + 1) % options.length;
                              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                                next = (index - 1 + options.length) % options.length;
                              } else if (e.key === "Home") {
                                next = 0;
                              } else if (e.key === "End") {
                                next = options.length - 1;
                              } else {
                                return;
                              }
                              e.preventDefault();
                              e.stopPropagation();
                              chooseChip(f, options[next].value);
                              const buttons =
                                e.currentTarget.parentElement?.querySelectorAll("button");
                              (buttons?.[next] as HTMLButtonElement | undefined)?.focus();
                            }}
                          >
                            <span className="settings-chip-dot" />
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                ) : f.kind === "multiline" ? (
                    <textarea
                      id={`set-${f.key}`}
                      className="settings-input settings-textarea"
                      rows={4}
                      value={values[f.key]}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      onChange={(e) =>
                        setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))
                      }
                      onBlur={() => commit(f.key)}
                      onKeyDown={(e) => {
                        // Enter inserts a line here — Escape is the way out
                        if (e.key === "Escape") close();
                        e.stopPropagation();
                      }}
                    />
                  ) : (
                    <input
                      id={`set-${f.key}`}
                      className="settings-input"
                      type={f.masked ? "password" : "text"}
                      value={values[f.key]}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      onChange={(e) =>
                        setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))
                      }
                      onBlur={() => commit(f.key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") close();
                        e.stopPropagation();
                      }}
                    />
                  )}
                </div>
              </Fragment>
            ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="key">esc</span> close · changes apply within a second
          </span>
        </div>
      </div>
      {/* stop the mousedown here: the settings overlay closes on any
          click that reaches it, and the switch sheet renders inside it */}
      {switching && vault && (
        <Suspense fallback={null}>
          <div onMouseDown={(e) => e.stopPropagation()}>
            <Onboarding
              switching
              envPinned={vault.env_pinned}
              suggested={vault.suggested}
              configPath={vault.config_path}
              onChosen={() => {}}
              onCancel={() => setSwitching(false)}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}
