/* Settings.md is the app's settings surface (a plain root note, hot-reloaded
   by the backend watcher). The backend consumes `capture-hotkey` and
   `close-to-tray`; the terminal HUD keys (SUB-398) are frontend-owned — the
   PTY spawn call passes them down, so the Rust side never parses them. */

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
  /** which window edge the HUD docks to (SUB-864) */
  dock: TerminalDock;
  /** bottom-dock height as a fraction of the window, 0.2–0.9 */
  height: number;
  /** right-dock width as a fraction of the window, 0.2–0.7 (SUB-864) */
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

/** `terminal-font` → the xterm `fontFamily` string (SUB-862).

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
export function terminalFontFamily(userFont: string, fallbackChain: string): string {
  const families: string[] = [];
  for (const part of userFont.split(",")) {
    let f = part.trim();
    const quoted = f.match(/^(['"])(.*)\1$/);
    if (quoted) f = quoted[2].trim();
    // whitelist, and not a bare number (a height typed into the font row)
    if (!f || !/^[A-Za-z0-9 _.-]+$/.test(f) || /^[\d. ]+$/.test(f)) continue;
    // bare only when it's a clean CSS identifier — keeps generic keywords
    // (monospace) working; anything else (spaces, dots, leading digit) is
    // quoted so one odd name can't invalidate the whole declaration
    families.push(/^[A-Za-z][A-Za-z0-9_-]*$/.test(f) ? f : `"${f}"`);
  }
  return families.length ? `${families.join(", ")}, ${fallbackChain}` : fallbackChain;
}

/** One palette quick action typed into the terminal HUD (SUB-441). */
export interface TerminalAction {
  /** palette row label */
  label: string;
  /** text typed into the PTY (a carriage return is appended on run) */
  command: string;
}

/** `terminal-actions` — palette rows that type a command into the ⌘⇧T HUD
    (SUB-441). These used to be two hardcoded rows naming the author's own
    agent skills (`/inbox-sweep`, `/cal`), which do nothing on anyone else's
    machine; now every user lists their own, or none. Format: one
    `Label: command` per list entry (or a bare `command`, which labels itself).
    Anything unparseable is dropped rather than rendered as a broken row. */
/* One list entry → its `Label: command` line, or null if it isn't one.
   `docs/vault-format.md` documents the format as `Label: command`, which YAML
   parses as a single-pair MAP unless the author quotes it — so both shapes
   reach us from real vaults and both have to survive the ⌘, editor round trip
   (SUB-476: the string-only filter used to delete the map-shaped ones). */
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
  const raw = props["terminal-actions"];
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

/* SUB-476: the ⌘, form edits `terminal-actions` as one entry per line. Both
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

/** `drop-hint` — the drag-over pill explaining copy vs ⇧-link (SUB-438).
    Default ON; only an explicit `false` hides it, so an unset key or any
    typo'd value keeps the affordance discoverable. */
export function parseDropHint(props: Record<string, unknown>): boolean {
  const v = props["drop-hint"];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `mod-hud` — the hold-⌘ shortcut HUD (SUB-490). Default ON, same rule as
    `drop-hint`: only an explicit `false` hides it, so an unset key or a typo'd
    value keeps a discovery affordance discoverable. */
export function parseModHud(props: Record<string, unknown>): boolean {
  const v = props["mod-hud"];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** `db-grid` — vertical column rules in database tables (SUB-607). Default
    ON, same rule as `drop-hint`: only an explicit `false` turns the grid off
    globally. A database's own ViewPref `grid` overrides this either way. */
export function parseDbGrid(props: Record<string, unknown>): boolean {
  const v = props["db-grid"];
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}

/** The vault-root agent orientation files (SUB-831): seeded for the ⌘⇧T
    terminal's agent CLI, but concealed from the app's own note surfaces so a
    fresh vault reads as the user's blank slate. On disk, in the engine index
    and to Finder they stay ordinary notes — `show-agent-files: true` lists
    them in-app again. Exact names only: a user's own "agents notes.md" or a
    nested copy is normal content. */
export const AGENT_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

export function isAgentFile(path: string): boolean {
  return AGENT_FILES.includes(path);
}

/** `show-agent-files` — the reveal switch for the two files above (SUB-831).
    Default OFF, inverted rule from `drop-hint`: only an explicit `true`
    reveals, so an unset key or a typo keeps the blank slate. */
export function parseShowAgentFiles(props: Record<string, unknown>): boolean {
  const v = props["show-agent-files"];
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

export function parseTerminalSettings(props: Record<string, unknown>): TerminalSettings {
  const str = (k: string) => {
    const v = props[k];
    return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  };
  // height and width are parsed independently of the current dock: flipping
  // the dock must not have to re-read the note, and each side remembers the
  // size last chosen for it
  return {
    command: str("terminal-command"),
    cwd: str("terminal-cwd"),
    dock: parseTerminalDock(props["terminal-dock"]),
    height: parseTerminalSize("bottom", props["terminal-height"]),
    width: parseTerminalSize("right", props["terminal-width"]),
    font: str("terminal-font"),
  };
}
