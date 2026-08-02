import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "../lib/tauri";
import { parseZoom, zoomLabel, ZOOM_STORAGE_KEY } from "../lib/zoom";

/**
 * SUB-686: overall app zoom (⌘= / ⌘− / ⌘0), the Notion idiom. Same
 * localStorage tier as the sidebar collapse (SUB-394): per-window
 * ergonomics, not vault state. In the real app the WEBVIEW zooms (native
 * text/layout scaling, like a browser); in the mock/dev browser that API
 * doesn't exist, so CSS zoom on the root stands in — same visual result,
 * and it gives Playwright something observable.
 */
export function useZoom(showToast: (msg: string) => void) {
  const [zoom, setZoom] = useState(() => parseZoom(localStorage.getItem(ZOOM_STORAGE_KEY)));

  useEffect(() => {
    if (isTauri) {
      // a refused setZoom (missing capability, IPC hiccup) must not look
      // like success in silence — the toast already said the level applied
      getCurrentWebview()
        .setZoom(zoom)
        .catch((e) => console.warn("setZoom failed", e));
    } else {
      // Chromium's non-standard but universally shipped page zoom
      (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom =
        zoom === 1 ? "" : String(zoom);
    }
  }, [zoom]);

  const applyZoom = useCallback(
    (next: number) => {
      // clamped no-op (⌘= at 200%, ⌘0 at 100%): stay silent instead of
      // re-toasting the same level on every press. Plain comparison, not a
      // setZoom updater — StrictMode double-invokes updaters, and a toast
      // inside one would fire twice in dev.
      if (next === zoom) return;
      localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
      setZoom(next);
      showToast(`Zoom ${zoomLabel(next)}`);
    },
    [zoom, showToast]
  );

  return { zoom, applyZoom };
}
