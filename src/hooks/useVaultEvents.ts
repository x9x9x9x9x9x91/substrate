import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri, listen } from "../lib/tauri";
import { deeplinkTakePending } from "../lib/ipc";
import { hotkeyRejectedMessage, type HotkeyRejection } from "../lib/hotkey";
import { dropClaimedNear } from "../lib/dragdrop";
import { basename } from "../lib/files";
import { parseEverywhereView } from "../lib/everywhere";
import { splitEcho } from "../lib/ownwrites";
import { resetAudioSources } from "../lib/assets";
import { refreshAudioPlayers } from "../lib/editor-widgets";
import type { UndoAction } from "./useUndoStack";
import type { ToastAction } from "./useToast";
import type { View } from "../lib/types";

/** payload of `app:open-sheet-row`: the sheet, the column that
    fired, and the row's label cell — the row identity the alert was keyed
    with. Backend spelling: `notify.rs`'s fire_and_handle. */
export interface SheetRowTarget {
  path: string;
  column: string;
  row: string;
}

/**
 * every backend-originated event the shell listens to: the file watcher
 * (vault:changed), sync pulls (vault:pulled), external config edits
 * (vault:config-changed), inherited-seal enforcement failures
 * (vault:seal-degraded), a dead watcher (vault:watch-degraded), a refused
 * capture hotkey (capture:hotkey-rejected), a restore that buried a newer
 * external edit (history:restored-over-external), unclaimed Finder drops, and
 * notification/tray note opens (app:open-note, app:open-sheet-row).
 * The everywhere palette jumping to a destination (app:open-view) rides here
 * too.
 *
 * `lastOwnRefreshRef` is shared with App's `refresh` (it tags app-initiated
 * refreshes), so it stays in App and is passed in; `openNoteRef` is created
 * here and returned because App wires its current opener into it.
 */
