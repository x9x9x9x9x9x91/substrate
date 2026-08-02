import { useCallback, useMemo } from "react";
import { vaultSetSidebarOrder, vaultSidebarOrder } from "../lib/ipc";
import { mergeGroupOrder } from "../lib/sidebar";
import type { SidebarOrder } from "../lib/types";
import { type Section } from "../components/Sidebar";

/**
 * the writers over `$sidebar` in views.json: section order, collapsed
 * sections, pins and user-assigned keys. Each one folds its edit into the
 * live order object, skips the write when nothing changed, and persists
 * through the shared views.json queue (SUB-241).
 */
export function useSidebarOrderModel(opts: {
  sidebarOrder: SidebarOrder;
  setSidebarOrder: React.Dispatch<React.SetStateAction<SidebarOrder>>;
  persistViewsConfig: <T>(
    write: () => Promise<T>,
    adopt: (value: T) => void,
    reread: () => Promise<T>,
    msg: string
  ) => void;
  dashGroupIds: Set<string>;
}) {
  const { sidebarOrder, setSidebarOrder, persistViewsConfig, dashGroupIds } = opts;

  const setSectionOrder = useCallback(
    (section: Section, ids: string[]) => {
      setSidebarOrder((cur) => {
        // SUB-585: every lane funnels into one of three persisted lists, each
        // holding SIBLING GROUPS folded into one flat list — so reordering
        // Life's children can't disturb the roots' order, and a no-op merge
        // returns the same array, worth skipping the write. SUB-605 made
        // `dashboards` such a list too: the Dashboards section's rows and each
        // folder's tree dashboards are separate groups sharing it, so a section
        // reorder must merge rather than replace or it drops the tree rows'
        // entries and they fall back to alphabetical.
        let next: SidebarOrder;
        if (section === "dashboards" || section.startsWith("dashes:")) {
          const dashboards = mergeGroupOrder(cur.dashboards ?? [], ids);
          if (dashboards === cur.dashboards) return cur;
          next = { ...cur, dashboards };
        } else if (section === "dashgroups") {
          // SUB-698: the Dashboards section's group HEADERS get their own list.
          // Folding them into `folders` would let a group's position fight a
          // same-named tree folder's, and into `dashboards` would let it fight
          // the dashboard rows it contains — the headers only ever order
          // against each other, one group, so a merge here is just a rewrite.
          const dashgroups = mergeGroupOrder(cur.dashgroups ?? [], ids);
          if (dashgroups === cur.dashgroups) return cur;
          next = { ...cur, dashgroups };
        } else if (section === "pins" || section.startsWith("pins:")) {
          const pins = mergeGroupOrder(cur.pins ?? [], ids);
          if (pins === cur.pins) return cur;
          next = { ...cur, pins };
        } else {
          const folders = mergeGroupOrder(cur.folders ?? [], ids);
          if (folders === cur.folders) return cur;
          next = { ...cur, folders };
        }
        persistViewsConfig(
          () => vaultSetSidebarOrder(next),
          setSidebarOrder,
          vaultSidebarOrder,
          "Couldn't save sidebar settings"
        );
        return next;
      });
    },
    [persistViewsConfig]
  );

  const toggleCollapsed = useCallback(
    (id: string) => {
      setSidebarOrder((cur) => {
        const collapsed = cur.collapsed ?? [];
        const next: SidebarOrder = {
          ...cur,
          collapsed: (collapsed.includes(id)
            ? collapsed.filter((c) => c !== id)
            : [...collapsed, id]
          )
            // moving or deleting the last dashboard out of a subfolder retires
            // its group; drop the orphaned id here rather than letting it
            // accumulate in views.json forever (it would also silently
            // re-collapse a folder the user later re-creates)
            .filter((c) => !c.startsWith("dashgroup:") || dashGroupIds.has(c)),
        };
        persistViewsConfig(
          () => vaultSetSidebarOrder(next),
          setSidebarOrder,
          vaultSidebarOrder,
          "Couldn't save sidebar settings"
        );
        return next;
      });
    },
    [persistViewsConfig, dashGroupIds]
  );

  const collapsedIds = useMemo(() => sidebarOrder.collapsed ?? [], [sidebarOrder]);

  // SUB-410: a plain note gets a sidebar row of its own. The pin is the note's
  // path in `$sidebar.pins`; the engine follows it through renames and moves
  // and drops it on trash, so the stored list stays live.
  const pinnedPaths = useMemo(() => sidebarOrder.pins ?? [], [sidebarOrder]);

  const setPinned = useCallback(
    (path: string, pinned: boolean) => {
      setSidebarOrder((cur) => {
        const pins = cur.pins ?? [];
        if (pins.includes(path) === pinned) return cur;
        const next: SidebarOrder = {
          ...cur,
          pins: pinned ? [...pins, path] : pins.filter((p) => p !== path),
        };
        persistViewsConfig(
          () => vaultSetSidebarOrder(next),
          setSidebarOrder,
          vaultSidebarOrder,
          "Couldn't save sidebar settings"
        );
        return next;
      });
    },
    [persistViewsConfig]
  );

  // SUB-467: user-assigned keys live in `$sidebar.keys` as key token → sidebar
  // target token. Same persistence shape as the pins above; the engine
  // retargets and drops the VALUES through renames and trash.
  const customKeys = useMemo(() => sidebarOrder.keys ?? {}, [sidebarOrder]);

  const writeKeys = useCallback(
    (edit: (cur: Record<string, string>) => Record<string, string>) => {
      setSidebarOrder((cur) => {
        // one base object for the identity check: the helpers return their
        // input untouched on a no-op, and `cur.keys ?? {}` twice would
        // compare two distinct empty literals and persist for nothing
        const base = cur.keys ?? {};
        const keys = edit(base);
        if (keys === base) return cur;
        const next: SidebarOrder = { ...cur, keys };
        persistViewsConfig(
          () => vaultSetSidebarOrder(next),
          setSidebarOrder,
          vaultSidebarOrder,
          "Couldn't save sidebar settings"
        );
        return next;
      });
    },
    [persistViewsConfig]
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
