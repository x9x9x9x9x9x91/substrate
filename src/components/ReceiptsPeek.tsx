import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { actorText, footerText, lastChangeText, receiptRows, relativeTime } from "../lib/receipts";
import { useHistoryLanes } from "./useHistory";
import { anchorFrom, type AnchorRect } from "./SelectMenu";

/** Receipts peek (spec §6) — who changed this fact, when, and to what.
    Anchored beside the chip or cell it belongs to, in the CalPeek mold:
    portalled, flipped and clamped to the viewport, dismissed by Esc, an
    outside press, or a scroll that moves the anchor out from under it.

    Rows are the fact's change points newest first; the lane is complete by
    construction, so five rows are visible and the rest are a scroll away. A
    row is a door: clicking one scrubs the vault to that snapshot. The footer
    never renders blank — either the lane reaches its own beginning or history
    was trimmed under it and says so (the trim trap, §6). */

const PEEK_W = 300;
const PEEK_MAX_H = 320;
const GAP = 8;

interface ReceiptsPeekProps {
  /** the fact's address — a frontmatter key on a note (§1) */
  path: string;
  factKey: string;
  /** the chip's or cell's viewport rect */
  anchor: AnchorRect;
  /** lanes reset with the vault; the store is keyed by this epoch */
  vaultEpoch: number;
  onClose: () => void;
  /** a row was clicked — scrub the vault to that snapshot */
  onScrub: (commit: string) => void;
  /** the footer's door into the note's own history panel */
  onOpenHistory: () => void;
}

export default function ReceiptsPeek({
  path,
  factKey,
  anchor,
  vaultEpoch,
  onClose,
  onScrub,
  onOpenHistory,
}: ReceiptsPeekProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  // one ref, one lane: the app-wide store answers a fact once per epoch, so a
  // peek opened twice on the same chip pays for one revwalk (§5)
  const refs = useMemo(() => [{ path, key: factKey }], [path, factKey]);
  const { ready, lanes } = useHistoryLanes(refs, vaultEpoch);
  const lane = lanes.find((l) => l.path === path && l.key === factKey);
  const rows = receiptRows(lane);
  const loading = !ready || !lane;

  // outside press and Esc close, like every other anchored overlay
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // the anchor rect goes stale the moment its pane scrolls — close rather
  // than float detached. Armed a beat after mount for the same reason CalPeek
  // arms late: the click that opened this peek may itself have scrolled the
  // chip into view, and that scroll lands after this listener exists.
  const armedRef = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      armedRef.current = true;
    }, 150);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const close = () => {
      if (armedRef.current) closeRef.current();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  // below the anchor by default, flipped above when the bottom half of the
  // window has no room, and clamped so a chip near the right edge doesn't
  // push the peek off screen
  const flipUp = anchor.bottom + PEEK_MAX_H + GAP > window.innerHeight && anchor.top > PEEK_MAX_H;
  const style: React.CSSProperties = {
    left: Math.max(GAP, Math.min(anchor.left, window.innerWidth - PEEK_W - GAP)),
    ...(flipUp ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
  };

  const menu = (
    <div
      className="receipts-peek"
      style={style}
      ref={boxRef}
      role="dialog"
      aria-label={`Receipts for ${factKey}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="receipts-head">
        <span className="receipts-key">{factKey}</span>
      </div>
      <div className="receipts-rows">
        {loading ? (
          <div className="receipts-empty">Reading history…</div>
        ) : rows.length === 0 ? (
          <div className="receipts-empty">No recorded changes</div>
        ) : (
          rows.map((p) => (
            <button
              key={p.commit}
              type="button"
              className="receipts-row"
              title={p.subject}
              aria-label={`${p.value ?? "cleared"} · ${actorText(p.actor, p.subject)} · ${relativeTime(p.ts_ms)} — open this snapshot`}
              onClick={() => onScrub(p.commit)}
            >
              <span className="receipts-val">
                {p.value ?? <span className="receipts-cleared">cleared</span>}
              </span>
              <span className="receipts-actor">{actorText(p.actor, p.subject)}</span>
              <span className="receipts-when">{relativeTime(p.ts_ms)}</span>
            </button>
          ))
        )}
      </div>
      <div className="receipts-foot">
        {/* never blank, in either state: a lane still loading says so, and a
            landed one states its own beginning or the trim boundary (§6) */}
        <span className="receipts-first">{loading ? "reading history…" : footerText(lane)}</span>
        <button type="button" className="receipts-open" onClick={onOpenHistory}>
          Open note history ↗
        </button>
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}

interface ChipReceiptLineProps {
  path: string;
  factKey: string;
  vaultEpoch: number;
  /** open the peek anchored on this line */
  onOpen: (anchor: AnchorRect) => void;
}

/** The chip editor's quiet last-change line (§6) — who touched this fact last
    and when, and the keyboard path into the same peek the hover glyph opens.
    Mounting it also warms the lane, so a peek opened from here is instant. */
export function ChipReceiptLine({ path, factKey, vaultEpoch, onOpen }: ChipReceiptLineProps) {
  const refs = useMemo(() => [{ path, key: factKey }], [path, factKey]);
  const { lanes } = useHistoryLanes(refs, vaultEpoch);
  const lane = lanes.find((l) => l.path === path && l.key === factKey);
  // before the lane lands the line still offers the door — it just can't
  // describe the last change yet
  const text = lastChangeText(lane) ?? "Receipts";
  return (
    <button
      type="button"
      className="chip-receipt-line"
      title="Who changed this, and when"
      onClick={(e) => onOpen(anchorFrom(e.currentTarget))}
    >
      {text}
    </button>
  );
}
