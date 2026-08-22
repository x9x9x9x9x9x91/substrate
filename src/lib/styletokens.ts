/** Bounded style tokens. Boards and custom kinds get to set mood,
 *  never CSS: an author picks a NAME from a closed roster and the design system
 *  decides what that name looks like. So `accent: teal` is expressible and
 *  `accent: #14b8a6`, `accent: 2px`, a font or a rule is not — there is no
 *  syntax that carries a value the theme didn't author, which is what keeps a
 *  board coherent no matter who (or what) wrote it.
 *
 *  Two tokens exist today:
 *
 *  - `accent: <name>` — one of the ten option colors, the same roster select
 *    options, status pills and database icons draw from. Cards and hub
 *    callouts carry it as `data-accent="<name>"`; the ten rules in
 *    styles.css are the only place a name becomes a color, so no surface can
 *    quietly invent an eleventh.
 *  - `size: tall` — a chart fence asking for the taller plot.
 *  - `span: 2` — a hub callout asking for the double-width card. The board,
 *    not the author, owns what a width is worth: 2 means "two of this
 *    board's columns", never a measurement.
 *
 *  UNKNOWN NAMES RENDER AS ABSENT, NEVER AS AN ERROR. This deliberately
 *  differs from how binding keys parse, where a typo throws: a wrong bind is a
 *  lie about the data and must be named, while a wrong accent is only a
 *  preference the theme declines to honor — worth no interruption, and never
 *  worth taking a board down. The value never reaches CSS as text either, so a
 *  fragment like `red; content: …` can't ride an interpolated var() name in.
 *
 *  Pure TS, no DOM/node imports: runs in the app and under `node --test`. */

import { ICON_TINTS, optionColorVar } from "./dbicons.ts";

/** The accent roster — the `--opt-*` vocabulary, shared with option colors so
    a board and its databases speak one set of hues. */
export const ACCENT_NAMES = ICON_TINTS;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** An author's accent as the renderer can use it: a roster name, or absent for
    anything else — a hex value, a px value, a typo, a non-string. */
export function parseAccent(raw: unknown): AccentName | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().toLowerCase();
  // optionColorVar is the single roster gate (src/lib/dbicons.ts); asking it
  // rather than re-listing the names keeps the palette in one place
  return optionColorVar(name) ? (name as AccentName) : undefined;
}

/** Chart sizes an author may ask for. One today; the token exists so the next
    one is a name here rather than a height in someone's note. */
export const CHART_SIZES = ["tall"] as const;
export type ChartSize = (typeof CHART_SIZES)[number];

/** A chart fence's `size` as the renderer can use it, or absent for the
    default plot — including for `size: 400px`, which is exactly the kind of
    value this token exists to refuse. */
export function parseChartSize(raw: unknown): ChartSize | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().toLowerCase();
  return (CHART_SIZES as readonly string[]).includes(name) ? (name as ChartSize) : undefined;
}

/** Card widths an author may ask for, counted in board columns. Two values,
    because a board that lets a card claim any width is a layout engine, not a
    note — 1 is the default cell and 2 is the wide one. */
export const CARD_SPANS = [1, 2] as const;
export type CardSpan = (typeof CARD_SPANS)[number];

/** A `span` token as the renderer can use it, or absent for the ordinary
    single-column card — including for `span: 3` and `span: 50%`, which the
    board declines the same silent way it declines an off-roster accent. */
export function parseCardSpan(raw: unknown): CardSpan | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return name === "2" ? 2 : name === "1" ? 1 : undefined;
}

/** The `|`-separated style tail of a callout header (`> [!note|teal|span:2]`),
    read as the tokens it carries. Each token is read on its own and an
    unreadable one is simply dropped, so `> [!note|teal|span:2]`,
    `> [!note|span:2]` and `> [!note|teal]` all work and
    `> [!note|teal|span:7|wat]` is the teal card it can honour. The accent
    stays a bare name because that is what shipped; later tokens are named
    (`span:2`) so the roster a value belongs to is never a guess.

    Both surfaces that read a callout header — the hub board and the editor's
    own callout decoration — call this, so an accent written beside a width
    tints in the editor exactly as it does on the board. */
export function parseCalloutStyle(tail: string | undefined): {
  accent?: AccentName;
  span?: CardSpan;
} {
  const out: { accent?: AccentName; span?: CardSpan } = {};
  for (const raw of (tail ?? "").split("|")) {
    const token = raw.trim();
    if (!token) continue;
    const named = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(token);
    if (named && named[1].toLowerCase() === "span") {
      const span = parseCardSpan(named[2]);
      if (span !== undefined) out.span = span;
    } else if (!named) {
      const accent = parseAccent(token);
      if (accent !== undefined) out.accent = accent;
    }
  }
  return out;
}
