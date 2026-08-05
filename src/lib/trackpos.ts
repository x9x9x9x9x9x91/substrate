/* A document position that survives an await.
 *
 * Asset intake captures where the embed belongs — the caret at paste time, the
 * point under a drop — and only writes it after an IPC round trip that can take
 * seconds for a big file. A raw offset captured before that await is stale the
 * moment anything edits the document, and re-reading the live cursor instead
 * splices the embed wherever the user has since started typing.
 *
 * The CodeMirror idiom is to map the captured offset through every change set
 * that lands in between. A StateField sees each transaction, so registering the
 * position there keeps it mapped for free, including through the intake's own
 * earlier inserts — a multi-file batch chains, each embed landing after the
 * last.
 */
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Register (`pos`) or drop (`null`) the tracked position under `id`. */
export const setTrackedPos = StateEffect.define<{ id: number; pos: number | null }>();

export const trackedPositions = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<number, number> | null = null;
    if (tr.docChanged && value.size > 0) {
      next = new Map();
      // assoc 1: text typed exactly at the mark pushes the mark after it, so a
      // pending embed appends to what the user wrote instead of splitting it
      for (const [id, pos] of value) next.set(id, tr.changes.mapPos(pos, 1));
    }
    for (const effect of tr.effects) {
      if (!effect.is(setTrackedPos)) continue;
      next ??= new Map(value);
      if (effect.value.pos === null) next.delete(effect.value.id);
      else next.set(effect.value.id, effect.value.pos);
    }
    return next ?? value;
  },
});

/** The mapped position, or null once released (or if the field is absent). */
export function trackedPos(state: EditorState, id: number): number | null {
  return state.field(trackedPositions, false)?.get(id) ?? null;
}

let nextTrackId = 1;

export interface PosTracker {
  /** Where the captured point sits in the current document. */
  pos(): number | null;
  release(): void;
}

/** Start tracking `pos` in `view`. Always release when the intake finishes —
 *  an unreleased mark costs one map per transaction for the view's lifetime. */
export function trackPos(view: EditorView, pos: number): PosTracker {
  const id = nextTrackId++;
  view.dispatch({ effects: setTrackedPos.of({ id, pos }) });
  return {
    pos: () => (view.dom.isConnected ? trackedPos(view.state, id) : null),
    release: () => {
      if (view.dom.isConnected) view.dispatch({ effects: setTrackedPos.of({ id, pos: null }) });
    },
  };
}
