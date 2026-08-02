import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { invoke } from "./lib/tauri";
import type { NoteMeta } from "./lib/types";
import { looksLikeUrl } from "./lib/url";

// Floating quick-capture window: global hotkey shows it, Enter files the note
// into Inbox, Escape (or clicking away — the window hides on blur) dismisses.
const isTauri = "__TAURI_INTERNALS__" in window;

async function hideWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .hide()
    .catch(() => undefined);
}

function CaptureApp() {
  const [q, setQ] = useState("");
  // SUB-113: last save failure — the text stays in the input, Enter retries
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The window persists hidden between captures; every time the hotkey
  // re-shows it we start clean with the input focused.
  const reset = useCallback(() => {
    setQ("");
    setError(null);
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    reset();
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .listen("tauri://focus", reset)
        .then((u) => {
          if (cancelled) u();
          else unlisten = u;
        });
    });
    return () => {
      cancelled = true;
      unlisten?.();
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
    void hideWindow();
  };

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
            // titles/URLs, not prose — no macOS autocorrect bubble (SUB-397)
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
          <span className="key">↩</span> {looksLikeUrl(q) ? "capture link" : "file in Inbox"}
        </span>
        <span className="capture-foot-hint">
          <span className="key">esc</span> close
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
