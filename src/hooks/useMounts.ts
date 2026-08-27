import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  filePick,
  mountAdd,
  mountAnnotate,
  mountBind,
  mountRemove,
  mountRows,
  drivesList,
  mountsList,
} from "../lib/ipc";
import {
  isIntrinsic,
  MOUNT_SCHEME,
  rowMetas,
  scanStatLine,
} from "../lib/mounts";
import type { PropWriter } from "../lib/undoprops";
import { withSnapshotWarning } from "../lib/sweep";
import type { DriveInfo, MountInfo, MountRow, MountScanStats, PropValue, View } from "../lib/types";
import { errText } from "../lib/errtext";

/** what a mount needs from the rest of App to do its work */
type MountsDeps = {
  vaultEpoch: number;
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  showToast: (msg: string) => void;
  refresh: () => void;
  /** re-read the .vault JSONs — a mount IS a database, so unmounting moves them */
  reloadDbMeta: () => void;
  presweepSnapshot: (label: string) => Promise<boolean>;
};

/**
 * Reality mounts: the registry, this machine's bindings, the Drive Shelf's
 * catalog, the open mount's rows, and every act that changes one — mount,
 * unmount, locate, annotate a row, and the search-hit handoff that lands a
 * global hit on the right board row.
 *
 * A mount's name IS a schema type, so the database-shaped derivations live
 * here too: they are what let the sidebar, the manager and the palette route
 * to a mount without any of them knowing what a mount is.
 */
