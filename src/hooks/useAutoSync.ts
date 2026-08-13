import { useEffect, useRef } from "react";
import { isHistoryReadOnly, listen, onVaultWrite } from "../lib/tauri";
import { vaultSyncPull, vaultSyncPush, vaultSyncStatus } from "../lib/ipc";
import { syncConfigured } from "../lib/embedstate";
import { AutoSync, AUTO_SYNC_TIMINGS } from "../lib/autosync";

/** The live binding for the auto-sync scheduler (lib/autosync.ts): push
    debounced off every vault change, pull on app open / window focus / a
    slow interval. Mounted once by App; the `autoSync` prop is the Settings.md
    toggle, read through a ref so flipping it takes effect on the next
    trigger without re-arming the timers.

    `configured` is resolved once per session (embedstate's cache) — a remote
    saved mid-session arms the lane only after a reload, which is the honest
    shape of the first-join flow: that pull is the pane's button, not ours.

    The `window.__mockAutoSync` timing override is a test seam, set by e2e
    specs that cannot wait two minutes for a debounce. */
export function useAutoSync(autoSync: boolean) {
  const enabledRef = useRef(autoSync);
  useEffect(() => {
    enabledRef.current = autoSync;
  });

  useEffect(() => {
    let alive = true;
    let configured = false;
    const sync = new AutoSync(
      {
        enabled: () =>
          alive && enabledRef.current && configured && !isHistoryReadOnly(),
        status: () => vaultSyncStatus(),
        push: () => vaultSyncPush("auto"),
        pull: () => vaultSyncPull("auto"),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        now: () => Date.now(),
        log: (msg) => console.debug(msg),
      },
      { ...AUTO_SYNC_TIMINGS, ...window.__mockAutoSync }
    );
    sync.start();
    void syncConfigured().then((ok) => {
      configured = ok;
      // start()'s open-pull usually runs before this resolves and no-ops on
      // unconfigured; land it now instead. If it did run, the focus gap
      // absorbs this second ask.
      if (ok) sync.focus();
    });
    // our own writes arrive synchronously at the invoke return; everyone
    // else's (external editors, another device's push landing here) arrive
    // as watcher events. Both arm the same debounce.
    const offOwnWrite = onVaultWrite(() => sync.notifyChanged());
    let unlisten: (() => void) | undefined;
    listen("vault:changed", () => sync.notifyChanged()).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    const onFocus = () => sync.focus();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      sync.stop();
      offOwnWrite();
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
    // one scheduler per app run; the toggle reaches it through the ref
  }, []);
}
