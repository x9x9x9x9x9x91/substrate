/* Appearance dials (SUB-955) — the two Settings.md keys that move the app's
   look without touching its structure: `glow` (bloom intensity) and the accent
   tone pair (`accent-tone` + `accent-tone-nudge`).

   Both live in Settings.md like every other setting; this module owns the
   parse, the clamp and the one function that writes them onto the document
   element. Nothing here decides what a value LOOKS like — the CSS token table
   in styles.css does that — so the two sides can be read separately. */

import { foldedPropKey } from "./types.ts";

/** the curated accent tones (SUB-955). Sky is index 0 and is the shipped
    look: its token values are the exact SUB-932 hexes, so a fresh vault and a
    vault that explicitly picks `sky` render identically. */
export const TONES = [
  { id: "sky", label: "Sky" },
  { id: "teal", label: "Teal" },
  { id: "indigo", label: "Indigo" },
  { id: "violet", label: "Violet" },
] as const;

export type ToneId = (typeof TONES)[number]["id"];

export const DEFAULT_TONE: ToneId = "sky";

export const GLOW_MIN = 0;
export const GLOW_MAX = 100;
export const DEFAULT_GLOW = 0;

/** the fine-tune slider's bound, in HSL degrees around the chosen preset.

    ±12 rather than the fuller wheel the issue sketched: the SUB-932 family
    rule is that every ramp entry clears 3:1 as a shape on BOTH grounds (dark
    app, print paper), and rotating hue at fixed HSL lightness moves luminance.
    A sweep of all four presets × every moving slot × both grounds puts the
    first slot below 3:1 at −13° (sky's paper series-1, 2.97:1), so the dial
    stops at 12. Series-5 is fixed outside this sweep because rotating its
    warm khaki would cross the reserved state band. This is a nudge around a
    curated point, not a free hue wheel. */
export const NUDGE_MAX = 12;
export const DEFAULT_NUDGE = 0;

/** Where the dial changes what it is doing: below this the line language
    (strokes, dots, emphasised values) ramps up; above it that language is at
    full weight and the BARS fade in — the loudest mark on the page, so the
    last thing to light up.

    The number is not arbitrary. The 03.08 contact sheet's V2 and V3 differ
    only in whether bars bloom, so a single linear scalar could reproduce one
    of them but never both. Splitting the dial here puts V2 exactly at 70 and
    V3 exactly at 100 — both verified pixel-identical against the reference
    overrides — with a continuous ramp underneath. */
export const GLOW_BARS_FROM = 70;

export interface Appearance {
  /** 0–100; 0 (the default) compiles to no filter rules at all */
  glow: number;
  tone: ToneId;
  /** −12..12 degrees of hue offset around the preset */
  nudge: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  glow: DEFAULT_GLOW,
  tone: DEFAULT_TONE,
  nudge: DEFAULT_NUDGE,
};

/* Settings.md is hand-editable, so every read here folds key casing (SUB-924)
   and treats an unreadable value as the default rather than as an error — the
   same posture the rest of the settings parsers take. */

