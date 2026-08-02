import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a hairline above this item — groups it apart (e.g. the destructive lane). */
  separatorAbove?: boolean;
  /** Keep the menu open after selection — a drill-in item that swaps the
      item list (the editor's "Turn into…" page) instead of running an action. */
  keepOpen?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const ITEM_H = 28;
const PAD = 5;

/**
 * Right-click menu, Linear-quiet. Pointer-driven; keyboard (arrows/Enter/Esc)
 * works too since the menu takes focus on open. Closes on outside press,
 * Escape, or scroll.
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sel, setSel] = useState(-1);

  // clamp inside the viewport once we know our real size
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 6),
      top: Math.min(y, window.innerHeight - r.height - 6),
    });
    el.focus();
  }, [x, y]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      const enabled = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.disabled);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (enabled.length === 0) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const cur = enabled.findIndex(({ i }) => i === sel);
        const next = cur === -1 ? (dir === 1 ? enabled[0] : enabled[enabled.length - 1]) : enabled[(cur + dir + enabled.length) % enabled.length];
        setSel(next.i);
      } else if (e.key === "Enter" && sel >= 0 && items[sel] && !items[sel].disabled) {
        e.preventDefault();
        e.stopPropagation();
        items[sel].onSelect();
        if (!items[sel].keepOpen) onClose();
      }
    },
    [items, sel, onClose]
  );

  useEffect(() => {
    // scroll events already in flight as the menu opened (the browser's
    // scroll-into-view for the triggering click arrives a frame late) must
    // not close it instantly — only a real scroll after opening should.
    // Armed by frame, not by clock: the reveal scroll is a frame away, and a
    // frame is however long the machine needs (on a loaded CI container it
    // outran a 150ms budget, so the menu closed before it could be clicked).
    // Scroll events fire in the rendering step ahead of that step's animation
    // callbacks, so anything still unarmed here is the reveal.
    let armed = false;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        armed = true;
      });
    });
    const close = (e: Event) => {
      if (e.type === "scroll" && !armed) return;
      onClose();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div className="ctx-overlay" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="ctx-menu"
        style={{ ...pos, minWidth: 180 }}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        {items.map((it, i) => (
          <div
            key={`${it.label}-${i}`}
            className={`ctx-item${i === sel ? " selected" : ""}${it.danger ? " danger" : ""}${
              it.disabled ? " disabled" : ""
            }${it.separatorAbove && i > 0 ? " separated" : ""}`}
            style={{ height: ITEM_H, padding: `0 ${PAD + 7}px` }}
            onMouseEnter={() => setSel(i)}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              if (!it.keepOpen) onClose();
            }}
          >
            {it.icon}
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
