/** SUB-686: overall app zoom, the Notion ⌘+/⌘−/⌘0 idiom. This module owns the
    pure pieces — the level ladder and the persisted-value parsing — so they
    run under node --test; the DOM/webview application lives in App, which is
    the only place that knows whether a real webview is present. */

/** The zoom ladder. Notion-style asymmetry: finer steps below 1 (shrinking
    past 80% fast makes text unreadable), coarser above. */
export const ZOOM_LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const ZOOM_STORAGE_KEY = "substrate.zoom";

/** The ladder index whose level is closest to `z` (ties round up). */
function nearestIndex(z: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if (Math.abs(ZOOM_LEVELS[i] - z) <= Math.abs(ZOOM_LEVELS[best] - z)) best = i;
  }
  return best;
}

/** One step up (+1) or down (−1) from `current`, clamped to the ladder's
    ends. An off-ladder current (hand-edited storage) snaps to the nearest
    rung first, so stepping never strands the level between rungs. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = nearestIndex(current);
  const next = Math.min(Math.max(i + dir, 0), ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[next];
}

/** Parse a persisted zoom value; anything unusable (absent, NaN, out of the
    ladder's range) is 1 — the app must never boot unreadable. */
export function parseZoom(raw: string | null): number {
  if (!raw) return 1;
  const z = Number(raw);
  if (!Number.isFinite(z)) return 1;
  if (z < ZOOM_LEVELS[0] || z > ZOOM_LEVELS[ZOOM_LEVELS.length - 1]) return 1;
  return z;
}

/** "110%" — the toast / settings label. */
export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}
