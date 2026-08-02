import { useEffect, useRef } from "react";
import { check } from "@tauri-apps/plugin-updater";
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
 * in the background and lands in a sticky "Restart now" toast. Dismissing
 * either is honest: the staged update applies on the next quit anyway, and
 * the 12h re-check self-heals a missed toast.
 */
export function useUpdater(
  showToast: (msg: string, action?: ToastAction, opts?: ToastOpts) => void
) {
  // survives re-renders, resets per app run: don't re-toast a version the
  // user already saw this session (the cadence would nag twice a day)
  const offered = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let timer: number | undefined;

    const install = (version: string) => {
      if (busy.current) return;
      busy.current = true;
      // re-check instead of holding the Update resource across the toast's
      // lifetime — rid handles don't owe us liveness minutes later
      check()
        .then(async (update) => {
          if (!update) return;
          await update.downloadAndInstall();
          if (disposed) return;
          showToast(
            `Substrate ${version} ready`,
            { label: "Restart now", run: () => void relaunch() },
            { sticky: true }
          );
        })
        .catch(() => {
          if (disposed) return;
          offered.current = null; // let the next cycle re-offer
          showToast("Update failed — will retry later");
        })
        .finally(() => {
          busy.current = false;
        });
    };

    const cycle = async () => {
      try {
        const update = await check();
        if (disposed || !update) return;
        const { version } = update;
        // free the resource now; install() does its own fresh check()
        void update.close();
        if (offered.current === version || busy.current) return;
        offered.current = version;
        showToast(
          `Substrate ${version} is available`,
          { label: "Install", run: () => install(version) },
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
    };
  }, [showToast]);
}
