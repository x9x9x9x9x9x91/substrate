import { useEffect, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "../lib/tauri";
import type { ToastAction, ToastOpts } from "./useToast";

/** launch check waits this long so it never competes with vault load/index */
const FIRST_CHECK_MS = 20_000;
/** re-check cadence while the app stays open (it often runs for days) */
const RECHECK_MS = 12 * 60 * 60 * 1000;

/**
 * SUB-806: in-app updater. Quiet by design — a check that finds nothing, or
 * fails (offline, GitHub down, iOS where the plugin isn't registered), says
 * nothing. Something new → sticky toast with an Install action; install runs
 * in the background and lands in a sticky "Restart now" toast.
 *
 * The toast slot is shared with every routine 4s message, so a sticky offer
 * CAN be displaced at any moment (four-review finding, 2026-08-02). The
 * cycle therefore re-offers every 12h unconditionally: a dismissed or
 * displaced toast is silence until the next cycle, never a lost update. A
 * staged install (downloaded, awaiting restart) re-surfaces its "Restart
 * now" toast the same way without re-downloading.
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

    const install = (update: Update) => {
      if (busy.current) return;
      busy.current = true;
      update
        .downloadAndInstall()
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
        });
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
      } catch {
        // silent: offline, endpoint unreachable, or mobile (no plugin)
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
    };
  }, [showToast]);
}
