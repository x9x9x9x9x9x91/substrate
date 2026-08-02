import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri, listen } from "../lib/tauri";
import { hotkeyRejectedMessage, type HotkeyRejection } from "../lib/hotkey";
import { dropClaimedNear } from "../lib/dragdrop";
import { basename } from "../lib/files";
import { splitEcho } from "../lib/ownwrites";
import { resetAudioSources } from "../lib/assets";
import { refreshAudioPlayers } from "../lib/editor-widgets";
import type { UndoAction } from "./useUndoStack";
import type { ToastAction } from "./useToast";

/**
 * every backend-originated event the shell listens to: the file watcher
 * (vault:changed), sync pulls (vault:pulled), external config edits
 * (vault:config-changed), a dead watcher (vault:watch-degraded), a refused
 * capture hotkey (capture:hotkey-rejected), a restore that buried a newer
 * external edit (history:restored-over-external), unclaimed Finder drops, and
 * notification/tray note opens (app:open-note).
 *
 * `lastOwnRefreshRef` is shared with App's `refresh` (it tags app-initiated
 * refreshes), so it stays in App and is passed in; `openNoteRef` is created
 * here and returned because App wires its current opener into it.
 */
export function useVaultEvents(opts: {
  refresh: (ownWrite?: boolean, paths?: string[] | null) => void;
  refreshConfigs: () => void;
  showToast: (msg: string, action?: ToastAction) => void;
  undoDispatch: (a: UndoAction) => void;
  setChangedPaths: (paths: string[] | null) => void;
  setVaultEpoch: (fn: (n: number) => number) => void;
  lastOwnRefreshRef: React.RefObject<number>;
}) {
  const {
    refresh,
    refreshConfigs,
    showToast,
    undoDispatch,
    setChangedPaths,
    setVaultEpoch,
    lastOwnRefreshRef,
  } = opts;
  // the degraded-watcher toast fires once per app run, not per event (SUB-98)
  const watchDegradedRef = useRef(false);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // SUB-239: an in-echo-window event's trailing refresh (see below)
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
      // SUB-101: the audio/image caches key by name for the whole session, so
      // evict wholesale; the next use re-stats. Players re-resolve first so a
      // re-bounce rebuilds them. (SUB-460's rel-path payload could narrow this
      // too, but an asset's cache key isn't its note path — left wholesale.)
      resetAudioSources();
      refreshAudioPlayers();
      // SUB-516: attribute the event path by path (docs/undo.md §3.3).
      // `external` is what somebody else wrote, whatever we were doing at the
      // time; `unknown` is the engine's no-payload rescan, where there is
      // nothing to attribute and only the old timing signal is left.
      const split = splitEcho(Array.isArray(e.payload) ? (e.payload as string[]) : null);
      if (!split.unknown) {
        if (split.external.length === 0) {
          // A pure echo of our own write, proven per path rather than assumed
          // from the clock. Nothing to invalidate, and SUB-116's point stands:
          // the app already re-listed after its own IPC, so skip the identical
          // second full-vault refetch. The epoch bump is NOT skippable though —
          // not every writer calls refresh() (the settings sheet writes
          // Settings.md and waits for this event to re-read the flag, SUB-490),
          // so announce the narrow path set and let the epoch listeners decide.
          setChangedPaths(split.own);
          setVaultEpoch((n) => n + 1);
          return;
        }
        // somebody else's write, named. Only entries touching those paths can
        // clobber, and the panes only need to re-read those notes — no
        // trailing delay either: an in-window external change is a fact here,
        // not the guess SUB-239 had to defer on.
        undoDispatch({ t: "invalidate", paths: split.external });
        refresh(false, split.external);
        return;
      }
      // SUB-116/SUB-239, unchanged, for the events that name nothing: the
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
      // SUB-477: outside the echo window, an event that names nothing is the
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

  // SUB-516 (docs/undo.md §3.5): a sync pull checks a tree out from under the
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
  // event (SUB-100) — re-read the configs only; no note refetch, no audio
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

  // a changed capture-hotkey refused by the parser or the OS (SUB-651): the
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
  // the note (SUB-781). The restore is what the user asked for and it went
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
  // showed a "+" cursor, so silence reads as breakage; say what works (SUB-414)
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

  // a due-date notification click or a tray agenda item opens the note (SUB-21, SUB-30)
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

  return { openNoteRef };
}
