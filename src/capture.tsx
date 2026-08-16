import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { invoke } from "./lib/tauri";
import { resetCaptureBox } from "./lib/captureprefill";
import type { NoteMeta } from "./lib/types";
import { looksLikeUrl } from "./lib/url";
import { escapeHint, voiceEscape } from "./lib/voice";

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

/** What the window knows about an in-flight recording. The recording itself
    lives in the backend, so this is a read-out rather than the source of
    truth: the window hides on blur while a capture keeps running, and a
    reopened window rejoins by asking (`voice_is_recording`) instead of
    remembering. `stem` is null for a capture this window didn't start. */
type Voice = { stem: string | null; startedMs: number; level: number };

/** m:ss — a voice note is a thought, not a session; minutes are the only unit
    worth reading at a glance. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  // false until the backend says it can record, so a build that can't (or a
  // machine with no input) shows no button rather than one that always fails
  const [micOk, setMicOk] = useState(false);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // an Escape past the confirm threshold arms the discard instead of doing it
  const [armed, setArmed] = useState(false);
  // the recorder stops itself at MAX_SECS; the window has to stop counting too
  const [capped, setCapped] = useState(false);
  const voiceOn = voice !== null;

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

  // Ask once whether recording is possible, and whether one is already in
  // flight — the chord and the tray both start captures without this window.
  useEffect(() => {
    let dead = false;
    void (async () => {
      let supported = false;
      try {
        supported = await invoke<boolean>("voice_supported");
      } catch {
        supported = false;
      }
      if (dead || !supported) return;
      setMicOk(true);
      try {
        // startedMs is a placeholder until the first meter tick carries the
        // backend's own elapsed; the clock reads 0:00 for at most one tick
        if (await invoke<boolean>("voice_is_recording") && !dead)
          setVoice({ stem: null, startedMs: Date.now(), level: 0 });
      } catch {
        // unreadable state reads as idle: the worst case is a button press
        // that fails loudly, not a window that lies about recording
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  // The clock runs off wall time rather than counting ticks, so a throttled
  // background window doesn't drift behind the recording it's timing.
  useEffect(() => {
    // past the cap the recording has already ended, so the clock holds at the
    // limit rather than counting time that isn't being recorded
    if (!voice || capped) return;
    const tick = () => setElapsed(Date.now() - voice.startedMs);
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [voice, capped]);

  // Meter ticks (~10/s) and the two outcomes the hotkey path can reach while
  // this window is open — without these a chord-stopped capture would leave
  // the window showing a recording that ended.
  useEffect(() => {
    if (!isTauri || !micOk) return;
    let dead = false;
    const offs: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const add = async (name: string, fn: (p: never) => void) => {
        const off = await listen(name, (e) => fn(e.payload as never));
        if (dead) off();
        else offs.push(off);
      };
      await add("voice:level", (p: { level: number; elapsed_ms: number }) =>
        setVoice((v) =>
          v === null
            ? v
            : // a capture this window didn't start has no trustworthy origin
              // of its own, so the backend's elapsed sets the clock
              { ...v, level: p.level, startedMs: v.stem === null ? Date.now() - p.elapsed_ms : v.startedMs },
        ),
      );
      // the chord starts and stops captures without this window, so an open
      // window has to be told rather than left showing idle over a recording
      await add("voice:started", (stem: string) => {
        // the clock is set by the tick effect, and corrected to the backend's
        // own elapsed by the first meter tick
        setVoice((v) => (v === null ? { stem, startedMs: Date.now(), level: 0 } : v));
        setArmed(false);
        setCapped(false);
      });
      // the recorder stops itself at the ceiling; without this the window
      // would show a running clock and a live meter over nothing
      await add("voice:limit", (secs: number) => {
        setCapped(true);
        setElapsed(secs * 1000);
        setVoice((v) => (v === null ? v : { ...v, level: 0 }));
      });
      await add("voice:filed", () => setVoice(null));
      await add("voice:error", (m: string) => {
        setVoice(null);
        setError(m);
      });
    });
    return () => {
      dead = true;
      offs.forEach((off) => off());
    };
  }, [micOk]);

  const startVoice = async () => {
    setError(null);
    try {
      const stem = await invoke<string>("voice_start");
      setElapsed(0);
      setArmed(false);
      setCapped(false);
      setVoice({ stem, startedMs: Date.now(), level: 0 });
    } catch (e) {
      // a refused or missing microphone is the common case here, and it reads
      // as a sentence in the same slot a failed save uses
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Stop and file. Typed text that hasn't been filed yet keeps the window
  // open — the voice note is its own note, and hiding here would throw away
  // something the user typed.
  const stopVoice = async () => {
    try {
      await invoke<NoteMeta>("voice_stop");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      setVoice(null);
    }
    if (q.trim()) inputRef.current?.focus();
    else void hideWindow();
  };

  const cancelVoice = async () => {
    setVoice(null);
    setArmed(false);
    setCapped(false);
    // never rejects for "wasn't recording", so a lost race just discards twice
    await invoke("voice_cancel").catch(() => undefined);
    inputRef.current?.focus();
  };

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
  // `foot` is mutated rather than re-declared so the voice case below is one
  // strippable block instead of a ternary the mirror would have to keep half of.
  if (voiceOn) {
    // at the ceiling the recording is already over — Enter still files it, but
    // the hint says so rather than implying it is still listening
    foot.enter = capped ? "file — stopped at the 15 min limit" : "file voice note";
    foot.esc = escapeHint(armed);
  }

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
                // the recording is what's in flight — Enter files it first,
                // and any typed text stays for the Enter after that
                if (voiceOn) return void stopVoice();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                // discard the recording but keep the window: Escape twice to
                // close, so a mis-hit doesn't lose typed text as well. Past
                // the confirm threshold the first Escape only arms it — the
                // recording keeps running while the hint asks.
                if (voiceOn) {
                  if (voiceEscape(elapsed, armed) === "confirm") return setArmed(true);
                  return void cancelVoice();
                }
                void hideWindow();
              }
              // any other key answers the pending discard question with "no"
              else if (armed) setArmed(false);
            }}
          />
          {voiceOn && (
            <>
              {/* peak over the last tick — presence, not precision: it only has
                  to answer "is it hearing me?" at a glance */}
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  width: 34,
                  height: 3,
                  borderRadius: 2,
                  background: "var(--border-soft)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${Math.round(Math.min(1, (voice?.level ?? 0) * 1.6) * 100)}%`,
                    background: "var(--text-2)",
                  }}
                />
              </span>
              <span
                className="capture-foot-hint"
                style={{
                  flex: "none",
                  marginLeft: 8,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 12,
                  color: "var(--text-2)",
                }}
              >
                {clock(elapsed)}
              </span>
            </>
          )}
          {micOk && (
            <button
              type="button"
              // inline rather than a shared class: the capture window is its
              // own 620×88 bundle and this is its only button
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                padding: 0,
                marginRight: 12,
                marginLeft: voiceOn ? 8 : 6,
                border: "none",
                background: "none",
                color: voiceOn ? "var(--text-2)" : "var(--text-3)",
                cursor: "pointer",
              }}
              aria-label={voiceOn ? "Stop and file voice note" : "Record voice note"}
              title={voiceOn ? "Stop and file" : "Record a voice note"}
              // the input keeps focus: the button is a pointer affordance, and
              // stealing focus would break Enter/Escape mid-recording
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void (voiceOn ? stopVoice() : startVoice())}
            >
              {voiceOn ? (
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "var(--danger)",
                  }}
                />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                </svg>
              )}
            </button>
          )}
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
