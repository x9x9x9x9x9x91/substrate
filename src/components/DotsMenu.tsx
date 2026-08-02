import { useEffect, useRef, useState } from "react";
import { DotsIcon } from "./Icons";

interface DotsMenuProps {
  /** aria/tooltip label for the trigger button */
  title: string;
  buttonClass?: string;
  items: {
    label: string;
    icon?: React.ReactNode;
    /** quiet trailing note (e.g. trash's "recoverable") */
    hint?: string;
    /** the destructive lane — danger color, grouped apart by a hairline */
    danger?: boolean;
    separatorAbove?: boolean;
    run: () => void;
  }[];
}

/** The view-header ⋯ menu: a small right-aligned dropdown for rare actions
    (exports live here). Closes on pick, outside click, or Escape. */
export default function DotsMenu({ title, buttonClass, items }: DotsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="dots" ref={wrapRef}>
      <button
        className={`${buttonClass ?? "dots-btn"}${open ? " active" : ""}`}
        title={title}
        aria-label={title}
        onClick={() => setOpen((o) => !o)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="dots-menu">
          {items.map((it) => (
            <button
              key={it.label}
              className={`dots-item${it.danger ? " danger" : ""}${it.separatorAbove ? " separated" : ""}`}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.icon}
              <span className="dots-label">{it.label}</span>
              {it.hint && <span className="dots-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
