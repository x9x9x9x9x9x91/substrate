import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { invoke } from "./lib/tauri";
import { resetCaptureBox } from "./lib/captureprefill";
import type { NoteMeta } from "./lib/types";
import { looksLikeUrl } from "./lib/url";

// Floating quick-capture window: global hotkey shows it, Enter files the note
// into Inbox, Escape (or clicking away — the window hides on blur) dismisses.
const isTauri = "__TAURI_INTERNALS__" in window;

/** Drop any pending `substrate://capture?text=` prefill — the window is done
    with it, so the next ⌥Space capture opens empty. Awaited before
    the hide it belongs to, so it can never land on a *later* link's prefill.
    The blur-hide has no JS in it at all and is cleared Rust-side instead. */
async function dropPrefill(): Promise<void> {
  if (!isTauri) return;
  await invoke<void>("deeplink_clear_capture_prefill").catch(() => undefined);
}


async function hideWindow(): Promise<void> {
  // hiding is the window saying it's done: a prefill it didn't file dies here
  // rather than waiting for the next capture to inherit it
  await dropPrefill();
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .hide()
    .catch(() => undefined);
}

function CaptureApp() {
  const [q, setQ] = useState("");
  // Last save failure — the text stays in the input, Enter retries
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The window persists hidden between captures; every time the hotkey
  // re-shows it we start clean with the input focused — except when a
  // `substrate://capture?text=…` link put something there. The
  // prefill is *pulled* after the clear, never pushed before it, because this
  // reset is what would wipe it. One link fires this reset more than once
  // (`capture:prefill` and `tauri://focus`), so the pull must be repeatable —
  // hence a read that doesn't consume, and an explicit `dropPrefill` when the
  // window hides or files. The ordering rule lives in `lib/captureprefill.ts`,
  // where it is tested.
  const reset = useCallback(() => {
    setError(null);
    inputRef.current?.focus();
    void resetCaptureBox({
      setText: setQ,
      readPrefill: () =>
        isTauri ? invoke<string | null>("deeplink_capture_prefill") : Promise.resolve(null),
    });
  }, []);

  useEffect(() => {
    reset();
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let unlistenPrefill: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.listen("tauri://focus", reset).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
      // a capture window that was already open and focused gets no
      // `tauri://focus`, so the link tells it to pull directly
      win.listen("capture:prefill", reset).then((u) => {
        if (cancelled) u();
        else unlistenPrefill = u;
      });
    });
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenPrefill?.();
    };
  }, [reset]);


  const submit = async () => {
    const title = q.trim();
    if (!title) return;
    setError(null);
    // a pasted link becomes a reference note; the page title arrives in the background
    try {
      if (looksLikeUrl(title)) await invoke<NoteMeta>("url_capture", { url: title });
      else await invoke<NoteMeta>("vault_create", { title, folder: "Inbox" });
    } catch (e) {
      // never discard the text on failure: keep it in the input so the user
      // can retry (Enter) or copy it out — the window stays open
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setQ("");
    void hideWindow(); // files the note and drops any prefill it came from
  };

  const foot = { enter: looksLikeUrl(q) ? "capture link" : "file in Inbox", esc: "close" };

  return (
    <div
      className="palette capture-palette"
      style={{
        width: "100%",
        maxWidth: "none",
        marginTop: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <div>
        <div className="capture-row">
          {/* the rooted-asterisk brand mark, same geometry as the tray icon */}
          <svg
            className="capture-mark"
            viewBox="0 0 1024 1024"
            aria-hidden="true"
            stroke="currentColor"
            strokeLinecap="round"
            fill="none"
          >
            <g strokeWidth="96" transform="translate(0 15)">
              <line x1="512" y1="252" x2="512" y2="622" />
              <line x1="344" y1="330" x2="680" y2="528" />
              <line x1="680" y1="330" x2="344" y2="528" />
              <line x1="268" y1="622" x2="756" y2="622" strokeWidth="80" />
              <line x1="512" y1="622" x2="512" y2="742" />
            </g>
          </svg>
          <input
            ref={inputRef}
            className="palette-input"
            // titles/URLs, not prose — no macOS autocorrect bubble
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Capture to Inbox…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                void hideWindow();
              }
            }}
          />
        </div>
        {error && <div className="capture-error">couldn’t save — {error}</div>}
      </div>
      <div className="palette-foot">
        <span>
          <span className="key">↩</span> {foot.enter}
        </span>
        <span className="capture-foot-hint">
          <span className="key">esc</span> {foot.esc}
        </span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CaptureApp />
  </React.StrictMode>,
);
