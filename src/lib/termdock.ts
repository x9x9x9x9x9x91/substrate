/* Terminal HUD geometry (SUB-863, SUB-864): which edge the ⌘⇧T panel docks to
   and how much of the window it takes.

   Both live in Settings.md — `terminal-dock`, `terminal-height`,
   `terminal-width` — so the drag handle and the ⌘, form write the same three
   keys and there is exactly one source of truth. The size is a *fraction of
   the window*, not pixels: a vault synced between a laptop and a big display
   should read as "the terminal takes a third of the screen" on both.

   Height and width get separate keys and separate clamps rather than one
   shared number. A comfortable bottom strip (45% of the height) and a
   comfortable right column (38% of the width) are different quantities, and
   flipping the dock should return you to the size you last chose for that
   side, not rescale the other one. */

import { normalizeNumberInput } from "./aggregate.ts";

export type TerminalDock = "bottom" | "right";

export const DEFAULT_TERMINAL_DOCK: TerminalDock = "bottom";

/** bottom dock: a strip, so it may grow tall enough to be a full workspace */
export const DEFAULT_TERMINAL_HEIGHT = 0.45;
export const TERMINAL_HEIGHT_MIN = 0.2;
export const TERMINAL_HEIGHT_MAX = 0.9;

/** right dock: a column beside the note, so it stops well short of the whole
    window — past ~70% the thing it is docked next to stops being readable */
export const DEFAULT_TERMINAL_WIDTH = 0.38;
export const TERMINAL_WIDTH_MIN = 0.2;
export const TERMINAL_WIDTH_MAX = 0.7;

/** The size range that applies to a dock, with the value an unset or unusable
    setting falls back to. */
export function terminalSizeRange(dock: TerminalDock): {
  min: number;
  max: number;
  fallback: number;
} {
  return dock === "right"
    ? { min: TERMINAL_WIDTH_MIN, max: TERMINAL_WIDTH_MAX, fallback: DEFAULT_TERMINAL_WIDTH }
    : { min: TERMINAL_HEIGHT_MIN, max: TERMINAL_HEIGHT_MAX, fallback: DEFAULT_TERMINAL_HEIGHT };
}

/** `terminal-dock` — only the two exact words dock anywhere but the bottom.
    An unset key, a typo, or a non-string all read as `bottom`, which is the
    shape the HUD has always had (SUB-398) and so the safe fallback. */
export function parseTerminalDock(v: unknown): TerminalDock {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "right" ? "right" : DEFAULT_TERMINAL_DOCK;
}

/** A stored/typed size fraction → the number to render with. Out-of-range and
    unparseable values fall back to the dock's default rather than clamping
    into it: a `terminal-height: 7` is a mistake, not a request for 90%. */
export function parseTerminalSize(dock: TerminalDock, v: unknown): number {
  const { min, max, fallback } = terminalSizeRange(dock);
  // de-DE typed fractions ("0,6") are the app's own display dialect, not a
  // typo — fold them to dot-decimal before parsing (SUB-926, SUB-636 family)
  const n =
    typeof v === "number" ? v : Number.parseFloat(typeof v === "string" ? normalizeNumberInput(v) : "");
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** A size arrived at by dragging → the number to render and store. Unlike a
    typed value this one IS clamped: the pointer runs past the edge of the
    allowed range constantly, and the panel should stop there rather than snap
    back to the default. Rounded to whole percent — that is the granularity
    the panel renders at (`Nvh`/`Nvw`) and it keeps Settings.md readable. */
export function clampDraggedSize(dock: TerminalDock, fraction: number): number {
  const { min, max, fallback } = terminalSizeRange(dock);
  if (!Number.isFinite(fraction)) return fallback;
  return Math.round(Math.min(max, Math.max(min, fraction)) * 100) / 100;
}

/** Drag geometry, in one place so it can be tested without a DOM.

    `grow` is pointer travel *towards the far edge* — the panel is anchored to
    a window edge, so dragging its inner edge away from that anchor makes it
    bigger, whichever dock it is in. Callers pass `startY - e.clientY` when
    docked bottom and `startX - e.clientX` when docked right. */
export function draggedSize(
  dock: TerminalDock,
  startFraction: number,
  grow: number,
  windowPx: number
): number {
  if (!(windowPx > 0)) return clampDraggedSize(dock, startFraction);
  return clampDraggedSize(dock, startFraction + grow / windowPx);
}
