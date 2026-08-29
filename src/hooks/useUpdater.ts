import { useCallback, useEffect, useRef } from "react";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "../lib/tauri";
import type { ToastAction, ToastOpts } from "./useToast";

/**
 * What one on-demand check found. The background cycle stays silent on all but
 * one of these — nothing new, a feed it could not reach, no feed at all — so
 * the answer only has somewhere to go when a person asked the question.
 *
 * `available` also covers an update this session already picked up: an offer
 * standing in the toast, a download running, or bytes installed and waiting
 * for a restart. Saying which one keeps a second press from starting a second
 * download.
 *
 * `unconfigured` is the public build, which ships with no endpoint: there is
 * nothing to reach, so "couldn't reach the feed" would name a fault that does
 * not exist. It updates by being downloaded again.
 */
export type UpdateCheck =
  | { state: "current" }
  | { state: "available"; version: string; stage: "offered" | "downloading" | "ready" }
  | { state: "unreachable" }
  | { state: "unconfigured" };

/* The plugin's own words for a build with an empty endpoint list — the one
   thing that distinguishes "no feed configured" from "the feed did not
   answer", and it only reaches here as the text of a thrown error. */
const NO_ENDPOINTS = "does not have any endpoints set";

/** Which kind of failure a check threw: a build with no feed, or a feed that
    would not answer. Anything unrecognizable reads as unreachable, which is
    the answer that was already given to everything. */
function failureState(e: unknown): UpdateCheck {
  return String(e).includes(NO_ENDPOINTS) ? { state: "unconfigured" } : { state: "unreachable" };
}

/** launch check waits this long so it never competes with vault load/index */
const FIRST_CHECK_MS = 20_000;
/** re-check cadence while the app stays open (it often runs for days) */
const RECHECK_MS = 12 * 60 * 60 * 1000;

/**
 * In-app updater. Quiet by design — a check that finds nothing, or
 * fails (offline, GitHub down, iOS where the plugin isn't registered), says
 * nothing. Something new → sticky toast with an Install action; install
 * replaces that offer with a sticky progress toast and lands in a sticky
 * "Restart now" toast.
 *
 * The toast slot is shared with every routine 4s message, so a sticky offer
 * CAN be displaced at any moment. The
 * cycle therefore re-offers every 12h unconditionally: a dismissed or
 * displaced toast is silence until the next cycle, never a lost update. A
 * staged install (downloaded, awaiting restart) re-surfaces its "Restart
 * now" toast the same way without re-downloading.
 *
 * Returns the same check as one callable thing (`checkNow`), for the Settings
 * row where a person can ask on demand. It shares this cycle's feed, held
 * offer and install path — it does not add a second one, and it changes no
 * cadence.
 */
