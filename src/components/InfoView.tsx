import { useEffect, useState, type ReactNode } from "react";
import { infoTipForElement, infoTipForView, type InfoTip } from "../lib/infotips";
import type { View } from "../lib/types";

const STORAGE_KEY = "substrate.infoView";

export default function InfoView({ view, trailing }: { view: View; trailing?: ReactNode }) {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === "1");
  const [tip, setTip] = useState<InfoTip>(() => infoTipForView(view));

  useEffect(() => {
    setTip(infoTipForView(view));
  }, [view]);

  useEffect(() => {
    if (!open) return;
    const onPointerOver = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      // The readout itself is not a help target. Preserve the current tip when
      // the pointer moves down to read or select it instead of replacing the
      // explanation with a generic description of the panel.
      if (event.target.closest(".info-view-panel")) return;
      const next = infoTipForElement(event.target) ?? infoTipForView(view);
      setTip((current) =>
        current.title === next.title && current.body === next.body ? current : next
      );
    };
    document.addEventListener("pointerover", onPointerOver);
    return () => document.removeEventListener("pointerover", onPointerOver);
  }, [open, view]);

  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      if (next) setTip(infoTipForView(view));
      return next;
    });
  };

  return (
    <div className={`info-view${open ? " open" : ""}`}>
      {/* SUB-452: the ? and any sibling "about the app" control share one row,
          so the changelog button sits immediately beside the ? rather than at
          the far edge of the sidebar column. */}
      <div className="info-view-row">
        <button
          type="button"
          className="info-view-toggle"
          title={open ? "Hide info view" : "Show info view"}
          aria-label={open ? "Hide info view" : "Show info view"}
          aria-expanded={open}
          aria-controls="info-view-panel"
          onClick={toggle}
        >
          ?
        </button>
        {trailing}
      </div>
      {open && (
        <aside
          id="info-view-panel"
          className="info-view-panel"
          aria-label="Info view"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="info-view-title">{tip.title}</div>
          <div className="info-view-body">{tip.body}</div>
        </aside>
      )}
    </div>
  );
}
