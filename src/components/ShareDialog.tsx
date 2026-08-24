import { useEffect, useState } from "react";
import type { NoteMeta } from "../lib/types";
import SendLinkDialog from "./SendLinkDialog";

/* One "share this" door. Sharing had grown three front doors — a link, a lens
   and a letterbox — that already sit on the same relay, the same sealed wire
   format and the same relay secret; only the shape of the sharing differed. They are modes now: one dialog, one picker, and each mode
   is the surface it always was, unchanged in behaviour.

   The picker only appears when there is a choice to make, so a build that
   carries a single mode shows that mode's dialog exactly as before. */

export type ShareMode = "link" | "lens" | "letterbox";

const MODES: { id: ShareMode; label: string; hint: string }[] = [
  { id: "link", label: "Send as link", hint: "one sealed copy, expires" },
];

export default function ShareDialog({
  meta,
  onClose,
  onToast,
}: {
  meta: NoteMeta;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [mode, setMode] = useState<ShareMode>("link");

  /* Only the fenced modes have anything to say back to the app, so a build
     carrying just the link mode never reaches for this — the door still takes
     it so the caller passes the same props to every build. */
  void onToast;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const picked = MODES.find((m) => m.id === mode) ?? MODES[0];
  const target = meta.title;

  /* Letterbox is the one mode with two columns of settings to show, so it asks
     for a wider door. Only builds that carry that mode carry the class, which
     is why the widening lives behind the same fence the mode does. */
  let wide = "";

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`dbform${wide}`}
        role="dialog"
        aria-label="Share"
      >
        <div className="dbform-title">Share “{target}”</div>
        {MODES.length > 1 && (
          <div className="sendlink-expiry" role="radiogroup" aria-label="How to share">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                title={m.hint}
                className={`selmenu-btn${mode === m.id ? " sendlink-expiry-on" : ""}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {MODES.length > 1 && <div className="dbform-note">{picked.hint}.</div>}
        {mode === "link" && <SendLinkDialog meta={meta} onClose={onClose} embedded />}
      </div>
    </div>
  );
}
