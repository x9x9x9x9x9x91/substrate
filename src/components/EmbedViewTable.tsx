/** The read-only live-table body a resolved ````view` embed renders (SUB-860).
    Extracted from the workbook's view page so the two read-only surfaces that
    show one — a workbook `view:`/`saved:` page and a hub dashboard's fence —
    are literally the same table rather than two drifting copies. Chrome-less
    by design: the head (title, row count, "Open database") belongs to the
    surface, which knows whether it owns a page or a section slot.

    The editor's inline widget (lib/editor-widgets.ts) stays separate — it is
    imperative DOM with cell editing attached; these surfaces are read-only. */

import type { EmbedResult } from "../lib/embeds";

export default function EmbedViewTable({
  result,
  onOpenSource,
  className,
}: {
  /** the resolved, non-error half of an EmbedResult */
  result: Extract<EmbedResult, { columns: string[] }>;
  onOpenSource: (path: string) => void;
  /** surface modifier alongside the shared `.embed-view-table` */
  className?: string;
}) {
  return (
    <>
      <table className={`embed-view-table${className ? ` ${className}` : ""}`}>
        <thead>
          <tr>
            <th>Title</th>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.path}>
              <td className="embed-view-title">
                <button type="button" className="dash-link" onClick={() => onOpenSource(r.path)}>
                  {r.title}
                </button>
              </td>
              {r.cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Why the table is short, said honestly (SUB-942). An author's `limit:`
          and the surface's safety cap are different facts: the first is the
          table they asked for, the second is rows we declined to paint. Both
          state the count they can see against the full match count, so a
          five-row cut of twenty-three never reads as "twenty-three releases". */}
      {result.cut && (
        <div className="dash-foot">
          {result.cut.kind === "limit"
            ? `${result.rows.length} of ${result.total} rows — this view's limit`
            : `${result.rows.length} of ${result.total} rows — open the database for the rest`}
        </div>
      )}
    </>
  );
}
