/* Settings overlay (⌘,): a small form over the vault's Settings.md.
   The note stays the source of truth (plain markdown, hot-reloaded by the
   backend watcher within a second of any save), this pane is just a typed
   front door: read props on open, write each field back on commit via the
   same vault_set_prop IPC every prop editor uses. "Edit raw" opens the note
   in the normal editor for anything beyond the known keys. */

import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  contextAxTrusted,
  contextRequestAccess,
  onboardingStatus,
  vaultRead,
  voiceModelDownload,
  voiceModelState,
  voiceSupported,
} from "../lib/ipc";
import type { VoiceModelState } from "../lib/ipc";
import { CHANGELOG } from "../lib/changelog";
import type { UpdateCheck } from "../hooks/useUpdater";
import RecallSettings from "./RecallSettings";
import ReflexesSettings from "./ReflexesSettings";
import { normalizeNumberInput } from "../lib/aggregate";
import { NUMBER_LOCALES, numberLocaleSample, numberLocaleSetting } from "../lib/numberLocale";
import { DATE_LOCALES, dateLocaleSample } from "../lib/dateLocale";
import { setPropUndoable } from "../lib/undoprops";
import { useEdgeFade } from "../hooks/useEdgeFade";
import KindsSettings from "./KindsSettings";
import { CheckIcon } from "./Icons";
import { useUndo } from "../lib/undoContext";
import {
  missingTerminalFonts,
  parseUpcomingDock,
  SETTINGS_PATH,
  terminalActionsToText,
  textToTerminalActions,
  WINDOW_OPACITY_DEFAULT,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
} from "../lib/settings";
import { previewWindowOpacity, vibrancyCapable } from "../lib/vibrancy";
import {
  EXPERIMENTAL_NOTE,
  EXPERIMENTAL_TOGGLES,
  visibleExperimentalToggles,
  type ExperimentalToggle,
} from "../lib/experimental";
import type { TerminalFontProblems } from "../lib/settings";
import { foldedPropKey } from "../lib/types";
import { isTauri, listen } from "../lib/tauri";
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
import McpSettings from "./McpSettings";
import CalendarSettings from "./CalendarSettings";
import { DEFAULT_AGENDA_PLACEMENT, type AgendaPlacement } from "../lib/calagenda";
import { visibleSettingsTabs, type SettingsTabId } from "../lib/settingsTabs";
import { errText } from "../lib/errtext";
import ImportSettings from "./ImportSettings";
import SyncFoldersSettings from "./SyncFoldersSettings";

const Onboarding = lazy(() => import("./Onboarding"));

/* The speech model is half a gigabyte, so it is not in the app: transcription
   stays off until someone asks for it here. Which makes this row the one place
   voice capture touches the network, and the honest place to say so.

   Not a `Field`: the rest of the sheet writes a prop to Settings.md, and this
   writes nothing — it reports a file's presence and starts a long download.
   Its own block rather than a new field kind, for one control. */
function VoiceModelRow({ onToast }: { onToast: (msg: string) => void }) {
  const [state, setState] = useState<VoiceModelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let live = true;
    voiceSupported()
      .then((ok) => (ok ? voiceModelState() : null))
      .then((s) => {
        if (live && s) setState(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let dead = false;
    let unlisten: (() => void)[] = [];
    Promise.all([
      listen<{ received: number; total: number }>("voice:model", (e) => {
        // the tick carries the byte count, so the bar moves without polling
        setState({ installed: false, bytes: e.payload.received, expected_bytes: e.payload.total });
        if (e.payload.received >= e.payload.total) {
          setBusy(false);
          setState({
            installed: true,
            bytes: e.payload.total,
            expected_bytes: e.payload.total,
          });
        }
      }),
      listen<string>("voice:model-error", (e) => {
        setBusy(false);
        // the reason stays on the row: a toast is gone in three seconds and
        // this is a five-minute download someone walked away from
        setFailed(String(e.payload || "download failed"));
      }),
    ]).then((callbacks) => {
      if (dead) callbacks.forEach((c) => c());
      else unlisten = callbacks;
    });
    return () => {
      dead = true;
      unlisten.forEach((c) => c());
    };
  }, []);

  if (!state) return null;
  const pct =
    state.expected_bytes > 0 ? Math.floor((state.bytes / state.expected_bytes) * 100) : 0;
  const size = `${Math.round(state.expected_bytes / 1e6)} MB`;
  return (
    <>
      <div className="palette-section">Voice</div>
      <div className="settings-row" data-testid="voice-model-row">
        <div className="settings-row-text">
          <div className="settings-label">Speech model</div>
          <div className="settings-hint">
            {state.installed
              ? "installed — voice notes are transcribed on this Mac, and nothing is sent anywhere"
              : `not installed — voice notes are still recorded and filed, they just stay audio until this ${size} model is downloaded once`}
          </div>
          {failed && (
            <div className="settings-hint settings-hint-warn" data-testid="voice-model-error">
              {failed}
            </div>
          )}
        </div>
        {state.installed ? (
          <div className="settings-hint settings-hint-done" role="img" aria-label="installed">
            <CheckIcon />
          </div>
        ) : (
          <button
            className="settings-raw"
            data-testid="voice-model-download"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed("");
              voiceModelDownload().catch((e) => {
                setBusy(false);
                onToast(errText(e));
              });
            }}
          >
            {busy || state.bytes > 0 ? `${pct}%` : "download…"}
          </button>
        )}
      </div>
    </>
  );
}


