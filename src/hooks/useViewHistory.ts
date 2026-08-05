import { useCallback, useEffect, useRef } from "react";
import type { View } from "../lib/types";
import { viewKey } from "../lib/types";

// a database's open entry lives in `dbNote`, not `selected`, so a
// history entry carries both or ⌫ back into a database lands with the side
// split shut
type Loc = { view: View; selected: string | null; dbNote: string | null };

/**
 * ⌫ walks back through the views this session visited, restoring the
 * row that was selected when the view was left. Search is a modal detour with
 * its own return flows (Esc), so neither side of a search
 * transition is recorded. A pop flags itself so the restore doesn't re-push
 * the view it just left.
 */
export function useViewHistory(opts: {
  view: View;
  viewKeyNow: string;
  selected: string | null;
  dbNote: string | null;
  preSearchView: React.RefObject<Loc>;
  dbNoteCarryRef: React.RefObject<boolean>;
  setView: (v: View) => void;
  setSelected: (p: string | null) => void;
  setDbNote: (p: string | null) => void;
}) {
  const {
    view,
    viewKeyNow,
    selected,
    dbNote,
    preSearchView,
    dbNoteCarryRef,
    setView,
    setSelected,
    setDbNote,
  } = opts;
  const viewHistory = useRef<Loc[]>([]);
  const histLoc = useRef<({ key: string } & Loc) | null>(null);
  const backNav = useRef(false);
  useEffect(() => {
    const prev = histLoc.current;
    // same-view selection moves — and opening/closing a database's side note —
    // keep the stash current, so back restores the row we were last on, not
    // the one the view was entered with
    histLoc.current = { key: viewKeyNow, view, selected, dbNote };
    if (!prev || prev.key === viewKeyNow) return;
    if (backNav.current) {
      backNav.current = false;
      return;
    }
    if (view.kind === "search") return;
    if (prev.view.kind === "search") {
      // a search hit landed somewhere new: bridge the detour so ⌫ goes to
      // where the search was opened FROM (Esc-return still owns
      // going back to the results). Esc-close restores the stash itself —
      // pushing it then would make ⌫ reopen ground we're already on.
      const stash = preSearchView.current;
      if (viewKey(stash.view) !== viewKeyNow)
        viewHistory.current.push({
          view: stash.view,
          selected: stash.selected,
          dbNote: stash.dbNote,
        });
      return;
    }
    viewHistory.current.push({ view: prev.view, selected: prev.selected, dbNote: prev.dbNote });
    if (viewHistory.current.length > 50) viewHistory.current.shift();
  }, [viewKeyNow, view, selected, dbNote]);

  const goBack = useCallback(() => {
    // an open database side note is the topmost level — ⌫ closes it first,
    // exactly like Esc
    if ((view.kind === "db" || view.kind === "saved") && dbNote) {
      setDbNote(null);
      return;
    }
    const entry = viewHistory.current.pop();
    if (!entry) return;
    backNav.current = true;
    // a restored side note has to survive the leave-clears effect the view
    // change itself fires — same one-shot carry a db→db birth uses,
    // armed only when that effect would actually clear (leaving a db/saved
    // view for a different one), so it can never sit unspent. An entry without
    // a note restores null, so no stale note leaks into a non-database view.
    if (
      entry.dbNote &&
      (view.kind === "db" || view.kind === "saved") &&
      viewKey(entry.view) !== viewKeyNow
    )
      dbNoteCarryRef.current = true;
    setView(entry.view);
    setSelected(entry.selected);
    setDbNote(entry.dbNote);
  }, [view, viewKeyNow, dbNote]);

  return { viewHistory, goBack };
}
