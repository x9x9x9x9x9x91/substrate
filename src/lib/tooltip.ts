/* Hover tooltip geometry and timing.
 *
 * The app carried ~280 `title=` attributes: hover copy that lives in OS chrome,
 * appears after the system's ~1s delay, wears the OS font, and can't be styled,
 * positioned or read on a touch screen. This module owns the parts of the
 * replacement that are pure — where the bubble goes and when it opens — so they
 * are testable without a DOM. The React side (the singleton host and the
 * `tooltip()` prop factory) lives in `src/components/Tooltip.tsx`.
 *
 * Placement follows the CalPeek/SelectMenu grammar already in the app: measure
 * the trigger's viewport rect, prefer one side, flip when the preferred side
 * has no room, and clamp into the viewport rather than letting the surface
 * hang off the edge.
 */

/** Gap between the trigger and the bubble, px. */
export const TIP_GAP = 6;
/** Keep-out margin from the viewport edges, px. */
export const TIP_MARGIN = 8;

/** Hover dwell before a cold tooltip opens. Long enough that crossing a
    toolbar doesn't strobe, far short of the OS's ~1s (the whole point). */
export const TIP_DELAY_MS = 350;
/** After a tooltip closes, the next one opens instantly for this long — moving
    along a row of icon buttons reads as one continuous readout instead of
    re-paying the dwell at every step. */
const TIP_WARM_MS = 400;

export interface TipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipSize {
  width: number;
  height: number;
}

export interface TipViewport {
  width: number;
  height: number;
}

export type TipSide = "top" | "bottom";

/**
 * Bands at the top and bottom of the viewport the bubble must stay out of, px.
 *
 * The viewport is not the whole story: the app has fixed chrome that paints
 * ABOVE the bubble — the mini-player strip along the bottom (z 150) and the
 * time-travel banner along the top (z 190), both over the bubble's z 115,
 * which is deliberate (a tooltip belongs under toasts and banners, not over
 * them). Clamping to the raw viewport therefore has a failure mode that looks
 * like nothing at all: a sidebar-footer control with a folder queued gets a
 * bubble placed into the mini-player strip, "fits below" is true so the flip
 * never fires, and the copy is simply covered. Insetting the fit/clamp band by
 * that chrome makes the geometry answer the real question — where is there
 * room the user can SEE.
 */
export interface TipInset {
  top: number;
  bottom: number;
}

export const NO_TIP_INSET: TipInset = { top: 0, bottom: 0 };

export interface TipPlacement {
  left: number;
  top: number;
  /** which side of the trigger the bubble ended up on — drives the CSS
      transform-origin so it grows out of the thing it describes */
  side: TipSide;
}

/**
 * Place a bubble of `size` against the trigger `rect`.
 *
 * Below the trigger by default (the pointer is coming from above and the
 * bubble must not sit under it), flipped above when below would overflow and
 * above has room. Horizontally centred on the trigger, then clamped so the
 * bubble never leaves the viewport — a control in the sidebar's far corner
 * still gets fully readable copy.
 *
 * `inset` narrows the vertical band the bubble may occupy, keeping it clear of
 * fixed chrome that would paint over it (see `TipInset`). Both the fit test
 * and the clamp use the inset band, so the flip fires for a trigger that has
 * room in the viewport but none the user can see.
 */
export function placeTip(
  rect: TipRect,
  size: TipSize,
  viewport: TipViewport,
  gap: number = TIP_GAP,
  margin: number = TIP_MARGIN,
  inset: TipInset = NO_TIP_INSET
): TipPlacement {
  // the band the bubble may occupy: viewport minus the edge margin, minus any
  // chrome painting over it
  const bandTop = margin + Math.max(0, inset.top);
  const bandBottom = viewport.height - margin - Math.max(0, inset.bottom);

  const below = rect.top + rect.height + gap;
  const above = rect.top - gap - size.height;
  const fitsBelow = below + size.height <= bandBottom;
  const fitsAbove = above >= bandTop;
  const side: TipSide = fitsBelow || !fitsAbove ? "bottom" : "top";

  // centred on the trigger, then clamped. The max() guards the degenerate
  // case of a bubble wider than the viewport: clamp low rather than negative.
  const centred = rect.left + rect.width / 2 - size.width / 2;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(centred, margin), maxLeft);

  // clamped into the band. The max() keeps the degenerate case (a bubble
  // taller than the band, or chrome covering most of the window) anchored at
  // the top of what's visible rather than pushed under the bottom chrome.
  const rawTop = side === "bottom" ? below : above;
  const maxTop = Math.max(bandTop, bandBottom - size.height);
  const top = Math.min(Math.max(rawTop, bandTop), maxTop);

  return { left, top, side };
}

/**
 * How long to wait before opening, given when the last tooltip closed.
 *
 * `lastCloseMs = 0` means "none this session" — a cold open pays the full
 * dwell. Inside the warm window the answer is 0, which is what makes a row of
 * icon buttons feel like one surface rather than eighteen separate waits.
 */
export function tipDelay(
  now: number,
  lastCloseMs: number,
  delay: number = TIP_DELAY_MS,
  warm: number = TIP_WARM_MS
): number {
  if (lastCloseMs > 0 && now - lastCloseMs <= warm) return 0;
  return delay;
}