/** Which build this is, and a way to ask the release feed whether it is still
    the newest one.

    The app already looks on its own every twelve hours and says nothing when
    it finds nothing — which is indistinguishable, from the outside, from an
    updater that is broken or a feed that was never published. This row is the
    question asked out loud: the same check, with all three of its answers
    written down. Finding something hands straight over to the standing
    Install offer; it never installs anything by itself. */
function AboutRow({ onCheckUpdates }: { onCheckUpdates: () => Promise<UpdateCheck> }) {
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<UpdateCheck | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const version = CHANGELOG[0]?.version ?? "";
  return (
    <>
      <div className="palette-section">About</div>
      <div className="settings-row" data-testid="about-row">
        <div className="settings-row-text">
          <div className="settings-label">{version ? `Substrate ${version}` : "Substrate"}</div>
          <div className="settings-hint" data-testid="update-status">
            {answer === null
              ? "the app looks for a new release on its own every few hours; this asks now"
              : answer.state === "current"
              ? "up to date"
              : answer.state === "unreachable"
              ? "couldn't reach the update feed — no answer from the release server"
              : answer.stage === "ready"
              ? `Substrate ${answer.version} is installed — restart to finish`
              : answer.stage === "downloading"
              ? `Substrate ${answer.version} is downloading — its progress is at the bottom of the window`
              : `Substrate ${answer.version} is available — install it from the offer at the bottom of the window`}
          </div>
        </div>
        <button
          className="settings-raw"
          data-testid="check-updates"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            // the check answers for every outcome it has, including the
            // failures, so there is no rejection left to leave the button
            // spinning — the catch is the belt to that braces
            onCheckUpdates()
              .catch((): UpdateCheck => ({ state: "unreachable" }))
              .then((result) => {
                if (!live.current) return;
                setAnswer(result);
                setAsking(false);
              });
          }}
        >
          {asking ? "checking…" : "check for updates"}
        </button>
      </div>
    </>
  );
}

interface SettingsPaneProps {
  onClose: () => void;
  onEditRaw: () => void;
  /** Re-read render settings after a write or inverse so an open terminal
      follows this sheet instead of waiting for its next summon. */
  onSettingsChanged: () => void | Promise<void>;
  onToast: (msg: string) => void;
  vaultSealed: boolean;
  vaultSealPending: boolean;
  /** A root seal marker that arrived from outside this device and seals
      nothing until it is confirmed here. */
  vaultSealUnconfirmed: boolean;
  onSealVault: () => void;
  onConfirmVaultSeal: () => void;
  onRejectVaultSeal: () => void;
  onRemoveVaultSeal: () => void;
  /** Ask the release feed, once, on this click — the same check the app runs
      on its own, so a find lands in the standing Install offer. */
  onCheckUpdates: () => Promise<UpdateCheck>;
  /** the calendar's `upcoming-dock`, held by App because the calendar reads
      it too — the Calendar section moves it optimistically so the pane behind
      this sheet flips on the click rather than on the watcher echo */
  upcomingDock: AgendaPlacement;
  setUpcomingDock: (next: AgendaPlacement) => void;
}

interface Field {
  key: string;
  /** which tab of the sheet this row lives on — every field names one, so a
      new setting can't quietly land nowhere */
  tab: SettingsTabId;
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
  /** slider fields only: the dial's bounds and the value that
      means "unset" — landing on it clears the key instead of writing it */
  slider?: { min: number; max: number; step: number; default: number };
  /** slider fields only: how the live number reads next to the track */
  format?: (n: number) => string;
  /** text fields only: render as a password input (shoulder-surfing guard —
      the value still lives in Settings.md as plain frontmatter) */
  masked?: boolean;
  /** choice fields only: the options, first one the default an unset key
      reads as */
  choices?: { value: string; label: string }[];
  /** heading this field opens (rendered above its row) — the list is flat and
      ordered, so a section runs until the next field that starts one */
  section?: string;
}

