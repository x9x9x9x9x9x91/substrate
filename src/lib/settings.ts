/* Settings.md is the app's settings surface (a plain root note, hot-reloaded
   by the backend watcher). The backend consumes `capture-hotkey`,
   `close-to-tray` and `window-opacity` (which both sides read — the backend
   for the OS material, this side for the ground alpha); the terminal HUD
   keys are frontend-owned — the
   PTY spawn call passes them down, so the Rust side never parses them. */

import { foldedPropKey } from "./types.ts";
import {
  DEFAULT_TERMINAL_DOCK,
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  parseTerminalDock,
  parseTerminalSize,
  type TerminalDock,
} from "./termdock.ts";

export {
  DEFAULT_TERMINAL_DOCK,
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  parseTerminalDock,
  type TerminalDock,
} from "./termdock.ts";

export const SETTINGS_PATH = "Settings.md";

/** the ⌘⇧T terminal's spawn config, read from Settings.md at open time */
export interface TerminalSettings {
  /** command typed into the fresh shell (agent CLI); empty = plain shell */
  command: string;
  /** working directory; empty or missing on disk = the vault root (backend fallback) */
  cwd: string;
  /** which window edge the HUD docks to */
  dock: TerminalDock;
  /** bottom-dock height as a fraction of the window, 0.2–0.9 */
  height: number;
  /** right-dock width as a fraction of the window, 0.2–0.7 */
  width: number;
  /** font family for the HUD terminal; empty = the app's `--mono` chain */
  font: string;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  command: "",
  cwd: "",
  dock: DEFAULT_TERMINAL_DOCK,
  height: DEFAULT_TERMINAL_HEIGHT,
  width: DEFAULT_TERMINAL_WIDTH,
  font: "",
};

/** `terminal-font` → the xterm `fontFamily` string.

    The value is NORMALIZED, never passed through: split on commas, each name
    unwrapped from its quotes, checked against a strict whitelist
    (letters/digits/space/`_``.``-`), re-quoted when spaced, rejects dropped.
    xterm's DOM renderer interpolates this string raw into a `<style>` element
    and Settings.md is vault content (it syncs and imports), so anything
    looser is a CSS injection surface — the same threat model that gates
    `terminal-command` behind the trust card. Normalizing also means the
    output is always a VALID declaration: a typo'd value (trailing comma,
    stray quote, a number in the wrong row) degrades to the app's mono chain
    instead of invalidating the whole rule and landing the terminal in the
    browser's proportional default. */
/** one comma-separated entry of a `terminal-font` value */
interface FontPart {
  /** the family as typed, unwrapped from its quotes and trimmed */
  name: string;
  /** the CSS token it normalizes to, or null when the whitelist drops it */
  css: string | null;
}

/* Single parse of the user's chain — `terminalFontFamily` builds the CSS
   declaration from it, `missingTerminalFonts` reports what fell out. Two
   copies of this whitelist would drift, and a drifted hint is worse than
   none (it would clear on a family the HUD is actually dropping). */