export function useVaultEvents(opts: {
  refresh: (ownWrite?: boolean, paths?: string[] | null) => void;
  refreshConfigs: () => void;
  refreshSealScopes: () => void;
  showToast: (msg: string, action?: ToastAction) => void;
  undoDispatch: (a: UndoAction) => void;
  setChangedPaths: (paths: string[] | null) => void;
  setVaultEpoch: (fn: (n: number) => number) => void;
  lastOwnRefreshRef: React.RefObject<number>;
}) {
  const {
    refresh,
    refreshConfigs,
    refreshSealScopes,
    showToast,
    undoDispatch,
    setChangedPaths,
    setVaultEpoch,
    lastOwnRefreshRef,
  } = opts;
  // the degraded-watcher toast fires once per app run, not per event
  const watchDegradedRef = useRef(false);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // An in-echo-window event's trailing refresh (see below)
    let trailingTimer: number | undefined;
    let trailingEventAt = 0;
    const fireTrailing = () => {
      trailingTimer = undefined;
      // a fresh app-write refresh after the event already re-listed the
      // vault (its snapshot postdates the event's disk change) — nothing
      // left to fetch
      if (lastOwnRefreshRef.current > trailingEventAt) return;
      // a newer app write extended the echo window past this timer — wait
      // it out rather than refetch inside the new window
      const remaining = lastOwnRefreshRef.current + 1000 - Date.now();
      if (remaining > 0) {
        trailingTimer = window.setTimeout(fireTrailing, remaining);
        return;
      }
      refresh(false);
    };
    listen("vault:changed", (e) => {
      // The audio/image caches key by name for the whole session, so
      // evict wholesale; the next use re-stats. Players re-resolve first so a
      // re-bounce rebuilds them. (The rel-path payload could narrow this
      // too, but an asset's cache key isn't its note path — left wholesale.)
      resetAudioSources();
      refreshAudioPlayers();
      // Attribute the event path by path (docs/undo.md §3.3).
      // `external` is what somebody else wrote, whatever we were doing at the
      // time; `unknown` is the engine's no-payload rescan, where there is
      // nothing to attribute and only the old timing signal is left.
      const split = splitEcho(Array.isArray(e.payload) ? (e.payload as string[]) : null);
      if (!split.unknown) {
        if (split.external.length === 0) {
          // A pure echo of our own write, proven per path rather than assumed
          // from the clock. Nothing to invalidate, and the point stands:
          // the app already re-listed after its own IPC, so skip the identical
          // second full-vault refetch. The epoch bump is NOT skippable though —
          // not every writer calls refresh() (the settings sheet writes
          // Settings.md and waits for this event to re-read the flag),
          // so announce the narrow path set and let the epoch listeners decide.
          setChangedPaths(split.own);
          setVaultEpoch((n) => n + 1);
          return;
        }
        // somebody else's write, named. Only entries touching those paths can
        // clobber, and the panes only need to re-read those notes — no
        // trailing delay either: an in-window external change is a fact here,
        // not the guess this once had to defer on.
        undoDispatch({ t: "invalidate", paths: split.external });
        refresh(false, split.external);
        return;
      }
      // Unchanged, for the events that name nothing: the
      // echo of our own write arrives within the watcher's debounce, so an
      // in-window event is most likely ours and the duplicate refetch is
      // skipped. It can't be proven to be ONLY the echo either — so rather
      // than drop an external edit until the next event, coalesce in-window
      // events into one trailing refresh at window expiry (fireTrailing
      // decides): external changes surface ~1s late instead of never.
      const now = Date.now();
      if (split.recentOwn && now - lastOwnRefreshRef.current < 1000) {
        trailingEventAt = now;
        // no invalidation here — inside the echo window an unpathed event is
        // most likely our own write coming back
        if (trailingTimer === undefined) {
          trailingTimer = window.setTimeout(fireTrailing, lastOwnRefreshRef.current + 1000 - now);
        }
        return;
      }
      // Outside the echo window, an event that names nothing is the
      // engine saying it rescanned — someone else's write, of unknown reach.
      // The conservative reading is that every stored inverse might now
      // clobber it, so mark them all stale. The engine's own guard is the real
      // safety net; this only stops ⌘Z from walking into a refusal.
      undoDispatch({ t: "invalidateAll" });
      refresh(false);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(trailingTimer);
      unlisten?.();
    };
  }, [refresh]);

  // docs/undo.md §3.5: a sync pull checks a tree out from under the
  // app. That is a write nobody can undo, and the watcher would report it as a
  // storm of unrelated file changes — so the pull announces exactly what it
  // rewrote, and those entries (only those) stop being invertible.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("vault:pulled", (e) => {
      const paths = Array.isArray(e.payload) ? (e.payload as string[]) : [];
      if (paths.length === 0) {
        undoDispatch({ t: "invalidateAll" });
        refresh(false);
        return;
      }
      undoDispatch({ t: "invalidate", paths });
      refresh(false, paths);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // external .vault/{schema,views,folders}.json edits arrive on their own
  // event — re-read the configs only; no note refetch, no audio
  // cache eviction (those ride vault:changed)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("vault:config-changed", () => refreshConfigs()).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshConfigs]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("vault:seal-scopes-changed", refreshSealScopes).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshSealScopes]);

  // A malformed marker, failed atomic replacement, or failed local-history
  // purge must never leave an inherited privacy boundary looking healthy.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string[]>("vault:seal-degraded", (e) => {
      const count = Array.isArray(e.payload) ? e.payload.length : 0;
      showToast(
        `Persistent sealing needs attention for ${count || "one or more"} item${count === 1 ? "" : "s"} — inspect the seal marker, disk permissions, and local history before treating the boundary as complete.`
      );
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // A peer/old client sent plaintext into an inherited scope. This machine
  // has encrypted it and rewritten its own app-owned history; the sender and
  // remote are separate copies, exactly like the per-note seal warning.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string[]>("vault:seal-remote-plaintext", (e) => {
      const count = Array.isArray(e.payload) ? e.payload.length : 0;
      showToast(
        `${count || "Some"} synced note${count === 1 ? "" : "s"} arrived as plaintext and were sealed locally — clean or replace the remote history separately.`
      );
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // the file watcher died in the backend: warn once, keep running degraded
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("vault:watch-degraded", () => {
      if (watchDegradedRef.current) return;
      watchDegradedRef.current = true;
      showToast(
        "File watching unavailable — external changes are picked up by a periodic rescan, within about a minute.",
      );
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // a changed capture-hotkey refused by the parser or the OS: the
  // settings form shows the new chord but the OLD one still fires — every
  // refused save is a distinct user action, so each gets its own toast
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<HotkeyRejection>("capture:hotkey-rejected", (e) => {
      showToast(hotkeyRejectedMessage(e.payload));
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // a restore landed on top of an edit that reached disk after the panel read
  // the note. The restore is what the user asked for and it went
  // through — but the buried edit is only findable in history, so say so
  // rather than letting the change vanish silently.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ path: string }>("history:restored-over-external", (e) => {
      showToast(
        `Restored over a newer edit to ${basename(e.payload.path)} — that edit is in version history.`
      );
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // a Finder drop no editor claimed (dashboard, list, sidebar…) — the OS
  // showed a "+" cursor, so silence reads as breakage; say what works
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop" || event.payload.paths.length === 0) return;
        const t = Date.now();
        // editors claim synchronously within this dispatch; check from a
        // macrotask so listener registration order doesn't matter
        window.setTimeout(() => {
          if (!dropClaimedNear(t)) showToast("To attach files, drop them into a note's text.");
        }, 0);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // a due-date notification click or a tray agenda item opens the note
  const openNoteRef = useRef<(path: string) => void>(() => {});
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>("app:open-note", (e) => openNoteRef.current(e.payload)).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

// `substrate://note/…` links the OS handed the app. The first
  // drain is what tells Rust this window is ready, so it also collects
  // anything that arrived during a cold start; after that every warm link
  // announces itself with `deeplink:pending` and drains the same way.
  //
  // A link that named a note this vault doesn't have comes back as a message
  // rather than a path — opening nothing is the one outcome the feature rules
  // out, and App's opener would show an empty pane for a path with no note.
  useEffect(() => {
    let cancelled = false;
    const drain = () => {
      void deeplinkTakePending()
        .then((items) => {
          if (cancelled) return;
          for (const item of items) {
            if (item.path) openNoteRef.current(item.path);
            else if (item.error) showToast(item.error);
          }
        })
        .catch(() => undefined);
    };
    drain();
    let unlisten: (() => void) | undefined;
    listen("deeplink:pending", drain).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showToast]);

  // a sheet cell's notification click opens the note AND asks for the row
  //. Its own event rather than a widened `app:open-note` payload:
  // that one is a bare path string and the tray agenda emits it too.
  const openSheetRowRef = useRef<(target: SheetRowTarget) => void>(() => {});
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<SheetRowTarget>("app:open-sheet-row", (e) => openSheetRowRef.current(e.payload)).then(
      (un) => {
        if (cancelled) un();
        else unlisten = un;
      }
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // the everywhere palette jumped to a destination rather than a note. Its
  // own event for the same reason the sheet row has one, and the payload is
  // checked here (`parseEverywhereView`) rather than trusted: a kind this
  // build has no case for would show an empty pane.
  const openViewRef = useRef<(view: View) => void>(() => {});
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<unknown>("app:open-view", (e) => {
      const view = parseEverywhereView(e.payload);
      if (view) openViewRef.current(view);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return {
    openNoteRef,
    openSheetRowRef,
    openViewRef,
  };
}