/* A `terminal-font` the machine can't resolve looks like the setting
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

/* The Experimental section.

   Its own block rather than rows in the flat list, for two reasons: it must
   sit at the bottom (below Voice, Reflexes and Kinds, which render after the
   list), and it says one thing above all of its rows — these may change or
   disappear — rather than repeating it per switch.

   The Accessibility grant lives here too. Context-bound capture reads what it
   can WITHOUT any permission (the frontmost app's name) and reads the focused
   document only when macOS already trusts us, so the feature works, smaller,
   with the grant refused. That is why the prompt hangs off this button: it is
   an offer, and hitting the capture hotkey must never raise a system dialog. */
function ExperimentalSection({
  values,
  onToggle,
  onToast,
}: {
  values: Record<string, string>;
  onToggle: (f: Field) => void;
  onToast: (msg: string) => void;
}) {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const fields = EXPERIMENTAL_SHOWN;
  const needsAccess = EXPERIMENTAL_TOGGLES.some(
    (t) => t.needsAccessibility && boolOn(field(t.key), values[t.key] ?? "")
  );

  useEffect(() => {
    if (!needsAccess) return;
    let live = true;
    contextAxTrusted()
      .then((ok) => {
        if (live) setTrusted(ok);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needsAccess]);

  if (fields.length === 0) return null;
  return (
    <>
      {/* no heading: the tab is already called Experimental, and a section
          head repeating its tab's name reads as a group that has a sibling
          somewhere below it. The caveat still gets said once, up top. */}
      <div className="settings-hint settings-experimental-note">{EXPERIMENTAL_NOTE}</div>
      {fields.map((f) => (
        <div className="settings-row" key={f.key} data-testid={`experimental-${f.key}`}>
          <div className="settings-row-text">
            <label className="settings-label" htmlFor={`set-${f.key}`}>
              {f.label}
            </label>
            <div className="settings-hint">{f.hint}</div>
          </div>
          <button
            id={`set-${f.key}`}
            role="switch"
            aria-checked={boolOn(f, values[f.key] ?? "")}
            aria-label={f.label}
            className={`settings-switch${boolOn(f, values[f.key] ?? "") ? " on" : ""}`}
            onClick={() => onToggle(f)}
          >
            <span className="settings-knob" />
          </button>
        </div>
      ))}
      {/* only once a switch that wants it is on, and only while the grant is
          actually missing: an offer nobody needs is noise */}
      {needsAccess && trusted !== null && (
        <div className="settings-row" data-testid="context-access-row">
          <div className="settings-row-text">
            <div className="settings-label">Accessibility access</div>
            <div className="settings-hint">
              {trusted
                ? "granted — captures can name the document you were in, not just the app"
                : "not granted — captures name the frontmost app only. Granting lets them name the open document (and your Ableton set)."}
            </div>
          </div>
          {trusted ? (
            <div className="settings-hint settings-hint-done" role="img" aria-label="granted">
              <CheckIcon />
            </div>
          ) : (
            <button
              className="settings-raw"
              data-testid="context-grant-access"
              onClick={() => {
                contextRequestAccess()
                  .then((ok) => {
                    setTrusted(ok);
                    if (!ok) onToast("approve Substrate in System Settings → Privacy & Security → Accessibility");
                  })
                  .catch((e) => onToast(errText(e)));
              }}
            >
              grant access…
            </button>
          )}
        </div>
      )}
    </>
  );
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
    the first choice, matching how the parsers in `lib/settings.ts` default.
    Matched on a trimmed case-fold, like `selectValue` — a hand-typed
    `number-locale: en-us` is the value the app formats with, so
    the row has to show it selected rather than falling back to the default. */
function choiceValue(f: Field, raw: string): string {
  const choices = f.choices ?? [];
  const want = raw.trim().toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === want)?.value ?? choices[0]?.value ?? "";
}

/* Experimental toggles are one list (lib/experimental.ts) turned into fields
   here, so the sheet loads and writes them exactly like every other key while
   the section itself renders apart — last, under its own heading and its own
   warning. */
const experimentalField = (t: ExperimentalToggle): Field => ({
  key: t.key,
  tab: "experimental" as const,
  label: t.label,
  hint: t.hint,
  kind: "bool",
  only: t.only,
});

/** every experimental key, whether or not this build shows it: the form loads
    and writes them all, and the docs and seed checks read this list. */
const EXPERIMENTAL_FIELDS: Field[] = EXPERIMENTAL_TOGGLES.map(experimentalField);

/* The sheet hides macOS-only rows off macOS. In the browser harness that would
   hide the section outright, and the mock backend models a Mac in every other
   respect — same posture the voice rows take, which the mock's
   `voice_supported` answers. */
const EXPERIMENTAL_CAPABLE = vibrancyCapable || !isTauri;

/** what the Experimental section will actually put on screen. Empty is a real
    answer — off macOS, in a build without the unreleased toggles, nothing here
    survives — and the tab strip reads this rather than promising a tab the
    section then renders as nothing. */
const EXPERIMENTAL_SHOWN: Field[] =
  visibleExperimentalToggles(EXPERIMENTAL_CAPABLE).map(experimentalField);

/** the strip this build renders. Every tab in it has something on it. */
const TABS = visibleSettingsTabs(EXPERIMENTAL_SHOWN.length > 0);

const FIELDS: Field[] = [
  {
    key: "capture-hotkey",
    tab: "general",
    label: "Quick-capture hotkey",
    hint: "global shortcut for the floating capture window, works from any app",
    placeholder: "alt+space",
    kind: "text",
    section: "Hotkeys",
  },
  {
    key: "voice-hotkey",
    tab: "general",
    label: "Voice-note hotkey",
    hint: "global shortcut that starts recording straight away, and stops and files on the second press — no window, no click",
    // the built-in default, so an empty field shows the chord that is
    // actually registered rather than one nothing uses
    placeholder: "alt+shift+space",
    kind: "text",
    only: "macos",
  },
  {
    key: "palette-hotkey",
    tab: "general",
    label: "Everywhere palette hotkey",
    hint: "optional global shortcut for the palette — it already opens with ⌘K from quick capture; set a chord here to reach it from any app without capture first",
    // empty is the default and means no chord, so the placeholder shows a
    // chord that would work rather than one that is registered
    placeholder: "none — e.g. cmd+shift+space",
    kind: "text",
  },
  {
    key: "close-to-tray",
    tab: "general",
    label: "Close to menu bar",
    hint: "closing the window keeps Substrate running in the tray",
    kind: "bool",
    section: "In the app",
  },
  {
    key: "drop-hint",
    tab: "general",
    label: "Drag-and-drop hint",
    hint: "while dragging a file over a note, show the copy-vs-⇧-link hint",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "mod-hud",
    tab: "general",
    label: "Hold-⌘ shortcut HUD",
    hint: "holding ⌘ (alone or with ⇧) folds out the shortcuts it can fire right now",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "task-stale-chips",
    tab: "appearance",
    label: "Task age chips",
    hint: "the stale / undated chips on the Tasks board; a board with its own stale_days keeps them, and a task with stale: never never wears one",
    kind: "bool",
    defaultOn: true,
    section: "Notes and tables",
  },
  {
    key: "db-grid",
    tab: "appearance",
    label: "Table grid lines",
    hint: "vertical lines between database table columns; each database can override this in its ⋯ menu",
    kind: "bool",
    defaultOn: true,
  },
  /* Appearance — the two dials that move the look without moving
     the layout. Both default to the shipped picture: glow 0, tone sky. */
  {
    key: "glow",
    tab: "appearance",
    label: "Glow",
    hint: "bloom on dashboard chart strokes, dots and emphasised values; bars join above 70. 0 is the shipped look",
    kind: "slider",
    slider: { min: GLOW_MIN, max: GLOW_MAX, step: 1, default: DEFAULT_GLOW },
    format: (n) => (n === 0 ? "off" : String(n)),
    section: "Colour and light",
  },
  {
    key: "accent-tone",
    tab: "appearance",
    label: "Accent tone",
    hint: "the hue the whole app wears — cell cursor, text selection, links, buttons and dashboard marks; state colours never move with it",
    kind: "chips",
    defaultChip: DEFAULT_TONE,
    options: TONES.map((t) => ({ value: t.id, label: t.label })),
  },
  {
    key: "accent-tone-nudge",
    tab: "appearance",
    label: "Tone fine-tune",
    hint: "shifts the chosen tone a few degrees; bounded so every mark stays legible on screen and on paper",
    kind: "slider",
    slider: { min: -NUDGE_MAX, max: NUDGE_MAX, step: 1, default: DEFAULT_NUDGE },
    format: (n) => (n === 0 ? "0°" : `${n > 0 ? "+" : ""}${n}°`),
  },
  /* The third look dial, and the only one that reaches outside the
     window — so it rides the same slider chrome but is hidden where the OS
     can't do it, rather than shown inert. */
  {
    key: "window-opacity",
    tab: "appearance",
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
    tab: "general",
    label: "Show app files",
    hint: "list AGENTS.md, CLAUDE.md and Settings.md — the notes the app itself seeds and reads — in notes and search; they stay on disk either way, and “edit raw” below always opens Settings.md",
    kind: "bool",
  },
  {
    key: "terminal-command",
    tab: "terminal",
    label: "Terminal command",
    hint: "what the ⌘⇧T terminal runs on start — your agent CLI (claude, codex, pi…); empty = plain shell",
    placeholder: "claude",
    kind: "text",
    section: "The terminal",
  },
  {
    key: "terminal-cwd",
    tab: "terminal",
    label: "Terminal folder",
    hint: "working directory the terminal starts in; empty = the vault folder",
    placeholder: "~/Notes/side-vault",
    kind: "text",
  },
  {
    key: "terminal-font",
    tab: "terminal",
    label: "Terminal font",
    hint: "font family for the ⌘⇧T terminal — set your nerd font here so powerline and prompt glyphs render; empty = the app's mono",
    placeholder: "JetBrainsMono Nerd Font",
    kind: "text",
  },
  /* with the other rows about what the terminal IS rather than down past the
     three geometry rows: a quick action is a command, and it reads next to the
     command the terminal starts with */
  {
    key: "terminal-actions",
    tab: "terminal",
    label: "Terminal quick actions",
    hint: "one `Label: command` per line — each becomes a ⌘K palette action that types its command into the terminal",
    placeholder: "Sweep inbox: /inbox-sweep",
    kind: "multiline",
  },
  {
    key: "terminal-dock",
    tab: "terminal",
    label: "Terminal position",
    hint: "which edge the ⌘⇧T terminal slides in from; drag its inner edge to resize either way",
    kind: "select",
    section: "Size and place",
    options: [
      { value: "bottom", label: "Bottom" },
      { value: "right", label: "Right" },
    ],
  },
  {
    key: "terminal-height",
    tab: "terminal",
    label: "Terminal height",
    hint: "fraction of the window the terminal covers when docked to the bottom (0.2–0.9)",
    placeholder: "0.45",
    kind: "text",
    range: { min: TERMINAL_HEIGHT_MIN, max: TERMINAL_HEIGHT_MAX },
  },
  {
    key: "terminal-width",
    tab: "terminal",
    label: "Terminal width",
    hint: "fraction of the window the terminal covers when docked to the right (0.2–0.7)",
    placeholder: "0.38",
    kind: "text",
    range: { min: TERMINAL_WIDTH_MIN, max: TERMINAL_WIDTH_MAX },
  },
  {
    key: "feed-curator",
    tab: "terminal",
    label: "Feed curator",
    hint: "command the feed dashboard's ↻ refresh runs to re-curate the items sheet (login shell, vault as cwd); the dashboard's own setup card edits the same key. Empty = no refresh button",
    placeholder: "~/scripts/curate-news.sh",
    kind: "text",
    section: "Feed",
  },
  /* ONE dial for the number dialect. Its predecessor `number-format`
     offered two values and reached only calc lines and unit cells while every
     other surface stayed hardwired to German — the pane promised more than it
     did. This key reaches all of them, and the labels are the locales' own
     output (numberLocaleSample) so the row reads as the thing it changes. */
  {
    key: "number-locale",
    tab: "general",
    label: "Number format",
    hint: "how every number is written — table cells, calc lines, totals, dashboards, file sizes",
    kind: "choice",
    choices: NUMBER_LOCALES.map((l) => ({ value: l, label: `${numberLocaleSample(l)}  ·  ${l}` })),
    section: "Formats",
  },
  {
    key: "date-locale",
    tab: "general",
    label: "Date format",
    hint: "how every date and clock time is written — trash and asset rows, history stamps, list dates, time travel, dashboard poll lines, printed exports",
    kind: "choice",
    choices: DATE_LOCALES.map((l) => ({ value: l, label: `${dateLocaleSample(l)}  ·  ${l}` })),
  },
  /* The requests that leave this machine, each with its own switch. Grouped
     under one heading so the answer to "what does this app talk to?" is a
     single place in the UI, not four settings apart. */
  {
    key: "net-link-titles",
    tab: "sharing",
    label: "Fetch link titles",
    hint: "pasting a URL asks that site for its page title",
    kind: "bool",
    defaultOn: true,
    section: "Outbound requests",
  },
  {
    key: "net-fx-rates",
    tab: "sharing",
    label: "Currency rates",
    hint: "fetches exchange rates from frankfurter.dev; off = conversions use the last saved rates and show their date",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "net-share-relay",
    tab: "sharing",
    label: "Send as link",
    hint: "uploads the encrypted note to your share relay; off hides the Send-as-link action",
    kind: "bool",
    defaultOn: true,
  },
  {
    key: "share-relay-url",
    tab: "sharing",
    label: "Share relay URL",
    hint: "where “Send as link” parks the encrypted copy — the relay only ever sees ciphertext; self-host one with scripts/handoff-relay",
    placeholder: "https://drop.example.org",
    kind: "text",
    section: "Share relay",
  },
  {
    key: "share-relay-token",
    tab: "sharing",
    label: "Share relay token",
    hint: "only if your relay requires a token for uploads (HANDOFF_TOKEN); recipients never need it — stored as plain text in Settings.md",
    kind: "text",
    masked: true,
  },
  ...EXPERIMENTAL_FIELDS,
];

/** Every key this sheet owns and the tab it lives on. Exported for the test
    that walks the tabs and holds the sheet to reaching all of them — grouping
    settings is only an improvement if nothing fell out of the sheet on the
    way, and a form nobody can find a key in sends people to the raw note. */
export const SETTINGS_FIELD_TABS: ReadonlyArray<{
  key: string;
  tab: SettingsTabId;
  only?: "macos";
}> = FIELDS.map((f) => ({ key: f.key, tab: f.tab, only: f.only }));

const field = (key: string): Field => FIELDS.find((f) => f.key === key)!;
const GLOW_FIELD = field("glow");
const TONE_FIELD = field("accent-tone");
const NUDGE_FIELD = field("accent-tone-nudge");
const WINDOW_OPACITY_FIELD = field("window-opacity");

/** What the three appearance keys currently in the form add up to. The pane
    previews through this rather than through the saved note, so dragging a
    dial repaints the app under the sheet before anything is written;
    App re-applies the committed truth on the next vault epoch. */
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
  vaultSealed,
  vaultSealPending,
  vaultSealUnconfirmed,
  onSealVault,
  onConfirmVaultSeal,
  onRejectVaultSeal,
  onRemoveVaultSeal,
  onCheckUpdates,
  upcomingDock,
  setUpcomingDock,
}: SettingsPaneProps) {
  const undo = useUndo();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  /** what `values` holds right now, readable from a handler that must not be
      re-created on every drag step. The appearance dials repaint OUTSIDE their
      state updater — see `slide` — and still need the current
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
  /** which tab is showing. Resets with the sheet: reopening lands on General
      rather than wherever the last visit ended, so ⌘, always opens the same
      thing. */
  const [tab, setTab] = useState<SettingsTabId>("general");
  /** families in the current `terminal-font` that won't take effect,
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
      // with the sheet gone there is nobody to hold an uncommitted
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
        // fold the read — a hand-cased key still shows its value
        const raw = c.props[foldedPropKey(c.props, f.key)];
        v[f.key] = fieldText(f, raw);
      }
      // The number dial must report the locale the app is ACTUALLY rendering
      // in. With `number-locale` absent, fieldText falls back to
      // the first choice — de-DE — but a vault still carrying the retired
      // `number-format: intl` key renders en-US, so the row would show de-DE
      // selected while the numbers say otherwise, and clicking the
      // apparently-selected row would silently flip them. numberLocaleSetting
      // is the same reader App uses, over the folded keys.
      v["number-locale"] = numberLocaleSetting({
        "number-locale": c.props[foldedPropKey(c.props, "number-locale")],
        "number-format": c.props[foldedPropKey(c.props, "number-format")],
      });
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
    // edit in the focused box is thrown away.
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
          .catch((e) => onToast(`couldn't save ${key} (${errText(e)})`));
        return;
      }
      const next = values[key].trim();
      if (next === (saved[key] ?? "")) return;
      // the HUD sizes get validated here so a typo can't silently collapse it
      if (field?.range && next !== "") {
        // accept de-DE typed fractions like the reader does
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
        .catch((e) => onToast(`couldn't save ${key} (${errText(e)})`));
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
        .catch((e) => onToast(`couldn't save ${key} (${errText(e)})`));
    },
    [values, onSettingsChanged, onToast, reconcileSettings, undo]
  );

  /** The Calendar section's one switch. Its key is not in `FIELDS` — the
      value renders a calendar rather than a form row, so App holds it — but
      the write is the same one every other switch makes: `upcoming-dock` into
      Settings.md, undoable, with the note as the source of truth. The local
      move first is what keeps the pane behind the sheet in step; a refused
      write settles the app back on what the note says rather than leaving it
      showing a rail the note never got — re-read, not the value this click
      captured, because another window may have written its own answer in the
      time the rejected write took, and restoring the captured one would put
      the app back behind the file. */
  const flipUpcomingDock = useCallback(
    (next: AgendaPlacement) => {
      const prior = upcomingDock;
      setUpcomingDock(next);
      setPropUndoable({
        path: SETTINGS_PATH,
        key: "upcoming-dock",
        value: next,
        record: undo.record,
        onApplied: reconcileSettings,
      })
        .then(() => void onSettingsChanged())
        .catch(async (e) => {
          onToast(`couldn't save upcoming-dock (${errText(e)})`);
          try {
            const c = await vaultRead(SETTINGS_PATH);
            setUpcomingDock(parseUpcomingDock(c.props) ?? DEFAULT_AGENDA_PLACEMENT);
          } catch {
            // the note is unreadable too — the value this click started from
            // is the best answer left
            setUpcomingDock(prior);
          }
        });
    },
    [upcomingDock, setUpcomingDock, onSettingsChanged, onToast, reconcileSettings, undo]
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
        .catch((e) => onToast(`couldn't save ${key} (${errText(e)})`));
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
    // opacity is the one dial you judge by looking THROUGH the
    // window at your desktop, so it has to preview on the drag too — and
    // it is only a class plus a custom property, so an abandoned drag
    // needs no undo: the next settings read repaints from the note.
    // Which is exactly why it needs the claim as well — that next
    // read must not arrive DURING the drag, or the old value is what sticks.
    if (f.key === WINDOW_OPACITY_FIELD.key) previewWindowOpacity(n);
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
      // the note — stop holding the appearance for it. Only up to
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
      // both repaints happen before the release, so both stay claimed — the
      // opacity one for the same reason as the appearance one
      if (key === WINDOW_OPACITY_FIELD.key) {
        previewWindowOpacity(sliderValue(WINDOW_OPACITY_FIELD, next[key]));
      }
      reconcileAppearance(previewed);
    },
    [saved]
  );

  /** release (pointer up, key up, or losing focus): persist if it moved */
  const commitSlider = useCallback(
    (f: Field) => {
      // a release that writes NOTHING must still hand the appearance back
      // Dragging glow 30 → 80 → 30 and letting go bumps the claim
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
      // a preview made while it is in flight stays claimed
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
          onToast(`couldn't save ${f.key} (${errText(e)})`);
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
          onToast(`couldn't save ${f.key} (${errText(e)})`);
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
        {/* the agent ledger's tab idiom — latched buttons in the pane's own
            head, not a second window chrome. Arrow keys move between them and
            only the current tab is a tab stop, the same bargain the segmented
            rows in the body strike. */}
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t, index) => (
            <button
              key={t.id}
              id={`settings-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              aria-controls="settings-tabpanel"
              tabIndex={t.id === tab ? 0 : -1}
              className={`settings-tab${t.id === tab ? " on" : ""}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                let next = index;
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  next = (index + 1) % TABS.length;
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  next = (index - 1 + TABS.length) % TABS.length;
                } else if (e.key === "Home") {
                  next = 0;
                } else if (e.key === "End") {
                  next = TABS.length - 1;
                } else {
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                setTab(TABS[next].id);
                const buttons = e.currentTarget.parentElement?.querySelectorAll("button");
                (buttons?.[next] as HTMLButtonElement | undefined)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* keyed by tab: one shared node would carry the scroll position from
            the tab just left, so a reader who scrolled Terminal and then picked
            Sharing would land part-way down Sharing, below the heading it is
            supposed to open under. A new node opens at its top, and the edge
            fade re-gates on the re-attach. */}
        <div
          key={tab}
          className={`shortcut-sheet-body${fade.className}`}
          id="settings-tabpanel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          {...fade.props}
        >
          {/* every other tab opens under a heading; these two rows are
              rendered here rather than declared as fields, and without one
              they read as strays above the tab's first group */}
          {tab === "vault" && <div className="palette-section">This vault</div>}
          {tab === "vault" && vault && (
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
          {tab === "vault" && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-label">Persistent vault seal</div>
              <div className="settings-hint">
                {vaultSealUnconfirmed
                  ? "A seal marker for this vault arrived from outside this device. It encrypts nothing and touches no history until you confirm it here."
                  : vaultSealPending
                  ? "An interrupted conversion is encrypted but still waiting for local history cleanup; restart or repair history to finish it."
                  : vaultSealed
                  ? "New and external notes inherit whole-file encryption. Existing ciphertext stays sealed if inheritance is stopped."
                  : "Encrypt every user note now, then automatically seal notes added by the app, sync, or external writers."}
              </div>
            </div>
            {vaultSealUnconfirmed ? (
              <>
                <button className="settings-raw" onClick={onConfirmVaultSeal}>
                  confirm seal…
                </button>
                <button className="settings-raw" onClick={onRejectVaultSeal}>
                  reject
                </button>
              </>
            ) : (
              <button
                className="settings-raw"
                disabled={vaultSealPending}
                onClick={vaultSealed ? onRemoveVaultSeal : onSealVault}
              >
                {vaultSealPending ? "conversion pending" : vaultSealed ? "stop inheritance" : "seal vault…"}
              </button>
            )}
          </div>
          )}
          {missing && (
            <div className="settings-missing">
              No Settings.md in the vault — create it via “edit raw”.
            </div>
          )}
          {values &&
            FIELDS.filter(
              (f) =>
                f.tab === tab &&
                !f.key.startsWith("experimental-") &&
                (f.only !== "macos" || vibrancyCapable)
            ).map((f) => (
              <Fragment key={f.key}>
                {f.section && <div className="palette-section">{f.section}</div>}
                {/* a picker with more options than fit beside a label drops
                    under it: the locale rows carry five samples apiece, and
                    forcing them into the control column made the whole sheet
                    scroll sideways into empty space */}
                <div
                  className={`settings-row${
                    f.kind === "choice" && (f.choices?.length ?? 0) > 2 ? " settings-row-stack" : ""
                  }`}
                >
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
                    <div
                      className="settings-choice"
                      id={`set-${f.key}`}
                      role="radiogroup"
                      aria-label={f.label}
                    >
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
                    /* The appearance dials. The live number sits next
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
          {/* the speech model pairs with the voice hotkey above it: one row
              says which chord records, the next whether anything can
              transcribe what it records */}
          {tab === "general" && values && <VoiceModelRow onToast={onToast} />}
          {/* last on the tab: which build this is, and the one question about
              it the app otherwise only ever answers unprompted */}
          {tab === "general" && <AboutRow onCheckUpdates={onCheckUpdates} />}
          {/* a plain layout preference, so it sits with the other
              preferences rather than below the consequential switches */}
          {tab === "appearance" && (
            <CalendarSettings dock={upcomingDock} onDock={flipUpcomingDock} />
          )}
          {tab === "sharing" && (
            <>
              {/* the standing grants below the switches that govern them: a
                  toggle is a preference, a grant is something handed out */}
              <McpSettings onToast={onToast} />
            </>
          )}
          {tab === "vault" && (
            <>
              <ImportSettings onToast={onToast} />
              {/* what the vault syncs, before who else can read it: a folder
                  left out of sync is a fact about this vault on every device,
                  and it renders away in a vault that has no folders yet */}
              <SyncFoldersSettings onToast={onToast} />
              {/* only when this vault has rules: the enable switch is a
                  consequential one, and it should not be the first thing
                  someone opening this tab trips over */}
              <ReflexesSettings onToast={onToast} />
              {/* below the reflex switch for the same reason it is below the
                  fields: an index over everything ever deleted is a decision,
                  not a preference */}
              <RecallSettings onToast={onToast} />
              {/* last, and only when the vault has any: consent is a per-vault
                  answer, not a preference, and it renders itself away in the
                  overwhelming majority of vaults that install no kinds */}
              <KindsSettings />
            </>
          )}
          {/* its own tab: an experimental switch is the one thing in here that
              can change under someone, so it is never something they scroll
              past on the way to a font size */}
          {tab === "experimental" && values && (
            <ExperimentalSection
              values={values}
              onToggle={toggle}
              onToast={onToast}
            />
          )}
        </div>
        <div className="palette-foot">
          {/* one fact per span, the palette's own idiom — the two used to be
              middot-chained inside a single one (principle 6) */}
          <span>
            <span className="key">esc</span> close
          </span>
          <span>changes apply within a second</span>
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