export function useMounts(deps: MountsDeps) {
  const { vaultEpoch, view, setView, showToast, refresh, reloadDbMeta, presweepSnapshot } = deps;

  // "Mount a folder…": the dialog's open state
  const [mountDialog, setMountDialog] = useState(false);
  /** every mount in the vault, with this machine's binding resolved */
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  /** the Drive Shelf's own list — the sidebar's row count and its drive rows.
      Drives ARE mounts, but the shelf's totals and staleness come from the
      catalog rather than the registry, so it is its own read. */
  const [drives, setDrives] = useState<DriveInfo[]>([]);

  /** the open mount's rows — its last-known index merged with its sidecars */
  const [mountRowList, setMountRowList] = useState<MountRow[]>([]);
  /** the mount whose "unmount and trash its notes" is awaiting confirmation */
  const [unmountAsk, setUnmountAsk] = useState<MountInfo | null>(null);

  /** mount by its database name — a mount's name IS its schema type, so any
      surface holding a type string can find out it is really a mount */
  const mountByType = useMemo(
    () => new Map(mounts.map((m) => [m.name.toLowerCase(), m])),
    [mounts]
  );

  /** folded names of the mounted folders, for surfaces that only want to know
      whether a database IS one (the sidebar's glyph) */
  const mountDbNames = useMemo(() => new Set(mountByType.keys()), [mountByType]);

  /** Where a database name really goes: its mount view when the name is a
      mounted folder, its database view otherwise. Every "open this database"
      path resolves through here, so a mount is reachable from the manager,
      the sidebar and the palette without any of them knowing what a mount
      is — the callers differ only in what else their navigation does. */
  const viewForDb = useCallback(
    (type: string): View => {
      const mount = mountByType.get(type.toLowerCase());
      return mount ? { kind: "mount", id: mount.id } : { kind: "db", type };
    },
    [mountByType]
  );

  const openDatabase = useCallback((type: string) => setView(viewForDb(type)), [viewForDb]);

  /** the mount the current view is about, or null */
  const activeMount = useMemo(
    () => (view.kind === "mount" ? (mounts.find((m) => m.id === view.id) ?? null) : null),
    [view, mounts]
  );

  /** its rows in note shape, which is all DatabasePane ever wanted */
  const mountNotes = useMemo(
    () => (activeMount ? rowMetas(activeMount, mountRowList) : []),
    [activeMount, mountRowList]
  );

  // the registry plus THIS machine's bindings — both halves can change
  // without a note changing, so mounts reload on their own schedule
  const reloadMounts = useCallback(
    () =>
      mountsList()
        .then(setMounts)
        .catch((e) => console.error(e)),
    []
  );

  // the registry rides the same epoch as everything else — a scan, a bind,
  // the migration at boot all bump it. Cheap: one .vault read.
  useEffect(() => {
    reloadMounts();
  }, [vaultEpoch, reloadMounts]);

  // …and the shelf, on the same epoch: the drive poller emits `vault:changed`
  // when a disk appears or vanishes, which is exactly what bumps it, so a
  // plugged-in drive reaches the sidebar without a second timer here.
  useEffect(() => {
    drivesList()
      .then(setDrives)
      .catch((e) => console.error(e));
  }, [vaultEpoch]);

  // …and the open mount's rows, which are its index merged with its sidecars.
  // Only the mount being looked at is loaded: a folder can hold thousands of
  // files, and nothing off-screen needs them.
  useEffect(() => {
    if (view.kind !== "mount") {
      setMountRowList([]);
      return;
    }
    let live = true;
    mountRows(view.id)
      .then((rows) => {
        if (live) setMountRowList(rows);
      })
      .catch((e) => {
        console.error(e);
        if (live) setMountRowList([]);
      });
    return () => {
      live = false;
    };
  }, [view, vaultEpoch]);

  // "Mount a folder…": register the mount, bind it here and scan it
  // once, all inside mount_add — then read that one scan's stats back for the
  // dialog to show inline. Nothing is imported: the scan only writes the
  // mount's own index, so the refresh is for the new database appearing.
  const mountSubmit = useCallback(
    async (name: string, path: string, globs: string[], watch: boolean): Promise<MountScanStats> => {
      const stats = await mountAdd(name, path, globs, watch);
      await reloadMounts();
      reloadDbMeta();
      refresh();
      return stats;
    },
    [reloadMounts, reloadDbMeta, refresh]
  );

  // Unmounting is two different acts. Plain "Unmount" forgets the
  // folder and leaves every sidecar behind as an ordinary note — remounting
  // the same folder reattaches them, which is why it needs no confirmation.
  // The cleanup variant trashes those notes, so it goes through a dialog and
  // a pre-sweep snapshot like every other bulk destructive op.
  const unmountNow = useCallback(
    async (mount: MountInfo, cleanup: boolean): Promise<void> => {
      const snapped = cleanup
        ? await presweepSnapshot(`before unmounting ${mount.name}`)
        : true;
      await mountRemove(mount.id, cleanup);
      setUnmountAsk(null);
      // the mount was a database: its view, its rows and its schema all go
      setView((v) => (v.kind === "mount" && v.id === mount.id ? { kind: "dbmanager" } : v));
      await reloadMounts();
      reloadDbMeta();
      refresh();
      showToast(
        withSnapshotWarning(
          cleanup
            ? `Unmounted “${mount.name}” and moved its notes to Trash`
            : `Unmounted “${mount.name}” — its notes stay in the vault`,
          snapped
        )
      );
    },
    [presweepSnapshot, reloadMounts, reloadDbMeta, refresh, showToast]
  );

  const unmount = useCallback(
    (mount: MountInfo, cleanup: boolean) => {
      if (cleanup) setUnmountAsk(mount);
      else unmountNow(mount, false).catch((e) => showToast(errText(e)));
    },
    [unmountNow, showToast]
  );

  /** the open mount's rows keyed the way the board keys them — by virtual
      path AND by sidecar path, because a row answers to whichever it has */
  const mountRowByPath = useMemo(() => {
    const by = new Map<string, MountRow>();
    if (!activeMount) return by;
    for (const r of mountRowList) {
      by.set(`${MOUNT_SCHEME}${activeMount.id}/${r.rel}`, r);
      if (r.note) by.set(r.note, r);
    }
    return by;
  }, [activeMount, mountRowList]);

  /** The mounted file a global-search hit named, on its way to its
      board. `n` distinguishes two requests for the same row, so opening the
      same hit twice reveals it twice. */
  const [mountHit, setMountHit] = useState<{ id: string; rel: string; n: number } | null>(null);

  /** Send a search hit that landed inside a mounted document to its board.
      `false` when this machine has no such mount: the vault carries the index,
      the machine carries the folder, so a hit can name a file that is real
      elsewhere and absent here — saying so beats a board that opens empty.

      The search pane never reaches that branch: it drops hits into absent
      mounts before it draws them, deliberately, so nothing there can be
      clicked. The notice is for the callers that hand over a name from
      somewhere other than a rendered row — and for the narrow race where a
      mount goes away between a row being drawn and being clicked. */
  const openMountHit = useCallback(
    (id: string, rel: string) => {
      if (!mounts.some((m) => m.id === id)) {
        showToast("That folder isn’t mounted on this machine");
        return false;
      }
      setView({ kind: "mount", id });
      setMountHit((h) => ({ id, rel, n: (h?.n ?? 0) + 1 }));
      return true;
    },
    [mounts, showToast]
  );

  /** The row the board should put itself on, once its rows are in. A row with
      a sidecar answers to the note's path and one without to the virtual path,
      so which one to reveal is only knowable from the loaded rows — and they
      arrive after the board does. Null until then, and null for a hit into
      some other mount than the open one. */
  const mountReveal = useMemo(() => {
    if (!mountHit || !activeMount || activeMount.id !== mountHit.id) return null;
    const row = mountRowList.find((r) => r.rel === mountHit.rel);
    if (!row) return null;
    return { path: row.note ?? `${MOUNT_SCHEME}${activeMount.id}/${row.rel}`, n: mountHit.n };
  }, [mountHit, activeMount, mountRowList]);

  /** Which row the board draws as open, kept apart from the request that put
      it there. The request is spent the moment the board has it — held any
      longer, every later rows fetch would hand the board the same one again
      and drag the user back to the row they arrived on, and so would leaving
      the board and coming back. The MARK has to outlive it, though: it is the
      answer to "which file was I sent to", and it stays until something else
      is opened. Kept per mount so another board never inherits it. */
  const [mountOpen, setMountOpen] = useState<{ id: string; path: string } | null>(null);

  /** The board queues the focus in its own effect, which runs before this
      one, so the request is safe to retire here. */
  useEffect(() => {
    if (!mountReveal || !mountHit) return;
    setMountOpen({ id: mountHit.id, path: mountReveal.path });
    setMountHit(null);
  }, [mountReveal, mountHit]);

  /** The row set the board was showing when a request came in — see below. */
  const mountHitRows = useRef<MountRow[] | null>(null);

  /** …and the other end of the same request: one no board can answer. A hit
      names a file the vault's index knows; the folder on this machine may not
      hold it any more, and then no rows ever carry that name. Waiting on it
      is not a wait that ends — it sits pending through the day, and the first
      rescan that does turn the name up drags whatever board is open then onto
      a row nobody asked for. So the board gets one answer: the first rows to
      land after the request, which always come, because arriving re-enters the
      board and that refetches. Rows without it retire it. */
  useEffect(() => {
    if (!mountHit) {
      mountHitRows.current = null;
      return;
    }
    // the board isn't on the requested mount yet; its rows are another mount's
    if (activeMount?.id !== mountHit.id) return;
    // the rows carry it — answered by `mountReveal`, not retired here
    if (mountRowList.some((r) => r.rel === mountHit.rel)) return;
    if (mountHitRows.current === null) mountHitRows.current = mountRowList;
    else if (mountHitRows.current !== mountRowList) setMountHit(null);
  }, [mountHit, activeMount, mountRowList]);

  /** A mount row's property write. Ordinary notes go through
      vaultSetProp; a mount row can't, because the note it would write to may
      not exist until this very edit creates it. `mount_annotate` creates the
      sidecar on demand and returns the note either way.

      Undo needs a `prior` to restore and the engine doesn't return one, so it
      comes from the row the board is showing — the same value the cell was
      displaying when it was edited. The guard vaultSetProp takes is dropped:
      a mount row's props live in a file the vault alone writes. */
  const mountWriteProp = useCallback<PropWriter>(
    async (path, key, value) => {
      if (!activeMount) throw new Error("no mounted folder is open");
      const row = mountRowByPath.get(path);
      if (!row) throw new Error("that row is no longer in the folder");
      if (isIntrinsic(key)) throw new Error(`${key} comes from the file itself`);
      const prior = (row.props[key] ?? null) as PropValue;
      const meta = await mountAnnotate(activeMount.id, row.rel, key, value);
      return { meta, prior };
    },
    [activeMount, mountRowByPath]
  );

  /** Point a mount at a folder on THIS machine — the "Locate folder…" lane,
      and the same call the board's banner offers when a bound folder has gone
      away. Binding rescans, so the rows are true again the moment it lands. */
  const locateMount = useCallback(
    (mount: MountInfo) => {
      filePick(true)
        .then(async (picked) => {
          if (!picked) return;
          const stats = await mountBind(mount.id, picked);
          await reloadMounts();
          refresh();
          showToast(`“${mount.name}” → ${picked} — ${scanStatLine(stats)}`);
        })
        .catch((e) => showToast(errText(e)));
    },
    [reloadMounts, refresh, showToast]
  );

  return {
    mountDialog,
    setMountDialog,
    mounts,
    drives,
    unmountAsk,
    setUnmountAsk,
    mountByType,
    mountDbNames,
    viewForDb,
    openDatabase,
    activeMount,
    mountNotes,
    mountRowByPath,
    mountReveal,
    mountOpen,
    setMountOpen,
    mountSubmit,
    unmountNow,
    unmount,
    openMountHit,
    mountWriteProp,
    locateMount,
  };
}
