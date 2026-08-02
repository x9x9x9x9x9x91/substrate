import { useCallback, useEffect, useState } from "react";
import {
  vaultFolderMetaRead,
  vaultSavedViewsRead,
  vaultSchemaRead,
  vaultSidebarOrder,
  vaultViewsRead,
} from "../lib/ipc";
import type {
  FolderMetaMap,
  SavedView,
  SchemaConfig,
  SidebarOrder,
  ViewsConfig,
} from "../lib/types";
import { createWriteQueue } from "../lib/writequeue";

/* SUB-241: db prefs, `$sidebar`, `$views` and `$folders` all live in
   `.vault/views.json` and every setter read-modify-writes the whole file —
   two in flight at once can interleave on disk (a key silently lost) and
   their responses can land out of order (stale config clobbers newer state).
   One queue for the file serializes them: a write starts only after the
   previous one settled, so disk and adoption move in issue order. */
export const queueViewsWrite = createWriteQueue();

/**
 * everything the app reads out of `.vault/views.json` and the schema: db
 * prefs, sidebar order, saved views, folder icons and the database schema —
 * plus the queued-write helper every optimistic setter goes through.
 */
export function useVaultConfigs(showToast: (msg: string) => void) {
  const [viewsConfig, setViewsConfig] = useState<ViewsConfig>({});
  // SUB-460: `folders` is seeded here rather than left undefined — a
  // `?? []` at the Sidebar call site would mint a fresh array every render and
  // silently defeat the memo for every vault whose folders were never dragged.
  const [sidebarOrder, setSidebarOrder] = useState<SidebarOrder>({
    dashboards: [],
    databases: [],
    folders: [],
  });
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  /** per-folder icons (SUB-84), keyed by vault-relative folder path */
  const [folderMeta, setFolderMeta] = useState<FolderMetaMap>({});
  const [schema, setSchema] = useState<SchemaConfig>({});

  // SUB-410: the engine rewrites `$sidebar.pins` behind our back — a rename or
  // move retargets the stored path, a trash drops it. Every op that can do
  // that re-reads the order so the Pinned section stays truthful. Same for
  // `$sidebar.keys` (SUB-467), which the engine keeps truthful the same way —
  // so a database rename or delete has to re-read too.
  const reloadSidebarOrder = useCallback(() => {
    vaultSidebarOrder().then(setSidebarOrder).catch(console.error);
  }, []);

  const refreshConfigs = useCallback(() => {
    vaultViewsRead().then(setViewsConfig).catch(console.error);
    vaultSidebarOrder().then(setSidebarOrder).catch(console.error);
    vaultSchemaRead().then(setSchema).catch(console.error);
    vaultSavedViewsRead().then(setSavedViews).catch(console.error);
    vaultFolderMetaRead().then(setFolderMeta).catch(console.error);
  }, []);

  /* SUB-241: every optimistic views.json write goes through the file's
     queue and, on failure, must not stay diverged from disk — surface it,
     then re-read the config (queued behind any pending writes, so the
     recovery snapshot includes everything already issued) so state
     re-converges with reality. */
  const persistViewsConfig = useCallback(
    <T,>(write: () => Promise<T>, adopt: (value: T) => void, reread: () => Promise<T>, msg: string) => {
      queueViewsWrite(write)
        .then(adopt)
        .catch((e: unknown) => {
          console.error(e);
          showToast(msg);
          queueViewsWrite(reread).then(adopt).catch(console.error);
        });
    },
    [showToast]
  );

  useEffect(() => {
    refreshConfigs();
  }, [refreshConfigs]);

  return {
    viewsConfig,
    setViewsConfig,
    sidebarOrder,
    setSidebarOrder,
    savedViews,
    setSavedViews,
    folderMeta,
    setFolderMeta,
    schema,
    setSchema,
    reloadSidebarOrder,
    refreshConfigs,
    persistViewsConfig,
  };
}
