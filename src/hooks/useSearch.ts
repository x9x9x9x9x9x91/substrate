import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteMeta, View } from "../lib/types";
import { foldedPropStr, viewKey } from "../lib/types";
import { parseMountPath } from "../lib/mounts";

/**
 * the search detour and its return trip: the query, the view a
 * search was opened FROM, the stash that one Esc in the landing context
 * spends to go back, and the one-shot reveal that points the editor at the
 * matched line.
 */
export function useSearch(opts: {
  notes: NoteMeta[];
  view: View;
  selected: string | null;
  dbNote: string | null;
  setView: React.Dispatch<React.SetStateAction<View>>;
  setSelected: (p: string | null) => void;
  setDbNote: (p: string | null) => void;
  showMobileDetail: () => void;
  abandonScratch: (path: string) => Promise<void>;
  /** a hit can name a file inside a mounted folder rather than a
      note. Landing it belongs to App — it owns the mount views and the board's
      reveal — so the hook hands the hit over and takes back the view it landed
      on, or `false` when this machine has no such mount and there is nowhere
      to go. */
  openMountHit: (id: string, rel: string) => boolean;
}) {
  const {
    notes,
    view,
    selected,
    dbNote,
    setView,
    setSelected,
    setDbNote,
    showMobileDetail,
    abandonScratch,
    openMountHit,
  } = opts;

  const [searchQuery, setSearchQuery] = useState("");
  // The search a hit was opened from — one Esc in the landing
  // context returns to it (query + picked row), then the stash is spent
  const [searchReturn, setSearchReturn] = useState<{
    query: string;
    sel: { path: string; line: number };
    view: View;
    note: string;
  } | null>(null);
  // the row SearchPane re-selects on that return (one-shot)
  const [searchRestore, setSearchRestore] = useState<{ path: string; line: number } | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(
    null
  );
  // where Esc from the search pane returns to: the view and its open note.
  // A database's open note lives in `dbNote`, not `selected`, so the
  // stash carries both or the return trip lands with the side split shut.
  const preSearchView = useRef<{ view: View; selected: string | null; dbNote: string | null }>({
    view: { kind: "notes" },
    selected: null,
    dbNote: null,
  });

  const openSearch = useCallback(
    (seed?: string) => {
      if (seed !== undefined) setSearchQuery(seed);
      setSearchRestore(null); // a fresh open drops any pending one-shot restore
      setView((v) => {
        if (v.kind !== "search") preSearchView.current = { view: v, selected, dbNote };
        return { kind: "search" };
      });
    },
    [selected, dbNote]
  );

  // Esc without a pick: back to the stashed view AND its open note — the
  // search view's empty scope nulled the selection while we were in it, and
  // leaving a database cleared its side note. Restoring after
  // setView is enough: the leave-clears effect fires on the way OUT of the db
  // view, not on the way back in.
  const closeSearch = useCallback(() => {
    setView(preSearchView.current.view);
    setSelected(preSearchView.current.selected);
    setDbNote(preSearchView.current.dbNote);
  }, []);

  // open a note at a specific match line, in its home context: its
  // database's side split when it has a type, else its folder view, else All
  // notes — and one Esc from there returns to the search, query and picked
  // row intact. Dashboard notes go to their rendered surface instead —
  // a raw fence line means nothing there; the pane's own source
  // button edits them
  const openSearchHit = useCallback(
    (path: string, line: number) => {
      // a mounted file's row, which has no note until someone
      // annotates it — it goes home to its board, not into the editor. No
      // return stash: the stash is spent the moment the landing view's open
      // note isn't the hit (the effect below), and a board row is not an open
      // note. Esc on the board is the board's ordinary Esc.
      const mounted = parseMountPath(path);
      if (mounted) {
        if (!openMountHit(mounted.id, mounted.rel)) return;
        showMobileDetail();
        return;
      }
      const note = notes.find((n) => n.path === path);
      if (note && foldedPropStr(note.props, "type") === "dashboard") {
        setView({ kind: "dashboard", path });
        return;
      }
      const type = note ? foldedPropStr(note.props, "type") : undefined;
      let home: View;
      if (note && type) {
        home = { kind: "db", type };
        setView(home);
        setDbNote(path);
      } else if (note && note.folder) {
        home = { kind: "folder", path: note.folder };
        setView(home);
        setSelected(path);
      } else {
        home = { kind: "all" };
        setView(home);
        setSelected(path);
      }
      showMobileDetail();
      setReveal((r) => ({ path, line, nonce: (r?.nonce ?? 0) + 1 }));
      setSearchReturn({ query: searchQuery, sel: { path, line }, view: home, note: path });
    },
    [
      notes,
      searchQuery,
      showMobileDetail,
      openMountHit,
    ]
  );

  // a reveal only applies to the note it was aimed at (it can be open in the
  // main pane or a database's side split)
  useEffect(() => {
    if (reveal && selected !== reveal.path && dbNote !== reveal.path) setReveal(null);
  }, [selected, dbNote, reveal]);

  // The return trip itself — query and picked row restored, stash
  // spent, so the next Esc is ordinary again. Shared by the app-level Esc
  // (focus outside text) and the editor's own Esc binding
  const returnToSearch = useCallback(
    (sr: NonNullable<typeof searchReturn>) => {
      setSearchReturn(null);
      setSearchQuery(sr.query);
      setSearchRestore(sr.sel);
      setView({ kind: "search" });
    },
    []
  );

  // The return stash lives exactly as long as its landing context —
  // any further navigation spends it, so a stale Esc can never jump back
  useEffect(() => {
    // An empty stash has nothing to spend. Without this the effect calls
    // setSearchReturn on every selection move — the updater returns null
    // again, but React still re-renders App once before bailing out on
    // equality, doubling its render count for the whole of an arrow-key walk.
    if (!searchReturn) return;
    setSearchReturn((sr) =>
      sr &&
      viewKey(sr.view) === viewKey(view) &&
      (sr.view.kind === "db" ? dbNote === sr.note : selected === sr.note)
        ? sr
        : null
    );
  }, [view, selected, dbNote, searchReturn]);

  // Esc from inside a note (title input or editor): an armed search-return
  // jumps back to the results; otherwise a pristine ⌘N note
  // abandons itself
  const onNoteEscape = useCallback(
    (path: string) => {
      const sr = searchReturn;
      if (sr && sr.note === path && viewKey(sr.view) === viewKey(view)) {
        returnToSearch(sr);
        return;
      }
      void abandonScratch(path);
    },
    [searchReturn, view, returnToSearch, abandonScratch]
  );

  return {
    searchQuery,
    setSearchQuery,
    searchReturn,
    searchRestore,
    setSearchRestore,
    reveal,
    setReveal,
    preSearchView,
    openSearch,
    closeSearch,
    openSearchHit,
    returnToSearch,
    onNoteEscape,
  };
}