function num(props: Record<string, unknown>, key: string): number | null {
  const v = props[foldedPropKey(props, key)];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number.parseFloat(v.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `glow` — 0–100 bloom intensity. Default 0: the shipped look has no bloom,
    and 0 must stay the cheapest possible value (no filter, no shadow). */
export function parseGlow(props: Record<string, unknown>): number {
  const n = num(props, "glow");
  return n === null ? DEFAULT_GLOW : Math.round(clamp(n, GLOW_MIN, GLOW_MAX));
}

/** `accent-tone` — which curated preset the accent family wears. An unset or
    unknown value reads as sky, so a typo degrades to the shipped look. */
export function parseTone(props: Record<string, unknown>): ToneId {
  const v = props[foldedPropKey(props, "accent-tone")];
  if (typeof v !== "string") return DEFAULT_TONE;
  const want = v.trim().toLowerCase();
  return TONES.find((t) => t.id === want)?.id ?? DEFAULT_TONE;
}

/** `accent-tone-nudge` — hue offset in degrees around the preset, clamped to
    ±NUDGE_MAX. Clamped rather than rejected: a hand-typed 40 lands at 12 and
    the dial still reads true, instead of silently snapping back to 0. */
export function parseNudge(props: Record<string, unknown>): number {
  const n = num(props, "accent-tone-nudge");
  return n === null ? DEFAULT_NUDGE : Math.round(clamp(n, -NUDGE_MAX, NUDGE_MAX));
}

export function parseAppearance(props: Record<string, unknown>): Appearance {
  return { glow: parseGlow(props), tone: parseTone(props), nudge: parseNudge(props) };
}

/** the line language's 0–1 scalar: ramps to full weight at GLOW_BARS_FROM
    (the V2 picture) and holds there, so the top of the dial adds bars rather
    than pushing the strokes past what the round-2 sheet tested. */
export function lineScalar(glow: number): number {
  return Math.min(glow / GLOW_BARS_FROM, 1);
}

/** the bar stage's own 0–1 scalar: bars stay dark until GLOW_BARS_FROM and
    reach full V3 weight at 100, so they fade in rather than pop. */
export function barScalar(glow: number): number {
  if (glow <= GLOW_BARS_FROM) return 0;
  return (glow - GLOW_BARS_FROM) / (GLOW_MAX - GLOW_BARS_FROM);
}

/** custom properties are text, and a repeating decimal written in full is
    noise in the inspector — four places is finer than a rendered pixel */
function scalarText(n: number): string {
  return String(Number(n.toFixed(4)));
}

/** Write an appearance onto a root element (the document element in the app,
    a detached node in tests).

    The two gating ATTRIBUTES are the point of this shape: `data-glow` is
    absent at glow 0, so every bloom rule — which is written behind
    `[data-glow]` — fails to match and the browser composites the dashboard
    with no filter and no text-shadow at all. A `--glow: 0` scalar alone would
    still leave a 0px drop-shadow on the paint path. `data-glow-bars` is the
    same trick one stage up. */
export function applyAppearance(root: HTMLElement, a: Appearance): void {
  const glow = Math.round(clamp(a.glow, GLOW_MIN, GLOW_MAX));
  const bars = barScalar(glow);

  if (glow > 0) {
    root.dataset.glow = "on";
    root.style.setProperty("--glow", scalarText(lineScalar(glow)));
  } else {
    delete root.dataset.glow;
    root.style.removeProperty("--glow");
  }

  if (bars > 0) {
    root.dataset.glowBars = "on";
    root.style.setProperty("--glow-bars", scalarText(bars));
  } else {
    delete root.dataset.glowBars;
    root.style.removeProperty("--glow-bars");
  }

  // sky is the CSS file's own :root default, so it stays attribute-free —
  // the shipped look never depends on an attribute having been written.
  if (a.tone !== DEFAULT_TONE) root.dataset.tone = a.tone;
  else delete root.dataset.tone;

  const nudge = Math.round(clamp(a.nudge, -NUDGE_MAX, NUDGE_MAX));
  if (nudge !== 0) root.style.setProperty("--tone-nudge", String(nudge));
  else root.style.removeProperty("--tone-nudge");
}

/* SUB-1122: two writers repaint the appearance — the settings pane's
   optimistic preview, which is instant and local, and App's re-read of
   Settings.md after a vault event, which is a round trip. A drag is a preview
   that has NOT reached the note yet (a range input writes on release, not on
   every step), so for the length of that drag the note honestly still holds
   the old value — and any re-read repaints it over what the user is looking
   at. The echo of the PREVIOUS commit is exactly such a re-read, and it lands
   mid-drag: the look snaps back to the old value and stays there, because
   nothing writes again until the dial moves once more.

   So the pane CLAIMS the appearance when it previews and hands it back once
   the note has caught up (or the sheet is gone), and a read that resolves
   inside a claim drops its appearance — only its appearance; the rest of that
   read is still the truth. The claim is a pair of counters rather than a
   boolean because dials move independently: reconciling the field whose write
   just landed must not hand back a preview another field made in the
   meantime. */
let previewSeq = 0;
let reconciledSeq = 0;

/** the settings pane's repaint: `applyAppearance`, plus the claim */
export function previewAppearance(root: HTMLElement, a: Appearance): void {
  previewSeq += 1;
  applyAppearance(root, a);
}

/** where the claim stands — take this before a write, hand it to
    `reconcileAppearance` once that write has landed */
export function appearancePreviewSeq(): number {
  return previewSeq;
}

/** the note has caught up with everything previewed as of `seq` (or the pane
    is unmounting and claims nothing) */
export function reconcileAppearance(seq: number): void {
  if (seq > reconciledSeq) reconciledSeq = seq;
}

/** true while the document element shows something the note does not yet
    hold — Settings.md reads must leave the appearance alone */
export function appearancePreviewPending(): boolean {
  return previewSeq > reconciledSeq;
}
