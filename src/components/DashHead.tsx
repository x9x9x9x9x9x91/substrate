import type { ReactNode } from "react";
import { NoteIcon } from "./Icons";
import { printPane } from "../lib/export";
import { BackButton } from "./BackButton";

/* The one dashboard header: title row over hairline. Every
   dashboard renders this — per-page headers were five different hand-built
   variants before. `actions` slots page controls (refresh, pause, window
   switcher, print) left of the source button. The breadcrumb kicker it used to
   print above the title is gone: the sidebar and the title
   already say where you are, and design-principles lists it under the
   anti-patterns. */
export function DashHead({
  title,
  state,
  actions,
  sourcePath,
  sourceTitle = "Open source note",
  onOpenSource,
}: {
  title: string;
  state?: { color?: string; label: string } | null;
  actions?: ReactNode;
  sourcePath?: string;
  sourceTitle?: string;
  onOpenSource?: (path: string) => void;
}) {
  return (
    <div className="dash-head">
      <BackButton />
      <span className="dash-title">{title}</span>
      {state && (
        <span className="dash-state">
          {state.color && <span className="dash-dot" style={{ background: state.color }} />}
          {state.label}
        </span>
      )}
      <span className="dash-actions">
        {actions}
        {sourcePath && onOpenSource && (
          <button
            className="dash-source"
            title={sourceTitle}
            onClick={() => onOpenSource(sourcePath)}
          >
            <NoteIcon />
          </button>
        )}
      </span>
    </div>
  );
}

/** The print action for the portable dashboard kinds — it slots
    into DashHead's `actions` the same way the other page controls do. The
    click clones the dashboard's own `.dash-inner` (the live pane, active
    workbook page included) into the note path's print surface. */
export function DashPrintButton() {
  return (
    <button
      type="button"
      className="sheet-tool"
      title="Print the dashboard — Save as PDF lives in the print dialog"
      onClick={(e) => {
        const pane = e.currentTarget.closest(".dash-inner");
        if (pane) printPane(pane).catch(console.error);
      }}
    >
      Print
    </button>
  );
}
