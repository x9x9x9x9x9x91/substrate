/* A React island a plain-DOM surface can open cell editors from.

   The database pane is React all the way down, so a cell editor is just a
   conditional element. The inline ```view widget is CodeMirror widget DOM —
   hand-built nodes with no component around them — and its cells need the
   same pickers. This is the seam: one `createRoot` per widget, mounted into a
   container the widget owns and unmounted when the widget is destroyed.

   Rebuild survival rides `open()` being idempotent: a vault change repaints
   the widget's table and simply re-opens the editor against the fresh
   snapshot. The element type never changes, so React reconciles instead of
   remounting and the user's in-progress typing lives through it — while the
   anchor, cell data, option lists and commit closures are all rebuilt from
   post-change data. */

import { createRoot, type Root } from "react-dom/client";
import CellEditor from "./CellEditor";
import type { CellModel } from "../lib/cellmodel";
import type { RelationCandidate } from "../lib/relation";

export { anchorFrom, type AnchorRect } from "./SelectMenu";

export interface CellEditorArgs {
  anchor: { left: number; top: number; bottom: number; width?: number; height?: number };
  column: string;
  cell: CellModel;
  used: string[];
  candidates: RelationCandidate[];
  onCommit: (value: string | null) => void;
  onCommitList: (values: string[]) => void;
  onCreateRelation?: (title: string) => void;
  onClose: () => void;
}

export interface CellEditorHost {
  /** open, or re-open with fresh data — same element type, so React
      reconciles and an in-progress edit survives */
  open(args: CellEditorArgs): void;
  isOpen(): boolean;
  close(): void;
  destroy(): void;
}

export function createCellEditorHost(container: HTMLElement): CellEditorHost {
  const root: Root = createRoot(container);
  let current: CellEditorArgs | null = null;
  const paint = () => root.render(current ? <CellEditor {...current} /> : null);
  return {
    open(args) {
      current = args;
      paint();
    },
    isOpen: () => current !== null,
    close() {
      if (!current) return;
      current = null;
      paint();
    },
    destroy() {
      current = null;
      // CodeMirror destroys widgets from inside its own update cycle, which
      // can land while React is rendering — unmounting synchronously there
      // warns and drops the work. A microtask lands it just after.
      queueMicrotask(() => root.unmount());
    },
  };
}
