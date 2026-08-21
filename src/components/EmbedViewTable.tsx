/** The live-table body a resolved ````view` embed renders.
    Extracted from the workbook's view page so the surfaces that show one — a
    workbook `view:`/`saved:` page, a grid card, and a hub dashboard's fence —
    are literally the same table rather than drifting copies. Chrome-less by
    design: the head (title, row count, "Open database") belongs to the
    surface, which knows whether it owns a page or a section slot.

    Cells edit in place when the surface hands down an `edit` prop.
    The editor's inline widget (lib/editor-widgets.ts) is still separate code —
    it is imperative DOM inside CodeMirror — but the DECISIONS are shared: what
    a cell means, whether it opens a picker, whether it takes a write and how a
    commit is shaped all live in lib/viewcell.ts, and the picker itself is the
    same CellEditor. So a status cell on a hub behaves like the identical fence
    two panes over: same picker, same undo, same failure toast. Without `edit`
    the table keeps its LOOK and loses only its affordances: a checkbox still
    paints as a box, because how a value looks is a property of the value, not
    of whether this surface happens to be able to write it. */

import { useLayoutEffect, useRef, useState } from "react";
import type { EmbedResult } from "../lib/embeds";
import {
  commitCellText,
  viewCellEditable,
  viewCellModel,
  viewCellPaint,
  viewCellWritable,
} from "../lib/viewcell";
import { chipCommitValue, propListValue, type RelationCandidate } from "../lib/relation";
import { foldedPropKey, foldedPropStr, type PropValue } from "../lib/types";
import CellEditor from "./CellEditor";
import { anchorFrom, OptionPill, type AnchorRect } from "./SelectMenu";
import { useFreshness } from "../hooks/useFreshness";
import { ageCell, reviewWindow } from "../lib/agecell";
import { factRefKey } from "../lib/freshcache";

/** The write path a surface lends its embeds. Optional as a whole: a surface
    that can't write simply doesn't pass it, and every affordance stays off.
    These are the app's own handlers (undoable prop writes, the used-values and
    relation-candidate lists) — the ones the editor fence already commits
    through, not a second implementation. */
export interface EmbedEdit {
  setProp: (path: string, key: string, value: PropValue) => void;
  usedValues: (dbType: string, column: string) => string[];
  relationCandidates: (targetType: string) => RelationCandidate[];
  createRelation?: (path: string, key: string, targetType: string, title: string) => void;
}

