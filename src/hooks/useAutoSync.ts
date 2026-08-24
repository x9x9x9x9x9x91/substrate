import { useEffect, useRef } from "react";
import { isHistoryReadOnly, listen, onVaultWrite } from "../lib/tauri";
import { vaultRead, vaultSyncPull, vaultSyncPush, vaultSyncStatus } from "../lib/ipc";
import { subscribeSyncConfigured, syncConfigured } from "../lib/embedstate";
import { AutoSync, AUTO_SYNC_TIMINGS } from "../lib/autosync";
import { parseAutoSync, SETTINGS_PATH } from "../lib/settings";

/** The live binding for the auto-sync scheduler (lib/autosync.ts): push
    debounced off every vault change, pull on app open / window focus / a
    slow interval. Mounted once by App; the `autoSync` prop is the Settings.md
    toggle, read through a ref so flipping it takes effect on the next
    trigger without re-arming the timers.

    `configured` is re-read whenever the Sync pane drops embedstate's cache,
    which its save-success path already does — so a remote saved mid-session
    arms this lane in place: settle-push, focus pull and interval pull all go
    live without a reload. What arming does NOT do is pull. `start()` ran at
    boot (its open pull refused by the same gate) and is never re-run, so the
    first pull after enrollment is still the pane's button, or the focus /
    interval that comes later on its own schedule — never the save itself.

    The prop cannot be trusted at mount: App holds `auto-sync` in state that
    starts at the default ON and only becomes the vault's answer once its own
    Settings.md read resolves, so a vault that says `auto-sync: false` spends
    the first moments of every run looking enabled — and start()'s open pull
    lands inside exactly that window. So the lane reads the setting itself and
    holds off until that answer is in.

    The `window.__mockAutoSync` timing override is a test seam, set by e2e
    specs that cannot wait two minutes for a debounce. */
export function useAutoSync(autoSync: boolean) {
  const enabledRef = useRef(autoSync);
  const bootProp = useRef(autoSync);
  const seeded = useRef(false);
  useEffect(() => {
    // Echo the prop — but not while it is still App's pre-read default, which
    // would put ON back over the boot read below. App reads the same file, so
    // the first value that differs is authoritative (as is a user's toggle),
    // and from then on the prop owns the ref again.
    if (!seeded.current && autoSync === bootProp.current) return;
    seeded.current = true;
    enabledRef.current = autoSync;
  });

  useEffect(() => {
    let alive = true;
    let configured = false;
    // A re-read landing out of order must not put the old answer back: the
    // boot read is two awaits deep, and a save inside that window resolves
    // second. Only the newest read owns the gate.
    let reads = 0;
    const readConfigured = () => {
      const seq = ++reads;
      return syncConfigured()
        .catch(() => false)
        .then((ok) => {
          if (alive && seq === reads) configured = ok;
        });
    };
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
    // Both answers before the first trigger, not alongside it: whether a
    // remote exists at all, and whether the vault wants this lane running.
    // start()'s open pull is the one trigger that cannot be taken back.
    void Promise.all([
      readConfigured(),
      vaultRead(SETTINGS_PATH)
        .then((note) => parseAutoSync(note.props))
        // an unreadable Settings.md is the default-ON case, same as a vault
        // that has never held the key
        .catch(() => true),
    ]).then(([, wanted]) => {
      if (!alive) return;
      if (!seeded.current) enabledRef.current = wanted;
      sync.start();
    });
    // A remote saved mid-session: the pane's save-success drops the cache, and
    // the gate re-reads it here. Only the gate — the scheduler is already
    // running, and calling start() again is what would turn enrollment into an
    // unsolicited pull. The Settings.md answer is untouched too, so a vault
    // that says `auto-sync: false` stays parked through a save.
    const offConfigured = subscribeSyncConfigured(() => void readConfigured());
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
      offConfigured();
      offOwnWrite();
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
    // one scheduler per app run; the toggle reaches it through the ref
  }, []);
}
