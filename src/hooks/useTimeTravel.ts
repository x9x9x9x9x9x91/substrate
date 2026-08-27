import { useCallback, useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  historyEnter,
  historyLeave,
  historyPoints,
  historyProjectionActive,
  historyRestore,
  historySnapshot,
  vaultFolderMetaRead,
  vaultFolders,
  vaultList,
  vaultSavedViewsRead,
  vaultSchemaRead,
  vaultSidebarOrder,
  vaultViewsRead,
} from "../lib/ipc";
import type {
  FolderMetaMap,
  NoteMeta,
  SavedView,
  SchemaConfig,
  SidebarOrder,
  VaultHistoryPoint,
  View,
  ViewsConfig,
} from "../lib/types";
import { errText } from "../lib/errtext";

/** everything the projection replaces when the app moves off the present */
type TimeTravelDeps = {
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<View>>;
  setNotes: Dispatch<SetStateAction<NoteMeta[]>>;
  setFolders: Dispatch<SetStateAction<string[]>>;
  setViewsConfig: Dispatch<SetStateAction<ViewsConfig>>;
  setSchema: Dispatch<SetStateAction<SchemaConfig>>;
  setSidebarOrder: Dispatch<SetStateAction<SidebarOrder>>;
  setSavedViews: Dispatch<SetStateAction<SavedView[]>>;
  setFolderMeta: Dispatch<SetStateAction<FolderMetaMap>>;
  setChangedPaths: Dispatch<SetStateAction<string[] | null>>;
  setVaultEpoch: Dispatch<SetStateAction<number>>;
  setOverlay: Dispatch<SetStateAction<null | "palette" | "capture">>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  flushOpenRef: RefObject<(() => Promise<void>) | null>;
  showToast: (msg: string) => void;
};

/**
 * Vault time travel: the snapshot list, the historical projection the whole
 * app reads while it is up, and the two ways back — return to the present, or
 * restore one note out of the past and land in the present with it.
 */