export default function EmbedViewTable({
  result,
  onOpenSource,
  className,
  edit,
}: {
  /** the resolved, non-error half of an EmbedResult */
  result: Extract<EmbedResult, { columns: string[] }>;
  onOpenSource: (path: string) => void;
  /** surface modifier alongside the shared `.embed-view-table` */
  className?: string;
  /** omit to keep the table read-only */
  edit?: EmbedEdit;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [editing, setEditing] = useState<{ path: string; column: string } | null>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  /* A click that dismisses an open picker does only that. The
     picker closes itself on the window's mousedown, which runs after ours, so
     the flag has to be taken here and spent on the click that follows. */
  const dismissing = useRef(false);
  /* Ages for the freshness columns this table asked for, filled in when the
     history answers. A table without one asks for nothing. */
  const ages = useFreshness(result);
  /* One instant for the whole paint. `Date.now()` per cell would date the
     first row and the last from different moments, and re-read the clock on
     every repaint for a number that moves once a day. */
  const painted = Date.now();

  /* Re-anchor after every repaint, and drop the editor when its row left the
     table — a status edit can re-sort or filter the query out from under an
     open picker. The widget re-opens against the fresh snapshot for the same
     reason; here the commit closures are rebuilt by the render itself. */
  useLayoutEffect(() => {
    if (!editing) return;
    const td = cellElement(tableRef.current, editing.path, editing.column);
    if (!td || !result.rows.some((r) => r.path === editing.path)) {
      setEditing(null);
      setAnchor(null);
      return;
    }
    setAnchor(anchorFrom(td));
  }, [editing, result]);

  const model = editing ? cellModelAt(result, editing.path, editing.column) : null;

  function onMouseDown(e: React.MouseEvent) {
    // primary button only — right/middle click must not write
    if (e.button !== 0 || !edit) return;
    dismissing.current = editing !== null;
    const hit = cellHit(e.target as HTMLElement, result);
    if (!hit || hit.model.kind !== "checkbox") return;
    // checked stores the YAML scalar true, unchecked REMOVES the prop — never
    // writes false. The read-only guard belongs on the write itself: this
    // toggle never opens an editor, so the editor guard misses it. It
    // fires under a dismissing click too, matching the database
    // pane, where an open menu closes and the checkbox still takes the click.
    if (!viewCellWritable(result, hit.column)) return;
    edit.setProp(hit.path, hit.model.actualKey, hit.model.checked ? null : true);
  }

  function onClick(e: React.MouseEvent) {
    if (e.button !== 0 || !edit) return;
    if (dismissing.current) {
      dismissing.current = false;
      return;
    }
    const hit = cellHit(e.target as HTMLElement, result);
    if (!hit || !viewCellEditable(result, hit.column, hit.model)) return;
    // clicking the open cell closes it rather than reopening the menu the
    // outside-mousedown just dismissed
    if (editing?.path === hit.path && editing.column === hit.column) return;
    setEditing({ path: hit.path, column: hit.column });
    setAnchor(anchorFrom(hit.td));
  }

  const close = () => {
    setEditing(null);
    setAnchor(null);
  };

  return (
    <>
      <table
        ref={tableRef}
        className={`embed-view-table${className ? ` ${className}` : ""}`}
        onMouseDown={onMouseDown}
        onClick={onClick}
      >
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
            <tr key={r.path} data-path={r.path}>
              <td className="embed-view-title">
                <button type="button" className="dash-link" onClick={() => onOpenSource(r.path)}>
                  {r.title}
                </button>
              </td>
              {r.cells.map((c, i) => {
                // a live select value wears its option pill, exactly like the
                // same value hand-typed into a markdown table beside it
                // (design principle 4 — one concept, one treatment). The
                // embed knows which database it queried, so the colour comes
                // from that type's own schema; a joined column's value
                // belongs to ANOTHER type, so a same-named local prop never
                // answers for it — the joined-column rule, applied to paint.
                const column = result.columns[i] ?? "";
                // the model is derived either way: a checkbox box is as much
                // the cell's look as a pill is, so a surface with no write
                // path must still paint the box rather than the raw string
                // `true`. `viewCellPaint` takes no `edit` — the two surfaces
                // cannot drift, which is the split this issue exists to close.
                const cellModel = viewCellModel(result, r.props, column);
                const paint = viewCellPaint(result, column, c, cellModel);
                // affordances only where a write can land: no `edit`, no
                // pointer, no inert-vs-live distinction — the table reads as
                // the flat read-only one it was
                const classes = edit
                  ? [
                      "embed-view-cell",
                      viewCellEditable(result, column, cellModel) ? "" : "embed-view-cell-inert",
                      editing?.path === r.path && editing.column === column ? "editing" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : undefined;
                // a freshness cell shows how long the value beside it has
                // stood, tinted once it is near or past the window its schema
                // declared. Quiet by construction: text weight only, and
                // nothing here can be clicked, written or dismissed.
                const ageProp = result.ages?.[column];
                if (ageProp !== undefined) {
                  const fresh = ages.get(factRefKey(r.path, ageProp));
                  const cell = fresh
                    ? ageCell(ageProp, fresh, reviewWindow(result.typeSchema, ageProp), painted)
                    : null;
                  return (
                    <td key={i} className={classes}>
                      {cell && (
                        <span className={cell.className} title={cell.title}>
                          {cell.text}
                        </span>
                      )}
                    </td>
                  );
                }
                return (
                  <td key={i} className={classes} data-column={edit ? column : undefined}>
                    {paint.kind === "checkbox" ? (
                      // the whole cell is the affordance — a box, not the
                      // string "true"
                      <span
                        className={`prop-check${paint.checked ? " on" : ""}`}
                        aria-label={paint.checked ? "Checked" : "Unchecked"}
                      />
                    ) : paint.kind === "pill" ? (
                      <OptionPill color={paint.color}>{c}</OptionPill>
                    ) : (
                      c
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* A cut that matched nothing is a fact, and the header row alone was
          not stating it: a table with columns and no rows under them reads as
          a broken embed rather than an empty one. Same sentence the chart
          fences use for the same condition, minus the source half — an
          unknown database is already its own error above this. */}
      {result.rows.length === 0 && (
        <div className="dash-foot">No rows matched — check the query and property names.</div>
      )}
      {/* Why the table is short, said honestly. An author's `limit:`
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
      {edit && editing && model && anchor && (
        <CellEditor
          anchor={anchor}
          column={editing.column}
          cell={model}
          used={edit.usedValues(result.dbType, editing.column)}
          candidates={model.schema?.type ? edit.relationCandidates(model.schema.type) : []}
          onCommit={(value) => {
            // list-shaped props reached through the plain text editor keep
            // their list shape — the rule the database table and the editor
            // fence both commit by. `result` is this render's snapshot,
            // so these are the current values, not the ones the open captured.
            const cur = editing;
            close();
            const live = liveProps(result, cur.path);
            const key = foldedPropKey(live, cur.column);
            const prior = foldedPropStr(live, cur.column) ?? "";
            if ((value ?? "") === prior) return;
            edit.setProp(
              cur.path,
              key,
              value === null ? null : chipCommitValue(live[key], commitCellText(value, model))
            );
          }}
          onCommitList={(values) => {
            // multi/relation commit live and the menu stays open — no close
            const live = liveProps(result, editing.path);
            edit.setProp(editing.path, foldedPropKey(live, editing.column), propListValue(values));
          }}
          onCreateRelation={
            model.schema?.type && edit.createRelation
              ? (title) =>
                  edit.createRelation!(editing.path, model.actualKey, model.schema!.type!, title)
              : undefined
          }
          onClose={close}
        />
      )}
    </>
  );
}

function liveProps(
  result: Extract<EmbedResult, { columns: string[] }>,
  path: string
): Record<string, unknown> {
  return result.rows.find((r) => r.path === path)?.props ?? {};
}

function cellModelAt(
  result: Extract<EmbedResult, { columns: string[] }>,
  path: string,
  column: string
) {
  return viewCellModel(result, liveProps(result, path), column);
}

function cellElement(
  table: HTMLTableElement | null,
  path: string,
  column: string
): HTMLElement | null {
  const row = table?.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  return (row?.querySelector(`td[data-column="${CSS.escape(column)}"]`) as HTMLElement) ?? null;
}

/** What a click landed on, or nothing — the title cell keeps navigating (its
    button owns the click), and the head and chrome belong to the surface. One
    derivation read by both handlers, so mousedown's checkbox half and click's
    picker half can't disagree about which cell was hit. */
function cellHit(target: HTMLElement, result: Extract<EmbedResult, { columns: string[] }>) {
  const row = target.closest?.("tr[data-path]") as HTMLElement | null;
  const path = row?.dataset.path;
  const td = target.closest?.("td.embed-view-cell") as HTMLElement | null;
  const column = td?.dataset.column;
  if (!path || !td || !column) return null;
  return { path, column, td, model: cellModelAt(result, path, column) };
}
