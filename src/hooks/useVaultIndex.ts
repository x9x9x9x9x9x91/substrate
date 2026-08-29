import { useCallback, useRef, useState } from "react";
import { vaultFolders, vaultList, vaultMetas } from "../lib/ipc";
import type { NoteMeta } from "../lib/types";
import { errText } from "../lib/errtext";
import { mergeList, patchNotes, RefreshOrder } from "../lib/listpatch";
import { requeueUnsyncedWrites, takeUnsyncedWrites } from "../lib/ownwrites";

/**
 * the vault index: the note list and folder list the whole app reads from,
 * the epoch/changed-paths pair panes key their re-reads off, the
 * boot-error bar (a failed list, or a launch index that never finished), and
 * the one refresh() that refills all of it.
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
  // The launch's index build unwound (`vault:boot-failed`). Deliberately not
  // cleared by a later successful list the way `bootError` is: the failure
  // poisoned the vault locks backend-side, so a read that happens to succeed
  // says nothing about the next one. Only a relaunch clears this.
  const [bootFailed, setBootFailed] = useState(false);
  // Every app mutation refreshes directly after its IPC lands, but
  // the engine watcher also echoes the write back ~300ms later as
  // vault:changed — an identical second full-vault refetch. Timestamp each
  // app-initiated refresh; echoes inside the window skip the refetch. The
  // listener's own refresh does NOT tag (external edits must never suppress
  // one another); only literal `false` marks a non-app origin.
  const lastOwnRefreshRef = useRef(0);
  // Refreshes overlap, and a full list is the slow one. Its snapshot is taken
  // when it is issued, so a list issued BEFORE a patch can land after it and
  // overwrite the patched rows with pre-write ones — and the patch has
  // already drained the paths that would have re-fetched them. Number the
  // refreshes at issue and let `RefreshOrder` say, path by path, which
  // answers are still news by the time they arrive.
  const seqRef = useRef(0);
  const orderRef = useRef(new RefreshOrder());
  // Has a whole list ever landed? A patch is an edit to a list, so there has
  // to be one: a write that completes before the first list arrives (a staged
  // vault, a capture on a cold start) would otherwise leave the app holding
  // the three notes it wrote and nothing else.
  const listedOnceRef = useRef(false);
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
    // What this refresh has to fetch. The whole vault is the expensive
    // answer and used to be the only one: re-listing every note to learn
    // about the one that just changed. It stays the answer wherever the
    // reach really is unknown — the first fill, an engine rescan, a write
    // nobody could name — and everywhere else the changed paths are already
    // known and only those are fetched.
    //
    // An app write leaves its paths in the own-write ledger (the same
    // reach undo attribution reads, derived once at the invoke); an
    // external event names them on the event. Draining is what "the list
    // has caught up on these" means, so a full list drains too.
    //
    // What makes the ledger safe to patch from is that it is complete: every
    // command that moves the index files there, watched write or not
    // (INDEX_WRITE_COMMANDS), and the ones that cannot name their reach file
    // `unnamed` and force the whole list. So a non-empty ledger covers this
    // refresh whoever called it — the caller does not have to name its own
    // paths, and a writer that files nothing at all leaves the ledger empty,
    // which re-lists.
    const pending = takeUnsyncedWrites();
    const named =
      paths && paths.length > 0 ? [...new Set([...paths, ...pending.paths])] : pending.paths;
    // An event that named nothing is the engine saying it rescanned: its
    // reach is the vault, whatever happened to be pending.
    const rescan = ownWrite === false && !(paths && paths.length > 0);
    const relist = !listedOnceRef.current || rescan || pending.unnamed || named.length === 0;
    const seq = ++seqRef.current;
    // this refresh drained the ledger, so it now owes the list those paths:
    // if nothing it fetches ever lands they go back, or the rows behind them
    // stay stale until something unrelated re-lists the vault
    const owed = () => requeueUnsyncedWrites(named, pending.unnamed);
    const applyList = (seqOfList: number) => (ns: NoteMeta[]) => {
      listedOnceRef.current = true;
      const newer = orderRef.current.admitList(seqOfList);
      if (newer) setNotes((prev) => mergeList(prev, ns, newer));
    };
    const listed = (
      relist
        ? vaultList().then(applyList(seq))
        : vaultMetas(named).then((metas) => {
            // only the paths no later refresh has already answered
            const fresh = new Set(orderRef.current.admitPatch(seq, named));
            if (fresh.size === 0) return;
            const freshPaths = named.filter((p) => fresh.has(p));
            const freshMetas = named.flatMap((p, i) => (fresh.has(p) ? [metas[i] ?? null] : []));
            setNotes((ns) => patchNotes(ns, freshPaths, freshMetas));
          })
    )
      .then(() => {
        setBootError(null); // a later refresh (vault:changed) recovered
      })
      .catch((err) => {
        console.error(err);
        // the patch never landed, so those paths are still unsynced — and a
        // patch is only ever as good as the list under it; fall back to the
        // whole thing rather than leave a row stale
        if (!relist) {
          const retry = ++seqRef.current; // issued now, so it outranks anything older
          return vaultList()
            .then(applyList(retry))
            .then(() => setBootError(null))
            .catch(() => {
              owed();
              setBootError(errText(err));
            });
        }
        owed();
        setBootError(errText(err));
      });
    // create, move and delete all change the folder set, so this is not
    // narrowable by path — but it is a list of strings, not of notes
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
    bootFailed,
    setBootFailed,
    lastOwnRefreshRef,
    refresh,
  };
}