export function useTimeTravel(deps: TimeTravelDeps) {
  const {
    selected,
    setSelected,
    setView,
    setNotes,
    setFolders,
    setViewsConfig,
    setSchema,
    setSidebarOrder,
    setSavedViews,
    setFolderMeta,
    setChangedPaths,
    setVaultEpoch,
    setOverlay,
    setSettingsOpen,
    flushOpenRef,
    showToast,
  } = deps;

  const [timeTravelOpen, setTimeTravelOpen] = useState(false);
  const [timePoints, setTimePoints] = useState<VaultHistoryPoint[]>([]);
  const [timePoint, setTimePoint] = useState<VaultHistoryPoint | null>(null);
  const [timeBusy, setTimeBusy] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);

  const selectTimePoint = useCallback(
    async (id: string) => {
      setTimeBusy(true);
      setTimeError(null);
      try {
        const snapshot = await historyEnter(id);
        setTimePoint(snapshot.point);
        setNotes(snapshot.notes);
        setFolders(snapshot.folders);
        setViewsConfig(snapshot.views);
        setSchema(snapshot.schema);
        setSidebarOrder(snapshot.sidebar_order);
        setSavedViews(snapshot.saved_views);
        setFolderMeta(snapshot.folder_meta);
        setChangedPaths(null);
        setVaultEpoch((epoch) => epoch + 1);
        setOverlay(null);
        setSettingsOpen(false);
      } catch (error) {
        setTimeError(errText(error));
      } finally {
        setTimeBusy(false);
      }
    },
    [
      setChangedPaths,
      setFolderMeta,
      setFolders,
      setNotes,
      setOverlay,
      setSavedViews,
      setSchema,
      setSettingsOpen,
      setSidebarOrder,
      setVaultEpoch,
      setViewsConfig,
    ]
  );

  const openTimeTravel = useCallback(async () => {
    setTimeTravelOpen(true);
    setTimeError(null);
    setTimeBusy(true);
    try {
      await (flushOpenRef.current?.() ?? Promise.resolve());
      // Make the departure state a real commit before any historical restore
      // can replace a live note. A clean tree already has that restore point.
      await historySnapshot("before vault time travel");
      const points = await historyPoints();
      setTimePoints(points);
      if (points.length === 0) setTimeError("No vault snapshots yet");
    } catch (error) {
      setTimeError(errText(error));
    } finally {
      setTimeBusy(false);
    }
  }, [flushOpenRef]);

  const reloadPresent = useCallback(
    async (reselect: string | null) => {
      const [liveNotes, liveFolders, liveViews, liveSchema, liveSidebar, liveSaved, liveFolderMeta] =
        await Promise.all([
          vaultList(),
          vaultFolders(),
          vaultViewsRead(),
          vaultSchemaRead(),
          vaultSidebarOrder(),
          vaultSavedViewsRead(),
          vaultFolderMetaRead(),
        ]);
      setNotes(liveNotes);
      setFolders(liveFolders);
      setViewsConfig(liveViews);
      setSchema(liveSchema);
      setSidebarOrder(liveSidebar);
      setSavedViews(liveSaved);
      setFolderMeta(liveFolderMeta);
      setChangedPaths(null);
      setVaultEpoch((epoch) => epoch + 1);
      setSelected(reselect && liveNotes.some((note) => note.path === reselect) ? reselect : null);
    },
    [
      setChangedPaths,
      setFolderMeta,
      setFolders,
      setNotes,
      setSavedViews,
      setSchema,
      setSelected,
      setSidebarOrder,
      setVaultEpoch,
      setViewsConfig,
    ]
  );

  const returnToPresent = useCallback(async () => {
    const reselect = selected;
    setTimeBusy(true);
    setTimeError(null);
    setSelected(null);
    // Live reads begin now, but shortcuts and every IPC mutation stay blocked
    // until their results have replaced the historical projection in React.
    historyLeave(false);
    try {
      await reloadPresent(reselect);
      historyLeave();
      setTimePoint(null);
      setTimeTravelOpen(false);
    } catch (error) {
      setTimeError(errText(error));
      // Recovery must never dead-end: the guard is still on with no
      // projection behind it, so a failed re-entry would leave every write
      // blocked and no working control on screen. Re-show the past
      // if we can; otherwise release the guard and land in the present, where
      // the error message is at least actionable.
      try {
        if (!timePoint) throw new Error("no snapshot to return to");
        await selectTimePoint(timePoint.id);
      } catch {
        historyLeave();
        setTimePoint(null);
        setTimeTravelOpen(false);
      }
    } finally {
      setTimeBusy(false);
    }
  }, [reloadPresent, selected, selectTimePoint, setSelected, timePoint]);

  const restoreFromTime = useCallback(
    async (note: NoteMeta) => {
      if (!timePoint) return;
      setTimeBusy(true);
      setTimeError(null);
      try {
        // the baseline is the version being restored: any live
        // file newer than it means this restore would bury someone else's
        // change, which is exactly what the detection + rescue
        // snapshot exist for. Passing 0 disabled both.
        await historyRestore(note.path, timePoint.id, note.path, note.updated_ms);
        setSelected(null);
        historyLeave(false);
        await reloadPresent(note.path);
        historyLeave();
        setTimePoint(null);
        setTimeTravelOpen(false);
        setView({ kind: "all" });
        showToast(`Restored ${note.title}`);
      } catch (error) {
        if (!historyProjectionActive() && timePoint) await selectTimePoint(timePoint.id);
        setTimeError(errText(error));
      } finally {
        setTimeBusy(false);
      }
    },
    [reloadPresent, selectTimePoint, setSelected, setView, showToast, timePoint]
  );

  useEffect(() => () => historyLeave(), []);

  return {
    timeTravelOpen,
    setTimeTravelOpen,
    setTimeError,
    timePoints,
    timePoint,
    timeBusy,
    timeError,
    selectTimePoint,
    openTimeTravel,
    returnToPresent,
    restoreFromTime,
  };
}
