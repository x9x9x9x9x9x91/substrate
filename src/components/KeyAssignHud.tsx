import { useCallback, useEffect, useRef, useState } from "react";
import { ASSIGNABLE_KEYS, keyLabel, pinIndexForToken, splitFreeKeys, targetLabel } from "../lib/keyassign";
import { KEY_DRAG_MIME } from "../lib/sidebar";
import { XIcon } from "./Icons";

/** The key HUD: a floating panel of draggable key chips. Drag a free
    chip onto any sidebar destination to bind it; drag an assigned chip back
    here to clear it. Non-modal on purpose — the sidebar has to stay live
    underneath, so this is NOT an overlay: it's a fixed panel with the sheet's
    chrome, closing on Esc or an outside click (the KeyHints lifecycle). Assign
   mode is session-only; nothing about the panel persists.

    Free chips come in two grades. Digits 5–9 already carry the
    automatic pin mapping, so they are listed apart — assignable, but labelled
    with what the drop costs instead of offered as unclaimed. */
export default function KeyAssignHud({
  keys,
  pinCount,
  pins,
  onUnassign,
  onClose,
  labelCtx,
}: {
  /** `$sidebar.keys` — key token → target token */
  keys: Record<string, string>;
  /** live pinned-view count: digits 5–9 shadow that many pin shortcuts */
  pinCount: number;
  /** live pinned views in ⌘-digit order (App's pinIds) — the shadow section
      names the view each digit maps to */
  pins: string[];
  onUnassign: (token: string) => void;
  onClose: () => void;
  /** live rows, so an assigned chip reads as its destination's real name */
  labelCtx: {
    dashboards: { path: string; title: string }[];
    savedViews: { id: string; name: string }[];
    pinned: { path: string; title: string }[];
    tagFolders: { id: string; name: string }[];
  };
}) {
  const [closing, setClosing] = useState(false);
  const [over, setOver] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 90);
  }, [onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Esc and outside-click close, bubble phase. The panel owns no keys, so Esc
  // rides the bubble phase like KeyHints does — the registry's `esc-close` is
  // surface-scoped and stays live while the HUD is open, so one Esc can also
  // close a db side note or spend an armed search-return. Accepted: same
  // overlap KeyHints has, and dismissing a panel you just opened is the rarer
  // half of the gesture.
  useEffect(() => {
    if (closing) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // a click on a sidebar row is the user aiming at a destination, not a
      // dismissal — the panel would vanish mid-gesture otherwise
      if (wrapRef.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.(".sidebar")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [closing, close]);

  const { open, shadowing } = splitFreeKeys(keys, pinCount);
  const assigned = ASSIGNABLE_KEYS.filter((k) => k.token in keys);

  // The view a shadowing digit answers to — ⌘5 and ⌃5 name the same
  // pin (both halves of the pool reach it), resolved off the same pinIds
  // order the shortcut fires on
  const pinName = (token: string): string => {
    const i = pinIndexForToken(token, pinCount);
    const id = i === null ? undefined : pins[i];
    return labelCtx.savedViews.find((v) => v.id === id)?.name ?? "Pinned view";
  };

  const chip = (token: string, extra = "") => (
    <span
      key={token}
      className={`key key-chip${extra}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(KEY_DRAG_MIME, token);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      {keyLabel(token)}
    </span>
  );

  return (
    <div
      className={`key-hud${closing ? " closing" : ""}${over ? " drop-target" : ""}`}
      ref={wrapRef}
      // the whole panel is the unassign target: a chip dropped anywhere on it
      // comes home, whichever row it came from
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(KEY_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(KEY_DRAG_MIME)) return;
        e.preventDefault();
        setOver(false);
        const token = e.dataTransfer.getData(KEY_DRAG_MIME);
        if (token) onUnassign(token);
      }}
    >
      <div className="key-hud-head">
        <span className="key-hud-title">Assign keys</span>
        <button type="button" className="key-hud-close" onClick={close} aria-label="Close">
          <XIcon />
        </button>
      </div>
      <div className="key-hud-body">
        <div className="key-hud-hint">Drag a key onto a sidebar row.</div>
        {open.length > 0 && (
          <div className="key-hud-grid">{open.map((k) => chip(k.token))}</div>
        )}
        {open.length === 0 && shadowing.length === 0 && (
          <div className="key-hud-hint">Every key is assigned.</div>
        )}
        {/* Still free, but a pinned view already answers to them.
            Draggable on purpose — an assignment beating the pin mapping is the
            spec'd precedence; the section just stops the HUD calling them
            unclaimed. Each chip names the view it would displace. */}
        {shadowing.length > 0 && (
          <>
            <div className="key-hud-section">Used by pinned views</div>
            <div className="key-hud-assigned">
              {shadowing.map((k) => (
                <div className="key-hud-row" key={k.token}>
                  {chip(k.token, " key-chip-shadow")}
                  <span className="key-hud-row-label">{pinName(k.token)}</span>
                </div>
              ))}
            </div>
            <div className="key-hud-hint">
              Assigning one replaces its pin shortcut.
            </div>
          </>
        )}
        {assigned.length > 0 && (
          <>
            <div className="key-hud-section">Assigned — drop here to clear</div>
            <div className="key-hud-assigned">
              {assigned.map((k) => (
                <div className="key-hud-row" key={k.token}>
                  {chip(k.token)}
                  <span className="key-hud-row-label">
                    {targetLabel(keys[k.token], labelCtx)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
