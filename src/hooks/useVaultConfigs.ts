import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  vaultFolderMetaRead,
  vaultSavedViewsRead,
  vaultSchemaRead,
  vaultSidebarOrder,
  vaultTagFoldersRead,
  vaultViewsRead,
} from "../lib/ipc";
import type {
  FolderMetaMap,
  SavedView,
  SchemaConfig,
  SidebarOrder,
  TagFolder,
  ViewsConfig,
} from "../lib/types";
import { createWriteQueue } from "../lib/writequeue";

/* Db prefs, `$sidebar`, `$views` and `$folders` all live in
   `.vault/views.json` and every setter read-modify-writes the whole file —
   two in flight at once can interleave on disk (a key silently lost) and
   their responses can land out of order (stale config clobbers newer state).
   One queue for the file serializes them: a write starts only after the
   previous one settled, so disk and adoption move in issue order. */
export const queueViewsWrite = createWriteQueue();

/** State plus a ref holding the value the last SET left, which is not what
    the last render was handed. Two gestures on the same object inside one
    frame both read the render's copy, so the second records an undo whose
    `before` is two steps back — undoing it then jumps a step, or refuses on a
    conflict that never happened. The undoable writers read the ref instead.
    The updater form is resolved against the ref rather than against React's
    copy, so there is exactly one truth here rather than two that can drift.

    The ref is only as live as what is written INTO it, which is why every
    queued write's adoption passes through the app's adoption gate
    (`lib/writequeue.ts`) on the way here: without it a completed write's
    response walks the ref back to that write's value while a newer gesture is
    still in flight, and an undo recorded in that window captures the wrong
    `before`. */
function useLive<T>(initial: T): [T, Dispatch<SetStateAction<T>>, RefObject<T>] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: SetStateAction<T>) => {
    ref.current = typeof next === "function" ? (next as (cur: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref];
}

/**
 * everything the app reads out of `.vault/views.json` and the schema: db
 * prefs, sidebar order, saved views, folder icons and the database schema —
 * plus the queued-write helper every optimistic setter goes through.
 */
export function useVaultConfigs(showToast: (msg: string) => void) {
  const [viewsConfig, setViewsConfig, viewsConfigRef] = useLive<ViewsConfig>({});
  // `folders` is seeded here rather than left undefined — a
  // `?? []` at the Sidebar call site would mint a fresh array every render and
  // silently defeat the memo for every vault whose folders were never dragged.
  const [sidebarOrder, setSidebarOrder, sidebarOrderRef] = useLive<SidebarOrder>({
    dashboards: [],
    databases: [],
    folders: [],
  });
  const [savedViews, setSavedViews, savedViewsRef] = useLive<SavedView[]>([]);
  /** per-folder icons, keyed by vault-relative folder path */
  const [folderMeta, setFolderMeta, folderMetaRef] = useLive<FolderMetaMap>({});
  /* tag-query folders. Their own file, not views.json — the queue
     above serializes views.json writers only, and tagfolders.json has a
     single writer (the builder), so it needs no queue of its own. */
  const [tagFolders, setTagFolders] = useState<TagFolder[]>([]);
  const [schema, setSchema] = useState<SchemaConfig>({});

  // The engine rewrites `$sidebar.pins` behind our back — a rename or
  // move retargets the stored path, a trash drops it. Every op that can do
  // that re-reads the order so the Pinned section stays truthful. Same for
  // `$sidebar.keys`, which the engine keeps truthful the same way —
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
    vaultTagFoldersRead().then(setTagFolders).catch(console.error);
  }, []);

  /* Every optimistic views.json write goes through the file's
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
    viewsConfigRef,
    sidebarOrder,
    setSidebarOrder,
    sidebarOrderRef,
    savedViews,
    setSavedViews,
    savedViewsRef,
    folderMeta,
    setFolderMeta,
    folderMetaRef,
    tagFolders,
    setTagFolders,
    schema,
    setSchema,
    reloadSidebarOrder,
    refreshConfigs,
    persistViewsConfig,
  };
}
