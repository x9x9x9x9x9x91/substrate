import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../lib/tauri";
import {
  DONATE_URL,
  NAG_COPY,
  NAG_STORAGE_KEY,
  afterBoot,
  afterForeverDismiss,
  nagEnabled,
  parseNagState,
  serializeNagState,
  shouldNag,
} from "../lib/donate";
import { XIcon } from "./Icons";

/** The €1 nag — a quiet banner, not a modal: it lands at the bottom
    of the window on app boot, never over work in progress, and never steals
    focus from the editor. Esc or the close button dismisses it for this
    session; the checkbox retires it for good.

    Its innards ride the shared dialog grammar — dbform-note for the
    sentence, dbform-foot for the action row, dbform-x + XIcon for dismiss — so
    only the toast shell is its own. It deliberately does NOT compose `overlay`
    the way the dbform dialogs do: a backdrop would put it on top of work in
    progress, which is the one thing this surface must never do.

    Dormant unless the master switch (NAG_ENABLED in lib/donate.ts) is on —
    with it off this component decides "no" before touching storage, so a
    disabled build writes nothing and renders nothing. */
export default function DonationNag() {
  // Decided once, on mount: whether this boot shows the nag. The same effect
  // stamps the boot into storage, so the schedule advances exactly once per
  // launch rather than on every re-render.
  const [open, setOpen] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const enabled = nagEnabled(isTauri);
    if (!enabled) return; // master switch off: zero storage traffic
    const now = Date.now();
    const state = parseNagState(localStorage.getItem(NAG_STORAGE_KEY));
    const showing = shouldNag(state, now, enabled);
    localStorage.setItem(NAG_STORAGE_KEY, serializeNagState(afterBoot(state, now, showing)));
    setOpen(showing);
  }, []);

  // Listen from mount, not from `open`: gating this on `open` put the
  // listener in a later commit than the one that paints the banner, so an Esc
  // pressed the instant it appeared hit no handler and the nag stayed up.
  // Closing an already-closed nag is a no-op, so listening while hidden is free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const forever = () => {
    const state = parseNagState(localStorage.getItem(NAG_STORAGE_KEY));
    localStorage.setItem(NAG_STORAGE_KEY, serializeNagState(afterForeverDismiss(state)));
    setOpen(false);
  };

  return (
    <aside className="donate-nag" aria-label="Support Substrate">
      <div className="dbform-note">{NAG_COPY}</div>
      <div className="dbform-foot donate-nag-foot">
        <a
          className="selmenu-btn donate-nag-link"
          href={DONATE_URL}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (!isTauri) return;
            e.preventDefault();
            openUrl(DONATE_URL).catch(console.error);
          }}
        >
          Donate €1
        </a>
        <label className="donate-nag-forever">
          <input type="checkbox" onChange={forever} />
          I donated (or just want this gone) — don't show this again.
        </label>
        <button type="button" className="dbform-x" aria-label="Dismiss" onClick={() => setOpen(false)}>
          <XIcon />
        </button>
      </div>
    </aside>
  );
}