export function useUpdater(
  showToast: (msg: string, action?: ToastAction, opts?: ToastOpts) => void
) {
  // the offered-but-not-installed Update resource. Held (not closed, not
  // re-checked) so Install installs exactly the bytes the toast named — a
  // release landing between offer and click becomes a NEW offer next cycle
  // instead of silently installing under the old label.
  const pending = useRef<Update | null>(null);
  /** version downloaded+installed this session, awaiting restart */
  const staged = useRef<string | null>(null);
  const busy = useRef(false);
  /** version currently downloading, so an on-demand check can name it */
  const installing = useRef<string | null>(null);
  /* The on-demand check, reachable from outside the effect that builds it.
     Outside Tauri the effect returns before assigning, and this stub stands:
     no plugin is registered there, which is the same answer as a feed that
     cannot be reached. */
  const ask = useRef<() => Promise<UpdateCheck>>(() =>
    Promise.resolve({ state: "unreachable" })
  );

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let timer: number | undefined;

    const offerRestart = (version: string) =>
      showToast(
        `Substrate ${version} ready`,
        { label: "Restart now", run: () => void relaunch() },
        { sticky: true }
      );

    /* Download progress, in the same sticky slot the offer occupied. The
       plugin reports chunk lengths, not a running total, so the total is
       accumulated here; `contentLength` is optional (a server that omits
       Content-Length), and MB downloaded is the honest fallback — a percentage
       of an unknown whole would be invented. showToast re-renders the slot, so
       it is called only when the rendered label would actually change. */
    const progressToast = (update: Update) => {
      let total: number | undefined;
      let downloaded = 0;
      // undefined, not "": the first render carries no detail yet, and it is
      // the one that has to replace the offer toast
      let shown: string | undefined;
      const render = (detail: string) => {
        if (detail === shown) return;
        shown = detail;
        showToast(`Downloading Substrate ${update.version}…${detail}`, undefined, {
          sticky: true,
        });
      };
      render("");
      return (event: DownloadEvent) => {
        if (disposed) return;
        if (event.event === "Started") {
          total = event.data.contentLength;
          return;
        }
        if (event.event !== "Progress") return;
        downloaded += event.data.chunkLength;
        render(
          total !== undefined && total > 0
            ? ` ${Math.min(100, Math.floor((downloaded / total) * 100))}%`
            : ` ${(downloaded / 1_000_000).toFixed(1)} MB`
        );
      };
    };

    const install = (update: Update) => {
      if (busy.current) return;
      busy.current = true;
      installing.current = update.version;
      update
        .downloadAndInstall(progressToast(update))
        // no close() after success: install frees both rids rust-side
        .then(() => {
          staged.current = update.version;
          pending.current = null;
          if (!disposed) offerRestart(update.version);
        })
        .catch(() => {
          // keep `pending` — the next cycle re-offers the same update
          if (!disposed) showToast("Update failed — will retry later");
        })
        .finally(() => {
          busy.current = false;
          installing.current = null;
        });
    };

    /* Put a found update on offer and answer with the version now offered.
       An update naming the version already held keeps the held resource — the
       one the standing Install button installs — and the freshly fetched
       duplicate is dropped. */
    const offer = (update: Update): string => {
      let held: Update;
      if (pending.current && pending.current.version === update.version) {
        // same offer still held — drop the duplicate resource
        held = pending.current;
        update.close().catch(() => {});
      } else {
        pending.current?.close().catch(() => {});
        pending.current = update;
        held = update;
      }
      showToast(
        `Substrate ${held.version} is available`,
        { label: "Install", run: () => install(held) },
        { sticky: true }
      );
      return held.version;
    };

    const cycle = async () => {
      try {
        if (busy.current) return;
        if (staged.current) {
          // already installed; just keep the restart offer reachable
          offerRestart(staged.current);
          return;
        }
        const update = await check();
        if (!update) return;
        if (disposed) {
          update.close().catch(() => {});
          return;
        }
        offer(update);
      } catch {
        // silent: offline, endpoint unreachable, or mobile (no plugin)
      }
    };

    /* The Settings row's button. Same feed, same offer, same install path —
       all it adds is an answer for the two outcomes the cycle above keeps
       quiet about. It never starts a second download: an install already
       running, or already finished and awaiting a restart, reports that
       instead of checking again. */
    ask.current = async (): Promise<UpdateCheck> => {
      if (staged.current) {
        // the bytes are in; re-surface the restart offer rather than re-fetch
        offerRestart(staged.current);
        return { state: "available", version: staged.current, stage: "ready" };
      }
      if (busy.current && installing.current) {
        return { state: "available", version: installing.current, stage: "downloading" };
      }
      try {
        const update = await check();
        if (!update) return { state: "current" };
        if (disposed) {
          update.close().catch(() => {});
          return { state: "current" };
        }
        return { state: "available", version: offer(update), stage: "offered" };
      } catch (e) {
        return failureState(e);
      }
    };

    timer = window.setTimeout(function run() {
      void cycle();
      timer = window.setTimeout(run, RECHECK_MS);
    }, FIRST_CHECK_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      pending.current?.close().catch(() => {});
      pending.current = null;
      ask.current = () => Promise.resolve({ state: "unreachable" });
    };
  }, [showToast]);

  /* Stable across renders: the row holding it must not re-run its own effects
     because this hook re-rendered. */
  return { checkNow: useCallback(() => ask.current(), []) };
}
