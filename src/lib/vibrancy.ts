/* SUB-951 — the frontend half of window vibrancy.

   The backend installs or removes the OS material (an `NSVisualEffectView`
   behind the window) for the same `window-opacity` key; this paints the app's
   own ground at the matching alpha, so the dial reads as "how much desktop
   shows through". The blur is always the material's — never a CSS
   `backdrop-filter`, which would blur the notes themselves.

   macOS-in-Tauri only, and only below 100: the plain webview, iOS and the
   Playwright mock never get the class, so their window stays exactly as
   opaque as before and no e2e can come to depend on a material only AppKit
   provides. At 100 the class is REMOVED rather than set to `100%`, so the
   solid `background: var(--bg)` rule applies bit-for-bit as it did before the
   setting existed. */

import { claimAppearancePreview } from "./appearance.ts";
import { isTauri } from "./tauri.ts";
import { WINDOW_OPACITY_MAX } from "./settings.ts";

export const vibrancyCapable = isTauri && /mac/i.test(navigator.platform);

/** Paint the window ground for `pct` (80–100). Idempotent; safe anywhere.

    The class lands on `<html>`, not `<body>`: index.html paints the canvas
    `#08090a` so the window never flashes white before React mounts, and an
    opaque canvas is what a translucent `<body>` would composite against — the
    material would be installed and invisible. The rule in styles.css clears
    that ground for exactly this class, which is also why the anti-flash paint
    survives untouched everywhere else. */
export function applyWindowOpacity(pct: number): void {
  const on = vibrancyCapable && pct < WINDOW_OPACITY_MAX;
  const root = document.documentElement;
  root.classList.toggle("vibrancy", on);
  if (on) root.style.setProperty("--window-opacity", `${pct}%`);
  else root.style.removeProperty("--window-opacity");
}

/** The settings pane's repaint: `applyWindowOpacity`, plus the appearance
    claim (SUB-1126).

    A drag previews a value the note does not hold yet, so the very next
    Settings.md read — the watcher echo of the PREVIOUS commit, which lands
    mid-drag — would repaint the old opacity over it and leave it there:
    nothing writes again until the dial moves. Same race the appearance dials
    lost in SUB-1122, and the same claim answers it; see lib/appearance.ts for
    why one counter covers both. Nothing here is undoable, so an abandoned
    drag still needs no undo: the release hands the claim back and the next
    read repaints from the note (the SUB-951 shape, unchanged).

    The claim here is belt-and-braces as the pane stands today: `slide` paints
    the appearance for every dial it drives, opacity included, so the drag is
    already inside a claim by the time this runs and the extra bump only moves
    a counter the release hands back wholesale. It is taken anyway because
    that appearance paint is a no-op on an opacity drag — the kind of line a
    later reader deletes as dead weight, which would silently reopen this bug.
    Claiming in the painter keeps the rule local to the thing it protects. */
export function previewWindowOpacity(pct: number): void {
  claimAppearancePreview();
  applyWindowOpacity(pct);
}