function terminalFontParts(userFont: string): FontPart[] {
  const parts: FontPart[] = [];
  for (const part of userFont.split(",")) {
    let f = part.trim();
    const quoted = f.match(/^(['"])(.*)\1$/);
    if (quoted) f = quoted[2].trim();
    // an empty entry is punctuation (trailing comma), not a family: it isn't
    // a dropped name and mustn't surface as one
    if (!f) continue;
    // whitelist, and not a bare number (a height typed into the font row)
    if (!/^[A-Za-z0-9 _.-]+$/.test(f) || /^[\d. ]+$/.test(f)) {
      parts.push({ name: f, css: null });
      continue;
    }
    // bare only when it's a clean CSS identifier — keeps generic keywords
    // (monospace) working; anything else (spaces, dots, leading digit) is
    // quoted so one odd name can't invalidate the whole declaration
    parts.push({ name: f, css: /^[A-Za-z][A-Za-z0-9_-]*$/.test(f) ? f : `"${f}"` });
  }
  return parts;
}

export function terminalFontFamily(userFont: string, fallbackChain: string): string {
  const families = terminalFontParts(userFont)
    .map((p) => p.css)
    .filter((c): c is string => c !== null);
  return families.length ? `${families.join(", ")}, ${fallbackChain}` : fallbackChain;
}

/* CSS generic families and the global keywords: never a name to look up, so
   never "not found" — a canvas measurement would report them as resolving
   anyway, but the exemption is stated here so the helper is honest on its
   own, and it keeps the platform's substitution rules out of the answer. */
const GENERIC_FAMILIES = new Set([
  "monospace",
  "sans-serif",
  "serif",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "unset",
]);

/** entries in `terminal-font` that won't take effect.

    Two ways to type a font the terminal never uses, and they need different
    words on the settings row: a name the normalization above drops (whitelist
    reject, a height typed in the font row) isn't a font at all, so pointing at
    Font Book would be a wild goose chase; a name that survives but isn't
    installed is exactly the Font Book case. xterm falls back to the app's mono
    for both, silently. Reported as typed, split by cause.

    `isAvailable` is injected — the pane measures the family against the
    generic bases — so this stays a pure function. */
export interface TerminalFontProblems {
  /** survived normalization, but the machine has no such family */
  missing: string[];
  /** never reached the font check: not a usable family name */
  unusable: string[];
}

export function missingTerminalFonts(
  userFont: string,
  isAvailable: (family: string) => boolean
): TerminalFontProblems {
  const missing: string[] = [];
  const unusable: string[] = [];
  for (const { name, css } of terminalFontParts(userFont)) {
    if (GENERIC_FAMILIES.has(name.toLowerCase())) continue;
    if (css === null) {
      if (!unusable.includes(name)) unusable.push(name);
      continue;
    }
    if (isAvailable(name)) continue;
    if (!missing.includes(name)) missing.push(name);
  }
  return { missing, unusable };
}

/** One palette quick action typed into the terminal HUD. */
export interface TerminalAction {
  /** palette row label */
  label: string;
  /** text typed into the PTY (a carriage return is appended on run) */
  command: string;
}

/** `terminal-actions` — palette rows that type a command into the ⌘⇧T HUD.
    These used to be two hardcoded rows naming the author's own
    agent skills (`/inbox-sweep`, `/cal`), which do nothing on anyone else's
    machine; now every user lists their own, or none. Format: one
    `Label: command` per list entry (or a bare `command`, which labels itself).
    Anything unparseable is dropped rather than rendered as a broken row. */
/* One list entry → its `Label: command` line, or null if it isn't one.
   `docs/vault-format.md` documents the format as `Label: command`, which YAML
   parses as a single-pair MAP unless the author quotes it — so both shapes
   reach us from real vaults and both have to survive the ⌘, editor round trip
   (the string-only filter used to delete the map-shaped ones). */
function terminalActionLine(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const pairs = Object.entries(item as Record<string, unknown>);
    if (pairs.length !== 1) return null;
    const [label, command] = pairs[0];
    if (typeof command !== "string") return null;
    return `${label}: ${command}`;
  }
  return null;
}

export function parseTerminalActions(props: Record<string, unknown>): TerminalAction[] {
  const raw = props[foldedPropKey(props, "terminal-actions")];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: TerminalAction[] = [];
  for (const item of items) {
    const line = terminalActionLine(item);
    if (line === null) continue;
    const s = line.trim();
    if (!s) continue;
    // split on the FIRST colon: labels don't contain one, commands may. A
    // colon at index 0 is a labelless entry, not a bare command — it falls
    // out below rather than becoming a row labelled ":…".
    const at = s.indexOf(":");
    const label = at >= 0 ? s.slice(0, at).trim() : s;
    const command = at >= 0 ? s.slice(at + 1).trim() : s;
    if (!label || !command) continue;
    out.push({ label, command });
  }
  return out;
}

/* The ⌘, form edits `terminal-actions` as one entry per line. Both
   directions stay dumb — trim and drop empties, nothing else. Validation is
   `parseTerminalActions`' job downstream (it silently drops what it can't
   read), so a half-written line is never rewritten under the cursor. */

/** stored value → textarea text */
export function terminalActionsToText(raw: unknown): string {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  // map-shaped entries flatten back to their `Label: command` line rather than
  // being filtered out — otherwise the next commit writes the box back without
  // them and silently deletes rows the user never touched.
  return items
    .map(terminalActionLine)
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** textarea text → stored list */
export function textToTerminalActions(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/* Key reads below fold casing: Settings.md is hand-editable, so a
   cased spelling (`Drop-Hint:`) must read like the documented one — same
   exact-first rule as every other frontmatter read. */

/** `drop-hint` — the drag-over pill explaining copy vs ⇧-link.
    Default ON; only an explicit `false` hides it, so an unset key or any
    typo'd value keeps the affordance discoverable. */
export function parseDropHint(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "drop-hint")];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `mod-hud` — the hold-⌘ shortcut HUD. Default ON, same rule as
    `drop-hint`: only an explicit `false` hides it, so an unset key or a typo'd
    value keeps a discovery affordance discoverable. */
export function parseModHud(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "mod-hud")];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `db-grid` — vertical column rules in database tables. Default
    ON, same rule as `drop-hint`: only an explicit `false` turns the grid off
    globally. A database's own ViewPref `grid` overrides this either way. */
export function parseDbGrid(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "db-grid")];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `task-stale-chips` — the `stale` / `undated` age chips on the Tasks board.
    Default ON, same rule as `drop-hint`: only an explicit `false`
    turns them off. This is the GLOBAL DEFAULT — a board that sets its own
    `stale_days` keeps its chips either way, and a task note with
    `stale: never` never wears one. */
export function parseTaskStaleChips(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "task-stale-chips")];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `auto-sync` — the timer lane of vault sync: push once edits settle, pull
    on open/focus and on a slow interval. Default ON, same rule as
    `drop-hint`: only an explicit `false` parks it, and the Sync pane's
    Push/Pull buttons work either way. Meaningless without a remote — the
    lane no-ops on an unconfigured vault regardless of this flag. */
