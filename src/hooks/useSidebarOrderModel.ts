import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import { mergeGroupOrder } from "../lib/sidebar";
import type { SidebarOrder } from "../lib/types";
import { setSidebarOrderUndoable, type ViewsApply } from "../lib/undoviews";
import type { UndoRecorder } from "../lib/undoprops";
import { type Section } from "../components/Sidebar";

/**
 * the writers over `$sidebar` in views.json: section order, collapsed
 * sections, pins and user-assigned keys. Each one folds its edit into the
 * live order object, skips the write when nothing changed, and persists
 * through the shared views.json queue.
 *
 * Each edit computes its next order from the order the last WRITE left —
 * `sidebarOrderRef`, not the render's copy — rather than from inside a
 * `setSidebarOrder` updater. The updater form ran its persist AND its undo
 * record as a side effect of a function React is free to call twice; a
 * duplicated write is merely wasteful, but a duplicated undo entry means one
 * drag takes two ⌘Z to take back. The render's copy is the wrong base for the
 * opposite reason: two gestures inside one batch both read the pre-batch
 * order, so the second builds its forward write from a stale value and drops
 * the first gesture's change outright — not just its `before`. The ref is what
 * the last set left, so it carries both. Render still reads the state: the
 * memos below.
 */
export function useSidebarOrderModel(opts: {
  sidebarOrder: SidebarOrder;
  /** the value the last set left, which is what an edit builds from */
  sidebarOrderRef: RefObject<SidebarOrder>;
  setSidebarOrder: React.Dispatch<React.SetStateAction<SidebarOrder>>;
  dashGroupIds: Set<string>;
  /** the session undo stack's write end, and the queued writer both the edit
      and its inverse go through */
  record: UndoRecorder;
  apply: ViewsApply;
  /** the caller's "it didn't stick" recovery: toast and re-read */
  onWriteError: (e: unknown) => void;
}) {
  const { sidebarOrder, sidebarOrderRef, setSidebarOrder, dashGroupIds, record, apply, onWriteError } =
    opts;

  /** One persisted sidebar edit: adopt it optimistically, queue the write,
      and record the whole prior order as its inverse (every one of these is a
      whole-object replace, so the prior object IS the undo). */
  const commit = useCallback(
    (before: SidebarOrder, next: SidebarOrder, label: string) => {
      setSidebarOrder(next);
      void setSidebarOrderUndoable({
        before,
        next,
        label,
        record,
        apply,
        adopt: setSidebarOrder,
      }).catch(onWriteError);
    },
    [setSidebarOrder, record, apply, onWriteError]
  );

  const setSectionOrder = useCallback(
    (section: Section, ids: string[]) => {
      const cur = sidebarOrderRef.current;
      // Every lane funnels into one of three persisted lists, each
      // holding SIBLING GROUPS folded into one flat list — so reordering
      // Life's children can't disturb the roots' order, and a no-op merge
      // returns the same array, worth skipping the write. `dashboards`
      // is such a list too: the Dashboards section's rows and each
      // folder's tree dashboards are separate groups sharing it, so a section
      // reorder must merge rather than replace or it drops the tree rows'
      // entries and they fall back to alphabetical.
      let next: SidebarOrder;
      if (section === "dashboards" || section.startsWith("dashes:")) {
        const dashboards = mergeGroupOrder(cur.dashboards ?? [], ids);
        if (dashboards === cur.dashboards) return;
        next = { ...cur, dashboards };
      } else if (section === "dashgroups") {
        // The Dashboards section's group HEADERS get their own list.
        // Folding them into `folders` would let a group's position fight a
        // same-named tree folder's, and into `dashboards` would let it fight
        // the dashboard rows it contains — the headers only ever order
        // against each other, one group, so a merge here is just a rewrite.
        const dashgroups = mergeGroupOrder(cur.dashgroups ?? [], ids);
        if (dashgroups === cur.dashgroups) return;
        next = { ...cur, dashgroups };
      } else if (section === "pins" || section.startsWith("pins:")) {
        const pins = mergeGroupOrder(cur.pins ?? [], ids);
        if (pins === cur.pins) return;
        next = { ...cur, pins };
      } else {
        const folders = mergeGroupOrder(cur.folders ?? [], ids);
        if (folders === cur.folders) return;
        next = { ...cur, folders };
      }
      commit(cur, next, "Reorder sidebar");
    },
    [sidebarOrderRef, commit]
  );

  const toggleCollapsed = useCallback(
    (id: string) => {
      const cur = sidebarOrderRef.current;
      // moving or deleting the last dashboard out of a subfolder retires its
      // group; drop the orphaned id here rather than letting it accumulate in
      // views.json forever (it would also silently re-collapse a folder the
      // user later re-creates)
      const collapsed = (cur.collapsed ?? []).filter(
        (c) => !c.startsWith("dashgroup:") || dashGroupIds.has(c)
      );
      const opening = collapsed.includes(id);
      const next: SidebarOrder = {
        ...cur,
        collapsed: opening ? collapsed.filter((c) => c !== id) : [...collapsed, id],
      };
      /* The order this toggle takes back is the swept one, not the stored one.
         The sweep is housekeeping the user never asked for and cannot see, so
         an inverse carrying the retired ids back would undo it too — one ⌘Z
         after a collapse and views.json holds the orphans again. */
      const before: SidebarOrder =
        collapsed.length === (cur.collapsed?.length ?? 0) ? cur : { ...cur, collapsed };
      commit(before, next, opening ? "Expand section" : "Collapse section");
    },
    [sidebarOrderRef, dashGroupIds, commit]
  );

  const collapsedIds = useMemo(() => sidebarOrder.collapsed ?? [], [sidebarOrder]);

  // A plain note gets a sidebar row of its own. The pin is the note's
  // path in `$sidebar.pins`; the engine follows it through renames and moves
  // and drops it on trash, so the stored list stays live.
  const pinnedPaths = useMemo(() => sidebarOrder.pins ?? [], [sidebarOrder]);

  const setPinned = useCallback(
    (path: string, pinned: boolean) => {
      const cur = sidebarOrderRef.current;
      const pins = cur.pins ?? [];
      if (pins.includes(path) === pinned) return;
      const next: SidebarOrder = {
        ...cur,
        pins: pinned ? [...pins, path] : pins.filter((p) => p !== path),
      };
      commit(cur, next, pinned ? "Pin to sidebar" : "Unpin from sidebar");
    },
    [sidebarOrderRef, commit]
  );

  // User-assigned keys live in `$sidebar.keys` as key token → sidebar
  // target token. Same persistence shape as the pins above; the engine
  // retargets and drops the VALUES through renames and trash.
  const customKeys = useMemo(() => sidebarOrder.keys ?? {}, [sidebarOrder]);

  const writeKeys = useCallback(
    (edit: (cur: Record<string, string>) => Record<string, string>) => {
      const cur = sidebarOrderRef.current;
      // one base object for the identity check: the helpers return their
      // input untouched on a no-op, and `cur.keys ?? {}` twice would
      // compare two distinct empty literals and persist for nothing
      const base = cur.keys ?? {};
      const keys = edit(base);
      if (keys === base) return;
      commit(cur, { ...cur, keys }, "Sidebar shortcut");
    },
    [sidebarOrderRef, commit]
  );

  return {
    setSectionOrder,
    toggleCollapsed,
    collapsedIds,
    pinnedPaths,
    setPinned,
    customKeys,
    writeKeys,
  };
}
