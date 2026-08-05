import { useCallback, useRef, useState } from "react";
import { vaultFolders, vaultList } from "../lib/ipc";
import type { NoteMeta } from "../lib/types";

/**
 * the vault index: the note list and folder list the whole app reads from,
 * the epoch/changed-paths pair panes key their re-reads off, the
 * boot-error bar, and the one refresh() that refills all of it.
 */
export function useVaultIndex() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  // read-only latest-notes handle for callbacks that must not re-create on
  // every list change (the folder menu rebuilds would close an open menu)
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [folders, setFolders] = useState<string[]>([]);
  const [vaultEpoch, setVaultEpoch] = useState(0);
  // The paths behind the current epoch bump, or null for "unknown".
  // Set in the same batch as the bump, so a pane reading it in its vaultEpoch
  // effect sees the reason for that bump.
  const [changedPaths, setChangedPaths] = useState<string[] | null>(null);
  // Vault-list read failure — a persistent bar, never an empty
  // "working" app; cleared by the next successful list (e.g. vault:changed)
  const [bootError, setBootError] = useState<string | null>(null);
  // Every app mutation refreshes directly after its IPC lands, but
  // the engine watcher also echoes the write back ~300ms later as
  // vault:changed — an identical second full-vault refetch. Timestamp each
  // app-initiated refresh; echoes inside the window skip the refetch. The
  // listener's own refresh does NOT tag (external edits must never suppress
  // one another); only literal `false` marks a non-app origin.
  const lastOwnRefreshRef = useRef(0);
  // Which paths this epoch's bump is about, or null for "unknown —
  // assume anything". Panes that key off vaultEpoch use it to skip work for a
  // change that didn't touch them; an app write passes null because the app
  // has already updated itself and the re-read is only a safety net.
  // Returns once the note list has landed, for the rare caller that must wait
  // for it — selecting a path the app wrote but has no meta for yet.
  // Everyone else keeps calling it fire-and-forget.
  const refresh = useCallback((ownWrite: boolean = true, paths: string[] | null = null) => {
    if (ownWrite !== false) lastOwnRefreshRef.current = Date.now();
    setChangedPaths(paths);
    const listed = vaultList()
      .then((ns) => {
        setNotes(ns);
        setBootError(null); // a later refresh (vault:changed) recovered
      })
      .catch((err) => {
        console.error(err);
        setBootError(err instanceof Error ? err.message : String(err));
      });
    vaultFolders().then(setFolders).catch(console.error);
    setVaultEpoch((e) => e + 1);
    return listed;
  }, []);

  return {
    notes,
    setNotes,
    notesRef,
    folders,
    setFolders,
    vaultEpoch,
    setVaultEpoch,
    changedPaths,
    setChangedPaths,
    bootError,
    lastOwnRefreshRef,
    refresh,
  };
}