export function parseAutoSync(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "auto-sync")];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}


/** `feed-curator` — the command the feed dashboard's refresh button
    runs: any command that re-curates the feed's items sheet. Run via
    the login shell with the vault root as cwd; empty = no curator plugged
    in, so the feed head offers the setup card instead of the button. Like
    `terminal-command` this is vault content that can arrive by sync or by
    an agent's write, so the exact string is gated behind the same
    per-machine trust approval before it ever runs (lib/termtrust.ts). */
export function parseFeedCurator(props: Record<string, unknown>): string {
  const v = props[foldedPropKey(props, "feed-curator")];
  return typeof v === "string" ? v.trim() : "";
}

/** The vault-root files the app itself owns (Settings.md joined): the seeded
    agent orientation pair for the ⌘⇧T terminal's CLI,
    plus the settings note behind the ⌘, sheet. Concealed from the app's own
    note surfaces so a vault reads as the user's content, not the tooling's.
    On disk, in the engine index and to Finder they stay ordinary notes —
    `show-agent-files: true` lists them in-app again, and the ⌘, sheet's
    "edit raw" opens Settings.md regardless. Exact names only: a user's own
    "agents notes.md" or a nested copy is normal content. */
export const APP_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", SETTINGS_PATH];

export function isAppFile(path: string): boolean {
  return APP_FILES.includes(path);
}

/** `show-agent-files` — the reveal switch for the files above.
    The key name predates Settings.md joining the set and is kept
    so existing vaults that set it stay revealed; the ⌘, sheet labels it
    "Show app files". Default OFF, inverted rule from `drop-hint`: only an
    explicit `true` reveals, so an unset key or a typo keeps the blank slate. */
export function parseShowAppFiles(props: Record<string, unknown>): boolean {
  const v = props[foldedPropKey(props, "show-agent-files")];
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/** The three things Substrate can send off this machine. Each has
    its own `net-*` switch in Settings.md, all default ON.

    Enforcement lives at the call sites, not in Rust: the shipped CSP allows no
    remote origin, so every request is made by the engine — but the engine only
    ever makes one because a TS call asked it to. Gate the ask and nothing
    leaves. `link-titles` gates the enrichment fetch behind link capture (the
    note is still created, from the bare URL), `fx-rates` gates the frankfurter
    read (`useFx` consults it; conversions fall back to the last saved rates),
    and `share-relay` gates the "Send as link" upload. */
export type NetFeature =
  | "link-titles"
  | "fx-rates"
  | "share-relay";

/** `net-link-titles` / `net-fx-rates` / `net-share-relay` — same rule as
    `drop-hint`: only an explicit `false` turns one off, so an unset key or a
    typo'd value leaves the app behaving as documented rather than quietly
    losing a feature. */
export function netAllowed(props: Record<string, unknown>, feature: NetFeature): boolean {
  const v = props[foldedPropKey(props, `net-${feature}`)];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/* `number-format` used to be read here, as a two-value dialect
   switch that reached only calc lines and unit cells. The number-locale key replaced it
   with `number-locale`, which every number surface honors; the retired key is
   still read — as a fallback, once — in numberLocale.ts, so a vault that set
   `intl` keeps its en-style numbers. Nothing else should parse either key. */

/** `window-opacity` — how solid the app's own surfaces are over the desktop,
    in percent (macOS). The backend reads the same key to install or
    remove the OS vibrancy material; this side paints the ground at the matching
    alpha. Clamping is deliberately NOT done: an out-of-range or unreadable
    value falls back to the default, because "150" is a mistake, not a wish for
    the maximum, and a silent clamp would hide it. */
/** Keep in step with `Settings::OPACITY_MIN` (src-tauri/src/vault/mod.rs),
    which carries the contrast measurement behind the 80. */
export const WINDOW_OPACITY_MIN = 80;
export const WINDOW_OPACITY_MAX = 100;
export const WINDOW_OPACITY_DEFAULT = 90;

export function parseWindowOpacity(props: Record<string, unknown>): number {
  const v = props[foldedPropKey(props, "window-opacity")];
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN;
  if (!Number.isFinite(n)) return WINDOW_OPACITY_DEFAULT;
  const r = Math.round(n);
  return r >= WINDOW_OPACITY_MIN && r <= WINDOW_OPACITY_MAX ? r : WINDOW_OPACITY_DEFAULT;
}

export function parseTerminalSettings(props: Record<string, unknown>): TerminalSettings {
  const str = (k: string) => {
    const v = props[foldedPropKey(props, k)];
    return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  };
  // height and width are parsed independently of the current dock: flipping
  // the dock must not have to re-read the note, and each side remembers the
  // size last chosen for it
  return {
    command: str("terminal-command"),
    cwd: str("terminal-cwd"),
    dock: parseTerminalDock(props[foldedPropKey(props, "terminal-dock")]),
    height: parseTerminalSize("bottom", props[foldedPropKey(props, "terminal-height")]),
    width: parseTerminalSize("right", props[foldedPropKey(props, "terminal-width")]),
    font: str("terminal-font"),
  };
}

